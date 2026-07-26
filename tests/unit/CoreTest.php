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
	/** @var \Closure|null Bootstrap-installed curl seam, restored in tearDown so a test reassignment can't leak. */
	private $saved_curl_exec;

	protected function setUp(): void {
		parent::setUp();
		Core::reset();
		$this->saved_curl_exec = Core::$curl_exec;
	}

	protected function tearDown(): void {
		Core::$curl_exec = $this->saved_curl_exec;
		parent::tearDown();
	}

	// $config_resolvers (process-lifetime; Core::reset leaves it) is snapshotted in
	// the base setUp and restored in the base tearDown — a test that registers or
	// wipes a namespace here can't leak it into the next test class.

	public function test_register_and_lookup_node_by_name(): void {
		$obj = new \Newspack_Nodes\Node();
		Core::register_node( 'foo', $obj );
		$this->assertSame( $obj, Core::node( 'foo' ) );
	}

	public function test_lookup_missing_node_returns_null(): void {
		$this->assertNull( Core::node( 'nonexistent' ) );
	}

	public function test_as_int_casts_scalars_and_zeroes_non_scalars(): void {
		$this->assertSame( 42, Core::as_int( '42' ) );
		$this->assertSame( 42, Core::as_int( 42.9 ) );
		$this->assertSame( 1, Core::as_int( true ) );
		$this->assertSame( 0, Core::as_int( 'abc' ) );
		$this->assertSame( 0, Core::as_int( null ) );
		$this->assertSame( 0, Core::as_int( [ 3 ] ) );
	}

	public function test_as_float_casts_scalars_and_zeroes_non_scalars(): void {
		$this->assertSame( 1.5, Core::as_float( '1.5' ) );
		$this->assertSame( 3.0, Core::as_float( 3 ) );
		$this->assertSame( 0.0, Core::as_float( null ) );
		$this->assertSame( 0.0, Core::as_float( [ 1.5 ] ) );
	}

	public function test_num_int_zeroes_everything_non_numeric(): void {
		$this->assertSame( 42, Core::num_int( '42' ) );
		$this->assertSame( 42, Core::num_int( 42.9 ) );
		$this->assertSame( 0, Core::num_int( true ), 'bool is corrupt data on a math path' );
		$this->assertSame( 0, Core::num_int( '12abc' ), 'partial-numeric string must not partially parse' );
		$this->assertSame( 0, Core::num_int( null ) );
		$this->assertSame( 0, Core::num_int( [ 3 ] ) );
	}

	public function test_coercion_helpers_take_an_optional_default_for_the_miss_case(): void {
		$this->assertSame( 7, Core::as_int( null, 7 ) );
		$this->assertSame( 42, Core::as_int( '42', 7 ), 'default only applies on a miss' );
		$this->assertSame( 1.5, Core::as_float( [], 1.5 ) );
		$this->assertSame( 'localhost', Core::as_string( null, 'localhost' ) );
		$this->assertSame( 86400, Core::num_int( 'abc', 86400 ) );
		$this->assertSame( 9.9, Core::num_float( true, 9.9 ) );
	}

	public function test_str_passes_strings_through_and_defaults_everything_else(): void {
		$this->assertSame( 'abc', Core::str( 'abc' ) );
		$this->assertSame( '', Core::str( 5 ), 'no casting — an int is not a string' );
		$this->assertSame( '', Core::str( true ) );
		$this->assertSame( '', Core::str( null ) );
		$this->assertSame( 'GET', Core::str( null, 'GET' ) );
		$this->assertSame( 'abc', Core::str( 'abc', 'GET' ), 'default only applies on a miss' );
	}

	public function test_arr_passes_arrays_through_and_defaults_everything_else(): void {
		$this->assertSame( [ 1, 2 ], Core::arr( [ 1, 2 ] ) );
		$this->assertSame( [], Core::arr( 'abc' ) );
		$this->assertSame( [], Core::arr( null ) );
		$this->assertSame( [ 'x' => 1 ], Core::arr( 5, [ 'x' => 1 ] ) );
	}

	public function test_int_passes_ints_through_and_defaults_everything_else(): void {
		$this->assertSame( 64, Core::int( 64 ) );
		$this->assertSame( 0, Core::int( '64' ), 'no coercion — a numeric string is not an int' );
		$this->assertSame( 0, Core::int( 6.4 ) );
		$this->assertSame( 0, Core::int( null ) );
		$this->assertSame( 1, Core::int( 'x', 1 ) );
	}

	public function test_num_float_zeroes_everything_non_numeric(): void {
		$this->assertSame( 1.5, Core::num_float( '1.5' ) );
		$this->assertSame( 3.0, Core::num_float( 3 ) );
		$this->assertSame( 0.0, Core::num_float( true ) );
		$this->assertSame( 0.0, Core::num_float( 'abc' ) );
		$this->assertSame( 0.0, Core::num_float( null ) );
	}

	public function test_unregister_removes_node(): void {
		Core::register_node( 'foo', new \Newspack_Nodes\Node() );
		Core::unregister_node( 'foo' );
		$this->assertNull( Core::node( 'foo' ) );
	}

	public function test_resolve_config_tokens_substitutes_registered_namespace(): void {
		Core::register_config_namespace(
			'config',
			static fn ( string $key ): string => 'logs_dir' === $key ? '/data/logs' : ''
		);

		$this->assertSame(
			'/data/logs/req.p0',
			Core::resolve_config_tokens( '<config:logs_dir>/req.p0' )
		);
	}

	public function test_resolve_config_tokens_replaces_unknown_token_with_empty(): void {
		Core::$config_resolvers = [];

		$this->assertSame(
			'/req.p0',
			Core::resolve_config_tokens( '<config:logs_dir>/req.p0' )
		);
	}

	public function test_resolve_partition_template_substitutes_both_token_forms_and_config(): void {
		// The shared partition-token resolver: both `<partition>` angle and
		// `{partition}` curly become $p, then `<ns:key>` config tokens resolve.
		Core::register_config_namespace(
			'config',
			static fn ( string $key ): string => 'logs_dir' === $key ? '/data/logs' : ''
		);

		$this->assertSame( 'firehose.p3', Core::resolve_partition_template( 'firehose.p<partition>', 3 ) );
		$this->assertSame( 'firehose.p3', Core::resolve_partition_template( 'firehose.p{partition}', 3 ) );
		$this->assertSame(
			'/data/logs/firehose.p2',
			Core::resolve_partition_template( '<config:logs_dir>/firehose.p<partition>', 2 )
		);
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

	public function test_right_now_refreshes_and_returns_the_cached_clock(): void {
		Core::$now = 1.0; // distinct from the 0.0 default AND from any real microtime
		$r = Core::right_now();
		$this->assertGreaterThan( 1.0, $r, 'right_now() must read the live clock, not the seeded sentinel' );
		$this->assertSame( $r, Core::$now, 'right_now() must store what it returns into Core::$now' );
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

	public function test_print_less_often_emits_first_occurrence(): void {
		$buf = '';
		Core::set_stderr_handler( function ( $message ) use ( &$buf ) { $buf .= $message; } );
		Core::print_less_often( 'first warning' );
		$this->assertStringContainsString( 'first warning', $buf );
	}

	public function test_print_less_often_suppresses_within_60s(): void {
		$buf = '';
		Core::set_stderr_handler( function ( $message ) use ( &$buf ) { $buf .= $message; } );
		Core::$now = 1000.0;
		Core::print_less_often( 'duplicate' );
		Core::$now = 1030.0; // 30s later — within window
		Core::print_less_often( 'duplicate' );
		$this->assertSame( 1, \substr_count( $buf, 'duplicate' ) );
	}

	public function test_print_less_often_throttles_on_prefix_only_and_prints_varying_payload(): void {
		// The throttle key is the first arg (stable category); varying payload
		// args print on the first occurrence but never widen the key.
		$buf = '';
		Core::set_stderr_handler( function ( $message ) use ( &$buf ) { $buf .= $message; } );
		Core::print_less_often( 'transport error ', '28', ' on ', 'austin' );
		Core::print_less_often( 'transport error ', '52', ' on ', 'burlington' );
		$this->assertSame( 1, \substr_count( $buf, 'transport error' ), 'flood collapses to one emission under the stable prefix' );
		$this->assertStringContainsString( 'transport error 28 on austin', $buf, 'the one emission carries the first payload' );
	}

	public function test_emit_stderr_falls_back_when_handler_re_enters(): void {
		// Handler that synchronously re-emits via print_less_often. Without
		// the re-entry guard this recurses until the stack blows.
		$outer_called = 0;
		$inner_called = 0;
		Core::set_stderr_handler(
			function ( $message ) use ( &$outer_called, &$inner_called ) {
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
			function ( $message ) use ( &$call ) {
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
		// must surface there as a TM_BYTESTREAM (it also persists to error_log; see
		// test_stderr_default_handler_also_persists_to_error_log).
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
		// body) — and also persists to error_log.
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

	public function test_stderr_default_handler_also_persists_to_error_log(): void {
		// The REPL/SSE/OUTPUT broadcast is ephemeral — once the session ends the
		// line is gone. stderr must ALSO write error_log so worker-stop + dead-letter
		// alerts survive in debug.log (locally) / php-errors (Atomic), even when a
		// sink is wired.
		Core::reset();
		$out = new Capture_Sink_Node();
		Core::register_node( Node_Names::OUTPUT, $out );

		$tmp = \tempnam( \sys_get_temp_dir(), 'nodes-stderr-dur-' );
		$old = \ini_set( 'error_log', $tmp );
		try {
			Core::stderr( 'durable line' );
		} finally {
			\ini_set( 'error_log', false === $old ? '' : $old );
		}

		$this->assertCount( 1, $out->captured, 'still broadcasts to the wired sink' );
		$this->assertStringContainsString(
			'durable line',
			(string) \file_get_contents( $tmp ),
			'and also persists to error_log'
		);
		@\unlink( $tmp );
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
		Core::set_stderr_handler( static function ( string $message ): void {} );

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

	public function test_prune_logs_evicts_entries_older_than_timeout(): void {
		// prune_logs() removes recent_log_timers entries older than the
		// timeout; the next rate-limiter call then re-emits. Mirrors Perl
		// Tachikoma Router::update_logs.
		$buf = '';
		Core::set_stderr_handler( function ( $message ) use ( &$buf ) { $buf .= $message; } );

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
		$this->assertCount( 100, $ref->getValue() );
	}

	// ── stderr in_stderr re-entry guard exits via error_log ─────────────

	public function test_stderr_re_entry_lands_on_error_log_fallback(): void {
		// Direct re-entry through stderr() (vs going through print_less_often):
		// during the first call, the handler itself calls Core::stderr().
		// The dispatcher's in_stderr flag is set, so the second call hits the
		// guard and routes to PHP's error_log() instead of the handler.
		Core::set_stderr_handler( function ( string $message ): void {
			if ( \strpos( $message, 'first' ) !== false ) {
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

	public function test_log_prefix_no_args_returns_dated_prefix(): void {
		// log_prefix is the timestamp only now — the "<host> <$0>[<pid>]: " process identity
		// split out into log_midfix. With no args it returns just the prefix (no newline).
		$prefix = Core::log_prefix();
		$this->assertMatchesRegularExpression( '/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC $/', $prefix );
	}

	public function test_log_midfix_no_args_returns_process_identity(): void {
		// log_midfix carries the "<hostname> <$0>[<pid>]: " identity split out of log_prefix.
		$midfix = Core::log_midfix();
		$this->assertMatchesRegularExpression( '/^.+\[\d+\]: $/', $midfix );
	}

	public function test_log_prefix_and_midfix_compose_the_full_line(): void {
		// The production line is log_prefix( log_midfix( text ) ): timestamp, then identity,
		// then the message — the composition the real stderr handler applies.
		$full = Core::log_prefix( Core::log_midfix( 'a warning' ) );
		$this->assertMatchesRegularExpression( '/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC .+\[\d+\]: a warning\n$/', $full );
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
			$this->assertMatchesRegularExpression( '/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC line (one|two)$/', $part );
		}
	}

	public function test_log_prefix_chomps_trailing_newline_before_prefixing(): void {
		// A pre-newlined message must not yield a blank prefixed line at the end.
		$line = Core::log_prefix( "trailing\n" );
		$this->assertSame( 1, \substr_count( $line, "\n" ) );
		$this->assertStringEndsWith( "trailing\n", $line );
	}

	public function test_stderr_midfixes_text_before_the_handler(): void {
		// Core::stderr now applies the process-identity midfix (host argv0[pid]:)
		// ONCE, centrally, before handing to the stderr handler — the handler adds
		// only the timestamp prefix (log_prefix). Previously the midfix lived in
		// the handler, which diverged the dmesg ring (recent_log) from live output.
		// The full composition is covered by test_log_prefix_and_midfix_compose_the_full_line.
		$buf = '';
		Core::set_stderr_handler( function ( $message ) use ( &$buf ) { $buf .= $message; } );
		Core::stderr( 'a warning' );
		$this->assertSame( Core::log_midfix( 'a warning' ), $buf );
	}

	public function test_stderr_midfixes_even_already_dated_text(): void {
		// The old Tachikoma date-guard (write already-YYYY-MM-DD text verbatim) is
		// gone: the midfix is applied once in Core::stderr for EVERY line, so text
		// that happens to start with a date is midfixed like anything else — the
		// host/pid midfix leads, the embedded date trails in the body.
		$buf = '';
		Core::set_stderr_handler( function ( $message ) use ( &$buf ) { $buf .= $message; } );
		Core::stderr( '2026-05-22 00:00:00 UTC already dated' );
		$this->assertSame( Core::log_midfix( '2026-05-22 00:00:00 UTC already dated' ), $buf );
		// Not special-cased: the line leads with the midfix, not the embedded date.
		$this->assertSame( 0, \preg_match( '/^\d{4}-\d\d-\d\d/', $buf ) );
		$this->assertStringStartsWith( Core::log_midfix(), $buf );
	}

	public function test_print_less_often_routes_through_stderr(): void {
		// The rate-limited helper still routes its text through stderr() (the handler prefixes);
		// prove the routing by capturing the emitted text.
		$buf = '';
		Core::set_stderr_handler( function ( $message ) use ( &$buf ) { $buf .= $message; } );
		Core::print_less_often( 'rate limited msg' );
		$this->assertStringContainsString( 'rate limited msg', $buf );
	}

	public function test_print_less_often_keys_by_log_midfix(): void {
		// Core and a named Node share Core::$recent_log_timers. Core keys by
		// its own (un-tagged) log_midfix while Node keys by "<name>: text", so
		// the same raw text from each does not collide — both emit.
		$buf = '';
		Core::set_stderr_handler( function ( $message ) use ( &$buf ) { $buf .= $message; } );
		$node = new \Newspack_Nodes\Node();
		$node->name( 'alice' );
		Core::print_less_often( 'same text' );
		$node->print_less_often( 'same text' );
		$this->assertSame( 2, \substr_count( $buf, 'same text' ) );
		$this->assertStringContainsString( 'alice: same text', $buf );
	}

	// ── fire_and_forget_post (shared raw-curl spawn POST helper) ───────────────

	public function test_fire_and_forget_post_rejects_empty_url(): void {
		$this->assertSame( 'empty url', Core::fire_and_forget_post( '', [ 'type' => 'x' ] ) );
	}

	public function test_fire_and_forget_post_invokes_curl_exec_seam_with_url_and_body(): void {
		$seen = [];
		Core::$curl_exec = static function ( \CurlHandle $ch, array $body ) use ( &$seen ) {
			$seen[] = [
				'url'  => (string) \curl_getinfo( $ch, \CURLINFO_EFFECTIVE_URL ),
				'body' => $body,
			];
			return false; // fire-and-forget: no response expected.
		};

		$err = Core::fire_and_forget_post( 'http://example.test/spawn', [ 'type' => 'firehose', 'partition' => 2 ] );

		// errno is 0 (the seam never raised one) → treated as success.
		$this->assertNull( $err );
		$this->assertCount( 1, $seen );
		$this->assertSame( 'http://example.test/spawn', $seen[0]['url'] );
		$this->assertSame( [ 'type' => 'firehose', 'partition' => 2 ], $seen[0]['body'] );
	}

	public function test_fire_and_forget_post_returns_error_string_on_curl_failure(): void {
		// Use the real libcurl call (null seam) against an unsupported protocol so
		// a deterministic, non-timeout errno exercises the error-classification branch.
		Core::$curl_exec = null;
		$err = Core::fire_and_forget_post( 'gopher-bogus://nowhere', [ 'type' => 'x' ] );
		$this->assertNotNull( $err );
		$this->assertNotSame( '', $err );
	}
	/**
	 * The spawn POST carries the rotating spawn token, and Spawn_Controller
	 * accepts that token BEFORE the capability and nonce checks — so anyone who
	 * can answer for the site's own hostname could present any certificate and
	 * capture it. Verification is on by default; the knob exists because a
	 * self-signed internal certificate is a real deployment.
	 */
	public function test_the_spawn_post_verifies_tls_by_default(): void {
		$opts = ( new \ReflectionMethod( Core::class, 'post_curl_options' ) )
			->invoke( null, 'https://example.test/spawn', 'a=b' );

		$this->assertSame( 2, $opts[ \CURLOPT_SSL_VERIFYHOST ] );
		$this->assertTrue( $opts[ \CURLOPT_SSL_VERIFYPEER ] );
	}

	public function test_the_spawn_post_honours_the_verification_opt_out(): void {
		Core::$verify_spawn_tls = false;
		try {
			$opts = ( new \ReflectionMethod( Core::class, 'post_curl_options' ) )
				->invoke( null, 'https://example.test/spawn', 'a=b' );
		} finally {
			Core::$verify_spawn_tls = true;
		}

		$this->assertSame( 0, $opts[ \CURLOPT_SSL_VERIFYHOST ] );
		$this->assertFalse( $opts[ \CURLOPT_SSL_VERIFYPEER ] );
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
