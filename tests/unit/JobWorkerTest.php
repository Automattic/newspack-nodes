<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Job_Worker_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Job_Worker_Node::class )]
class JobWorkerTest extends TestCase {

	protected function setUp(): void {
		parent::setUp();
		// Wipe filter/action state between tests so handler-loading and the
		// before/after-job extension listeners don't leak across cases.
		$GLOBALS['_wp_actions'] = [];
	}

	/**
	 * Build a TM_STRUCT message in the canonical jobs.log shape:
	 *   { k, handler, parameters, ts }
	 */
	private function job_message( string $handler, array $parameters = [], string $kind = 'job' ): array {
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_STRUCT;
		$message[ Message::VALUE ] = [
			'k'          => $kind,
			'handler'    => $handler,
			'parameters' => $parameters,
			'ts'         => 1700000000.0,
		];
		return $message;
	}

	public function test_executes_job_via_handler(): void {
		$jw = new Job_Worker_Node();
		$received = null;
		$this->register_job_handler( $jw, 'a', function ( $payload ) use ( &$received ) {
			$received = $payload;
		} );

		$message = $this->job_message( 'a', [ 'x' => 1 ] );
		$jw->fill( $message );

		$this->assertSame( [ 'x' => 1 ], $received );
		$this->assertSame( 1, $this->jobs_executed( $jw ) );
	}

	// --- Before/after-job extension point -----------------------------------

	public function test_before_and_after_job_actions_fire_with_handler(): void {
		$jw = new Job_Worker_Node();
		$this->register_job_handler( $jw, 'ctx', fn ( $p ) => null );

		$seen = [];
		add_action( 'newspack_nodes/job_worker/before_job', function ( $h ) use ( &$seen ) { $seen[] = "before:$h"; } );
		add_action( 'newspack_nodes/job_worker/after_job', function ( $h ) use ( &$seen ) { $seen[] = "after:$h"; } );

		$message = $this->job_message( 'ctx' );
		$jw->fill( $message );

		$this->assertSame( [ 'before:ctx', 'after:ctx' ], $seen );
	}

	public function test_after_job_action_fires_even_when_handler_throws(): void {
		$jw = new Job_Worker_Node();
		$this->register_job_handler( $jw, 'boom', function () { throw new \RuntimeException( 'x' ); } );

		$after = 0;
		add_action( 'newspack_nodes/job_worker/after_job', function () use ( &$after ) { ++$after; } );

		$message = $this->job_message( 'boom' );
		$jw->fill( $message ); // swallowed

		$this->assertSame( 1, $after );
		$this->assertSame( 1, $this->jobs_executed( $jw ) );
	}

	public function test_after_job_fires_and_worker_survives_when_before_job_listener_throws(): void {
		// before_job is a public extension point: an arbitrary plugin listener
		// may throw. fill() must NOT let that escape (it would crash the whole
		// Consumer drain batch) and must STILL fire after_job (else an app's
		// logger left suspended in before_job never resumes).
		$jw = new Job_Worker_Node();
		$handler_ran = false;
		$this->register_job_handler( $jw, 'ctx', function () use ( &$handler_ran ) { $handler_ran = true; } );

		$after = 0;
		add_action( 'newspack_nodes/job_worker/before_job', function () { throw new \RuntimeException( 'listener boom' ); } );
		add_action( 'newspack_nodes/job_worker/after_job', function () use ( &$after ) { ++$after; } );

		$message = $this->job_message( 'ctx' );
		$jw->fill( $message ); // must not throw out of fill()

		$this->assertSame( 1, $after, 'after_job must fire even when a before_job listener throws' );
		$this->assertFalse( $handler_ran, 'handler is skipped when before_job throws' );
		$this->assertSame( 1, $this->jobs_executed( $jw ) );
	}

	public function test_no_actions_wired_still_dispatches(): void {
		// A worker with no before/after listeners (e.g. a non-event-logger
		// consumer of the substrate) must dispatch normally.
		$jw = new Job_Worker_Node();
		$ran = false;
		$this->register_job_handler( $jw, 'plain', function () use ( &$ran ) { $ran = true; } );

		$message = $this->job_message( 'plain' );
		$jw->fill( $message );

		$this->assertTrue( $ran );
		$this->assertSame( 1, $this->jobs_executed( $jw ) );
	}

