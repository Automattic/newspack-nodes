<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Node_Names;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Core::class )]
class CoreTest extends TestCase {
	protected function setUp(): void {
		parent::setUp();
		Core::reset();
	}

	public function test_register_and_lookup_node_by_name(): void {
		$obj = new \Newspack_Nodes\Node();
		Core::register_node( 'foo', $obj );
		$this->assertSame( $obj, Core::node( 'foo' ) );
	}

	public function test_lookup_missing_node_returns_null(): void {
		$this->assertNull( Core::node( 'nonexistent' ) );
	}

	public function test_unregister_removes_node(): void {
		Core::register_node( 'foo', new \Newspack_Nodes\Node() );
		Core::unregister_node( 'foo' );
		$this->assertNull( Core::node( 'foo' ) );
	}

	public function test_now_returns_float(): void {
		Core::$now = \microtime(true);
		$this->assertIsFloat( Core::$now );
		$this->assertIsFloat( Core::$now );
	}

	public function test_now_microsecond_precision(): void {
		Core::$now = 1234567890.123456;
		$this->assertSame( 1234567890.123456, Core::$now );
		// $now matches $now (no truncation).
		$this->assertSame( 1234567890.123456, Core::$now );
	}

	public function test_reset_stamps_init_time_with_current_now(): void {
		Core::$now = 0.0;
		Core::reset();
		$this->assertSame( Core::$now, Core::$init_time );
		$this->assertGreaterThan( 0.0, Core::$init_time );
	}

	public function test_memd_defaults_to_null(): void {
		Core::reset();
		$this->assertNull( Core::$memd );
	}

	public function test_reset_clears_memd_handle(): void {
		Core::$memd = new \Memcached();
		Core::reset();
		$this->assertNull( Core::$memd, 'Core::reset() must clear the shared Memcached handle for test isolation' );
	}

	public function test_run_closing_executes_callbacks_in_order(): void {
		$order = [];
		Core::push_closing( function () use ( &$order ) { $order[] = 'a'; } );
		Core::push_closing( function () use ( &$order ) { $order[] = 'b'; } );
		Core::push_closing( function () use ( &$order ) { $order[] = 'c'; } );

		Core::run_closing();
		$this->assertSame( [ 'a', 'b', 'c' ], $order );
	}

	public function test_run_closing_drains_queue(): void {
		$count = 0;
		Core::push_closing( function () use ( &$count ) { ++$count; } );
		Core::run_closing();
		Core::run_closing(); // should be no-op now
		$this->assertSame( 1, $count );
	}

	public function test_print_less_often_emits_first_occurrence(): void {
		$buf = '';
		Core::set_stderr_handler( function ( $msg ) use ( &$buf ) { $buf .= $msg; } );
		Core::print_less_often( 'first warning' );
		$this->assertStringContainsString( 'first warning', $buf );
	}

	public function test_print_less_often_suppresses_within_60s(): void {
		$buf = '';
		Core::set_stderr_handler( function ( $msg ) use ( &$buf ) { $buf .= $msg; } );
		Core::$now = 1000.0;
		Core::print_less_often( 'duplicate' );
		Core::$now = 1030.0; // 30s later — within window
		Core::print_less_often( 'duplicate' );
		$this->assertSame( 1, \substr_count( $buf, 'duplicate' ) );
	}

	public function test_print_least_often_emits_at_tenth_call(): void {
		$buf = '';
		Core::set_stderr_handler( function ( $msg ) use ( &$buf ) { $buf .= $msg; } );
		for ( $i = 0; $i < 9; ++$i ) {
			Core::print_least_often( 'rare' );
		}
		$this->assertStringNotContainsString( 'rare', $buf );
		Core::print_least_often( 'rare' ); // 10th
		$this->assertStringContainsString( 'rare', $buf );
	}

