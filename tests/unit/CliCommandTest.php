<?php
/**
 * Tests for `wp nodes ls` and `wp nodes cli` (Cli_Command WP-CLI wrapper).
 *
 * The stdin-reading driver (readline / fgets / EOF round-trip / tab-completion)
 * now lives in `TTY_In_Node` and is exercised by `TTYInNodeTest`. Here we cover
 * the command wrapper itself:
 *
 *  - root-uid guard for `cli`
 *  - `base_dir()` filter resolution
 *  - `ls` output for empty / live / stale lock dirs
 *  - `build_repl_graph` (private) — bare and pivoted graph topology, incl. the
 *    `_output` (Dumper) → `_stdout` (TTY_Out) output wiring
 *  - the reply → render → `_stdout` write path end-to-end
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\CLI_Command;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Dumper_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Node_Names;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\TTY_Out_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

require_once \dirname( __DIR__, 2 ) . '/includes/class-cli-command.php';
require_once \dirname( __DIR__, 2 ) . '/includes/class-tap-node.php';
require_once \dirname( __DIR__ ) . '/Helpers/WPCLIStub.php';

#[CoversClass( CLI_Command::class )]
#[CoversClass( Dumper_Node::class )]
class CliCommandTest extends TestCase {
	private string $tmp;

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
		CLI_Command::$uid_provider = null;
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
		// Simulate uid 0 via the seam (the runner is non-root). The guard must
		// refuse before any graph is built; WP_CLI::error is stubbed to throw.
		CLI_Command::$uid_provider = static fn (): int => 0;

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessageMatches( '/must run as the same user/' );

		( new CLI_Command() )->cli( [], [] );
	}

	public function test_cli_bare_repl_exits_on_closed_piped_stdin(): void {
		CLI_Command::$uid_provider = static fn (): int => 1000;
		$start = \microtime( true );

		( new CLI_Command() )->cli( [], [] );

		$this->assertLessThan( 1.0, \microtime( true ) - $start );
		$this->assertSame( [], $GLOBALS['_test_wp_cli_logs'], 'non-TTY stdin should not render prompts or trailing courtesy lines' );

		Core::cleanup_all_nodes();
	}

	public function test_prepare_repl_bare_mode_sets_local_status_lines(): void {
		CLI_Command::$uid_provider = static fn (): int => 1000;
		$ref = new \ReflectionMethod( CLI_Command::class, 'prepare_repl' );

		[ $shell, $dumper, $stdout ] = $ref->invoke( new CLI_Command(), [] );

		$this->assertInstanceOf( \Newspack_Nodes\Shell_Node::class, $shell );
		$this->assertInstanceOf( Dumper_Node::class, $dumper );
		$this->assertInstanceOf( TTY_Out_Node::class, $stdout );
		$this->assertSame( [ 'Bare cli mode (local nodes only).' ], $shell->status_lines );

		Core::cleanup_all_nodes();
	}

	public function test_prepare_repl_pivoted_mode_attaches_worker_and_sets_status_lines(): void {
		CLI_Command::$uid_provider = static fn (): int => 1000;
		\mkdir( "{$this->tmp}/locks/jobs.p2.lock.d", 0755, true );
		\mkdir( "{$this->tmp}/ipc/jobs.p2/input", 0755, true );
		\mkdir( "{$this->tmp}/ipc/jobs.p2/output", 0755, true );
		$ref = new \ReflectionMethod( CLI_Command::class, 'prepare_repl' );

		[ $shell ] = $ref->invoke( new CLI_Command(), [ 'jobs.p2' ] );

		$this->assertSame(
			[
				'Pivoted-cli mode for jobs.p2',
				"  input  partition: {$this->tmp}/ipc/jobs.p2/input",
				"  output partition: {$this->tmp}/ipc/jobs.p2/output",
			],
			$shell->status_lines
		);

		Core::cleanup_all_nodes();
	}

	public function test_prepare_repl_reports_unknown_pivot_worker(): void {
		CLI_Command::$uid_provider = static fn (): int => 1000;
		$ref = new \ReflectionMethod( CLI_Command::class, 'prepare_repl' );

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'missing.p0' );

		$ref->invoke( new CLI_Command(), [ 'missing.p0' ] );
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
		// Bare mode: _shell → _command_interpreter → _router → _output (Dumper),
		// and _output forwards its rendered lines to _stdout (TTY_Out writer).
		// We invoke the private method via reflection to verify the graph shape
		// without entering the run_repl event loop.
		$ref = new \ReflectionMethod( CLI_Command::class, 'build_repl_graph' );

		[ $shell, $dumper, $stdout ] = $ref->invoke( new CLI_Command(), false, null );

		$this->assertInstanceOf( \Newspack_Nodes\Shell_Node::class, $shell );
		$this->assertInstanceOf( Dumper_Node::class, $dumper );
		$this->assertInstanceOf( TTY_Out_Node::class, $stdout );

		// Verify registry: _command_interpreter, _router, _output, _stdout present.
		$nodes = Core::$nodes_by_name;
		$this->assertArrayHasKey( '_router', $nodes );
		$this->assertArrayHasKey( '_command_interpreter', $nodes );
		$this->assertArrayHasKey( '_output', $nodes );
		$this->assertArrayHasKey( '_stdout', $nodes );

		// Dumper is registered as `_output` (so worker replies addressed to
		// `_output/$pid` route correctly via _router); _stdout is the writer.
		$this->assertSame( $dumper, $nodes['_output'] );
		$this->assertSame( $stdout, $nodes['_stdout'] );
		$this->assertSame( $stdout, Core::node( Node_Names::STDOUT ) );

		// Every node sinks into the interpreter (Rule #2); the Dumper reaches
		// _stdout by target/TO routing, not a direct sink.
		$interpreter = Core::node( Node_Names::COMMAND_INTERPRETER );
		$this->assertSame( $interpreter, $dumper->sink() );
		$this->assertSame( $interpreter, $stdout->sink() );
		$this->assertSame( Node_Names::STDOUT, $dumper->target() );

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

		[ $shell, $dumper, $stdout ] = $ref->invoke( new CLI_Command(), true, $ipc );

		$this->assertInstanceOf( Dumper_Node::class, $dumper );
		$this->assertInstanceOf( TTY_Out_Node::class, $stdout );

		$nodes = Core::$nodes_by_name;
		// The IPC input Partition is named after the worker, so `cd <worker>` routes to it.
		$this->assertArrayHasKey( 'firehose-workers.p0', $nodes );
		$this->assertInstanceOf( \Newspack_Nodes\Partition_Node::class, $nodes['firehose-workers.p0'] );
		// Prompt + cwd reflect the worker path.
		$this->assertSame( '/firehose-workers.p0> ', $shell->prompt );
		$this->assertSame( 'firehose-workers.p0', $shell->path );

		// Shell → Tap: pivoted commands are HMAC-signed,
		// then routed by TO (the Router peels the worker id to the mounted Partition).
		$this->assertSame(
			Core::node( \Newspack_Nodes\Node_Names::CONSOLE_TAP ),
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

		[ , $dumper ] = $ref->invoke( new CLI_Command(), true, $ipc );

		// Reflect on the private field to confirm the filter is the current pid.
		$pid_prop = new \ReflectionProperty( $dumper, 'to_filter' );
		$this->assertSame( (string) \getmypid(), $pid_prop->getValue( $dumper ) );

		Core::cleanup_all_nodes();
	}

	// ── reply → render → _stdout write path ───────────────────────────────────

	public function test_reply_addressed_to_output_renders_on_stdout_stream(): void {
		// End-to-end proof of the REPL output path with a capturable _stdout: a
		// worker reply addressed TO=_output/$pid, filled at the Dumper, is
		// rendered and re-minted TO=_stdout, routed through the interpreter +
		// router, and fwritten onto _stdout's stream.
		$router = new Router_Node();
		$router->name( Node_Names::ROUTER );

		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( Node_Names::COMMAND_INTERPRETER );
		$interpreter->sink( $router );

		$out_stream = \fopen( 'php://memory', 'w+' );
		$stdout     = new TTY_Out_Node( $out_stream, false );
		$stdout->name( Node_Names::STDOUT );
		$stdout->sink( $interpreter );

		$dumper = new Dumper_Node();
		$dumper->name( Node_Names::OUTPUT );
		$dumper->sink( $interpreter );
		$dumper->target( Node_Names::STDOUT );

		$reply                     = Message::new_message();
		$reply[ Message::TYPE ]    = Message::TM_COMMAND | Message::TM_RESPONSE;
		$reply[ Message::TO ]      = Node_Names::OUTPUT . '/' . \getmypid();
		$reply[ Message::VALUE ]   = [ 'name' => 'ls', 'payload' => 'hello' ];

		$dumper->fill( $reply );

		\rewind( $out_stream );
		$this->assertStringContainsString( 'hello', \stream_get_contents( $out_stream ) );

		Core::cleanup_all_nodes();
		\fclose( $out_stream );
	}

	public function test_dumper_completion_sink_intercepts_reply_before_render(): void {
		// The Dumper routes a KEY='completion' reply to its completion_sink (the
		// reader's ingester) and renders NOTHING for it.
		$out_stream = \fopen( 'php://memory', 'w+' );
		$dumper     = new Dumper_Node();
		$dumper->name( Node_Names::OUTPUT );
		$dumper->target( Node_Names::STDOUT );

		$stdout = new TTY_Out_Node( $out_stream, false );
		$stdout->name( Node_Names::STDOUT );
		$dumper->sink( $stdout );

		$seen = null;
		$dumper->set_completion_sink( function ( array $m ) use ( &$seen ): bool {
			$seen = $m;
			return true;
		} );

		$reply                                   = Message::new_message();
		$reply[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$reply[ Message::KEY ]   = 'completion';
		$reply[ Message::VALUE ] = [ 'name' => 'help', 'payload' => "cd\nhelp" ];
		$dumper->fill( $reply );

		$this->assertNotNull( $seen, 'completion_sink received the reply' );
		\rewind( $out_stream );
		$this->assertSame( '', \stream_get_contents( $out_stream ), 'consumed completion reply renders nothing' );

		Core::cleanup_all_nodes();
		\fclose( $out_stream );
	}

	public function test_class_docblock_describes_wp_nodes_parent_command(): void {
		// WP-CLI builds `wp nodes --help` from the CLI_Command CLASS doc comment
		// (a file-level docblock separated by namespace/code does not attach to
		// the class). It must carry a real description for the parent command.
		$doc = ( new \ReflectionClass( CLI_Command::class ) )->getDocComment();

		$this->assertIsString( $doc, 'CLI_Command needs a class docblock for `wp nodes --help`' );
		$this->assertStringContainsString( 'wp nodes', $doc );
		$this->assertStringContainsString( '## EXAMPLES', $doc );
	}
}