	// --- Non-array VALUE handling ------------------------------------------

	public function test_non_array_value_is_dropped(): void {
		$jw = new Job_Worker_Node();
		$called = false;
		$this->register_job_handler( $jw, 'deep', function () use ( &$called ) { $called = true; } );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_STRUCT;
		$message[ Message::VALUE ] = 'not-an-array';
		$jw->fill( $message );

		$this->assertFalse( $called, 'non-array VALUE must not reach the handler' );
		$this->assertSame( 0, $this->jobs_executed( $jw ) );
	}

	public function test_handler_exception_caught_and_logged(): void {
		$jw = new Job_Worker_Node();
		$this->register_job_handler( $jw, 'boom', function () { throw new \RuntimeException( 'x' ); } );

		$message = $this->job_message( 'boom' );
		$jw->fill( $message );
		$this->assertSame( 1, $this->jobs_executed( $jw ) );
	}

	// --- Constructor params + getters ---------------------------------------

	public function test_default_stale_timeout_is_600(): void {
		$jw = new Job_Worker_Node();
		$this->assertSame( 600, $this->read_private( $jw, 'stale_timeout' ) );
	}

	public function test_default_max_runtime_is_600(): void {
		$jw = new Job_Worker_Node();
		$this->assertSame( 600, $this->read_private( $jw, 'max_runtime' ) );
	}

	public function test_constructor_overrides_stale_and_runtime(): void {
		$jw = new Job_Worker_Node();
		$jw->arguments( '10 1200 1200' );
		$this->assertSame( 1200, $this->read_private( $jw, 'stale_timeout' ) );
		$this->assertSame( 1200, $this->read_private( $jw, 'max_runtime' ) );
	}

	public function test_cache_flush_interval_default_is_50(): void {
		$jw = new Job_Worker_Node();
		$this->register_job_handler( $jw, 'noop', fn ( $p ) => null );

		for ( $i = 0; $i < 51; ++$i ) {
			$message = $this->job_message( 'noop' );
			$jw->fill( $message );
		}

		$this->assertSame( 51, $this->jobs_executed( $jw ) );
	}

	// --- Memory pressure ----------------------------------------------------

	public function test_memory_pressure_starts_false(): void {
		$jw = new Job_Worker_Node();
		$this->assertFalse( $this->read_private( $jw, 'memory_pressure' ) );
	}

	public function test_is_memory_high_returns_false_when_limit_unlimited(): void {
		$prev = ini_set( 'memory_limit', '-1' );
		try {
			$jw = new Job_Worker_Node();
			$this->assertFalse( $jw->is_memory_high() );
		} finally {
			if ( false !== $prev ) {
				ini_set( 'memory_limit', $prev );
			}
		}
	}

	// --- Kind validation ----------------------------------------------------

	public function test_non_job_lines_are_skipped(): void {
		$jw = new Job_Worker_Node();
		$called = false;
		$this->register_job_handler( $jw, 'noop', function () use ( &$called ) { $called = true; } );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_STRUCT;
		$message[ Message::VALUE ] = [ 'k' => 'start', 'handler' => 'noop', 'parameters' => [] ];
		$jw->fill( $message );

		$this->assertFalse( $called );
		$this->assertSame( 0, $this->jobs_executed( $jw ) );
	}

	// --- Canonical `k` discriminator (jobs.log / jobintake.log wire shape) ---

	public function test_dispatches_local_entry_keyed_by_k(): void {
		// jobs.log + jobintake.log entries carry the job kind under `k` — the
		// firehose category field, written verbatim by Job_Intake and carried
		// through by Job_Router. Job_Worker must dispatch on `k`, not `type`.
		$jw = new Job_Worker_Node();
		$received = null;
		$this->register_job_handler( $jw, 'evtemplate', function ( $p ) use ( &$received ) { $received = $p; } );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_STRUCT;
		$message[ Message::VALUE ] = [
			'k'          => 'job',
			'handler'    => 'evtemplate',
			'parameters' => [ 'template' => 'Tools/ImportFilmTimes.html' ],
			'ts'         => 1700000000.0,
		];
		$jw->fill( $message );

		$this->assertSame( [ 'template' => 'Tools/ImportFilmTimes.html' ], $received );
		$this->assertSame( 1, $this->jobs_executed( $jw ) );
	}