	public function test_emit_stderr_falls_back_when_handler_re_enters(): void {
		// Handler that synchronously re-emits via print_less_often. Without
		// the re-entry guard this recurses until the stack blows.
		$outer_called = 0;
		$inner_called = 0;
		Core::set_stderr_handler(
			function ( $msg ) use ( &$outer_called, &$inner_called ) {
				++$outer_called;
				if ( 1 === $outer_called ) {
					// Fault inside the handler: emit another stderr line.
					// Distinct text so print_less_often's dedup doesn't
					// short-circuit before reaching emit_stderr.
					Core::print_less_often( 'inner failure' );
					++$inner_called;
				}
			}
		);
		// Capture PHP's error_log fallback output for the re-entry path.
		$tmp = \tempnam( \sys_get_temp_dir(), 'nodes-stderr-' );
		$old = \ini_set( 'error_log', $tmp );
		try {
			Core::print_less_often( 'outer failure' );
		} finally {
			\ini_set( 'error_log', false === $old ? '' : $old );
		}
		$fallback_log = (string) \file_get_contents( $tmp );
		\unlink( $tmp );

		// Outer message went through the custom handler exactly once.
		$this->assertSame( 1, $outer_called );
		// The recursive call inside the handler returned (no stack overflow).
		$this->assertSame( 1, $inner_called );
		// Inner message landed on the error_log fallback, not the custom handler.
		$this->assertStringContainsString( 'inner failure', $fallback_log );
	}

	public function test_emit_stderr_resets_guard_when_handler_throws(): void {
		// A throwing handler must not permanently latch the re-entry flag —
		// otherwise the very next emit_stderr call would forever divert to
		// error_log, silently disabling the configured handler.
		$call = 0;
		Core::set_stderr_handler(
			function ( $msg ) use ( &$call ) {
				++$call;
				if ( 1 === $call ) {
					throw new \RuntimeException( 'first call' );
				}
			}
		);
		try {
			Core::print_less_often( 'first' );
			$this->fail( 'Expected RuntimeException to propagate' );
		} catch ( \RuntimeException $e ) {
			// Expected.
		}
		// Second call (distinct text → no dedup): the handler should see it,
		// proving the in_stderr flag was reset by the finally block.
		Core::print_less_often( 'second' );
		$this->assertSame( 2, $call );
	}

	// ── default stderr handler: reply-sink routing ───────────────────────

	public function test_stderr_default_handler_routes_to_output_when_no_repl(): void {
		// No _repl (worker) registered, but a REPL Dumper (_output) is — the line
		// must surface there as a TM_BYTESTREAM, not fall to error_log.
		Core::reset();
		$out = new Capture_Sink_Node();
		Core::register_node( Node_Names::OUTPUT, $out );
		Core::stderr( 'hi there' );
		$this->assertCount( 1, $out->captured );
		$this->assertSame( Message::TM_BYTESTREAM, $out->captured[0][ Message::TYPE ] );
		$this->assertStringContainsString( 'hi there', (string) $out->captured[0][ Message::VALUE ] );
	}

	public function test_stderr_default_handler_prefers_repl_over_output(): void {
		// Worker context: both could be registered; _repl (the output partition)
		// wins so the line isn't double-rendered.
		Core::reset();
		$repl = new Capture_Sink_Node();
		$out  = new Capture_Sink_Node();
		Core::register_node( Node_Names::REPL, $repl );
		Core::register_node( Node_Names::OUTPUT, $out );
		Core::stderr( 'only repl' );
		$this->assertCount( 1, $repl->captured );
		$this->assertCount( 0, $out->captured );
	}

	public function test_stderr_default_handler_falls_back_to_output(): void {
		// Ephemeral POST /command process: only the _output response writer exists.
		// stderr is a broadcast, so the line rides back through _output (the JSONL
		// body), not error_log.
		Core::reset();
		$out = new Capture_Sink_Node();
		Core::register_node( Node_Names::OUTPUT, $out );
		Core::stderr( 'to output' );
		$this->assertCount( 1, $out->captured );
		$this->assertStringContainsString( 'to output', (string) $out->captured[0][ Message::VALUE ] );
	}

	public function test_stderr_prefers_the_sse_egress_over_output(): void {
		// SSE-stream process: both the `_sse` egress and the `_output` reply filter
		// are registered. A broadcast (empty TO) must reach the `_sse` egress —
		// `_output` is the pid-gating HTTP_Filter that drops empty-head messages.
		Core::reset();
		$sse = new Capture_Sink_Node();
		$out = new Capture_Sink_Node();
		Core::register_node( Node_Names::SSE, $sse );
		Core::register_node( Node_Names::OUTPUT, $out );
		Core::stderr( 'to sse' );
		$this->assertCount( 1, $sse->captured, 'stderr rides the _sse egress' );
		$this->assertCount( 0, $out->captured, 'never the _output filter' );
	}

	// ── counter ──────────────────────────────────────────────────────────

	public function test_counter_pre_increments_starting_from_one(): void {
		// Counter is reset to 0 in reset(); first call must return 1.
		Core::reset();
		$this->assertSame( 1, Core::counter() );
		$this->assertSame( 2, Core::counter() );
		$this->assertSame( 3, Core::counter() );
	}

