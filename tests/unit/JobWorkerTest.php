<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Core;
use Newspack_Nodes\Job_Intake;
use Newspack_Nodes\Job_Worker_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Worker_Should_Stop;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use Newspack_Nodes\Tests\TestCase;

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
	 *   { k, handler, parameters, id? }
	 */
	private function job_message( string $handler, array $parameters = [], string $kind = 'job', ?string $id = null, array $extra = [] ): array {
		$entry = [
			'k'          => $kind,
			'handler'    => $handler,
			'parameters' => $parameters,
		] + $extra;
		if ( null !== $id ) {
			$entry['id'] = $id;
		}
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_STRUCT;
		$message[ Message::VALUE ] = $entry;
		return $message;
	}

	public function test_executes_job_via_handler(): void {
		$jw = new Job_Worker_Node();
		$received = null;
		$this->register_job_handler( $jw, 'a', function ( $id, $payload ) use ( &$received ) {
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
		$this->register_job_handler( $jw, 'ctx', fn ( $id, $p ) => null );

		$seen = [];
		// before_job is a filter, so the handler is its SECOND argument.
		add_filter( 'newspack_nodes/job_worker/before_job', function ( $run, $h ) use ( &$seen ) { $seen[] = "before:$h"; return $run; }, 10, 2 );
		add_action( 'newspack_nodes/job_worker/after_job', function ( $h ) use ( &$seen ) { $seen[] = "after:$h"; } );

		$message = $this->job_message( 'ctx' );
		$jw->fill( $message );

		$this->assertSame( [ 'before:ctx', 'after:ctx' ], $seen );
	}

	public function test_a_handler_is_called_with_its_id_first(): void {
		// $id names the request context the job runs in, so it leads. Reversed,
		// a handler receives a string where it declared an array and dies.
		$jw   = new Job_Worker_Node();
		$seen = [];
		$this->register_job_handler(
			$jw,
			'ctx',
			function ( string $id, array $parameters ) use ( &$seen ) {
				$seen = [ $id, $parameters ];
			}
		);

		$jw->fill( $this->job_message( 'ctx', [ 'stage' => 'theaters' ], 'job', 'run-4471' ) );

		$this->assertSame( [ 'run-4471', [ 'stage' => 'theaters' ] ], $seen );
	}

	public function test_before_job_carries_the_job_message(): void {
		// A job's trace has no way back to the record that caused it unless the
		// message itself reaches the listener: FROM names the producer, ID is
		// the segment:offset:length the Consumer stamped, KEY the partition key.
		$jw = new Job_Worker_Node();
		$this->register_job_handler( $jw, 'ctx', fn ( $id, $p ) => null );

		$seen = null;
		add_filter(
			'newspack_nodes/job_worker/before_job',
			function ( $run, $handler, $id, $message ) use ( &$seen ) {
				$seen = $message;
				return $run;
			},
			10,
			4
		);

		$message                  = $this->job_message( 'ctx' );
		$message[ Message::FROM ] = 'jobs.p3';
		$message[ Message::ID ]   = '0:58746220:127';
		$message[ Message::KEY ]  = 'affinity-7719';
		$jw->fill( $message );

		$this->assertIsArray( $seen );
		$this->assertSame( 'jobs.p3', $seen[ Message::FROM ] );
		$this->assertSame( '0:58746220:127', $seen[ Message::ID ] );
		$this->assertSame( 'affinity-7719', $seen[ Message::KEY ] );
	}

	public function test_after_job_action_fires_even_when_handler_throws(): void {
		// after_job runs in a finally, so it fires even though the handler throw now
		// propagates (for the Consumer to quarantine) — an app logger suspended in
		// before_job is always resumed.
		$jw = new Job_Worker_Node();
		$this->register_job_handler( $jw, 'boom', function () { throw new \RuntimeException( 'x' ); } );

		$after = 0;
		add_action( 'newspack_nodes/job_worker/after_job', function () use ( &$after ) { ++$after; } );

		$message = $this->job_message( 'boom' );
		try {
			$jw->fill( $message );
			$this->fail( 'expected the handler throw to propagate' );
		} catch ( \RuntimeException $e ) {
			$this->assertSame( 'x', $e->getMessage() );
		}

		$this->assertSame( 1, $after, 'after_job fires before the throw propagates' );
	}

	public function test_after_job_listener_throw_does_not_poison_a_successful_job(): void {
		// after_job is an app cleanup extension point. A listener throwing there must
		// NOT masquerade as handler poison — otherwise a job that already SUCCEEDED is
		// quarantined and double-executed on replay. Swallow it, symmetric with
		// before_job; the successful job is still counted.
		$jw  = new Job_Worker_Node();
		$ran = false;
		$this->register_job_handler( $jw, 'ok', function () use ( &$ran ) { $ran = true; } );
		add_action( 'newspack_nodes/job_worker/after_job', function () { throw new \RuntimeException( 'cleanup boom' ); } );

		$message = $this->job_message( 'ok' );
		$jw->fill( $message ); // must NOT throw — the handler succeeded.

		$this->assertTrue( $ran );
		$this->assertSame( 1, $this->jobs_executed( $jw ), 'a successful job is counted even if after_job throws' );
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

	public function test_before_job_returning_false_declines_the_job(): void {
		// before_job is a filter: a listener that will not set a context up for
		// this job — one addressed to another host — declines it, and the
		// handler never runs. after_job still fires, exactly as it does when a
		// listener throws, so a DIFFERENT listener that had already set itself
		// up is torn down no matter what order the two ran in.
		$jw  = new Job_Worker_Node();
		$ran = false;
		$this->register_job_handler( $jw, 'evtemplate', function () use ( &$ran ) { $ran = true; } );

		$after = 0;
		add_action( 'newspack_nodes/job_worker/after_job', function () use ( &$after ) { ++$after; } );
		add_filter( 'newspack_nodes/job_worker/before_job', function () { return false; } );

		$jw->fill( $this->job_message( 'evtemplate', [], 'job', 'https://hub/Tools/UpdateSite.html' ) );

		$this->assertFalse( $ran, 'a declined job must not run its handler' );
		$this->assertSame( 1, $after, 'after_job must fire so a half-set-up listener is torn down' );
	}

	public function test_before_job_filter_receives_the_handler_id_and_message(): void {
		$jw = new Job_Worker_Node();
		$this->register_job_handler( $jw, 'evtemplate', function () {} );

		$seen = [];
		add_filter(
			'newspack_nodes/job_worker/before_job',
			function ( $run, $handler, $id, $message ) use ( &$seen ) {
				$seen = [ $run, $handler, $id, $message[ Message::KEY ] ];
				return $run;
			},
			10,
			4
		);

		$message                 = $this->job_message( 'evtemplate', [], 'job', 'https://hub/Tools/UpdateSite.html' );
		$message[ Message::KEY ] = 'affinity-3308';
		$jw->fill( $message );

		$this->assertSame( [ true, 'evtemplate', 'https://hub/Tools/UpdateSite.html', 'affinity-3308' ], $seen );
	}

	public function test_a_before_job_listener_returning_nothing_still_runs_the_job(): void {
		// Fail-open: a listener that ignores the filter contract and returns
		// null must not stop jobs. It DOES erase a decline threaded from an
		// earlier priority, which is why the handler re-checks the host itself.
		$jw  = new Job_Worker_Node();
		$ran = false;
		$this->register_job_handler( $jw, 'ctx', function () use ( &$ran ) { $ran = true; } );
		add_action( 'newspack_nodes/job_worker/before_job', function () { return null; } );

		$jw->fill( $this->job_message( 'ctx', [], 'job', 'run-6620' ) );

		$this->assertTrue( $ran, 'a void listener must not be read as a decline' );
		$this->assertSame( 1, $this->jobs_executed( $jw ) );
	}

	public function test_a_declined_job_leaves_its_batch_alone(): void {
		// Declining is a per-worker routing decision, not an outcome: a batched
		// job addressed to one host is declined by every OTHER subscribed worker,
		// and settling it there would decrement the batch N times and report
		// errors for work this host was never going to do.
		$tmp        = $this->arrange_retry_base();
		$prev       = Core::$memd;
		$memd       = new InMemoryMemcached();
		Core::$memd = $memd;
		try {
			$memd->set( Job_Intake::batch_count_key( 'bDecline' ), 2, 0 );
			$memd->set( Job_Intake::batch_err_key( 'bDecline' ), 0, 0 );

			$jw = new Job_Worker_Node();
			$this->register_job_handler( $jw, 'evtemplate', fn () => null );
			add_filter( 'newspack_nodes/job_worker/before_job', function () { return false; } );

			$jw->fill( $this->job_message( 'evtemplate', [], 'job', 'https://hub/x.html', [ 'batch' => 'bDecline' ] ) );

			$this->assertSame( 2, $memd->get( Job_Intake::batch_count_key( 'bDecline' ) ), 'the batch count must not move' );
			$this->assertSame( 0, $memd->get( Job_Intake::batch_err_key( 'bDecline' ) ), 'and no error may be recorded' );
		} finally {
			Core::$memd = $prev;
		}
	}

	// --- XXX: legacy gyrobase envelope shim ---------------------------------

	public function test_legacy_gyrobase_envelope_lifts_its_template_into_the_id(): void {
		// XXX: prod gyrobase queues {queue, template, parameters} with no
		// top-level id, so the handler used to receive '' and return without
		// rendering. Remove this test with the shim.
		$jw   = new Job_Worker_Node();
		$seen = [];
		$this->register_job_handler( $jw, 'evtemplate', function ( $id, $p ) use ( &$seen ) { $seen = [ $id, $p ]; } );

		$jw->fill( $this->job_message( 'evtemplate', [
			'queue'      => 'runTemplate',
			'template'   => 'https://hub/Tools/UpdateSite.html',
			'parameters' => [ 'Name' => 'Bend' ],
		] ) );

		$this->assertSame( [ 'https://hub/Tools/UpdateSite.html', [ 'Name' => 'Bend' ] ], $seen );
	}

	public function test_legacy_gyrobase_envelope_parses_a_query_string_body(): void {
		// No evLog attributes means the legacy producer left `parameters` as the
		// raw, form-encoded query string rather than a hash.
		$jw   = new Job_Worker_Node();
		$seen = [];
		$this->register_job_handler( $jw, 'evtemplate', function ( $id, $p ) use ( &$seen ) { $seen = [ $id, $p ]; } );

		$jw->fill( $this->job_message( 'evtemplate', [
			'queue'      => 'runTemplate',
			'template'   => 'https://hub/Tools/UpdateSite.html',
			'parameters' => 'Name=Bend&amp;ID=808579',
		] ) );

		$this->assertSame(
			[ 'https://hub/Tools/UpdateSite.html', [ 'Name' => 'Bend', 'ID' => '808579' ] ],
			$seen
		);
	}

	public function test_legacy_envelope_preserves_dotted_parameter_names(): void {
		// XXX: parse_str() rewrites `.` and space in keys to `_`; dotted field
		// names are idiomatic on the gyrobase side, and the shim exists to
		// reproduce the old producer's payload exactly. Remove with the shim.
		$jw   = new Job_Worker_Node();
		$seen = [];
		$this->register_job_handler( $jw, 'evtemplate', function ( $id, $p ) use ( &$seen ) { $seen = $p; } );

		$jw->fill( $this->job_message( 'evtemplate', [
			'queue'      => 'runTemplate',
			'template'   => 'Tools/UpdateSite.html',
			'parameters' => 'Site.Id=7391&Mailing+City=Bend',
		] ) );

		$this->assertSame( [ 'Site.Id' => '7391', 'Mailing City' => 'Bend' ], $seen );
	}

	public function test_legacy_envelope_with_a_null_parameters_key_still_lifts_its_template(): void {
		// XXX: isset() is false for a present-but-null `parameters`, which would
		// drop the envelope through unlifted. Remove with the shim.
		$jw   = new Job_Worker_Node();
		$seen = [];
		$this->register_job_handler( $jw, 'evtemplate', function ( $id, $p ) use ( &$seen ) { $seen = [ $id, $p ]; } );

		$jw->fill( $this->job_message( 'evtemplate', [
			'queue'      => 'runTemplate',
			'template'   => 'Tools/UpdateSite.html',
			'parameters' => null,
		] ) );

		$this->assertSame( [ 'Tools/UpdateSite.html', [] ], $seen );
	}

	public function test_the_legacy_shim_only_applies_to_evtemplate(): void {
		// XXX: shape alone is not proof — another handler whose parameters
		// legitimately carry these three keys would have its payload replaced
		// and its identity rewritten. Remove with the shim.
		$jw   = new Job_Worker_Node();
		$seen = [];
		$this->register_job_handler( $jw, 'importer', function ( $id, $p ) use ( &$seen ) { $seen = [ $id, $p ]; } );

		$envelope = [ 'queue' => 'q', 'template' => 'T.html', 'parameters' => [ 'x' => 1 ] ];
		$jw->fill( $this->job_message( 'importer', $envelope ) );

		$this->assertSame( [ '', $envelope ], $seen, 'a non-evtemplate handler keeps its parameters verbatim' );
	}

	public function test_the_legacy_shim_respects_the_job_id_cap(): void {
		// Every other id path bounds the id at MAX_JOB_ID_LEN, because it rides
		// in every jobstats record IDENTITY.
		$jw  = new Job_Worker_Node();
		$ran = false;
		$this->register_job_handler( $jw, 'evtemplate', function () use ( &$ran ) { $ran = true; } );

		$jw->fill( $this->job_message( 'evtemplate', [
			'queue'      => 'runTemplate',
			'template'   => \str_repeat( 'z', Job_Intake::MAX_JOB_ID_LEN + 1 ),
			'parameters' => [],
		] ) );

		$this->assertFalse( $ran, 'an overlong lifted id is refused, not truncated into a wrong identity' );
	}

	public function test_a_declined_job_is_not_counted_as_executed(): void {
		$jw = new Job_Worker_Node();
		$this->register_job_handler( $jw, 'evtemplate', fn () => null );
		add_filter( 'newspack_nodes/job_worker/before_job', function () { return false; } );

		$jw->fill( $this->job_message( 'evtemplate', [], 'job', 'https://hub/x.html' ) );

		$this->assertSame( 0, $this->jobs_executed( $jw ), 'a declined job did no work' );
	}

	public function test_a_modern_entry_is_untouched_by_the_legacy_shim(): void {
		// A current producer sets the id itself; a `template` parameter must not
		// be mistaken for the legacy envelope.
		$jw   = new Job_Worker_Node();
		$seen = [];
		$this->register_job_handler( $jw, 'evtemplate', function ( $id, $p ) use ( &$seen ) { $seen = [ $id, $p ]; } );

		$jw->fill( $this->job_message(
			'evtemplate',
			[ 'template' => 'PostTask.html', 'silo' => 'archive' ],
			'job',
			'Tools/Run.html'
		) );

		$this->assertSame( [ 'Tools/Run.html', [ 'template' => 'PostTask.html', 'silo' => 'archive' ] ], $seen );
	}

	// --- Job identity threaded to handler + before/after actions -------------

	public function test_two_param_handler_receives_the_top_level_id(): void {
		$jw          = new Job_Worker_Node();
		$captured_id = 'NO_ID';
		$this->register_job_handler( $jw, 'cron', function ( $id, $params ) use ( &$captured_id ) {
			$captured_id = $id;
		} );

		$jw->fill( $this->job_message( 'cron', [ 'x' => 1 ], 'job', 'films-2026' ) );

		$this->assertSame( 'films-2026', $captured_id );
	}

	public function test_single_param_handler_still_runs_when_id_present(): void {
		// BC pin: a legacy one-arg handler ignores the extra id arg and still runs.
		$jw       = new Job_Worker_Node();
		$received = null;
		$this->register_job_handler( $jw, 'legacy', function ( $id, $params ) use ( &$received ) {
			$received = $params;
		} );

		$jw->fill( $this->job_message( 'legacy', [ 'y' => 2 ], 'job', 'bc-1' ) );

		$this->assertSame( [ 'y' => 2 ], $received );
		$this->assertSame( 1, $this->jobs_executed( $jw ) );
	}

	public function test_handler_receives_empty_string_id_when_absent(): void {
		// No top-level id ⇒ the handler's id arg is '' (same coercion as the jobstats key).
		$jw          = new Job_Worker_Node();
		$captured_id = 'NO_ID';
		$this->register_job_handler( $jw, 'cron', function ( $id, $params ) use ( &$captured_id ) {
			$captured_id = $id;
		} );

		$jw->fill( $this->job_message( 'cron' ) );

		$this->assertSame( '', $captured_id );
	}

	public function test_before_job_filter_receives_the_id_as_third_arg(): void {
		$jw = new Job_Worker_Node();
		$this->register_job_handler( $jw, 'cron', fn ( $id, $p ) => null );

		$captured = 'MISSING';
		add_filter( 'newspack_nodes/job_worker/before_job', function ( $run, $h, $id = 'MISSING' ) use ( &$captured ) { $captured = $id; return $run; }, 10, 3 );

		$jw->fill( $this->job_message( 'cron', [], 'job', 'events-77' ) );

		$this->assertSame( 'events-77', $captured );
	}

	public function test_after_job_action_receives_the_id_as_second_arg(): void {
		$jw = new Job_Worker_Node();
		$this->register_job_handler( $jw, 'cron', fn ( $id, $p ) => null );

		$captured = 'MISSING';
		add_action( 'newspack_nodes/job_worker/after_job', function ( $h, $id = 'MISSING' ) use ( &$captured ) { $captured = $id; }, 10, 2 );

		$jw->fill( $this->job_message( 'cron', [], 'job', 'digest-9' ) );

		$this->assertSame( 'digest-9', $captured );
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

	public function test_handler_throw_propagates_out_of_fill_for_quarantine(): void {
		// A throwing job handler is poison: fill() no longer swallows it — the
		// exception propagates so the driving Consumer quarantines the job to its
		// deadletter sibling (a job entry is TM_STRUCT data, so it flows un-caught
		// back through router + interpreter to the Consumer's forward_line). The job
		// is NOT counted as executed — the handler did not complete.
		$jw = new Job_Worker_Node();
		$this->register_job_handler( $jw, 'boom', function () { throw new \RuntimeException( 'x' ); } );

		$message = $this->job_message( 'boom' );
		try {
			$jw->fill( $message );
			$this->fail( 'expected the handler throw to propagate out of fill()' );
		} catch ( \RuntimeException $e ) {
			$this->assertSame( 'x', $e->getMessage() );
		}
		$this->assertSame( 0, $this->jobs_executed( $jw ) );
	}

	// --- Constructor params + getters ---------------------------------------

	public function test_cache_flush_interval_default_is_50(): void {
		$jw = new Job_Worker_Node();
		$this->register_job_handler( $jw, 'noop', fn ( $id, $p ) => null );

		for ( $i = 0; $i < 51; ++$i ) {
			$message = $this->job_message( 'noop' );
			$jw->fill( $message );
		}

		$this->assertSame( 51, $this->jobs_executed( $jw ) );
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
		$this->register_job_handler( $jw, 'evtemplate', function ( $id, $p ) use ( &$received ) { $received = $p; } );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_STRUCT;
		$message[ Message::VALUE ] = [
			'k'          => 'job',
			'handler'    => 'evtemplate',
			'parameters' => [ 'template' => 'Tools/ImportFilmTimes.html' ],
		];
		$jw->fill( $message );

		$this->assertSame( [ 'template' => 'Tools/ImportFilmTimes.html' ], $received );
		$this->assertSame( 1, $this->jobs_executed( $jw ) );
	}

	public function test_dispatches_remote_entry_keyed_by_k(): void {
		$jw = new Job_Worker_Node();
		$received = null;
		$this->register_job_handler( $jw, 'hub_op', function ( $id, $p ) use ( &$received ) { $received = $p; }, true );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_STRUCT;
		$message[ Message::VALUE ] = [
			'k'          => 'remote_job',
			'handler'    => 'hub_op',
			'parameters' => [ 'a' => 1 ],
		];
		$jw->fill( $message );

		$this->assertSame( [ 'a' => 1 ], $received );
		$this->assertSame( 1, $this->jobs_executed( $jw ) );
	}

	public function test_a_handler_this_worker_does_not_own_is_silent(): void {
		// @longform Neither kind warns. A spoke's Job_Router produces jobs into
		// its own jobs.log that only the hub can run — rewrite-remote-job runs
		// hub-side — so a spoke sees every hub-destined job as an unownable
		// `job` and warned once per job for work completing fine elsewhere. The
		// remote_job branch was already silent for the mirror-image reason.
		$jw = new class() extends Job_Worker_Node {
			/** @var string[] */
			public array $warnings = [];
			public function print_less_often( string $text, string ...$extra ): void {
				$this->warnings[] = $text . \implode( '', $extra );
			}
		};

		$jw->fill( $this->job_message( 'unregistered', [], 'job' ) );
		$this->assertSame( [], $jw->warnings, 'a job this worker does not own must not warn' );

		$jw->fill( $this->job_message( 'unregistered', [], 'remote_job' ) );
		$this->assertSame( [], $jw->warnings, 'a missing remote_job handler must not warn' );
	}

	// --- Local vs. remote handler split -------------------------------------

	public function test_local_handler_dispatches_for_type_job(): void {
		$jw = new Job_Worker_Node();
		$received = null;
		$this->register_job_handler( $jw, 'sync', function ( $id, $p ) use ( &$received ) { $received = $p; } );

		$message = $this->job_message( 'sync', [ 'k' => 'v' ], 'job' );
		$jw->fill( $message );

		$this->assertSame( [ 'k' => 'v' ], $received );
	}

	public function test_remote_handler_dispatches_for_type_remote_job(): void {
		$jw = new Job_Worker_Node();
		$received = null;
		$this->register_job_handler( $jw, 'hub_op', function ( $id, $p ) use ( &$received ) { $received = $p; }, true );

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
		$jw->arguments( [ '0', '0', '-5' ] );

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
		$this->assertArrayHasKey( 'jobs_since_cache_flush', $payload );
		$this->assertArrayHasKey( 'cache_flush_interval', $payload );
		$this->assertSame( 2, $payload['local_handler_count'] );
		$this->assertSame( 1, $payload['remote_handler_count'] );
		$this->assertGreaterThanOrEqual( 1, $payload['counter'] );
		// Watermark stop/report is Worker_Base's job; no memory_pressure here.
		$this->assertArrayNotHasKey( 'memory_pressure', $payload );
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
			$this->assertSame( -1, $ref->invoke( $jw ) );
		} finally {
			if ( false !== $prev ) {
				\ini_set( 'memory_limit', $prev );
			}
		}
	}

	// --- Cache flush state machine ------------------------------------------

	public function test_cache_flush_state_machine_emits_set_state_event(): void {
		$jw = new Job_Worker_Node();
		$jw->arguments( [ '3' ] );
		$this->register_job_handler( $jw, 'noop', fn () => null );

		$ref = new \ReflectionProperty( \Newspack_Nodes\Node::class, 'registrations' );
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
		$jw->arguments( [ '7', '120', '480' ] );
		$ref = new \ReflectionClass( $jw );
		$this->assertSame( 7,   $ref->getProperty( 'cache_flush_interval' )->getValue( $jw ) );
	}

	public function test_arguments_setter_applies_schema_defaults_for_missing_optional_tokens(): void {
		$jw = new Job_Worker_Node();
		$jw->arguments( [] );
		$ref = new \ReflectionClass( $jw );
		$this->assertSame( Job_Worker_Node::CACHE_FLUSH_INTERVAL,   $ref->getProperty( 'cache_flush_interval' )->getValue( $jw ) );

		$jw2 = new Job_Worker_Node();
		$jw2->arguments( [ '5' ] );
		$ref2 = new \ReflectionClass( $jw2 );
		$this->assertSame( 5,                                       $ref2->getProperty( 'cache_flush_interval' )->getValue( $jw2 ) );
	}

	public function test_arguments_setter_normalizes_to_minimum_one(): void {
		$jw = new Job_Worker_Node();
		$jw->arguments( [ '0', '-3', '-5' ] );
		$ref = new \ReflectionClass( $jw );
		$this->assertSame( 1, $ref->getProperty( 'cache_flush_interval' )->getValue( $jw ) );
	}

	public function test_worker_should_stop_escapes_the_per_job_throwable_catch(): void {
		// Worker_Should_Stop must escape the per-job catch(\Throwable); after_job still runs.
		$jw = new Job_Worker_Node();
		$this->register_job_handler( $jw, 'stopper', function () {
			throw new Worker_Should_Stop();
		} );

		$after = 0;
		add_action( 'newspack_nodes/job_worker/after_job', function () use ( &$after ) { ++$after; } );

		$escaped = false;
		try {
			$message = $this->job_message( 'stopper' );
			$jw->fill( $message );
		} catch ( Worker_Should_Stop $e ) {
			$escaped = true;
		}

		$this->assertTrue( $escaped, 'Worker_Should_Stop propagates past the per-job Throwable catch' );
		$this->assertSame( 1, $after, 'after_job cleanup still fires before the stop propagates' );
	}

	// --- Retry with backoff --------------------------------------------------

	/** Point Config at a temp base dir so the retry requeue writes a real jobdelay.p0. */
	private function arrange_retry_base(): string {
		$tmp = $this->make_temp_dir( 'newspack-jobworker-retry-' );
		mkdir( "{$tmp}/locks", 0755, true );
		mkdir( "{$tmp}/logs", 0755, true );
		$this->use_base_dir( $tmp, [ 'num_partitions' => 1 ] );
		return $tmp;
	}

	private function read_jobdelay_lines( string $tmp ): array {
		$lines = [];
		$pdir  = "{$tmp}/logs/jobdelay.p0";
		if ( ! is_dir( $pdir ) ) {
			return $lines;
		}
		foreach ( glob( "{$pdir}/*.log" ) as $f ) {
			foreach ( preg_split( '/\n/', rtrim( (string) file_get_contents( $f ), "\n" ) ) as $line ) {
				if ( '' !== $line ) {
					$lines[] = Message::unpacked( $line )[ Message::VALUE ];
				}
			}
		}
		return $lines;
	}

	public function test_handler_throw_with_retries_left_requeues_with_backoff_and_swallows(): void {
		$tmp = $this->arrange_retry_base();
		$jw  = new Job_Worker_Node();
		$this->register_job_handler( $jw, 'flaky', function () { throw new \RuntimeException( 'transient 503' ); } );

		$before = \microtime( true );
		$jw->fill( $this->job_message( 'flaky', [ 'p' => 7 ], 'job', 'idr', [ 'retries' => 3 ] ) );

		$lines = $this->read_jobdelay_lines( $tmp );
		$this->assertCount( 1, $lines, 'the failed attempt must land back in jobdelay' );
		$this->assertSame( 'flaky', $lines[0]['handler'] );
		$this->assertSame( [ 'p' => 7 ], $lines[0]['parameters'] );
		$this->assertSame( 'idr', $lines[0]['id'] );
		$this->assertSame( 3, $lines[0]['retries'] );
		$this->assertSame( 1, $lines[0]['attempt'] );
		$this->assertGreaterThanOrEqual( $before + Job_Worker_Node::RETRY_BASE_S, $lines[0]['not_before'] );
		$this->assertLessThanOrEqual( \microtime( true ) + Job_Worker_Node::RETRY_BASE_S + 1.0, $lines[0]['not_before'] );
		// Deliberate asymmetry with the poison path: the handler RAN (and
		// consumed memory), so the GC/cache-flush cadence must advance.
		$this->assertSame( 1, $this->jobs_executed( $jw ) );
	}

	public function test_retry_backoff_doubles_with_attempt(): void {
		$tmp = $this->arrange_retry_base();
		$jw  = new Job_Worker_Node();
		$this->register_job_handler( $jw, 'flaky', function () { throw new \RuntimeException( 'still down' ); } );

		$before = \microtime( true );
		$jw->fill( $this->job_message( 'flaky', [], 'job', null, [ 'retries' => 5, 'attempt' => 2 ] ) );

		$lines = $this->read_jobdelay_lines( $tmp );
		$this->assertCount( 1, $lines );
		$this->assertSame( 3, $lines[0]['attempt'] );
		$expected = Job_Worker_Node::RETRY_BASE_S * 4;
		$this->assertGreaterThanOrEqual( $before + $expected, $lines[0]['not_before'] );
		$this->assertLessThanOrEqual( \microtime( true ) + $expected + 1.0, $lines[0]['not_before'] );
	}

	public function test_retry_exhausted_rethrows_for_quarantine(): void {
		$tmp = $this->arrange_retry_base();
		$jw  = new Job_Worker_Node();
		$this->register_job_handler( $jw, 'flaky', function () { throw new \RuntimeException( 'permanent' ); } );

		try {
			$jw->fill( $this->job_message( 'flaky', [], 'job', null, [ 'retries' => 3, 'attempt' => 3 ] ) );
			$this->fail( 'exhausted retries must fall back to the poison path' );
		} catch ( \RuntimeException $e ) {
			$this->assertSame( 'permanent', $e->getMessage() );
		}
		$this->assertSame( [], $this->read_jobdelay_lines( $tmp ) );
	}

	public function test_worker_should_stop_is_never_retried(): void {
		$tmp = $this->arrange_retry_base();
		$jw  = new Job_Worker_Node();
		$this->register_job_handler( $jw, 'stopper', function () { throw new Worker_Should_Stop( 'drain over' ); } );

		try {
			$jw->fill( $this->job_message( 'stopper', [], 'job', null, [ 'retries' => 3 ] ) );
			$this->fail( 'cooperative stop must propagate, not retry' );
		} catch ( Worker_Should_Stop $e ) {
			$this->assertSame( 'drain over', $e->getMessage() );
		}
		$this->assertSame( [], $this->read_jobdelay_lines( $tmp ) );
	}

	// --- Batch fan-in --------------------------------------------------------

	private function read_alerts_lines( string $tmp ): array {
		$lines = [];
		foreach ( glob( "{$tmp}/logs/alerts.p0/*.log" ) ?: [] as $f ) {
			foreach ( preg_split( '/\n/', rtrim( (string) file_get_contents( $f ), "\n" ) ) as $line ) {
				if ( '' !== $line ) {
					$message = Message::unpacked( $line );
					$lines[] = [ 'key' => $message[ Message::KEY ], 'value' => $message[ Message::VALUE ] ];
				}
			}
		}
		return $lines;
	}

	public function test_batch_decrements_and_last_job_signals_completion(): void {
		$tmp        = $this->arrange_retry_base();
		$prev       = Core::$memd;
		$memd       = new InMemoryMemcached();
		Core::$memd = $memd;
		\Newspack_Nodes\Alerts::reset();
		try {
			$memd->set( Job_Intake::batch_count_key( 'bX' ), 2, 0 );
			$memd->set( Job_Intake::batch_err_key( 'bX' ), 0, 0 );

			$jw = new Job_Worker_Node();
			$this->register_job_handler( $jw, 'member', fn () => null );

			$completed = [];
			add_action( 'newspack_nodes/job_worker/batch_complete', function ( $batch ) use ( &$completed ) { $completed[] = $batch; } );

			$jw->fill( $this->job_message( 'member', [], 'job', null, [ 'batch' => 'bX' ] ) );
			$this->assertSame( 1, $memd->get( Job_Intake::batch_count_key( 'bX' ) ) );
			$this->assertSame( [], $completed );

			$jw->fill( $this->job_message( 'member', [], 'job', null, [ 'batch' => 'bX' ] ) );
			$this->assertSame( [ 'bX' ], $completed );

			$alerts = $this->read_alerts_lines( $tmp );
			$this->assertCount( 1, $alerts );
			$this->assertSame( 'batch:bX', $alerts[0]['key'] );
			$this->assertSame( 'resolved', $alerts[0]['value']['severity'] );
			$this->assertSame( 'alert', $alerts[0]['value']['k'] );
		} finally {
			Core::$memd = $prev;
			\Newspack_Nodes\Alerts::reset();
		}
	}

	public function test_batch_with_error_outcomes_completes_as_warning(): void {
		$tmp        = $this->arrange_retry_base();
		$prev       = Core::$memd;
		$memd       = new InMemoryMemcached();
		Core::$memd = $memd;
		\Newspack_Nodes\Alerts::reset();
		try {
			$memd->set( Job_Intake::batch_count_key( 'bE' ), 1, 0 );
			$memd->set( Job_Intake::batch_err_key( 'bE' ), 0, 0 );

			$jw = new Job_Worker_Node();
			$this->register_job_handler( $jw, 'member', fn () => [ 'stats' => [ 'success_count' => 0, 'error_count' => 2 ] ] );

			$jw->fill( $this->job_message( 'member', [], 'job', null, [ 'batch' => 'bE' ] ) );

			$alerts = $this->read_alerts_lines( $tmp );
			$this->assertCount( 1, $alerts );
			$this->assertSame( 'warning', $alerts[0]['value']['severity'] );
			// Completion reaps both counters so the batch id can be reused.
			$this->assertFalse( $memd->get( Job_Intake::batch_count_key( 'bE' ) ) );
			$this->assertFalse( $memd->get( Job_Intake::batch_err_key( 'bE' ) ) );
		} finally {
			Core::$memd = $prev;
			\Newspack_Nodes\Alerts::reset();
		}
	}

	public function test_retry_scheduled_job_does_not_decrement_its_batch(): void {
		$this->arrange_retry_base();
		$prev       = Core::$memd;
		$memd       = new InMemoryMemcached();
		Core::$memd = $memd;
		try {
			$memd->set( Job_Intake::batch_count_key( 'bY' ), 1, 0 );
			$memd->set( Job_Intake::batch_err_key( 'bY' ), 0, 0 );

			$jw = new Job_Worker_Node();
			$this->register_job_handler( $jw, 'flaky', function () { throw new \RuntimeException( 'transient' ); } );

			$completed = [];
			add_action( 'newspack_nodes/job_worker/batch_complete', function ( $batch ) use ( &$completed ) { $completed[] = $batch; } );

			$jw->fill( $this->job_message( 'flaky', [], 'job', null, [ 'batch' => 'bY', 'retries' => 2 ] ) );

			$this->assertSame( 1, $memd->get( Job_Intake::batch_count_key( 'bY' ) ), 'a retry-scheduled job is not finished; the batch must stay open' );
			$this->assertSame( [], $completed );
		} finally {
			Core::$memd = $prev;
		}
	}
}