	public function test_dispatches_remote_entry_keyed_by_k(): void {
		$jw = new Job_Worker_Node();
		$received = null;
		$this->register_job_handler( $jw, 'hub_op', function ( $p ) use ( &$received ) { $received = $p; }, true );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_STRUCT;
		$message[ Message::VALUE ] = [
			'k'          => 'remote_job',
			'handler'    => 'hub_op',
			'parameters' => [ 'a' => 1 ],
			'ts'         => 1700000000.0,
		];
		$jw->fill( $message );

		$this->assertSame( [ 'a' => 1 ], $received );
		$this->assertSame( 1, $this->jobs_executed( $jw ) );
	}

	// --- Local vs. remote handler split -------------------------------------

	public function test_local_handler_dispatches_for_type_job(): void {
		$jw = new Job_Worker_Node();
		$received = null;
		$this->register_job_handler( $jw, 'sync', function ( $p ) use ( &$received ) { $received = $p; } );

		$message = $this->job_message( 'sync', [ 'k' => 'v' ], 'job' );
		$jw->fill( $message );

		$this->assertSame( [ 'k' => 'v' ], $received );
	}

	public function test_remote_handler_dispatches_for_type_remote_job(): void {
		$jw = new Job_Worker_Node();
		$received = null;
		$this->register_job_handler( $jw, 'hub_op', function ( $p ) use ( &$received ) { $received = $p; }, true );

		$message = $this->job_message( 'hub_op', [ 'a' => 1 ], 'remote_job' );
		$jw->fill( $message );

		$this->assertSame( [ 'a' => 1 ], $received );
	}

	public function test_local_handler_does_not_handle_remote_job(): void {
		$jw = new Job_Worker_Node();
		$called = false;
		$this->register_job_handler( $jw, 'priv', function () use ( &$called ) { $called = true; } );

		$message = $this->job_message( 'priv', [], 'remote_job' );
		$jw->fill( $message );

		$this->assertFalse( $called );
		$this->assertSame( 0, $this->jobs_executed( $jw ) );
	}

	public function test_remote_handler_does_not_handle_local_job(): void {
		$jw = new Job_Worker_Node();
		$called = false;
		$this->register_job_handler( $jw, 'priv', function () use ( &$called ) { $called = true; }, true );

		$message = $this->job_message( 'priv', [], 'job' );
		$jw->fill( $message );

		$this->assertFalse( $called );
	}

	public function test_same_handler_name_in_both_buckets_dispatches_both(): void {
		$jw = new Job_Worker_Node();
		$local_calls = 0;
		$remote_calls = 0;
		$this->register_job_handler( $jw, 'evTemplate', function () use ( &$local_calls ) { ++$local_calls; } );
		$this->register_job_handler( $jw, 'evTemplate', function () use ( &$remote_calls ) { ++$remote_calls; }, true );

		$message = $this->job_message( 'evTemplate', [], 'job' );
		$jw->fill( $message );
		$message = $this->job_message( 'evTemplate', [], 'remote_job' );
		$jw->fill( $message );
		$message = $this->job_message( 'evTemplate', [], 'job' );
		$jw->fill( $message );

		$this->assertSame( 2, $local_calls );
		$this->assertSame( 1, $remote_calls );
	}

	public function test_load_handlers_from_filters_pulls_both_buckets(): void {
		add_filter( 'newspack_nodes/job_handlers', function ( $h ) {
			$h['local_only']  = fn () => null;
			$h['shared']      = fn () => null;
			return $h;
		} );
		add_filter( 'newspack_nodes/remote_job_handlers', function ( $h ) {
			$h['remote_only'] = fn () => null;
			$h['shared']      = fn () => null;
			return $h;
		} );

		$jw = new Job_Worker_Node();
		$jw->load_handlers_from_filters();

		$this->assertSame( [ 'local_only', 'shared' ], \array_keys( (array) $this->read_private( $jw, 'local_handlers' ) ) );
		$this->assertSame( [ 'remote_only', 'shared' ], \array_keys( (array) $this->read_private( $jw, 'remote_handlers' ) ) );
	}