	public function test_counter_resets_with_core(): void {
		Core::counter();
		Core::counter();
		Core::counter();
		Core::reset();
		$this->assertSame( 1, Core::counter() );
	}

	// ── cleanup_all_nodes ────────────────────────────────────────────────

	public function test_cleanup_all_nodes_calls_remove_node_on_each_registered(): void {
		// Build two fake nodes with remove_node() that records being called.
		// Use static :: state on a one-off class so the side effects survive
		// across calls without needing pass-by-reference into anon classes.
		CoreTest_RecordingNode::$log = [];
		Core::register_node( 'a', new CoreTest_RecordingNode( 'a' ) );
		Core::register_node( 'b', new CoreTest_RecordingNode( 'b' ) );

		Core::cleanup_all_nodes();

		$this->assertSame( [ 'a', 'b' ], CoreTest_RecordingNode::$log );
	}

	// Retired: the registry is now Node-typed (Core::register_node(string, Node)),
	// so every registered value is a Node and always has remove_node(). The
	// duck-typed-skip path that test_cleanup_all_nodes_skips_objects_without_remove_node
	// exercised (a non-Node object in the registry) is unreachable.

	public function test_cleanup_all_nodes_keeps_going_when_one_throws(): void {
		// Spec docs: "Best-effort teardown; one node's failure shouldn't block
		// the rest." A throwing remove_node() must not prevent the next node
		// from being cleaned up.
		CoreTest_RecordingNode::$log = [];

		Core::register_node( 'a', new class extends \Newspack_Nodes\Node {
			public function remove_node(): void {
				throw new \RuntimeException( 'simulated teardown failure' );
			}
		} );
		Core::register_node( 'b', new CoreTest_RecordingNode( 'b' ) );

		// Swallow the rate-limited stderr emission from the thrown error.
		Core::set_stderr_handler( static function ( string $msg ): void {} );

		Core::cleanup_all_nodes();

		$this->assertSame( [ 'b' ], CoreTest_RecordingNode::$log, 'second node must still be cleaned up after the first throws' );
	}

	public function test_cleanup_all_nodes_snapshots_registry_before_iterating(): void {
		// remove_node() typically unregisters itself; the snapshot prevents
		// the iteration source from mutating mid-walk. Build a node whose
		// remove_node() calls unregister_node('x') and verify both 'x' and
		// 'y' still get cleaned up.
		CoreTest_SelfUnregisteringNode::$log = [];

		Core::register_node( 'x', new CoreTest_SelfUnregisteringNode( 'x' ) );
		Core::register_node( 'y', new CoreTest_SelfUnregisteringNode( 'y' ) );

		Core::cleanup_all_nodes();

		$this->assertSame( [ 'x', 'y' ], CoreTest_SelfUnregisteringNode::$log );
		$this->assertNull( Core::node( 'x' ) );
		$this->assertNull( Core::node( 'y' ) );
	}

	// ── print_least_often window expiration ─────────────────────────────

	public function test_print_least_often_resets_after_window_expires(): void {
		// print_least_often emits once at the 10th call. Re-windowing is NOT
		// inline: it happens when prune_logs() ages the entry out (the Router
		// calls it each tick) — matches Perl Tachikoma (Node::print_least_often
		// + Router::update_logs). Advancing time alone does nothing; the
		// counter restarts only once the aged entry is pruned.
		$buf = '';
		Core::set_stderr_handler( function ( $msg ) use ( &$buf ) { $buf .= $msg; } );

		Core::$now = 1000.0;
		for ( $i = 0; $i < 10; ++$i ) {
			Core::print_least_often( 'flaky' );
		}
		$this->assertSame( 1, \substr_count( $buf, 'flaky' ), 'first emission at 10th call' );

		// Advance past the timeout and prune (simulating the Router tick) to
		// evict the 'flaky' entry, restarting the counter.
		Core::$now = 1070.0;
		Core::prune_logs();
		for ( $i = 0; $i < 9; ++$i ) {
			Core::print_least_often( 'flaky' );
		}
		$this->assertSame( 1, \substr_count( $buf, 'flaky' ), 'no second emission until 10th call in new window' );

		Core::print_least_often( 'flaky' );
		$this->assertSame( 2, \substr_count( $buf, 'flaky' ), 'second emission lands at the 10th call of the new window' );
	}

