<?php
/**
 * Tests for `wp nodes ls` and `wp nodes cli` (Cli_Command WP-CLI wrapper).
 *
 * Hardest pieces are the run_repl event loop (STDIN-driven) and the readline
 * dance — those are exercised by manual integration testing. Here we cover:
 *
 *  - root-uid guard for `cli`
 *  - `base_dir()` filter resolution
 *  - `ls` output for empty / live / stale lock dirs
 *  - `build_repl_graph` (private) — bare and pivoted graph topology
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\CLI_Command;
use Newspack_Nodes\CLI_Stdin_Reader_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

require_once \dirname( __DIR__, 2 ) . '/includes/class-cli-command.php';
require_once \dirname( __DIR__ ) . '/Helpers/WPCLIStub.php';

#[CoversClass( CLI_Command::class )]
#[CoversClass( CLI_Stdin_Reader_Node::class )]
#[CoversClass( \Newspack_Nodes\Dumper_Node::class )]
class CliCommandTest extends TestCase {
	private string $tmp;

	/**
	 * Captured messages minus the readline-mode constructor's cache-seeding
	 * completion queries (KEY='completion'), so dispatch-count assertions stay
	 * focused on the lines actually typed.
	 *
	 * @param array<int,array<int,mixed>> $captured
	 * @return array<int,array<int,mixed>>
	 */
	private static function non_completion( array $captured ): array {
		return \array_values(
			\array_filter(
				$captured,
				static fn ( $m ) => 'completion' !== ( $m[ \Newspack_Nodes\Message::KEY ] ?? '' )
			)
		);
	}

	protected function setUp(): void {
		parent::setUp();
		// Use /tmp/... directly so realpath() matches input on macOS where
		// sys_get_temp_dir() resolves through /private/tmp.
		$staging = '/tmp/newspack-nodes-cli-command-test-' . \uniqid();
		\mkdir( $staging, 0755, true );
		$this->tmp = \realpath( $staging ) ?: $staging;

		$GLOBALS['_wp_actions']         = [];
		$GLOBALS['_test_wp_cli_logs']   = [];
		$GLOBALS['_test_wp_cli_warns']  = [];
		$GLOBALS['_test_wp_cli_errors'] = [];

		$this->use_base_dir( $this->tmp );
	}

	protected function tearDown(): void {
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	// ── ls ────────────────────────────────────────────────────────────────────

	public function test_ls_logs_no_workers_when_empty(): void {
		( new CLI_Command() )->ls( [], [] );

		$this->assertNotEmpty( $GLOBALS['_test_wp_cli_logs'] );
		$this->assertStringContainsString( 'No workers running', $GLOBALS['_test_wp_cli_logs'][0] );
	}

	public function test_ls_logs_live_worker_with_age(): void {
		\mkdir( "{$this->tmp}/locks/firehose-workers.p0.lock.d", 0755, true );
		\touch( "{$this->tmp}/locks/firehose-workers.p0.lock.d/heartbeat" );

		( new CLI_Command() )->ls( [], [] );

		$haystack = \implode( "\n", $GLOBALS['_test_wp_cli_logs'] );
		$this->assertStringContainsString( '[live]', $haystack );
		$this->assertStringContainsString( 'firehose-workers.p0', $haystack );
		$this->assertStringContainsString( 'heartbeat', $haystack );
	}

	public function test_ls_marks_stale_workers(): void {
		\mkdir( "{$this->tmp}/locks/jobs.p0.lock.d", 0755, true );
		// Heartbeat older than STALE_TIMEOUT (60s) → marked stale.
		\touch( "{$this->tmp}/locks/jobs.p0.lock.d/heartbeat", \time() - 3600 );

		( new CLI_Command() )->ls( [], [] );

		$haystack = \implode( "\n", $GLOBALS['_test_wp_cli_logs'] );
		$this->assertStringContainsString( '[stale]', $haystack );
		$this->assertStringContainsString( 'jobs.p0', $haystack );
	}

	public function test_ls_shows_never_for_missing_heartbeat(): void {
		// Lock dir present but heartbeat file never touched.
		\mkdir( "{$this->tmp}/locks/aggregator.p0.lock.d", 0755, true );

		( new CLI_Command() )->ls( [], [] );

		$haystack = \implode( "\n", $GLOBALS['_test_wp_cli_logs'] );
		$this->assertStringContainsString( 'never', $haystack );
		$this->assertStringContainsString( 'aggregator.p0', $haystack );
	}

	// ── cli (root guard) ──────────────────────────────────────────────────────

	public function test_cli_refuses_to_run_as_root(): void {
		// We can't actually be root in the test runner, but if we COULD, the cli()
		// would WP_CLI::error out. Validate the path indirectly: the function
		// reaches the root check first, and posix_getuid() is the only blocker
		// before any node graph is built. Run as the test user (non-root) and
		// verify a different code path runs.
		if ( \function_exists( 'posix_getuid' ) && 0 === \posix_getuid() ) {
			$this->expectException( \RuntimeException::class );
			$this->expectExceptionMessageMatches( '/must run as the same user/' );
			( new CLI_Command() )->cli( [], [] );
			return;
		}
		// Non-root path: the function will try to construct the REPL graph. We
		// can't drive the event loop in a unit test, so this is exercised in
		// the build_repl_graph tests below via reflection.
		$this->markTestSkipped( 'Root guard branch only reachable when test user has uid 0' );
	}

	// ── base_dir resolution ───────────────────────────────────────────────────

	public function test_base_dir_picks_up_config_file_value(): void {
		// base_dir() is private but we can verify it through the public surface:
		// `ls` builds a Cli with `base_dir()`. Without the config file pointing
		// at our tmp dir (set in setUp via use_base_dir), we'd see
		// "No workers running" because the lock dirs are under $this->tmp.
		\mkdir( "{$this->tmp}/locks/test-worker.p0.lock.d", 0755, true );
		\touch( "{$this->tmp}/locks/test-worker.p0.lock.d/heartbeat" );

		( new CLI_Command() )->ls( [], [] );

		$haystack = \implode( "\n", $GLOBALS['_test_wp_cli_logs'] );
		$this->assertStringContainsString( 'test-worker.p0', $haystack );
	}

	// ── build_repl_graph: bare and pivoted ───────────────────────────────────

	public function test_build_repl_graph_bare_constructs_local_pipeline(): void {
		// Bare mode: _shell → _command_interpreter → _router → _output (Dumper).
		// We invoke the private method via reflection to verify the graph shape
		// without entering the run_repl event loop.
		$ref = new \ReflectionMethod( CLI_Command::class, 'build_repl_graph' );
		$ref->setAccessible( true );

		[ $shell, $dumper ] = $ref->invoke( new CLI_Command(), false, null );

		$this->assertInstanceOf( \Newspack_Nodes\Shell_Node::class, $shell );
		$this->assertInstanceOf( \Newspack_Nodes\Dumper_Node::class, $dumper );

		// Verify registry: _command_interpreter, _router, _output should all be present.
		$nodes = Core::$nodes_by_name;
		$this->assertArrayHasKey( '_router', $nodes );
		$this->assertArrayHasKey( '_command_interpreter', $nodes );
		$this->assertArrayHasKey( '_output', $nodes );
		// Dumper is registered as `_output` (so worker replies addressed to
		// `_output/$pid` route correctly via _router).
		$this->assertSame( $dumper, $nodes['_output'] );

		// Cleanup: remove nodes so the next test starts fresh.
		Core::cleanup_all_nodes();
	}

	public function test_build_repl_graph_pivoted_mounts_worker_partition_and_reply_in(): void {
		// Pivoted mode: the IPC input Partition is mounted under the WORKER id (the
		// mount point routing peels to), plus an unnamed `reply-in` Consumer.
		$ipc = [
			'input'     => "{$this->tmp}/ipc/firehose-workers.p0/input",
			'output'    => "{$this->tmp}/ipc/firehose-workers.p0/output",
			'type'      => 'firehose-workers',
			'partition' => 0,
		];
		\mkdir( $ipc['input'], 0755, true );
		\mkdir( $ipc['output'], 0755, true );

		$ref = new \ReflectionMethod( CLI_Command::class, 'build_repl_graph' );
		$ref->setAccessible( true );

		[ $shell, $dumper ] = $ref->invoke( new CLI_Command(), true, $ipc );

		$nodes = Core::$nodes_by_name;
		// The IPC input Partition is named after the worker, so `cd <worker>` routes to it.
		$this->assertArrayHasKey( 'firehose-workers.p0', $nodes );
		$this->assertInstanceOf( \Newspack_Nodes\Partition_Node::class, $nodes['firehose-workers.p0'] );
		// Prompt + cwd reflect the worker path.
		$this->assertSame( '/firehose-workers.p0> ', $shell->prompt );
		$this->assertSame( 'firehose-workers.p0', $shell->path );

		// Shell → CommandInterpreter: pivoted commands are HMAC-signed,
		// then routed by TO (the Router peels the worker id to the mounted Partition).
		$this->assertSame(
			Core::node( \Newspack_Nodes\Node_Names::COMMAND_INTERPRETER ),
			$shell->sink()
		);

		Core::cleanup_all_nodes();
	}

	public function test_build_repl_graph_pivoted_sets_dumper_to_filter(): void {
		// Dumper TO filter must be set to the cli session's $pid so other
		// sessions' replies drop silently. We can't easily read the private
		// to_filter field — we verify behavior: a message addressed to "$pid"
		// should render, while one to a different pid should drop.
		$ipc = [
			'input'     => "{$this->tmp}/ipc/jobs.p0/input",
			'output'    => "{$this->tmp}/ipc/jobs.p0/output",
			'type'      => 'jobs',
			'partition' => 0,
		];
		\mkdir( $ipc['input'], 0755, true );
		\mkdir( $ipc['output'], 0755, true );

		$ref = new \ReflectionMethod( CLI_Command::class, 'build_repl_graph' );
		$ref->setAccessible( true );

		[ , $dumper ] = $ref->invoke( new CLI_Command(), true, $ipc );

		// Reflect on the private field to confirm the filter is the current pid.
		$pid_prop = new \ReflectionProperty( $dumper, 'to_filter' );
		$pid_prop->setAccessible( true );
		$this->assertSame( (string) \getmypid(), $pid_prop->getValue( $dumper ) );

		Core::cleanup_all_nodes();
	}

	// ── prepare_repl ────────────────────────────────────────────────────────

	public function test_prepare_repl_bare_mode_sets_bare_status_line(): void {
		if ( \function_exists( 'posix_getuid' ) && 0 === \posix_getuid() ) {
			$this->markTestSkipped( 'prepare_repl WP_CLI::errors on root before reaching the bare-mode path' );
		}

		[ $shell, $dumper ] = ( new CLI_Command() )->prepare_repl( [] );

		$this->assertInstanceOf( \Newspack_Nodes\Shell_Node::class, $shell );
		$this->assertInstanceOf( \Newspack_Nodes\Dumper_Node::class, $dumper );
		// Bare mode emits exactly one status line — the "local nodes only"
		// banner. Pivoted mode emits three.
		$this->assertCount( 1, $shell->status_lines );
		$this->assertStringContainsString( 'Bare cli mode', $shell->status_lines[0] );

		Core::cleanup_all_nodes();
	}

	public function test_prepare_repl_pivoted_mode_stashes_ipc_paths_in_status_lines(): void {
		if ( \function_exists( 'posix_getuid' ) && 0 === \posix_getuid() ) {
			$this->markTestSkipped( 'prepare_repl WP_CLI::errors on root before reaching the pivoted-mode path' );
		}

		// attach_to_worker requires a lock dir under {base}/locks/{reader}.lock.d.
		// Mirror the on-disk shape `wp nodes ls` discovers.
		\mkdir( "{$this->tmp}/locks/jobs.p0.lock.d", 0755, true );

		[ $shell, $dumper ] = ( new CLI_Command() )->prepare_repl( [ 'jobs.p0' ] );

		// Pivoted mode banner: three lines including the input/output IPC paths.
		$this->assertCount( 3, $shell->status_lines );
		$this->assertStringContainsString( 'Pivoted-cli mode for jobs.p0', $shell->status_lines[0] );
		$this->assertStringContainsString( "{$this->tmp}/ipc/jobs.p0/input",  $shell->status_lines[1] );
		$this->assertStringContainsString( "{$this->tmp}/ipc/jobs.p0/output", $shell->status_lines[2] );

		Core::cleanup_all_nodes();
	}

	public function test_prepare_repl_translates_attach_failure_to_wp_cli_error(): void {
		if ( \function_exists( 'posix_getuid' ) && 0 === \posix_getuid() ) {
			$this->markTestSkipped( 'prepare_repl WP_CLI::errors on root before reaching the attach path' );
		}

		// No lock dir exists for `nope.p0`, so attach_to_worker throws
		// InvalidArgumentException; prepare_repl catches and re-emits via
		// WP_CLI::error (which the WPCLIStub turns into a RuntimeException).
		// Cli::attach_to_worker wraps the reader id in esc_html(), so the
		// apostrophes around `nope.p0` arrive HTML-encoded (`&#039;`).
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessageMatches( "/no worker &#039;nope\\.p0&#039;/" );

		( new CLI_Command() )->prepare_repl( [ 'nope.p0' ] );
	}

	// ── dispatch_line ─────────────────────────────

	public function test_dispatch_line_returns_false_for_empty_or_comment_lines(): void {
		// Lines that the Shell parser drops (empty, comments) report false
		// so the loop driver knows nothing was emitted.
		$cmd   = new CLI_Command();
		$shell = new \Newspack_Nodes\Shell_Node();
		$sink  = new \Newspack_Nodes\Tests\Capture_Sink_Node();
		$shell->sink( $sink );

		$this->assertFalse( $cmd->dispatch_line( $shell, '' ) );
		$this->assertFalse( $cmd->dispatch_line( $shell, '   ' ) );
		$this->assertFalse( $cmd->dispatch_line( $shell, '# this is a comment' ) );
		$this->assertCount( 0, $sink->captured );
	}

	public function test_dispatch_line_strips_trailing_newline_then_dispatches(): void {
		// fgets() leaves the trailing "\n" in the line. dispatch_line strips
		// it and forwards through the Shell. Sink sees one TM_COMMAND.
		$cmd   = new CLI_Command();
		$shell = new \Newspack_Nodes\Shell_Node();
		$sink  = new \Newspack_Nodes\Tests\Capture_Sink_Node();
		$shell->sink( $sink );

		$result = $cmd->dispatch_line( $shell, "ls -al\n" );

		$this->assertTrue( $result );
		$this->assertCount( 1, $sink->captured );
		$this->assertSame( \Newspack_Nodes\Message::TM_COMMAND, $sink->captured[0][ \Newspack_Nodes\Message::TYPE ] );
	}

	public function test_dispatch_line_handles_crlf(): void {
		// Windows-style line endings get stripped just like LF.
		$cmd   = new CLI_Command();
		$shell = new \Newspack_Nodes\Shell_Node();
		$sink  = new \Newspack_Nodes\Tests\Capture_Sink_Node();
		$shell->sink( $sink );

		$cmd->dispatch_line( $shell, "ls\r\n" );

		$this->assertCount( 1, $sink->captured );
		// Shell builds the command VALUE as a live PHP array — read directly.
		$decoded = $sink->captured[0][ \Newspack_Nodes\Message::VALUE ];
		$this->assertSame( 'ls', $decoded['name'] );
	}

	public function test_stdin_reader_dispatches_lines_from_injected_stream(): void {
		// Inject a memory stream pre-loaded with two complete lines + EOF.
		// Drain ticks consume one line each; after both are gone, the next
		// drain hits EOF and flips $exit.
		$cmd    = new CLI_Command();
		$shell  = new \Newspack_Nodes\Shell_Node();
		$dumper = new \Newspack_Nodes\Dumper_Node( \fopen( 'php://memory', 'w+' ) );
		$sink   = new \Newspack_Nodes\Tests\Capture_Sink_Node();
		$shell->sink( $sink );

		$stream = \fopen( 'php://memory', 'r+' );
		\fwrite( $stream, "ls\n" );
		\fwrite( $stream, "tell foo hi\n" );
		\rewind( $stream );

		$reader = new \Newspack_Nodes\CLI_Stdin_Reader_Node( $cmd, $shell, $dumper, false, $stream );

		// Tick 1 → line "ls\n".
		$reader->fire();
		$this->assertCount( 1, $sink->captured );
		$this->assertSame( \Newspack_Nodes\Message::TM_COMMAND, $sink->captured[0][ \Newspack_Nodes\Message::TYPE ] );
		$this->assertFalse( $reader->exit );

		// Tick 2 → "tell foo hi\n".
		$reader->fire();
		$this->assertCount( 2, $sink->captured );
		$this->assertSame( \Newspack_Nodes\Message::TM_INFO, $sink->captured[1][ \Newspack_Nodes\Message::TYPE ] );
		$this->assertFalse( $reader->exit );

		// Tick 3 → stdin EOF: reader emits TM_EOF and waits for the echo
		// (or the deadline) before flipping exit. So exit is still false
		// here — that's the round-trip drain pattern.
		$reader->fire();
		$this->assertCount( 3, $sink->captured, 'EOF tick adds a TM_EOF Message' );
		$this->assertSame( \Newspack_Nodes\Message::TM_EOF, $sink->captured[2][ \Newspack_Nodes\Message::TYPE ] );
		$this->assertFalse( $reader->exit );

		\fclose( $stream );
	}

	public function test_stdin_reader_fire_cb_drains_only_when_it_has_a_sink(): void {
		// Production drives the reader via the timer's fire_cb(), NOT fire() directly.
		// fire_cb() inherits Timer_Node's no-sink guard, so a sink-less reader never
		// reaches fire() and silently ignores stdin — the cli hangs on input. run_repl
		// sinks the reader into the interpreter to keep the drain alive.
		$cmd    = new CLI_Command();
		$shell  = new \Newspack_Nodes\Shell_Node();
		$dumper = new \Newspack_Nodes\Dumper_Node( \fopen( 'php://memory', 'w+' ) );
		$sink   = new \Newspack_Nodes\Tests\Capture_Sink_Node();
		$shell->sink( $sink );

		$stream = \fopen( 'php://memory', 'r+' );
		\fwrite( $stream, "ls\n" );
		\rewind( $stream );

		$reader = new \Newspack_Nodes\CLI_Stdin_Reader_Node( $cmd, $shell, $dumper, false, $stream );

		// No sink → fire_cb() short-circuits, the line is never drained.
		$reader->fire_cb();
		$this->assertCount( 0, $sink->captured, 'a sink-less reader ignores input via fire_cb()' );

		// Sunk into a node (as run_repl does) → fire_cb() reaches fire() and drains.
		$reader->sink( new \Newspack_Nodes\Tests\Capture_Sink_Node() );
		$reader->fire_cb();
		$this->assertCount( 1, $sink->captured, 'a sunk reader drains the queued line via fire_cb()' );
		$this->assertSame(
			\Newspack_Nodes\Message::TM_COMMAND,
			$sink->captured[0][ \Newspack_Nodes\Message::TYPE ]
		);

		\fclose( $stream );
	}

	public function test_stdin_reader_constructor_writes_initial_prompt_in_non_readline_mode(): void {
		// Non-readline mode shows a manual prompt at construction so the
		// user sees something before typing the first line. The write is
		// routed through Dumper::write_prompt, so a memory-stream Dumper
		// captures it and phpunit's real STDOUT stays clean.
		$cmd        = new CLI_Command();
		$shell      = new \Newspack_Nodes\Shell_Node();
		$shell->prompt = 'test-prompt> ';
		$out_stream = \fopen( 'php://memory', 'w+' );
		$dumper     = new \Newspack_Nodes\Dumper_Node( $out_stream );
		$stream     = \fopen( 'php://memory', 'r+' );

		new \Newspack_Nodes\CLI_Stdin_Reader_Node( $cmd, $shell, $dumper, false, $stream );

		$prop = new \ReflectionProperty( $dumper, 'prompt_displayed' );
		$prop->setAccessible( true );
		$this->assertTrue( $prop->getValue( $dumper ) );

		// Prompt content reached the dumper's stdout stream.
		\rewind( $out_stream );
		$this->assertSame( 'test-prompt> ', \stream_get_contents( $out_stream ) );

		\fclose( $stream );
	}

	public function test_stdin_reader_skips_prompt_when_show_prompts_false(): void {
		// When stdin is piped (not a TTY), prompts pollute the captured
		// output. The 6th constructor arg gates prompt display: false skips
		// both the initial prompt at construction time AND the per-line
		// prompt redraw in drain_fh's non-readline branch.
		$cmd        = new CLI_Command();
		$shell      = new \Newspack_Nodes\Shell_Node();
		$shell->prompt = 'should-not-appear> ';
		$out_stream = \fopen( 'php://memory', 'w+' );
		$dumper     = new \Newspack_Nodes\Dumper_Node( $out_stream );
		$sink       = new \Newspack_Nodes\Tests\Capture_Sink_Node();
		$shell->sink( $sink );

		$stream = \fopen( 'php://memory', 'r+' );
		\fwrite( $stream, "ls\n" );
		\rewind( $stream );

		// 6th arg: show_prompts=false.
		$reader = new \Newspack_Nodes\CLI_Stdin_Reader_Node( $cmd, $shell, $dumper, false, $stream, false );

		// Constructor must NOT have set the dumper's prompt-displayed flag
		// (no prompt was rendered).
		$prop = new \ReflectionProperty( $dumper, 'prompt_displayed' );
		$prop->setAccessible( true );
		$this->assertFalse( $prop->getValue( $dumper ) );

		// drain_fh processes the line and must not redraw a prompt either.
		$reader->fire();
		$this->assertCount( 1, $sink->captured );
		$this->assertFalse( $prop->getValue( $dumper ) );

		\fclose( $stream );
	}

	public function test_stdin_reader_eof_emits_tm_eof_through_shell_and_does_not_immediately_exit(): void {
		// On stdin EOF, the reader emits a TM_EOF Message through the Shell
		// (FROM=_output/$pid) instead of immediately flipping $exit. The
		// drain loop keeps running until the echo comes back — that's how we
		// know the worker has drained all preceding output and the IPC reply
		// partition has been read off. Without this, scripted cli sessions
		// race: stdin closes, cli exits, and pending replies never get
		// rendered.
		$cmd    = new CLI_Command();
		$shell  = new \Newspack_Nodes\Shell_Node();
		$sink   = new \Newspack_Nodes\Tests\Capture_Sink_Node();
		$shell->sink( $sink );
		$dumper = new \Newspack_Nodes\Dumper_Node( \fopen( 'php://memory', 'w+' ) );
		$stream = \fopen( 'php://memory', 'r+' ); // empty -> immediate EOF

		// show_prompts=false (we're simulating a piped session).
		$reader = new \Newspack_Nodes\CLI_Stdin_Reader_Node( $cmd, $shell, $dumper, false, $stream, false );
		$reader->fire();

		$this->assertCount( 1, $sink->captured, 'stdin EOF emits exactly one TM_EOF Message' );
		$this->assertSame( \Newspack_Nodes\Message::TM_EOF, $sink->captured[0][ \Newspack_Nodes\Message::TYPE ] );
		$this->assertStringContainsString( '_output/' . \getmypid(), $sink->captured[0][ \Newspack_Nodes\Message::FROM ] );
		$this->assertFalse( $reader->exit, 'reader does not exit until echo arrives or timeout fires' );

		// Second drain: stdin still EOF; reader must NOT re-emit. One TM_EOF
		// per session is the contract.
		$reader->fire();
		$this->assertCount( 1, $sink->captured, 'TM_EOF must not be re-emitted on subsequent ticks' );
		$this->assertFalse( $reader->exit );

		\fclose( $stream );
	}

	public function test_stdin_reader_eof_is_addressed_to_the_pivot_path_so_it_round_trips_through_the_worker(): void {
		// In pivoted mode the EOF marker must route TO the worker (shell->path),
		// not bounce off the local interpreter (empty TO). Routing it through the
		// worker means the echo can only come back AFTER the worker has drained
		// every preceding reply on the ordered IPC return partition — that's what
		// keeps a scripted `echo ls | wp nodes cli <worker>` from exiting before
		// its `ls` reply is rendered.
		$cmd            = new CLI_Command();
		$shell          = new \Newspack_Nodes\Shell_Node();
		$shell->path    = 'combined.p0';
		$sink           = new \Newspack_Nodes\Tests\Capture_Sink_Node();
		$shell->sink( $sink );
		$dumper = new \Newspack_Nodes\Dumper_Node( \fopen( 'php://memory', 'w+' ) );
		$stream = \fopen( 'php://memory', 'r+' ); // empty -> immediate EOF

		$reader = new \Newspack_Nodes\CLI_Stdin_Reader_Node( $cmd, $shell, $dumper, false, $stream, false );
		$reader->fire();

		$this->assertCount( 1, $sink->captured );
		$this->assertSame( \Newspack_Nodes\Message::TM_EOF, $sink->captured[0][ \Newspack_Nodes\Message::TYPE ] );
		$this->assertSame( 'combined.p0', $sink->captured[0][ \Newspack_Nodes\Message::TO ] );

		\fclose( $stream );
	}

	public function test_stdin_reader_exits_when_dumper_signals_eof_echo(): void {
		// Cli wires Dumper's on_eof to flip the reader's exit flag. After
		// stdin EOF (the reader has emitted TM_EOF and is waiting), the echo
		// arrives, Dumper fires the callback, and the next drain loop tick
		// terminates.
		$cmd    = new CLI_Command();
		$shell  = new \Newspack_Nodes\Shell_Node();
		$shell->sink( new \Newspack_Nodes\Tests\Capture_Sink_Node() );
		$dumper = new \Newspack_Nodes\Dumper_Node( \fopen( 'php://memory', 'w+' ) );
		$stream = \fopen( 'php://memory', 'r+' );

		$reader = new \Newspack_Nodes\CLI_Stdin_Reader_Node( $cmd, $shell, $dumper, false, $stream, false );
		$dumper->on_eof( function () use ( $reader ) { $reader->exit = true; } );

		$reader->fire(); // hit stdin EOF, emit TM_EOF, wait
		$this->assertFalse( $reader->exit );

		// Simulate the worker's echo arriving: feed a TM_EOF through the
		// dumper directly. The callback fires, exit flips.
		$echo                  = \Newspack_Nodes\Message::new_message();
		$echo[ \Newspack_Nodes\Message::TYPE ] = \Newspack_Nodes\Message::TM_EOF;
		$dumper->fill( $echo );

		$this->assertTrue( $reader->exit );
		\fclose( $stream );
	}

	public function test_stdin_reader_exits_after_eof_deadline_when_no_echo_arrives(): void {
		// Fallback for a dead worker (or bare mode where the round-trip is
		// synchronous-but-still-need-bounded-wait): if no echo arrives
		// within $eof_deadline_s, the reader gives up and exits anyway.
		// Tests verify the deadline-based exit; production wires a 5s
		// deadline (configurable per session).
		$cmd    = new CLI_Command();
		$shell  = new \Newspack_Nodes\Shell_Node();
		$shell->sink( new \Newspack_Nodes\Tests\Capture_Sink_Node() );
		$dumper = new \Newspack_Nodes\Dumper_Node( \fopen( 'php://memory', 'w+' ) );
		$stream = \fopen( 'php://memory', 'r+' );

		// 0-second deadline → drain_fh sees stdin EOF, emits TM_EOF, then
		// the next tick notices "deadline elapsed" and exits.
		$reader = new \Newspack_Nodes\CLI_Stdin_Reader_Node( $cmd, $shell, $dumper, false, $stream, false, 0.0 );

		$reader->fire(); // emit TM_EOF
		$this->assertFalse( $reader->exit );
		\usleep( 1000 );      // ensure clock advanced past deadline
		$reader->fire(); // notice deadline, exit
		$this->assertTrue( $reader->exit );

		\fclose( $stream );
	}

	public function test_stdin_reader_default_readline_install_closure_calls_real_libreadline(): void {
		// bootstrap.php no-ops $readline_handler_install for every test so a
		// phpunit-in-a-terminal run doesn't write `prompt> ` to fd 1. That
		// leaves the default closure (which wraps the real libreadline call)
		// uncovered. Drop the seam to null here, drive install_handler() via
		// a fresh reader, then restore the bootstrap stub so subsequent tests
		// stay clean.
		if ( ! \function_exists( 'readline_callback_handler_install' ) ) {
			$this->markTestSkipped( 'readline extension not available' );
		}
		$cmd    = new CLI_Command();
		$shell  = new \Newspack_Nodes\Shell_Node();
		$dumper = new \Newspack_Nodes\Dumper_Node( \fopen( 'php://memory', 'w+' ) );
		$stream = \fopen( 'php://memory', 'r+' );
		$shell->sink( new \Newspack_Nodes\Tests\Capture_Sink_Node() );

		$saved = \Newspack_Nodes\CLI_Stdin_Reader_Node::$readline_handler_install;
		\Newspack_Nodes\CLI_Stdin_Reader_Node::$readline_handler_install = null;
		try {
			$reader = new \Newspack_Nodes\CLI_Stdin_Reader_Node( $cmd, $shell, $dumper, true, $stream );

			// Defensive: real readline write went to fd 1; we only need to
			// know the default closure ran (no exception, prompt_displayed
			// flipped via mark_prompt_displayed at the tail of install_handler).
			$prop = new \ReflectionProperty( $dumper, 'prompt_displayed' );
			$prop->setAccessible( true );
			$this->assertTrue( $prop->getValue( $dumper ) );
			$this->assertFalse( $reader->exit );
		} finally {
			@\readline_callback_handler_remove();
			\Newspack_Nodes\CLI_Stdin_Reader_Node::$readline_handler_install = $saved;
			\fclose( $stream );
		}
	}

	public function test_stdin_reader_default_readline_read_char_closure_calls_real_libreadline(): void {
		// As above, but for $readline_read_char's default closure (line 583-584
		// of class-cli-command.php). Driving fire() with null seam executes the
		// real readline_callback_read_char which reads one byte from STDIN —
		// non-blocking because stream_select sees no data on the memory stream
		// path (the inline try/catch covers ValueError on un-selectable streams).
		if ( ! \function_exists( 'readline_callback_read_char' ) ) {
			$this->markTestSkipped( 'readline extension not available' );
		}
		$cmd    = new CLI_Command();
		$shell  = new \Newspack_Nodes\Shell_Node();
		$dumper = new \Newspack_Nodes\Dumper_Node( \fopen( 'php://memory', 'w+' ) );
		$stream = \fopen( 'php://memory', 'r+' );
		$shell->sink( new \Newspack_Nodes\Tests\Capture_Sink_Node() );

		\Newspack_Nodes\Event_Framework::reset();

		$saved_install = \Newspack_Nodes\CLI_Stdin_Reader_Node::$readline_handler_install;
		$saved_read    = \Newspack_Nodes\CLI_Stdin_Reader_Node::$readline_read_char;
		// install_handler stays stubbed (real one writes to fd 1); only
		// read_char goes back to the real libreadline.
		\Newspack_Nodes\CLI_Stdin_Reader_Node::$readline_handler_install = static function ( string $prompt, callable $cb ): void {};
		\Newspack_Nodes\CLI_Stdin_Reader_Node::$readline_read_char       = null;

		try {
			$reader = new \Newspack_Nodes\CLI_Stdin_Reader_Node( $cmd, $shell, $dumper, true, $stream );

			// fire() will reach the default read_char closure if stream_select
			// reports any readiness on the memory stream. Even when stream_select
			// returns 0, the catch block forces $ready=1 on ValueError. Either
			// way the default closure executes — that's the line we want.
			$reader->fire();

			// Default closure ran without throwing; the test passes if we got
			// here. No further behavior to assert — the seam is what we're
			// proving works end-to-end.
			$this->assertFalse( $reader->exit );
		} finally {
			\Newspack_Nodes\CLI_Stdin_Reader_Node::$readline_handler_install = $saved_install;
			\Newspack_Nodes\CLI_Stdin_Reader_Node::$readline_read_char       = $saved_read;
			\fclose( $stream );
		}
	}

	public function test_stdin_reader_readline_mode_installs_handler_and_marks_prompt(): void {
		// has_readline=true → constructor calls install_handler() which in
		// turn calls readline_callback_handler_install() and marks the
		// dumper's prompt as on-screen. Tests just verify the side effects
		// since the per-byte readline-feed needs a real TTY.
		if ( ! \function_exists( 'readline_callback_handler_install' ) ) {
			$this->markTestSkipped( 'readline extension not available' );
		}
		$cmd    = new CLI_Command();
		$shell  = new \Newspack_Nodes\Shell_Node();
		$dumper = new \Newspack_Nodes\Dumper_Node( \fopen( 'php://memory', 'w+' ) );
		$stream = \fopen( 'php://memory', 'r+' );
		$shell->sink( new \Newspack_Nodes\Tests\Capture_Sink_Node() );

		try {
			$reader = new \Newspack_Nodes\CLI_Stdin_Reader_Node( $cmd, $shell, $dumper, true, $stream );

			$prop = new \ReflectionProperty( $dumper, 'prompt_displayed' );
			$prop->setAccessible( true );
			$this->assertTrue( $prop->getValue( $dumper ) );
			$this->assertFalse( $reader->exit );
		} finally {
			// Clean up the global readline handler so it doesn't leak into
			// subsequent tests.
			@\readline_callback_handler_remove();
			\fclose( $stream );
		}
	}

	public function test_stdin_reader_non_readline_subsequent_drain_keeps_prompt_displayed(): void {
		// After the first line is processed, drain_fh re-shows the prompt.
		// Calling show_prompt_fallback again is a no-op (prompt_displayed
		// already true) — that's the ~1-line early-return branch.
		$cmd    = new CLI_Command();
		$shell  = new \Newspack_Nodes\Shell_Node();
		$dumper = new \Newspack_Nodes\Dumper_Node( \fopen( 'php://memory', 'w+' ) );
		$sink   = new \Newspack_Nodes\Tests\Capture_Sink_Node();
		$shell->sink( $sink );
		$stream = \fopen( 'php://memory', 'r+' );
		\fwrite( $stream, "ls\n" );
		\rewind( $stream );

		$reader = new \Newspack_Nodes\CLI_Stdin_Reader_Node( $cmd, $shell, $dumper, false, $stream );

		// Reach into the reader and verify the prompt-displayed flag flips
		// off when fgets returns a line, then back on after show_prompt_
		// fallback runs at the end of drain_fh.
		$prop = new \ReflectionProperty( $reader, 'prompt_displayed' );
		$prop->setAccessible( true );

		// Initial state from constructor: prompt is showing.
		$this->assertTrue( $prop->getValue( $reader ) );

		// First drain processes the line; show_prompt_fallback redraws.
		$reader->fire();
		$this->assertCount( 1, $sink->captured );
		$this->assertTrue( $prop->getValue( $reader ), 'prompt should be re-shown after a processed line' );

		\fclose( $stream );
	}

	public function test_stdin_reader_handle_readline_line_with_null_sets_eof(): void {
		// readline delivers null on Ctrl-D / EOF. The callback flips the
		// reader's internal eof flag so the next drain tick exits.
		$cmd    = new CLI_Command();
		$shell  = new \Newspack_Nodes\Shell_Node();
		$dumper = new \Newspack_Nodes\Dumper_Node( \fopen( 'php://memory', 'w+' ) );
		$reader = new \Newspack_Nodes\CLI_Stdin_Reader_Node( $cmd, $shell, $dumper, false, \fopen( 'php://memory', 'r+' ) );

		$reader->handle_readline_line( null );

		$prop = new \ReflectionProperty( $reader, 'readline_eof' );
		$prop->setAccessible( true );
		$this->assertTrue( $prop->getValue( $reader ) );
	}

	public function test_stdin_reader_handle_readline_line_queues_and_clears_prompt(): void {
		// Non-null line → goes into the queue, clears the dumper's
		// prompt_displayed flag so subsequent synchronous output writes
		// plainly rather than doing the async wipe-and-redisplay dance.
		$cmd    = new CLI_Command();
		$shell  = new \Newspack_Nodes\Shell_Node();
		$dumper = new \Newspack_Nodes\Dumper_Node( \fopen( 'php://memory', 'w+' ) );
		$dumper->mark_prompt_displayed();
		$reader = new \Newspack_Nodes\CLI_Stdin_Reader_Node( $cmd, $shell, $dumper, false, \fopen( 'php://memory', 'r+' ) );

		$reader->handle_readline_line( 'ls -al' );

		$queue = new \ReflectionProperty( $reader, 'queue' );
		$queue->setAccessible( true );
		$this->assertSame( [ 'ls -al' ], $queue->getValue( $reader ) );

		$displayed = new \ReflectionProperty( $dumper, 'prompt_displayed' );
		$displayed->setAccessible( true );
		$this->assertFalse( $displayed->getValue( $dumper ) );
	}

	public function test_stdin_reader_handle_readline_line_skips_history_for_empty_string(): void {
		// readline_add_history is a no-op for empty input — the command
		// only adds non-empty lines to history. Verify the queue still
		// receives the empty string (so the loop sees the user's bare-
		// enter as a "no command" signal it can drop).
		$cmd    = new CLI_Command();
		$shell  = new \Newspack_Nodes\Shell_Node();
		$dumper = new \Newspack_Nodes\Dumper_Node( \fopen( 'php://memory', 'w+' ) );
		$reader = new \Newspack_Nodes\CLI_Stdin_Reader_Node( $cmd, $shell, $dumper, false, \fopen( 'php://memory', 'r+' ) );

		$reader->handle_readline_line( '' );

		$queue = new \ReflectionProperty( $reader, 'queue' );
		$queue->setAccessible( true );
		$this->assertSame( [ '' ], $queue->getValue( $reader ) );
	}

	public function test_stdin_reader_readline_drain_fh_with_no_bytes_is_a_noop(): void {
		// readline_callback_read_char() returns immediately when no bytes
		// are pending. The queue stays empty, exit stays false.
		if ( ! \function_exists( 'readline_callback_handler_install' ) ) {
			$this->markTestSkipped( 'readline extension not available' );
		}
		$cmd    = new CLI_Command();
		$shell  = new \Newspack_Nodes\Shell_Node();
		$dumper = new \Newspack_Nodes\Dumper_Node( \fopen( 'php://memory', 'w+' ) );
		$sink   = new \Newspack_Nodes\Tests\Capture_Sink_Node();
		$shell->sink( $sink );
		$stream = \fopen( 'php://memory', 'r+' );

		try {
			$reader = new \Newspack_Nodes\CLI_Stdin_Reader_Node( $cmd, $shell, $dumper, true, $stream );
			$reader->fire();

			$this->assertFalse( $reader->exit );
			$this->assertCount( 0, self::non_completion( $sink->captured ) );
		} finally {
			@\readline_callback_handler_remove();
			\fclose( $stream );
		}
	}

	// ── prepare_repl ──────────────────────────────────────────────────────

	public function test_prepare_repl_bare_mode_populates_status_lines_and_returns_shell_and_dumper(): void {
		// No args → bare mode. The mode summary is stashed on
		// $shell->status_lines for the `status` builtin to render on demand;
		// it's no longer auto-logged at startup (would pollute scripted
		// captures). Verify the lines are populated and the bare prompt
		// stays default. Root guard short-circuits before this branch.
		if ( \function_exists( 'posix_getuid' ) && 0 === \posix_getuid() ) {
			$this->markTestSkipped( 'prepare_repl bare branch only reachable when test user is non-root' );
		}
		$cmd = new CLI_Command();
		[ $shell, $dumper ] = $cmd->prepare_repl( [] );

		$this->assertInstanceOf( \Newspack_Nodes\Shell_Node::class, $shell );
		$this->assertInstanceOf( \Newspack_Nodes\Dumper_Node::class, $dumper );
		$this->assertSame( [ 'Bare cli mode (local nodes only).' ], $shell->status_lines );
		// Banner is no longer auto-logged.
		$this->assertNotContains( 'Bare cli mode (local nodes only).', $GLOBALS['_test_wp_cli_logs'] );
		// Bare mode keeps the default prompt.
		$this->assertSame( '/> ', $shell->prompt );

		Core::cleanup_all_nodes();
	}

	public function test_prepare_repl_pivoted_mode_populates_status_lines_and_sets_prompt(): void {
		// Reader-id arg → pivoted mode. The mode line and IPC paths land in
		// $shell->status_lines (renderable via the `status` builtin), the
		// prompt is rewritten to identify the target, and the previous
		// auto-banner is no longer emitted.
		if ( \function_exists( 'posix_getuid' ) && 0 === \posix_getuid() ) {
			$this->markTestSkipped( 'prepare_repl pivoted branch only reachable when test user is non-root' );
		}
		\mkdir( "{$this->tmp}/locks/firehose-workers.p0.lock.d", 0755, true );
		\mkdir( "{$this->tmp}/ipc/firehose-workers.p0/input", 0755, true );
		\mkdir( "{$this->tmp}/ipc/firehose-workers.p0/output", 0755, true );

		$cmd = new CLI_Command();
		[ $shell, $dumper ] = $cmd->prepare_repl( [ 'firehose-workers.p0' ] );

		$this->assertCount( 3, $shell->status_lines );
		$this->assertSame( 'Pivoted-cli mode for firehose-workers.p0', $shell->status_lines[0] );
		$this->assertStringContainsString( 'input  partition', $shell->status_lines[1] );
		$this->assertStringContainsString( 'output partition', $shell->status_lines[2] );
		$this->assertSame( '/firehose-workers.p0> ', $shell->prompt );
		// Banner is no longer auto-logged.
		$this->assertNotContains( 'Pivoted-cli mode for firehose-workers.p0', $GLOBALS['_test_wp_cli_logs'] );

		Core::cleanup_all_nodes();
	}

	public function test_prepare_repl_invalid_reader_id_calls_WP_CLI_error(): void {
		// Bad reader-id throws InvalidArgumentException from
		// Cli::attach_to_worker → WP_CLI::error → test stub throws.
		// Skip when the test runner is root — prepare_repl's root guard
		// short-circuits before reaching the reader-id validation. Covered
		// by `test_cli_refuses_to_run_as_root` instead.
		if ( \function_exists( 'posix_getuid' ) && 0 === \posix_getuid() ) {
			$this->markTestSkipped( 'reader-id branch only reachable when test user is non-root' );
		}
		$cmd = new CLI_Command();
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessageMatches( '/invalid reader id/' );
		$cmd->prepare_repl( [ 'no-partition-suffix' ] );
	}

	public function test_prepare_repl_unknown_worker_calls_WP_CLI_error(): void {
		// Parseable reader-id but no lock dir → attach_to_worker throws
		// "no worker ..." → WP_CLI::error → test stub throws RuntimeException.
		// Without this guard the cli would silently create ghost IPC dirs.
		// Skip under root for the same reason as the sibling test above.
		if ( \function_exists( 'posix_getuid' ) && 0 === \posix_getuid() ) {
			$this->markTestSkipped( 'unknown-worker branch only reachable when test user is non-root' );
		}
		$cmd = new CLI_Command();
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessageMatches( '/no worker.*typo\.p0/' );
		$cmd->prepare_repl( [ 'typo.p0' ] );
	}

	public function test_stdin_reader_fire_rearms_at_eof_poll_after_eof_sent(): void {
		// Spec: after fire() emits TM_EOF (stdin closed), subsequent fire()
		// ticks re-arm at EOF_POLL_MS=10 — tight enough to notice deadline /
		// echo, light enough to leave CPU for other timers in the meantime.
		$cmd    = new CLI_Command();
		$shell  = new \Newspack_Nodes\Shell_Node();
		$shell->sink( new \Newspack_Nodes\Tests\Capture_Sink_Node() );
		$dumper = new \Newspack_Nodes\Dumper_Node( \fopen( 'php://memory', 'w+' ) );
		$stream = \fopen( 'php://memory', 'r+' );

		\Newspack_Nodes\Event_Framework::reset();

		// Generous deadline so the deadline-elapsed branch doesn't flip exit
		// in this single fire(); we're isolating the EOF_POLL_MS re-arm.
		$reader = new \Newspack_Nodes\CLI_Stdin_Reader_Node( $cmd, $shell, $dumper, false, $stream, false, 60.0 );

		$reader->fire(); // empty memory stream → feof=true → send_eof_marker

		$ef       = \Newspack_Nodes\Event_Framework::instance();
		$ef_ref   = new \ReflectionClass( $ef );
		$timers_p = $ef_ref->getProperty( 'timers' );
		$timers_p->setAccessible( true );
		$timers   = $timers_p->getValue( $ef );
		$id       = \spl_object_id( $reader );
		$this->assertArrayHasKey( $id, $timers, 'reader must register a timer' );
		$this->assertSame(
			10,
			$timers[ $id ]->interval_ms,
			'after EOF emit, re-arm uses EOF_POLL_MS=10'
		);

		\fclose( $stream );
	}

	public function test_stdin_reader_fire_rearms_at_busy_poll_after_delivered_line(): void {
		// Spec: fire() with a delivered line re-arms at BUSY_POLL_MS=0 so the
		// next event-loop iteration drains the next line ASAP — critical for
		// piped-stdin throughput where the kernel has many lines buffered.
		$cmd    = new CLI_Command();
		$shell  = new \Newspack_Nodes\Shell_Node();
		$dumper = new \Newspack_Nodes\Dumper_Node( \fopen( 'php://memory', 'w+' ) );
		$sink   = new \Newspack_Nodes\Tests\Capture_Sink_Node();
		$shell->sink( $sink );

		$stream = \fopen( 'php://memory', 'r+' );
		\fwrite( $stream, "ls\n" );
		\rewind( $stream );

		\Newspack_Nodes\Event_Framework::reset();
		$reader = new \Newspack_Nodes\CLI_Stdin_Reader_Node( $cmd, $shell, $dumper, false, $stream, false );

		$reader->fire();

		$ef       = \Newspack_Nodes\Event_Framework::instance();
		$ef_ref   = new \ReflectionClass( $ef );
		$timers_p = $ef_ref->getProperty( 'timers' );
		$timers_p->setAccessible( true );
		$timers   = $timers_p->getValue( $ef );
		$id       = \spl_object_id( $reader );

		$this->assertArrayHasKey( $id, $timers );
		$this->assertSame( 0, $timers[ $id ]->interval_ms, 'delivered line re-arms at BUSY_POLL_MS=0' );

		\fclose( $stream );
	}

	public function test_stdin_reader_fire_does_not_rearm_when_exit_already_flipped(): void {
		// Spec: the exit check before re-arm means a fire() that emits TM_EOF
		// AND has its exit flipped (deadline elapsed, or echo received) MUST
		// NOT re-arm the timer. Otherwise the drain loop would spin one more
		// iteration after exit conditions met.
		$cmd    = new CLI_Command();
		$shell  = new \Newspack_Nodes\Shell_Node();
		$shell->sink( new \Newspack_Nodes\Tests\Capture_Sink_Node() );
		$dumper = new \Newspack_Nodes\Dumper_Node( \fopen( 'php://memory', 'w+' ) );
		$stream = \fopen( 'php://memory', 'r+' );

		// 0s deadline → fire() emits TM_EOF, then next fire() flips exit.
		$reader = new \Newspack_Nodes\CLI_Stdin_Reader_Node( $cmd, $shell, $dumper, false, $stream, false, 0.0 );

		$reader->fire(); // emit TM_EOF, sets eof_deadline_at = now (0s deadline)
		\usleep( 1000 );  // advance clock past deadline

		// Reset EventFramework right before fire #2 so any timer it registers
		// is the ONLY one we'd see. The deadline-elapsed branch should return
		// before set_timer() — so the registry must remain empty.
		\Newspack_Nodes\Event_Framework::reset();

		$reader->fire(); // deadline check fires, $exit=true, early return

		$this->assertTrue( $reader->exit );

		$ef       = \Newspack_Nodes\Event_Framework::instance();
		$ef_ref   = new \ReflectionClass( $ef );
		$timers_p = $ef_ref->getProperty( 'timers' );
		$timers_p->setAccessible( true );
		$timers   = $timers_p->getValue( $ef );
		$id       = \spl_object_id( $reader );
		$this->assertArrayNotHasKey(
			$id,
			$timers,
			'exit-flipped fire() must not re-arm the timer'
		);

		\fclose( $stream );
	}

	public function test_stdin_reader_readline_mode_fire_processes_queued_lines_and_reinstalls_handler(): void {
		// Readline mode: tests bootstrap stubs $readline_handler_install and
		// $readline_read_char to no-ops. Manually inject a line into the
		// queue, fire(), and verify:
		//   1. The line goes through dispatch_line (sink sees a Message).
		//   2. install_handler is re-called after delivery — verified by
		//      hooking the closure to count invocations.
		$cmd    = new CLI_Command();
		$shell  = new \Newspack_Nodes\Shell_Node();
		$dumper = new \Newspack_Nodes\Dumper_Node( \fopen( 'php://memory', 'w+' ) );
		$sink   = new \Newspack_Nodes\Tests\Capture_Sink_Node();
		$shell->sink( $sink );
		$stream = \fopen( 'php://memory', 'r+' );

		\Newspack_Nodes\Event_Framework::reset();

		$install_calls = 0;
		$saved_install = \Newspack_Nodes\CLI_Stdin_Reader_Node::$readline_handler_install;
		$saved_read    = \Newspack_Nodes\CLI_Stdin_Reader_Node::$readline_read_char;
		\Newspack_Nodes\CLI_Stdin_Reader_Node::$readline_handler_install = static function ( string $prompt, callable $cb ) use ( &$install_calls ): void {
			++$install_calls;
		};
		// read_char is no-op (no line consumed). We pre-seed the queue.
		\Newspack_Nodes\CLI_Stdin_Reader_Node::$readline_read_char = static function (): void {};

		try {
			$reader = new \Newspack_Nodes\CLI_Stdin_Reader_Node( $cmd, $shell, $dumper, true, $stream );

			$this->assertSame( 1, $install_calls, 'constructor installs the handler once' );

			// Inject a queued line and fire — fire() will dispatch it, then re-install.
			$queue_prop = new \ReflectionProperty( $reader, 'queue' );
			$queue_prop->setAccessible( true );
			$queue_prop->setValue( $reader, [ 'ls' ] );

			$reader->fire();

			// Sink got the dispatched message (ignore the constructor's seed queries).
			$dispatched = self::non_completion( $sink->captured );
			$this->assertCount( 1, $dispatched, 'queued line must be dispatched on fire()' );
			$this->assertSame(
				\Newspack_Nodes\Message::TM_COMMAND,
				$dispatched[0][ \Newspack_Nodes\Message::TYPE ]
			);
			// Handler re-installed after the dispatch (so the next prompt renders).
			$this->assertSame( 2, $install_calls, 'fire() re-installs handler after delivered line' );
		} finally {
			\Newspack_Nodes\CLI_Stdin_Reader_Node::$readline_handler_install = $saved_install;
			\Newspack_Nodes\CLI_Stdin_Reader_Node::$readline_read_char       = $saved_read;
			\fclose( $stream );
		}
	}

	// ── tab-completion candidate cache ────────────────────────────────────────

	public function test_build_completion_query_help_parses_to_pivot_command_with_completion_key(): void {
		// A completion query is a bytestream verb ('help') tagged KEY='completion'.
		// Filling it through the Shell parses it into a TM_COMMAND that inherits
		// the completion KEY plus FROM=_output/$pid, LOCAL, and the pivot TO.
		$cmd    = new CLI_Command();
		$shell  = new \Newspack_Nodes\Shell_Node();
		$shell->path = 'firehose-workers.p0';
		$sink   = new \Newspack_Nodes\Tests\Capture_Sink_Node();
		$shell->sink( $sink );
		$dumper = new \Newspack_Nodes\Dumper_Node( \fopen( 'php://memory', 'w+' ) );
		$reader = new \Newspack_Nodes\CLI_Stdin_Reader_Node( $cmd, $shell, $dumper, false, \fopen( 'php://memory', 'r+' ) );

		$query = $reader->build_completion_query( 'help' );
		$this->assertSame( \Newspack_Nodes\Message::TM_BYTESTREAM, $query[ \Newspack_Nodes\Message::TYPE ] );
		$this->assertSame( 'completion', $query[ \Newspack_Nodes\Message::KEY ] );
		$this->assertSame( 'help', $query[ \Newspack_Nodes\Message::VALUE ] );

		$shell->fill( $query );

		$this->assertCount( 1, $sink->captured );
		$out = $sink->captured[0];
		$this->assertSame( 'help', $out[ \Newspack_Nodes\Message::VALUE ]['name'] );
		$this->assertSame( 'completion', $out[ \Newspack_Nodes\Message::KEY ] );
		$this->assertSame( 'firehose-workers.p0', $out[ \Newspack_Nodes\Message::TO ] );
		$this->assertStringContainsString( '_output/' . \getmypid(), $out[ \Newspack_Nodes\Message::FROM ] );
		$this->assertTrue( $out[ \Newspack_Nodes\Message::LOCAL ] ?? false );
	}

	public function test_build_completion_query_ls_parses_to_local_command_with_completion_key(): void {
		// The node-name query is the `ls` verb tagged KEY='completion'. In bare
		// mode (empty pivot path) the parsed command routes to the local
		// interpreter (empty TO).
		$cmd    = new CLI_Command();
		$shell  = new \Newspack_Nodes\Shell_Node();
		$sink   = new \Newspack_Nodes\Tests\Capture_Sink_Node();
		$shell->sink( $sink );
		$dumper = new \Newspack_Nodes\Dumper_Node( \fopen( 'php://memory', 'w+' ) );
		$reader = new \Newspack_Nodes\CLI_Stdin_Reader_Node( $cmd, $shell, $dumper, false, \fopen( 'php://memory', 'r+' ) );

		$query = $reader->build_completion_query( 'ls' );
		$this->assertSame( \Newspack_Nodes\Message::TM_BYTESTREAM, $query[ \Newspack_Nodes\Message::TYPE ] );
		$this->assertSame( 'ls', $query[ \Newspack_Nodes\Message::VALUE ] );

		$shell->fill( $query );

		$this->assertCount( 1, $sink->captured );
		$out = $sink->captured[0];
		$this->assertSame( 'ls', $out[ \Newspack_Nodes\Message::VALUE ]['name'] );
		$this->assertSame( 'completion', $out[ \Newspack_Nodes\Message::KEY ] );
		// Bare mode: empty pivot path → empty TO (local interpreter).
		$this->assertSame( '', $out[ \Newspack_Nodes\Message::TO ] );
	}

	public function test_ingest_completion_reply_fills_command_cache_from_help(): void {
		// A help-completion reply (bare newline list) populates the command
		// candidate cache and is consumed (returns true → Dumper won't print).
		$cmd    = new CLI_Command();
		$shell  = new \Newspack_Nodes\Shell_Node();
		$dumper = new \Newspack_Nodes\Dumper_Node( \fopen( 'php://memory', 'w+' ) );
		$reader = new \Newspack_Nodes\CLI_Stdin_Reader_Node( $cmd, $shell, $dumper, false, \fopen( 'php://memory', 'r+' ) );

		$reply                                   = \Newspack_Nodes\Message::new_message();
		$reply[ \Newspack_Nodes\Message::TYPE ]  = \Newspack_Nodes\Message::TM_COMMAND | \Newspack_Nodes\Message::TM_RESPONSE;
		$reply[ \Newspack_Nodes\Message::KEY ]   = 'completion';
		$reply[ \Newspack_Nodes\Message::VALUE ] = [
			'name'    => 'help',
			'payload' => "cd\nhelp\nlist_nodes\nmake_node",
		];

		$consumed = $reader->ingest_completion_reply( $reply );

		$this->assertTrue( $consumed );
		$this->assertSame( [ 'cd', 'help', 'list_nodes', 'make_node' ], $reader->command_candidates() );
		$this->assertSame( [], $reader->node_candidates(), 'node cache untouched by a help reply' );
	}

	public function test_ingest_completion_reply_fills_node_cache_from_ls(): void {
		// An ls-completion reply populates the node candidate cache.
		$cmd    = new CLI_Command();
		$shell  = new \Newspack_Nodes\Shell_Node();
		$dumper = new \Newspack_Nodes\Dumper_Node( \fopen( 'php://memory', 'w+' ) );
		$reader = new \Newspack_Nodes\CLI_Stdin_Reader_Node( $cmd, $shell, $dumper, false, \fopen( 'php://memory', 'r+' ) );

		$reply                                   = \Newspack_Nodes\Message::new_message();
		$reply[ \Newspack_Nodes\Message::TYPE ]  = \Newspack_Nodes\Message::TM_COMMAND | \Newspack_Nodes\Message::TM_RESPONSE;
		$reply[ \Newspack_Nodes\Message::KEY ]   = 'completion';
		$reply[ \Newspack_Nodes\Message::VALUE ] = [
			'name'    => 'ls',
			'payload' => "_router\nfirehose-in\nrequest-builder",
		];

		$consumed = $reader->ingest_completion_reply( $reply );

		$this->assertTrue( $consumed );
		$this->assertSame( [ '_router', 'firehose-in', 'request-builder' ], $reader->node_candidates() );
	}

	public function test_ingest_completion_reply_replaces_cache_on_refresh(): void {
		// A second reply for the same verb replaces (not appends to) the cache —
		// nodes come and go.
		$cmd    = new CLI_Command();
		$shell  = new \Newspack_Nodes\Shell_Node();
		$dumper = new \Newspack_Nodes\Dumper_Node( \fopen( 'php://memory', 'w+' ) );
		$reader = new \Newspack_Nodes\CLI_Stdin_Reader_Node( $cmd, $shell, $dumper, false, \fopen( 'php://memory', 'r+' ) );

		$make = function ( string $payload ): array {
			$m                                   = \Newspack_Nodes\Message::new_message();
			$m[ \Newspack_Nodes\Message::TYPE ]  = \Newspack_Nodes\Message::TM_COMMAND | \Newspack_Nodes\Message::TM_RESPONSE;
			$m[ \Newspack_Nodes\Message::KEY ]   = 'completion';
			$m[ \Newspack_Nodes\Message::VALUE ] = [ 'name' => 'ls', 'payload' => $payload ];
			return $m;
		};

		$reader->ingest_completion_reply( $make( "a\nb" ) );
		$reader->ingest_completion_reply( $make( "c\nd\ne" ) );

		$this->assertSame( [ 'c', 'd', 'e' ], $reader->node_candidates() );
	}

	public function test_ingest_completion_reply_ignores_non_completion_messages(): void {
		// A normal command reply (no KEY='completion') is NOT consumed — the
		// Dumper must still render it.
		$cmd    = new CLI_Command();
		$shell  = new \Newspack_Nodes\Shell_Node();
		$dumper = new \Newspack_Nodes\Dumper_Node( \fopen( 'php://memory', 'w+' ) );
		$reader = new \Newspack_Nodes\CLI_Stdin_Reader_Node( $cmd, $shell, $dumper, false, \fopen( 'php://memory', 'r+' ) );

		$reply                                   = \Newspack_Nodes\Message::new_message();
		$reply[ \Newspack_Nodes\Message::TYPE ]  = \Newspack_Nodes\Message::TM_COMMAND | \Newspack_Nodes\Message::TM_RESPONSE;
		$reply[ \Newspack_Nodes\Message::VALUE ] = [ 'name' => 'ls', 'payload' => "n1\nn2" ];

		$this->assertFalse( $reader->ingest_completion_reply( $reply ) );
		$this->assertSame( [], $reader->node_candidates() );
	}

	public function test_complete_first_token_filters_command_candidates(): void {
		// At index 0 (first word on the line), completion offers command names
		// whose prefix matches the typed word.
		$cmd    = new CLI_Command();
		$shell  = new \Newspack_Nodes\Shell_Node();
		$dumper = new \Newspack_Nodes\Dumper_Node( \fopen( 'php://memory', 'w+' ) );
		$reader = new \Newspack_Nodes\CLI_Stdin_Reader_Node( $cmd, $shell, $dumper, false, \fopen( 'php://memory', 'r+' ) );

		$help                                   = \Newspack_Nodes\Message::new_message();
		$help[ \Newspack_Nodes\Message::TYPE ]  = \Newspack_Nodes\Message::TM_COMMAND | \Newspack_Nodes\Message::TM_RESPONSE;
		$help[ \Newspack_Nodes\Message::KEY ]   = 'completion';
		$help[ \Newspack_Nodes\Message::VALUE ] = [ 'name' => 'help', 'payload' => "cd\ndump_node\ndump_config\nmake_node" ];
		$reader->ingest_completion_reply( $help );

		$this->assertSame( [ 'dump_node', 'dump_config' ], $reader->complete( 'dump', 0 ) );
	}

	public function test_complete_later_token_filters_node_candidates(): void {
		// At index > 0 (an argument), completion offers node names.
		$cmd    = new CLI_Command();
		$shell  = new \Newspack_Nodes\Shell_Node();
		$dumper = new \Newspack_Nodes\Dumper_Node( \fopen( 'php://memory', 'w+' ) );
		$reader = new \Newspack_Nodes\CLI_Stdin_Reader_Node( $cmd, $shell, $dumper, false, \fopen( 'php://memory', 'r+' ) );

		$ls                                   = \Newspack_Nodes\Message::new_message();
		$ls[ \Newspack_Nodes\Message::TYPE ]  = \Newspack_Nodes\Message::TM_COMMAND | \Newspack_Nodes\Message::TM_RESPONSE;
		$ls[ \Newspack_Nodes\Message::KEY ]   = 'completion';
		$ls[ \Newspack_Nodes\Message::VALUE ] = [ 'name' => 'ls', 'payload' => "firehose-in\nfirehose-fanout\nrequest-builder" ];
		$reader->ingest_completion_reply( $ls );

		$this->assertSame( [ 'firehose-in', 'firehose-fanout' ], $reader->complete( 'fire', 1 ) );
	}

	public function test_complete_empty_word_returns_all_candidates_for_position(): void {
		// An empty word (Tab on a fresh prompt) returns the full command list.
		$cmd    = new CLI_Command();
		$shell  = new \Newspack_Nodes\Shell_Node();
		$dumper = new \Newspack_Nodes\Dumper_Node( \fopen( 'php://memory', 'w+' ) );
		$reader = new \Newspack_Nodes\CLI_Stdin_Reader_Node( $cmd, $shell, $dumper, false, \fopen( 'php://memory', 'r+' ) );

		$help                                   = \Newspack_Nodes\Message::new_message();
		$help[ \Newspack_Nodes\Message::TYPE ]  = \Newspack_Nodes\Message::TM_COMMAND | \Newspack_Nodes\Message::TM_RESPONSE;
		$help[ \Newspack_Nodes\Message::KEY ]   = 'completion';
		$help[ \Newspack_Nodes\Message::VALUE ] = [ 'name' => 'help', 'payload' => "cd\nhelp" ];
		$reader->ingest_completion_reply( $help );

		$this->assertSame( [ 'cd', 'help' ], $reader->complete( '', 0 ) );
	}

	public function test_send_completion_queries_emits_help_and_ls_through_shell(): void {
		// Refresh sends BOTH a help and an ls completion query through the Shell
		// (so they ride the same interpreter path as any other command).
		$cmd    = new CLI_Command();
		$shell  = new \Newspack_Nodes\Shell_Node();
		$sink   = new \Newspack_Nodes\Tests\Capture_Sink_Node();
		$shell->sink( $sink );
		$dumper = new \Newspack_Nodes\Dumper_Node( \fopen( 'php://memory', 'w+' ) );
		$reader = new \Newspack_Nodes\CLI_Stdin_Reader_Node( $cmd, $shell, $dumper, false, \fopen( 'php://memory', 'r+' ) );

		$reader->send_completion_queries();

		$verbs = \array_map(
			static fn ( $m ) => $m[ \Newspack_Nodes\Message::VALUE ]['name'],
			$sink->captured
		);
		$this->assertContains( 'help', $verbs );
		$this->assertContains( 'ls', $verbs );
		foreach ( $sink->captured as $m ) {
			$this->assertSame( 'completion', $m[ \Newspack_Nodes\Message::KEY ] );
		}
	}

	public function test_dumper_completion_sink_intercepts_reply_before_render(): void {
		// The Dumper routes a KEY='completion' reply to its completion_sink (the
		// reader's ingester) and renders NOTHING for it.
		$out_stream = \fopen( 'php://memory', 'w+' );
		$dumper     = new \Newspack_Nodes\Dumper_Node( $out_stream );
		$seen       = null;
		$dumper->set_completion_sink( function ( array $m ) use ( &$seen ): bool {
			$seen = $m;
			return true;
		} );

		$reply                                   = \Newspack_Nodes\Message::new_message();
		$reply[ \Newspack_Nodes\Message::TYPE ]  = \Newspack_Nodes\Message::TM_COMMAND | \Newspack_Nodes\Message::TM_RESPONSE;
		$reply[ \Newspack_Nodes\Message::KEY ]   = 'completion';
		$reply[ \Newspack_Nodes\Message::VALUE ] = [ 'name' => 'help', 'payload' => "cd\nhelp" ];
		$dumper->fill( $reply );

		$this->assertNotNull( $seen, 'completion_sink received the reply' );
		\rewind( $out_stream );
		$this->assertSame( '', \stream_get_contents( $out_stream ), 'consumed completion reply renders nothing' );
	}

	public function test_readline_mode_constructor_registers_completion_and_seeds_cache(): void {
		// Readline mode wires the Dumper's completion sink, registers the
		// completion callback (captured via the seam), and seeds the cache by
		// sending the initial help+ls queries through the Shell.
		$cmd    = new CLI_Command();
		$shell  = new \Newspack_Nodes\Shell_Node();
		$sink   = new \Newspack_Nodes\Tests\Capture_Sink_Node();
		$shell->sink( $sink );
		$dumper = new \Newspack_Nodes\Dumper_Node( \fopen( 'php://memory', 'w+' ) );
		$stream = \fopen( 'php://memory', 'r+' );

		$registered    = null;
		$saved_install = \Newspack_Nodes\CLI_Stdin_Reader_Node::$readline_handler_install;
		$saved_reg     = \Newspack_Nodes\CLI_Stdin_Reader_Node::$readline_completion_register;
		\Newspack_Nodes\CLI_Stdin_Reader_Node::$readline_handler_install = static function ( string $prompt, callable $cb ): void {};
		\Newspack_Nodes\CLI_Stdin_Reader_Node::$readline_completion_register = static function ( callable $cb ) use ( &$registered ): void {
			$registered = $cb;
		};

		try {
			$reader = new \Newspack_Nodes\CLI_Stdin_Reader_Node( $cmd, $shell, $dumper, true, $stream );

			$this->assertIsCallable( $registered, 'completion callback registered' );

			// Initial queries seeded the cache (help + ls).
			$verbs = \array_map(
				static fn ( $m ) => $m[ \Newspack_Nodes\Message::VALUE ]['name'],
				$sink->captured
			);
			$this->assertContains( 'help', $verbs );
			$this->assertContains( 'ls', $verbs );

			// The Dumper now feeds completion replies into the reader's cache.
			$reply                                   = \Newspack_Nodes\Message::new_message();
			$reply[ \Newspack_Nodes\Message::TYPE ]  = \Newspack_Nodes\Message::TM_COMMAND | \Newspack_Nodes\Message::TM_RESPONSE;
			$reply[ \Newspack_Nodes\Message::KEY ]   = 'completion';
			$reply[ \Newspack_Nodes\Message::VALUE ] = [ 'name' => 'help', 'payload' => "cd\nhelp" ];
			$dumper->fill( $reply );
			$this->assertSame( [ 'cd', 'help' ], $reader->command_candidates() );

			// The registered callback returns prefix-matched candidates.
			$this->assertSame( [ 'cd' ], $registered( 'c', 0 ) );
		} finally {
			\Newspack_Nodes\CLI_Stdin_Reader_Node::$readline_handler_install     = $saved_install;
			\Newspack_Nodes\CLI_Stdin_Reader_Node::$readline_completion_register = $saved_reg;
			\fclose( $stream );
		}
	}

	public function test_default_completion_register_closure_calls_real_libreadline(): void {
		// bootstrap no-ops the registration seam. Drop it to null to drive the
		// default closure (the real readline_completion_function call), then
		// restore — mirrors the read_char/handler default-closure coverage tests.
		if ( ! \function_exists( 'readline_completion_function' ) ) {
			$this->markTestSkipped( 'readline extension not available' );
		}
		$cmd    = new CLI_Command();
		$shell  = new \Newspack_Nodes\Shell_Node();
		$dumper = new \Newspack_Nodes\Dumper_Node( \fopen( 'php://memory', 'w+' ) );
		$stream = \fopen( 'php://memory', 'r+' );
		$shell->sink( new \Newspack_Nodes\Tests\Capture_Sink_Node() );

		$saved_install = \Newspack_Nodes\CLI_Stdin_Reader_Node::$readline_handler_install;
		$saved_reg     = \Newspack_Nodes\CLI_Stdin_Reader_Node::$readline_completion_register;
		\Newspack_Nodes\CLI_Stdin_Reader_Node::$readline_handler_install     = static function ( string $prompt, callable $cb ): void {};
		\Newspack_Nodes\CLI_Stdin_Reader_Node::$readline_completion_register = null;

		try {
			$reader = new \Newspack_Nodes\CLI_Stdin_Reader_Node( $cmd, $shell, $dumper, true, $stream );
			// Default closure ran without throwing; that's the line under test.
			$this->assertFalse( $reader->exit );
		} finally {
			@\readline_callback_handler_remove();
			\Newspack_Nodes\CLI_Stdin_Reader_Node::$readline_handler_install     = $saved_install;
			\Newspack_Nodes\CLI_Stdin_Reader_Node::$readline_completion_register = $saved_reg;
			\fclose( $stream );
		}
	}

	public function test_stdin_reader_readline_mode_fire_emits_eof_when_readline_signaled_eof(): void {
		// Readline mode: when readline_callback_read_char calls back with
		// null, the handle_readline_line flips $readline_eof. The NEXT
		// fire() sees the flag and emits TM_EOF (via send_eof_marker).
		$cmd    = new CLI_Command();
		$shell  = new \Newspack_Nodes\Shell_Node();
		$dumper = new \Newspack_Nodes\Dumper_Node( \fopen( 'php://memory', 'w+' ) );
		$sink   = new \Newspack_Nodes\Tests\Capture_Sink_Node();
		$shell->sink( $sink );
		$stream = \fopen( 'php://memory', 'r+' );

		\Newspack_Nodes\Event_Framework::reset();

		$saved_install = \Newspack_Nodes\CLI_Stdin_Reader_Node::$readline_handler_install;
		$saved_read    = \Newspack_Nodes\CLI_Stdin_Reader_Node::$readline_read_char;
		\Newspack_Nodes\CLI_Stdin_Reader_Node::$readline_handler_install = static function ( string $prompt, callable $cb ): void {};
		\Newspack_Nodes\CLI_Stdin_Reader_Node::$readline_read_char       = static function (): void {};

		try {
			$reader = new \Newspack_Nodes\CLI_Stdin_Reader_Node( $cmd, $shell, $dumper, true, $stream );

			// Simulate readline delivering null (Ctrl-D / EOF).
			$reader->handle_readline_line( null );

			// fire(): stream_select on a memory stream throws ValueError →
			// caught → $ready=1 → reads (no-op) → drains queue (empty) →
			// notices readline_eof=true → send_eof_marker.
			$reader->fire();

			$dispatched = self::non_completion( $sink->captured );
			$this->assertCount( 1, $dispatched, 'fire() with readline_eof must emit TM_EOF via Shell' );
			$this->assertSame(
				\Newspack_Nodes\Message::TM_EOF,
				$dispatched[0][ \Newspack_Nodes\Message::TYPE ]
			);
			// eof_sent should now be true.
			$prop = new \ReflectionProperty( $reader, 'eof_sent' );
			$prop->setAccessible( true );
			$this->assertTrue( $prop->getValue( $reader ) );
		} finally {
			\Newspack_Nodes\CLI_Stdin_Reader_Node::$readline_handler_install = $saved_install;
			\Newspack_Nodes\CLI_Stdin_Reader_Node::$readline_read_char       = $saved_read;
			\fclose( $stream );
		}
	}
}