	public function test_load_handlers_from_filters_skips_invalid_names(): void {
		add_filter( 'newspack_nodes/job_handlers', function ( $h ) {
			$h['valid']        = fn () => null;
			$h['1bad-leading'] = fn () => null;
			$h['ok']           = 'not-a-callable';
			return $h;
		} );

		$jw = new Job_Worker_Node();
		$jw->load_handlers_from_filters();

		// Only the valid, callable entry survives: bad name + non-callable skipped.
		$this->assertSame( [ 'valid' ], \array_keys( (array) $this->read_private( $jw, 'local_handlers' ) ) );
	}

	// ── Sibling interpreter + eager handler loading ─────────────────────

	public function test_job_worker_has_no_sibling_interpreter(): void {
		$jw = new Job_Worker_Node();
		$jw->name( 'jw' );
		$this->assertNull( $this->read_private( $jw, 'interpreter' ) );
	}

	public function test_job_worker_ctor_eager_loads_handlers_from_filters(): void {
		\add_filter(
			'newspack_nodes/job_handlers',
			static fn ( $h ) => \array_merge( (array) $h, [ 'ctor_test' => static fn () => null ] )
		);
		\add_filter(
			'newspack_nodes/remote_job_handlers',
			static fn ( $h ) => \array_merge( (array) $h, [ 'ctor_remote' => static fn () => null ] )
		);
		$jw = new Job_Worker_Node();
		$this->assertContains( 'ctor_test', \array_keys( (array) $this->read_private( $jw, 'local_handlers' ) ) );
		$this->assertContains( 'ctor_remote', \array_keys( (array) $this->read_private( $jw, 'remote_handlers' ) ) );
	}

	public function test_job_worker_node_schema_no_verbs(): void {
		$schema = Job_Worker_Node::node_schema();
		$this->assertSame( 'Control', $schema['category'] );
		$this->assertSame( [], $schema['commands'] );
	}

	public function test_job_worker_node_schema_declares_get_health_request(): void {
		$schema = Job_Worker_Node::node_schema();
		$this->assertArrayHasKey( 'requests', $schema );
		$request_names = \array_column( $schema['requests'], 'name' );
		$this->assertContains( 'GET_HEALTH', $request_names );
	}

	// --- Constructor clamping ----------------------------------------------

	public function test_constructor_clamps_zero_or_negative_to_one(): void {
		$jw = new Job_Worker_Node();
		$jw->arguments( '0 0 -5' );
		$this->assertSame( 1, $this->read_private( $jw, 'stale_timeout' ) );
		$this->assertSame( 1, $this->read_private( $jw, 'max_runtime' ) );

		$this->register_job_handler( $jw, 'noop', fn () => null );
		$message = $this->job_message( 'noop' );
		$jw->fill( $message );
		$message = $this->job_message( 'noop' );
		$jw->fill( $message );
		$this->assertSame( 2, $this->jobs_executed( $jw ) );
	}

	// --- fill(): malformed messages ----------------------------------------

	public function test_fill_drops_non_struct_messages(): void {
		$jw = new Job_Worker_Node();
		$called = false;
		$this->register_job_handler( $jw, 'noop', function () use ( &$called ) { $called = true; } );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::VALUE ] = 'not-a-struct';
		$jw->fill( $message );