	public function test_prune_logs_evicts_entries_older_than_timeout(): void {
		// prune_logs() removes recent_log_timers entries older than the
		// timeout; the next rate-limiter call then re-emits. Mirrors Perl
		// Tachikoma Router::update_logs.
		$buf = '';
		Core::set_stderr_handler( function ( $msg ) use ( &$buf ) { $buf .= $msg; } );

		Core::$now = 1000.0;
		Core::print_less_often( 'aged' ); // emit #1
		Core::print_less_often( 'aged' ); // suppressed (within window)
		$this->assertSame( 1, \substr_count( $buf, 'aged' ), 'suppressed within window' );

		Core::$now = 1100.0; // past the 60s timeout
		Core::prune_logs();
		Core::print_less_often( 'aged' ); // entry evicted → emit #2
		$this->assertSame( 2, \substr_count( $buf, 'aged' ), 're-emits after prune evicts the aged entry' );
	}

	public function test_stderr_recent_log_ring_buffer_is_bounded(): void {
		// stderr() keeps a bounded tail of recent lines (Perl Tachikoma caps
		// @RECENT_LOG at 100); it must not grow without bound in a worker.
		Core::set_stderr_handler( static function () {} );
		for ( $i = 0; $i < 150; ++$i ) {
			Core::stderr( "line {$i}" );
		}
		$ref = new \ReflectionProperty( Core::class, 'recent_log' );
		$ref->setAccessible( true );
		$this->assertCount( 100, $ref->getValue() );
	}

	// ── stderr in_stderr re-entry guard exits via error_log ─────────────

	public function test_stderr_re_entry_lands_on_error_log_fallback(): void {
		// Direct re-entry through stderr() (vs going through print_less_often):
		// during the first call, the handler itself calls Core::stderr().
		// The dispatcher's in_stderr flag is set, so the second call hits the
		// guard and routes to PHP's error_log() instead of the handler.
		Core::set_stderr_handler( function ( string $msg ): void {
			if ( \strpos( $msg, 'first' ) !== false ) {
				// Direct re-entry — must not invoke the handler again.
				Core::stderr( 'second-direct' );
			}
		} );

		$tmp = \tempnam( \sys_get_temp_dir(), 'nodes-stderr-direct-' );
		$old = \ini_set( 'error_log', $tmp );
		try {
			Core::stderr( 'first' );
		} finally {
			\ini_set( 'error_log', false === $old ? '' : $old );
		}

		$log_text = (string) \file_get_contents( $tmp );
		\unlink( $tmp );

		// The re-entered call should have landed in error_log, not the handler.
		$this->assertStringContainsString( 'second-direct', $log_text );
	}

	// ── log_prefix / log_midfix / stderr formatting ──────────────────────

	public function test_log_prefix_no_args_returns_dated_identity_prefix(): void {
		// Mirrors Tachikoma Node::log_prefix root/job branch:
		// "%F %T %Z <hostname> <$0>[<pid>]: ". With no args it returns just
		// the prefix (no trailing newline).
		$prefix = Core::log_prefix();
		$this->assertMatchesRegularExpression(
			'/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d .+\[\d+\]: $/',
			$prefix
		);
	}

	public function test_log_prefix_prepends_prefix_and_appends_newline(): void {
		$line = Core::log_prefix( 'hello world' );
		// Begins with a date, ends with the message + single newline.
		$this->assertMatchesRegularExpression( '/^\d{4}-\d\d-\d\d/', $line );
		$this->assertStringEndsWith( "hello world\n", $line );
		$this->assertSame( 1, \substr_count( $line, "\n" ) );
	}

	public function test_log_prefix_prefixes_every_line_of_multiline_message(): void {
		$line  = Core::log_prefix( "line one\nline two" );
		$parts = \explode( "\n", \rtrim( $line, "\n" ) );
		$this->assertCount( 2, $parts );
		foreach ( $parts as $part ) {
			$this->assertMatchesRegularExpression( '/^\d{4}-\d\d-\d\d.*\]: line (one|two)$/', $part );
		}
	}

	public function test_log_prefix_chomps_trailing_newline_before_prefixing(): void {
		// A pre-newlined message must not yield a blank prefixed line at the end.
		$line = Core::log_prefix( "trailing\n" );
		$this->assertSame( 1, \substr_count( $line, "\n" ) );
		$this->assertStringEndsWith( "trailing\n", $line );
	}

