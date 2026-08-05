<?php
/**
 * TTYInNodeTest — the readline/completion/prompt stdin reader for `wp nodes cli`,
 * built atop Stdin_Node. Drives the SHELL (not a plain sink): typed lines parse
 * into commands, stdin EOF round-trips a TM_EOF through the shell, tab-completion
 * candidates are cached from `help`/`ls` completion replies.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Message;
use Newspack_Nodes\Shell_Node;
use Newspack_Nodes\TTY_In_Node;
use Newspack_Nodes\TTY_Out_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;

#[CoversClass( TTY_In_Node::class )]
class TTYInNodeTest extends TestCase {

	/** @var \Closure|null */
	private $saved_install;
	/** @var \Closure|null */
	private $saved_read;
	/** @var \Closure|null */
	private $saved_register;

	protected function setUp(): void {
		parent::setUp();
		// Block real libreadline from firing during tests (the seams default to
		// the real calls in production; no-op them for the test process).
		$this->saved_install  = TTY_In_Node::$readline_handler_install;
		$this->saved_read     = TTY_In_Node::$readline_read_char;
		$this->saved_register = TTY_In_Node::$readline_completion_register;
		TTY_In_Node::$readline_handler_install     = static function ( string $prompt, callable $cb ): void {};
		TTY_In_Node::$readline_read_char           = static function (): void {};
		TTY_In_Node::$readline_completion_register = static function ( callable $cb ): void {};
	}

	protected function tearDown(): void {
		TTY_In_Node::$readline_handler_install     = $this->saved_install;
		TTY_In_Node::$readline_read_char           = $this->saved_read;
		TTY_In_Node::$readline_completion_register = $this->saved_register;
		parent::tearDown();
	}

	/** @return resource */
	private function memory_stream( string $contents ) {
		$mem = \fopen( 'php://memory', 'r+' );
		\fwrite( $mem, $contents );
		\rewind( $mem );
		return $mem;
	}

	private function out(): TTY_Out_Node {
		return new TTY_Out_Node( \fopen( 'php://memory', 'w+' ), false );
	}

	/**
	 * Drop the readline-mode constructor's cache-seeding completion queries
	 * (KEY='completion') so dispatch-count assertions stay focused on the
	 * lines actually typed.
	 *
	 * @param array<int,array<int,mixed>> $captured
	 * @return array<int,array<int,mixed>>
	 */
	private static function non_completion( array $captured ): array {
		return \array_values(
			\array_filter(
				$captured,
				static fn ( $m ) => 'completion' !== ( $m[ Message::KEY ] ?? '' )
			)
		);
	}

	public function test_non_readline_dispatches_lines_then_eof_round_trips(): void {
		// Two complete lines + EOF. Each fire() drains one line through the shell;
		// after both are gone, the next fire() hits stdin EOF and emits a TM_EOF
		// through the shell (which the shell forwards) — but exit stays false
		// (round-trip drain: we wait for the echo, not the local send).
		$shell = new Shell_Node();
		$cap   = new Capture_Sink_Node();
		$shell->sink( $cap );

		$stream = $this->memory_stream( "ls\ntell foo hi\n" );
		$reader = new TTY_In_Node( $shell, $this->out(), false, $stream );
		$reader->sink( $shell ); // the reader drains into the Shell

		$reader->fire();
		$this->assertCount( 1, $cap->captured );
		$this->assertSame( Message::TM_COMMAND, $cap->captured[0][ Message::TYPE ] );
		$this->assertFalse( $reader->exit );

		$reader->fire();
		$this->assertCount( 2, $cap->captured );
		$this->assertSame( Message::TM_INFO, $cap->captured[1][ Message::TYPE ] );
		$this->assertFalse( $reader->exit );

		$reader->fire();
		$this->assertCount( 3, $cap->captured, 'EOF tick adds a TM_EOF Message' );
		$this->assertSame( Message::TM_EOF, $cap->captured[2][ Message::TYPE ] );
		$this->assertFalse( $reader->exit );

		\fclose( $stream );
	}

	public function test_non_readline_redraws_prompt_after_each_delivered_line(): void {
		// readline-missing-but-TTY mode (has_readline=false, show_prompts=true): the
		// prompt must be re-drawn after every processed line, matching the old reader
		// which reset prompt_displayed per line. The ctor draws the initial prompt,
		// then each delivered line draws one more.
		$shell = new Shell_Node();
		$shell->sink( new Capture_Sink_Node() );
		$mem    = \fopen( 'php://memory', 'w+' );
		$out    = new TTY_Out_Node( $mem, false );
		$stream = $this->memory_stream( "ls\ntell foo hi\n" );
		$reader = new TTY_In_Node( $shell, $out, false, $stream, true );

		$reader->fire();
		$reader->fire();

		\rewind( $mem );
		$contents = \stream_get_contents( $mem );
		$this->assertSame(
			3,
			\substr_count( $contents, $shell->prompt ),
			'initial ctor prompt + one redraw per delivered line'
		);
		\fclose( $stream );
	}

	public function test_constructor_does_not_seed_completion_queries(): void {
		// Regression: with has_readline=true the ctor must NOT fire the completion
		// seed queries. run_repl seeds them only AFTER set_completion_sink is wired;
		// seeding in the ctor round-trips the replies while the intercept is still
		// null, dumping the whole verb/node list to the terminal at REPL launch.
		$shell = new Shell_Node();
		$cap   = new Capture_Sink_Node();
		$shell->sink( $cap );

		new TTY_In_Node( $shell, $this->out(), true, $this->memory_stream( '' ) );

		$this->assertCount( 0, $cap->captured, 'ctor must not seed completion queries (deferred to run_repl)' );
	}

	public function test_eof_marker_is_stamped_by_the_shell_not_the_reader(): void {
		// The reader does NOT stamp FROM on its TM_EOF; the Shell does
		// (FROM=_output/$pid) so the round-trip echo lands on this session.
		$shell = new Shell_Node();
		$cap   = new Capture_Sink_Node();
		$shell->sink( $cap );

		$stream = $this->memory_stream( '' ); // empty -> immediate EOF
		$reader = new TTY_In_Node( $shell, $this->out(), false, $stream, false );
		$reader->sink( $shell ); // the reader drains into the Shell

		$reader->fire();
		$this->assertCount( 1, $cap->captured );
		$this->assertSame( Message::TM_EOF, $cap->captured[0][ Message::TYPE ] );
		$this->assertStringContainsString( '_output/' . \getmypid(), $cap->captured[0][ Message::FROM ] );

		// Idempotent: a second EOF tick must NOT re-emit.
		$reader->fire();
		$this->assertCount( 1, $cap->captured, 'TM_EOF must not be re-emitted' );

		\fclose( $stream );
	}

	public function test_fire_cb_drains_only_when_it_has_a_sink(): void {
		// Production drives the reader via the timer's fire_cb(), which inherits
		// Timer_Node's no-sink guard: a sink-less reader never reaches fire().
		$shell = new Shell_Node();
		$cap   = new Capture_Sink_Node();
		$shell->sink( $cap );

		$stream = $this->memory_stream( "ls\n" );
		$reader = new TTY_In_Node( $shell, $this->out(), false, $stream );

		$reader->fire_cb();
		$this->assertCount( 0, $cap->captured, 'a sink-less reader ignores input via fire_cb()' );

		$reader->sink( $shell ); // wire the sink -> now fire_cb reaches fire() and drains into the Shell
		$reader->fire_cb();
		$this->assertCount( 1, $cap->captured, 'a sunk reader drains the queued line via fire_cb()' );
		$this->assertSame( Message::TM_COMMAND, $cap->captured[0][ Message::TYPE ] );

		\fclose( $stream );
	}

	public function test_readline_line_reaches_shell_and_reinstalls_handler(): void {
		// Readline mode: constructor installs the handler once (marking the prompt
		// on the TTY_Out). handle_readline_line queues a line and clears the
		// prompt flag; fire() drains it to the shell and re-installs the handler.
		$shell = new Shell_Node();
		$cap   = new Capture_Sink_Node();
		$shell->sink( $cap );
		$out    = $this->out();
		$stream = $this->memory_stream( '' );

		$install_calls = 0;
		TTY_In_Node::$readline_handler_install = static function ( string $prompt, callable $cb ) use ( &$install_calls ): void {
			++$install_calls;
		};

		$reader = new TTY_In_Node( $shell, $out, true, $stream );
		$reader->sink( $shell ); // the reader drains into the Shell
		$this->assertSame( 1, $install_calls, 'constructor installs the handler once' );
		$this->assertTrue( $out->prompt_displayed, 'install marks the prompt displayed' );

		$reader->handle_readline_line( 'ls' );
		$this->assertFalse( $out->prompt_displayed, 'queuing a line clears the prompt flag' );

		$reader->fire();

		$dispatched = self::non_completion( $cap->captured );
		$this->assertCount( 1, $dispatched, 'the queued line reached the shell' );
		$this->assertSame( Message::TM_COMMAND, $dispatched[0][ Message::TYPE ] );
		$this->assertSame( 2, $install_calls, 'fire() re-installs the handler after a delivered line' );
		$this->assertTrue( $out->prompt_displayed, 're-install re-marks the prompt displayed' );

		\fclose( $stream );
	}

	public function test_readline_null_line_signals_eof_and_next_fire_emits_tm_eof(): void {
		// readline delivers null on Ctrl-D; the NEXT fire() emits TM_EOF via the shell.
		$shell = new Shell_Node();
		$cap   = new Capture_Sink_Node();
		$shell->sink( $cap );
		$stream = $this->memory_stream( '' );

		$reader = new TTY_In_Node( $shell, $this->out(), true, $stream );
		$reader->sink( $shell ); // the reader drains into the Shell
		$reader->handle_readline_line( null );
		$reader->fire();

		$dispatched = self::non_completion( $cap->captured );
		$this->assertCount( 1, $dispatched, 'fire() with readline_eof emits TM_EOF via the shell' );
		$this->assertSame( Message::TM_EOF, $dispatched[0][ Message::TYPE ] );

		\fclose( $stream );
	}

	public function test_completion_cache_ingest_and_prefix_filter(): void {
		// A KEY='completion' `help` reply fills the command cache; complete()
		// at index 0 filters those candidates by prefix.
		$shell  = new Shell_Node();
		$reader = new TTY_In_Node( $shell, $this->out(), false, $this->memory_stream( '' ) );

		$reply                    = Message::new_message();
		$reply[ Message::TYPE ]   = Message::TM_COMMAND | Message::TM_RESPONSE;
		$reply[ Message::KEY ]    = 'completion';
		$reply[ Message::VALUE ]  = [ 'name' => 'help', 'payload' => "cd\nhelp\nlist_nodes\nls" ];

		$this->assertTrue( $reader->ingest_completion_reply( $reply ) );
		$this->assertSame( [ 'cd', 'help', 'list_nodes', 'ls' ], $reader->command_candidates() );
		$this->assertSame( [ 'list_nodes', 'ls' ], $reader->complete( 'l', 0 ) );
	}

	public function test_send_completion_queries_emits_help_and_ls_through_shell(): void {
		$shell = new Shell_Node();
		$cap   = new Capture_Sink_Node();
		$shell->sink( $cap );
		$reader = new TTY_In_Node( $shell, $this->out(), false, $this->memory_stream( '' ) );
		$reader->sink( $shell ); // completion queries go out through the sink (the Shell)

		$reader->send_completion_queries();

		$verbs = \array_map( static fn ( $m ) => $m[ Message::VALUE ]['name'], $cap->captured );
		$this->assertContains( 'help', $verbs );
		$this->assertContains( 'ls', $verbs );
		foreach ( $cap->captured as $m ) {
			$this->assertSame( 'completion', $m[ Message::KEY ] );
		}
	}

	public function test_send_completion_queries_is_a_noop_without_a_sink(): void {
		// The null-sink guard: a reader whose sink is unwired must swallow the
		// completion queries rather than fatal. Wiring the sink afterwards shows
		// the same call now dispatches — proving the first call was suppressed.
		$shell = new Shell_Node();
		$cap   = new Capture_Sink_Node();
		$shell->sink( $cap );
		$reader = new TTY_In_Node( $shell, $this->out(), false, $this->memory_stream( '' ) );

		$reader->send_completion_queries(); // no sink yet -> guarded no-op
		$this->assertCount( 0, $cap->captured );

		$reader->sink( $shell );
		$reader->send_completion_queries(); // now dispatches help + ls
		$this->assertCount( 2, $cap->captured );
	}

	public function test_registered_completion_callback_refreshes_cache_and_returns_matches(): void {
		// install_completion() registers a closure with readline; capture it via the
		// seam and invoke it directly. The closure re-sends the completion queries
		// (through the sink) and returns the prefix-filtered candidate list.
		$captured_cb = null;
		TTY_In_Node::$readline_completion_register = static function ( callable $cb ) use ( &$captured_cb ): void {
			$captured_cb = $cb;
		};

		$shell = new Shell_Node();
		$cap   = new Capture_Sink_Node();
		$shell->sink( $cap );
		$reader = new TTY_In_Node( $shell, $this->out(), true, $this->memory_stream( '' ) );
		$reader->sink( $shell );

		$this->assertIsCallable( $captured_cb );

		$reply                   = Message::new_message();
		$reply[ Message::KEY ]   = 'completion';
		$reply[ Message::VALUE ] = [ 'name' => 'help', 'payload' => "help\nls\nlist_nodes" ];
		$reader->ingest_completion_reply( $reply );

		$result = $captured_cb( 'l', 0 );

		$this->assertSame( [ 'ls', 'list_nodes' ], $result, 'closure returns prefix-filtered command candidates' );
		$verbs = \array_map( static fn ( $m ) => $m[ Message::VALUE ]['name'], $cap->captured );
		$this->assertContains( 'help', $verbs, 'closure refreshed the cache via send_completion_queries' );
		$this->assertContains( 'ls', $verbs );
	}

	public function test_readline_drain_returns_false_when_stream_has_no_data(): void {
		// Readline mode gates rl_getc behind stream_select so an idle TTY doesn't
		// spin the drain loop. A selectable-but-empty socket makes stream_select
		// report 0 ready -> drain_once returns false and nothing dispatches.
		$pair = \stream_socket_pair( \STREAM_PF_UNIX, \STREAM_SOCK_STREAM, \STREAM_IPPROTO_IP );
		$this->assertIsArray( $pair, 'stream_socket_pair must be available for this test' );

		$read_calls = 0;
		TTY_In_Node::$readline_read_char = static function () use ( &$read_calls ): void {
			++$read_calls;
		};

		$shell = new Shell_Node();
		$cap   = new Capture_Sink_Node();
		$shell->sink( $cap );
		$reader = new TTY_In_Node( $shell, $this->out(), true, $pair[0] );
		$reader->sink( $shell );

		$reader->fire();

		$this->assertSame( 0, $read_calls, 'no readline read on an empty stream' );
		$this->assertCount( 0, self::non_completion( $cap->captured ), 'nothing dispatched when stream is not ready' );
		$this->assertFalse( $reader->exit );

		\fclose( $pair[0] );
		\fclose( $pair[1] );
	}

	public function test_complete_with_empty_word_returns_the_whole_pool(): void {
		$shell  = new Shell_Node();
		$reader = new TTY_In_Node( $shell, $this->out(), false, $this->memory_stream( '' ) );

		$reply                   = Message::new_message();
		$reply[ Message::KEY ]   = 'completion';
		$reply[ Message::VALUE ] = [ 'name' => 'help', 'payload' => "cd\nhelp\nls" ];
		$reader->ingest_completion_reply( $reply );

		$this->assertSame( [ 'cd', 'help', 'ls' ], $reader->complete( '', 0 ) );
	}

	public function test_ls_completion_reply_fills_node_cache_and_argument_position_completes_against_it(): void {
		// A `ls`/`list_nodes` reply fills the NODE cache (not the command cache);
		// complete() at a non-zero token index completes against node names.
		$shell  = new Shell_Node();
		$reader = new TTY_In_Node( $shell, $this->out(), false, $this->memory_stream( '' ) );

		$reply                   = Message::new_message();
		$reply[ Message::KEY ]   = 'completion';
		$reply[ Message::VALUE ] = [ 'name' => 'ls', 'payload' => "firehose\nfirehose-workers\nrequest-builder" ];

		$this->assertTrue( $reader->ingest_completion_reply( $reply ) );
		$this->assertSame( [ 'firehose', 'firehose-workers', 'request-builder' ], $reader->node_candidates() );
		$this->assertSame( [ 'firehose', 'firehose-workers' ], $reader->complete( 'fire', 1 ) );
		$this->assertSame( [], $reader->command_candidates(), 'an ls reply must not touch the command cache' );
	}

	public function test_ingest_ignores_a_non_completion_reply(): void {
		$shell  = new Shell_Node();
		$reader = new TTY_In_Node( $shell, $this->out(), false, $this->memory_stream( '' ) );

		$reply                   = Message::new_message();
		$reply[ Message::KEY ]   = 'not-completion';
		$reply[ Message::VALUE ] = [ 'name' => 'help', 'payload' => "cd\nls" ];

		$this->assertFalse( $reader->ingest_completion_reply( $reply ) );
		$this->assertSame( [], $reader->command_candidates() );
	}

	public function test_ingest_ignores_a_completion_reply_whose_value_is_not_an_array(): void {
		$shell  = new Shell_Node();
		$reader = new TTY_In_Node( $shell, $this->out(), false, $this->memory_stream( '' ) );

		$reply                   = Message::new_message();
		$reply[ Message::KEY ]   = 'completion';
		$reply[ Message::VALUE ] = 'not-an-array';

		$this->assertFalse( $reader->ingest_completion_reply( $reply ) );
		$this->assertSame( [], $reader->command_candidates() );
	}
}