		$this->assertFalse( $called );
		$this->assertSame( 0, $this->jobs_executed( $jw ) );
	}

	public function test_fill_drops_oversized_entries(): void {
		$jw = new Job_Worker_Node();
		$called = false;
		$this->register_job_handler( $jw, 'big', function () use ( &$called ) { $called = true; } );

		$huge_param = \str_repeat( 'x', Job_Worker_Node::MAX_JOB_SIZE + 1024 );
		$message = $this->job_message( 'big', [ 'blob' => $huge_param ] );
		$jw->fill( $message );

		$this->assertFalse( $called );
		$this->assertSame( 0, $this->jobs_executed( $jw ) );
	}

	public function test_fill_drops_entries_with_invalid_handler_name(): void {
		$jw = new Job_Worker_Node();
		$message = $this->job_message( 'bad name with spaces' );
		$jw->fill( $message );
		$this->assertSame( 0, $this->jobs_executed( $jw ) );
	}

	public function test_fill_drops_unregistered_handler_name(): void {
		$jw = new Job_Worker_Node();
		$message = $this->job_message( 'never_registered' );
		$jw->fill( $message );
		$this->assertSame( 0, $this->jobs_executed( $jw ) );
	}

	// --- handle_request: GET_HEALTH + unknown verb ----------------------------

	public function test_handle_request_get_health_returns_payload(): void {
		$jw = new Job_Worker_Node();
		$this->register_job_handler( $jw, 'a', fn () => null );
		$this->register_job_handler( $jw, 'b', fn () => null );
		$this->register_job_handler( $jw, 'c', fn () => null, true );

		$sink = new Capture_Sink_Node();
		$jw->sink( $sink );

		$req                   = Message::new_message();
		$req[ Message::TYPE ]  = Message::TM_REQUEST;
		$req[ Message::FROM ]  = 'caller';
		$req[ Message::ID ]    = 'corr-1';
		$req[ Message::KEY ]   = 'app-key';
		$req[ Message::VALUE ] = 'GET_HEALTH';
		$jw->fill( $req );

		$this->assertCount( 1, $sink->captured );
		$reply = $sink->captured[0];
		$this->assertSame(
			Message::TM_RESPONSE | Message::TM_STRUCT,
			$reply[ Message::TYPE ]
		);
		$this->assertSame( 'caller', $reply[ Message::TO ] );
		$this->assertSame( 'corr-1', $reply[ Message::ID ] );
		$this->assertSame( 'app-key', $reply[ Message::KEY ] );

		$value = $reply[ Message::VALUE ];
		$this->assertIsArray( $value );
		$this->assertSame( 'GET_HEALTH', $value['verb'] );

		$payload = $value['data'];
		$this->assertIsArray( $payload );
		$this->assertArrayHasKey( 'memory_used_mb', $payload );
		$this->assertArrayHasKey( 'memory_limit_mb', $payload );
		$this->assertArrayHasKey( 'memory_pressure', $payload );
		$this->assertArrayHasKey( 'jobs_since_cache_flush', $payload );
		$this->assertArrayHasKey( 'cache_flush_interval', $payload );
		$this->assertSame( 2, $payload['local_handler_count'] );
		$this->assertSame( 1, $payload['remote_handler_count'] );
		$this->assertGreaterThanOrEqual( 1, $payload['counter'] );
		$this->assertFalse( $payload['memory_pressure'] );
	}

	public function test_handle_request_unknown_verb_returns_error_payload(): void {
		$jw = new Job_Worker_Node();
		$sink = new Capture_Sink_Node();
		$jw->sink( $sink );

		$req                   = Message::new_message();
		$req[ Message::TYPE ]  = Message::TM_REQUEST;
		$req[ Message::FROM ]  = 'caller';
		$req[ Message::ID ]    = 'corr-2';
		$req[ Message::VALUE ] = 'BOGUS_VERB';
		$jw->fill( $req );

		$this->assertCount( 1, $sink->captured );
		$value = $sink->captured[0][ Message::VALUE ];
		$this->assertSame( 'BOGUS_VERB', $value['verb'] );
		$this->assertArrayHasKey( 'error', $value['data'] );
		$this->assertStringContainsString( 'BOGUS_VERB', $value['data']['error'] );
	}

	public function test_handle_request_uppercases_verb(): void {
		$jw = new Job_Worker_Node();
		$sink = new Capture_Sink_Node();
		$jw->sink( $sink );

		$req                   = Message::new_message();
		$req[ Message::TYPE ]  = Message::TM_REQUEST;
		$req[ Message::FROM ]  = 'caller';
		$req[ Message::ID ]    = 'corr-3';
		$req[ Message::VALUE ] = 'get_health';
		$jw->fill( $req );

		$this->assertSame( 'GET_HEALTH', $sink->captured[0][ Message::VALUE ]['verb'] );
	}

	public function test_handle_request_ignores_response_messages(): void {
		$jw = new Job_Worker_Node();
		$sink = new Capture_Sink_Node();
		$jw->sink( $sink );

		$req                   = Message::new_message();
		$req[ Message::TYPE ]  = Message::TM_STRUCT | Message::TM_RESPONSE;
		$req[ Message::FROM ]  = 'caller';
		$req[ Message::VALUE ] = 'GET_HEALTH';
		$jw->fill( $req );

		$this->assertCount( 0, $sink->captured );
	}

	// --- memory_limit_bytes: every unit suffix --------------------------------

	public function test_memory_limit_bytes_parses_g_suffix(): void {
		$prev = \ini_set( 'memory_limit', '2G' );
		try {
			$jw  = new Job_Worker_Node();
			$ref = new \ReflectionMethod( Job_Worker_Node::class, 'memory_limit_bytes' );
			$ref->setAccessible( true );
			$this->assertSame( 2 * 1024 * 1024 * 1024, $ref->invoke( $jw ) );
		} finally {
			if ( false !== $prev ) {
				\ini_set( 'memory_limit', $prev );
			}
		}
	}

	public function test_memory_limit_bytes_parses_m_suffix(): void {
		$prev = \ini_set( 'memory_limit', '512M' );
		try {
			$jw  = new Job_Worker_Node();
			$ref = new \ReflectionMethod( Job_Worker_Node::class, 'memory_limit_bytes' );
			$ref->setAccessible( true );
			$this->assertSame( 512 * 1024 * 1024, $ref->invoke( $jw ) );
		} finally {
			if ( false !== $prev ) {
				\ini_set( 'memory_limit', $prev );
			}
		}
	}

	public function test_memory_limit_bytes_parses_k_suffix(): void {
		$prev = \ini_set( 'memory_limit', '1048576K' );
		try {
			$jw  = new Job_Worker_Node();
			$ref = new \ReflectionMethod( Job_Worker_Node::class, 'memory_limit_bytes' );
			$ref->setAccessible( true );
			$this->assertSame( 1048576 * 1024, $ref->invoke( $jw ) );
		} finally {
			if ( false !== $prev ) {
				\ini_set( 'memory_limit', $prev );
			}
		}
	}

	public function test_memory_limit_bytes_unlimited_returns_negative_one(): void {
		$prev = \ini_set( 'memory_limit', '-1' );
		try {
			$jw  = new Job_Worker_Node();
			$ref = new \ReflectionMethod( Job_Worker_Node::class, 'memory_limit_bytes' );
			$ref->setAccessible( true );
			$this->assertSame( -1, $ref->invoke( $jw ) );
		} finally {
			if ( false !== $prev ) {
				\ini_set( 'memory_limit', $prev );
			}
		}
	}

	// --- is_memory_high branches ----------------------------------------------

	public function test_is_memory_high_returns_false_below_watermark(): void {
		$prev = \ini_set( 'memory_limit', '16G' );
		try {
			$jw = new Job_Worker_Node();
			$this->assertFalse( $jw->is_memory_high() );
		} finally {
			if ( false !== $prev ) {
				\ini_set( 'memory_limit', $prev );
			}
		}
	}

	public function test_memory_pressure_does_not_latch_when_below_watermark(): void {
		$prev = \ini_set( 'memory_limit', '16G' );
		try {
			$jw = new Job_Worker_Node();
			$this->register_job_handler( $jw, 'noop', fn () => null );
			$this->assertFalse( $this->read_private( $jw, 'memory_pressure' ) );

			$message = $this->job_message( 'noop' );
			$jw->fill( $message );
			$message = $this->job_message( 'noop' );
			$jw->fill( $message );

			$this->assertFalse( $this->read_private( $jw, 'memory_pressure' ) );
		} finally {
			if ( false !== $prev ) {
				\ini_set( 'memory_limit', $prev );
			}
		}
	}

	// --- Cache flush state machine ------------------------------------------

	public function test_cache_flush_state_machine_emits_set_state_event(): void {
		$jw = new Job_Worker_Node();
		$jw->arguments( '3' );
		$this->register_job_handler( $jw, 'noop', fn () => null );

		$ref = new \ReflectionProperty( \Newspack_Nodes\Node::class, 'registrations' );
		$ref->setAccessible( true );
		$registrations             = $ref->getValue( $jw );
		$flush_observed            = [];
		$registrations['CACHE_FLUSH'] = [ 'listener_id' => function ( $payload ) use ( &$flush_observed ) {
			$flush_observed[] = $payload;
			return true; // keep registered
		} ];
		$ref->setValue( $jw, $registrations );

		for ( $i = 0; $i < 3; ++$i ) {
			$message = $this->job_message( 'noop' );
			$jw->fill( $message );
		}
		$this->assertCount( 1, $flush_observed, 'first flush fires at jobs == interval' );
		// CACHE_FLUSH payload is now a flat string (the job count).
		$this->assertSame( '3', $flush_observed[0] );

		for ( $i = 0; $i < 2; ++$i ) {
			$message = $this->job_message( 'noop' );
			$jw->fill( $message );
		}
		$this->assertCount( 1, $flush_observed );

		$message = $this->job_message( 'noop' );
		$jw->fill( $message );
		$this->assertCount( 2, $flush_observed );
	}

	// ── Tachikoma-parity arguments() ────────────────────────────────────

	public function test_constructible_via_no_arg_ctor_and_arguments_setter(): void {
		$jw = new Job_Worker_Node();
		$jw->arguments( '7 120 480' );
		$ref = new \ReflectionClass( $jw );
		$this->assertSame( 7,   $ref->getProperty( 'cache_flush_interval' )->getValue( $jw ) );
		$this->assertSame( 120, $ref->getProperty( 'stale_timeout' )->getValue( $jw ) );
		$this->assertSame( 480, $ref->getProperty( 'max_runtime' )->getValue( $jw ) );
	}

	public function test_arguments_setter_applies_schema_defaults_for_missing_optional_tokens(): void {
		$jw = new Job_Worker_Node();
		$jw->arguments( '' );
		$ref = new \ReflectionClass( $jw );
		$this->assertSame( Job_Worker_Node::CACHE_FLUSH_INTERVAL,   $ref->getProperty( 'cache_flush_interval' )->getValue( $jw ) );
		$this->assertSame( Job_Worker_Node::DEFAULT_STALE_TIMEOUT,  $ref->getProperty( 'stale_timeout' )->getValue( $jw ) );
		$this->assertSame( Job_Worker_Node::DEFAULT_MAX_RUNTIME,    $ref->getProperty( 'max_runtime' )->getValue( $jw ) );

		$jw2 = new Job_Worker_Node();
		$jw2->arguments( '5' );
		$ref2 = new \ReflectionClass( $jw2 );
		$this->assertSame( 5,                                       $ref2->getProperty( 'cache_flush_interval' )->getValue( $jw2 ) );
		$this->assertSame( Job_Worker_Node::DEFAULT_STALE_TIMEOUT,  $ref2->getProperty( 'stale_timeout' )->getValue( $jw2 ) );
		$this->assertSame( Job_Worker_Node::DEFAULT_MAX_RUNTIME,    $ref2->getProperty( 'max_runtime' )->getValue( $jw2 ) );
	}

	public function test_arguments_setter_normalizes_to_minimum_one(): void {
		$jw = new Job_Worker_Node();
		$jw->arguments( '0 -3 -5' );
		$ref = new \ReflectionClass( $jw );
		$this->assertSame( 1, $ref->getProperty( 'cache_flush_interval' )->getValue( $jw ) );
		$this->assertSame( 1, $ref->getProperty( 'stale_timeout' )->getValue( $jw ) );
		$this->assertSame( 1, $ref->getProperty( 'max_runtime' )->getValue( $jw ) );
	}
}