	public function test_stderr_writes_prefixed_line(): void {
		$buf = '';
		Core::set_stderr_handler( function ( $msg ) use ( &$buf ) { $buf .= $msg; } );
		Core::stderr( 'a warning' );
		// The handler receives the fully-prefixed line.
		$this->assertMatchesRegularExpression( '/^\d{4}-\d\d-\d\d.*\]: a warning\n$/', $buf );
	}

	public function test_stderr_passes_through_already_dated_message(): void {
		// Tachikoma: if a message already begins with YYYY-MM-DD it is assumed
		// pre-prefixed and written verbatim (no double prefix). Otherwise it
		// would prefix twice on re-log paths (cleanup_all_nodes → stderr).
		$buf = '';
		Core::set_stderr_handler( function ( $msg ) use ( &$buf ) { $buf .= $msg; } );
		Core::stderr( '2026-05-22 00:00:00 UTC host /x[1]: already prefixed' );
		// Exactly one date at the very start — not prefixed again.
		$this->assertSame( 1, \preg_match( '/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC host/', $buf ) );
		$this->assertStringEndsWith( "already prefixed\n", $buf );
		$this->assertStringNotContainsString( '[1]: 2026', $buf );
	}

	public function test_print_less_often_routes_through_stderr_prefix(): void {
		// The rate-limited helper must emit a prefixed line, proving it routes
		// through stderr()'s formatting rather than the raw text.
		$buf = '';
		Core::set_stderr_handler( function ( $msg ) use ( &$buf ) { $buf .= $msg; } );
		Core::print_less_often( 'rate limited msg' );
		$this->assertMatchesRegularExpression( '/^\d{4}-\d\d-\d\d.*\]: rate limited msg\n$/', $buf );
	}

	public function test_print_least_often_routes_through_stderr_prefix(): void {
		$buf = '';
		Core::set_stderr_handler( function ( $msg ) use ( &$buf ) { $buf .= $msg; } );
		for ( $i = 0; $i < 10; ++$i ) {
			Core::print_least_often( 'rare prefixed' );
		}
		$this->assertMatchesRegularExpression( '/^\d{4}-\d\d-\d\d.*\]: rare prefixed\n$/', $buf );
	}

	public function test_print_less_often_keys_by_log_midfix(): void {
		// Core and a named Node share Core::$recent_log_timers. Core keys by
		// its own (un-tagged) log_midfix while Node keys by "<name>: text", so
		// the same raw text from each does not collide — both emit.
		$buf = '';
		Core::set_stderr_handler( function ( $msg ) use ( &$buf ) { $buf .= $msg; } );
		$node = new \Newspack_Nodes\Node();
		$node->name( 'alice' );
		Core::print_less_often( 'same text' );
		$node->print_less_often( 'same text' );
		$this->assertSame( 2, \substr_count( $buf, 'same text' ) );
		$this->assertStringContainsString( 'alice: same text', $buf );
	}

	// ── push_closing / run_closing edge cases ────────────────────────────

	public function test_run_closing_handles_callbacks_pushed_during_drain(): void {
		// A callback may push another callback while draining. run_closing()'s
		// `while ( ! empty( ... ) )` loop must keep draining until the queue
		// is truly empty.
		$order = [];
		Core::push_closing( function () use ( &$order ) {
			$order[] = 'outer';
			Core::push_closing( function () use ( &$order ) {
				$order[] = 'inner';
			} );
		} );

		Core::run_closing();

		$this->assertSame( [ 'outer', 'inner' ], $order );
	}
}

/**
 * Recording node used in cleanup_all_nodes tests. Static log avoids the
 * pass-by-reference dance through anon-class constructors and survives across
 * multiple instances within a single test.
 */
class CoreTest_RecordingNode extends \Newspack_Nodes\Node {
	public static array $log = [];
	private string $tag;
	public function __construct( string $tag ) {
		$this->tag = $tag;
		parent::__construct();
	}
	public function remove_node(): void {
		self::$log[] = $this->tag;
	}
}

/**
 * Recording node that ALSO unregisters itself from Core during remove_node().
 * Used to verify that cleanup_all_nodes snapshots the registry before
 * iterating — otherwise the self-unregister mutates the iteration source
 * mid-walk and the second node is skipped.
 */
class CoreTest_SelfUnregisteringNode extends \Newspack_Nodes\Node {
	public static array $log = [];
	private string $tag;
	public function __construct( string $tag ) {
		$this->tag = $tag;
		parent::__construct();
	}
	public function remove_node(): void {
		self::$log[] = $this->tag;
		Core::unregister_node( $this->tag );
	}
}
