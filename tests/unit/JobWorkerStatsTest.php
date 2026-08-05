<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Core;
use Newspack_Nodes\Jobstats_Record;
use Newspack_Nodes\Job_Worker_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Worker_Should_Stop;
use Newspack_Nodes\Tests\TestCase;

/**
 * Durable per-handler job stats: fill() records outcome + duration around the
 * handler call and exposes the accumulator via probe_stats() (a list of positional
 * Jobstats_Record snapshots the Job_Probe sweeps). The pyrobase-cron outcome
 * contract (success_count default -1, error_count default 0) is honored verbatim.
 */
#[CoversClass( Job_Worker_Node::class )]
class JobWorkerStatsTest extends TestCase {

	protected function setUp(): void {
		parent::setUp();
		$GLOBALS['_wp_actions'] = [];
		Core::$now              = 1_700_000_000;
	}

	/** A jobs.log TM_STRUCT entry, with optional top-level id + enqueue ts. */
	private function job_message( string $handler, array $parameters = [], ?string $id = null, ?float $ts = null ): array {
		$entry = [
			'k'          => 'job',
			'handler'    => $handler,
			'parameters' => $parameters,
		];
		if ( null !== $id ) {
			$entry['id'] = $id;
		}
		if ( null !== $ts ) {
			$entry['ts'] = $ts;
		}
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_STRUCT;
		$message[ Message::VALUE ] = $entry;
		return $message;
	}

	/** @return array<int,int|string> The one probe record for $key (fails if absent). */
	private function record_for( Job_Worker_Node $jw, string $key ): array {
		foreach ( $jw->probe_stats() as $record ) {
			if ( $key === $record[ Jobstats_Record::KEY ] ) {
				return $record;
			}
		}
		$this->fail( "no jobstats record for key '{$key}'" );
	}

	public function test_records_a_successful_run_with_handler_reported_items(): void {
		$jw = new Job_Worker_Node();
		// Distinct-from-default counts (not -1/0) so a silent no-op still fails.
		$this->register_job_handler( $jw, 'ingest', fn () => [ 'stats' => [ 'success_count' => 7, 'error_count' => 0 ] ] );

		$jw->fill( $this->job_message( 'ingest' ) );

		$record = $this->record_for( $jw, 'ingest' );
		$this->assertSame( 'ingest', $record[ Jobstats_Record::HANDLER ] );
		$this->assertSame( 1, $record[ Jobstats_Record::RUNS ] );
		$this->assertSame( 0, $record[ Jobstats_Record::ERRORS ] );
		$this->assertSame( 7, $record[ Jobstats_Record::ITEMS_OK ] );
		$this->assertSame( 0, $record[ Jobstats_Record::ITEMS_ERR ] );
		$this->assertSame( 'success', $record[ Jobstats_Record::LAST_STATUS ] );
		$this->assertSame( (int) Core::$now, $record[ Jobstats_Record::LAST_TS ] );
	}

	public function test_all_errors_no_items_is_recorded_as_error(): void {
		$jw = new Job_Worker_Node();
		$this->register_job_handler( $jw, 'sync', fn () => [ 'stats' => [ 'success_count' => 0, 'error_count' => 3 ] ] );

		$jw->fill( $this->job_message( 'sync' ) );

		$record = $this->record_for( $jw, 'sync' );
		$this->assertSame( 1, $record[ Jobstats_Record::RUNS ] );
		$this->assertSame( 1, $record[ Jobstats_Record::ERRORS ] );
		$this->assertSame( 3, $record[ Jobstats_Record::ITEMS_ERR ] );
		$this->assertSame( 'error', $record[ Jobstats_Record::LAST_STATUS ] );
		$this->assertStringContainsString( 'Job failed', $record[ Jobstats_Record::LAST_MESSAGE ] );
	}

	public function test_partial_errors_are_recorded_as_success_with_a_completed_with_errors_message(): void {
		$jw = new Job_Worker_Node();
		$this->register_job_handler( $jw, 'sync', fn () => [ 'stats' => [ 'success_count' => 5, 'error_count' => 2 ] ] );

		$jw->fill( $this->job_message( 'sync' ) );

		$record = $this->record_for( $jw, 'sync' );
		$this->assertSame( 0, $record[ Jobstats_Record::ERRORS ], 'partial errors count as a successful run' );
		$this->assertSame( 5, $record[ Jobstats_Record::ITEMS_OK ] );
		$this->assertSame( 2, $record[ Jobstats_Record::ITEMS_ERR ] );
		$this->assertSame( 'success', $record[ Jobstats_Record::LAST_STATUS ] );
		$this->assertStringContainsString( 'Completed with errors', $record[ Jobstats_Record::LAST_MESSAGE ] );
	}

	public function test_errors_without_a_success_count_never_display_the_sentinel(): void {
		// error_count > 0 with success_count absent (-1 sentinel) → "success with
		// errors" per the contract, but the human string must clamp, not say "-1".
		$jw = new Job_Worker_Node();
		$this->register_job_handler( $jw, 'sync', fn () => [ 'stats' => [ 'error_count' => 3 ] ] );

		$jw->fill( $this->job_message( 'sync' ) );

		$record = $this->record_for( $jw, 'sync' );
		$this->assertSame( 'success', $record[ Jobstats_Record::LAST_STATUS ] );
		$this->assertSame(
			'Completed with errors: 0 processed, 3 error(s)',
			$record[ Jobstats_Record::LAST_MESSAGE ]
		);
	}

	public function test_a_void_returning_handler_records_a_plain_success(): void {
		// The pyrobase contract: no stats → success_count -1 → "Job completed
		// successfully", ITEMS_OK 0 (the -1 sentinel never pollutes the total).
		$jw = new Job_Worker_Node();
		$this->register_job_handler( $jw, 'noop', fn () => null );

		$jw->fill( $this->job_message( 'noop' ) );

		$record = $this->record_for( $jw, 'noop' );
		$this->assertSame( 1, $record[ Jobstats_Record::RUNS ] );
		$this->assertSame( 0, $record[ Jobstats_Record::ITEMS_OK ] );
		$this->assertSame( 'success', $record[ Jobstats_Record::LAST_STATUS ] );
		$this->assertSame( 'Job completed successfully', $record[ Jobstats_Record::LAST_MESSAGE ] );
	}

	public function test_a_thrown_handler_records_an_error_run_and_still_propagates(): void {
		$jw = new Job_Worker_Node();
		$this->register_job_handler( $jw, 'boom', function () { throw new \RuntimeException( 'kaboom-42' ); } );

		$threw = false;
		try {
			$jw->fill( $this->job_message( 'boom' ) );
		} catch ( \RuntimeException $e ) {
			$threw = true;
		}
		$this->assertTrue( $threw, 'poison must still propagate to the Consumer' );

		$record = $this->record_for( $jw, 'boom' );
		$this->assertSame( 1, $record[ Jobstats_Record::RUNS ] );
		$this->assertSame( 1, $record[ Jobstats_Record::ERRORS ] );
		$this->assertSame( 'error', $record[ Jobstats_Record::LAST_STATUS ] );
		$this->assertSame( 'kaboom-42', $record[ Jobstats_Record::LAST_MESSAGE ] );
	}

	public function test_a_worker_should_stop_records_nothing(): void {
		// A cooperative stop is not a job failure — no run is counted for it.
		$jw = new Job_Worker_Node();
		$this->register_job_handler( $jw, 'stopper', function () { throw new Worker_Should_Stop(); } );

		try {
			$jw->fill( $this->job_message( 'stopper' ) );
		} catch ( Worker_Should_Stop $e ) {
			// expected
		}

		$this->assertSame( [], $jw->probe_stats(), 'a cooperative stop leaves no stats behind' );
	}

	public function test_top_level_id_scopes_stats_per_identity(): void {
		$jw = new Job_Worker_Node();
		$this->register_job_handler( $jw, 'cron', fn () => null );

		$jw->fill( $this->job_message( 'cron', [], 'import-films' ) );
		$jw->fill( $this->job_message( 'cron', [], 'import-events' ) );

		$keys = \array_map( static fn ( $r ) => $r[ Jobstats_Record::KEY ], $jw->probe_stats() );
		\sort( $keys );
		$this->assertSame( [ 'cron:import-events', 'cron:import-films' ], $keys );
		$this->assertSame( 'cron', $this->record_for( $jw, 'cron:import-films' )[ Jobstats_Record::HANDLER ] );
	}

	public function test_after_job_receives_the_outcome_as_a_second_arg(): void {
		$jw = new Job_Worker_Node();
		$this->register_job_handler( $jw, 'ok', fn () => [ 'stats' => [ 'success_count' => 9, 'error_count' => 0 ] ] );

		$captured = 'UNSET';
		\add_action( 'newspack_nodes/job_worker/after_job', function ( $h, $outcome ) use ( &$captured ) { $captured = $outcome; }, 10, 2 );

		$jw->fill( $this->job_message( 'ok' ) );

		$this->assertIsArray( $captured );
		$this->assertSame( 'success', $captured['status'] );
	}

	public function test_runs_and_duration_accumulate_across_consecutive_jobs(): void {
		$jw = new Job_Worker_Node();
		$this->register_job_handler( $jw, 'tick', fn () => [ 'stats' => [ 'success_count' => 4, 'error_count' => 0 ] ] );

		$jw->fill( $this->job_message( 'tick' ) );
		$jw->fill( $this->job_message( 'tick' ) );

		$record = $this->record_for( $jw, 'tick' );
		$this->assertSame( 2, $record[ Jobstats_Record::RUNS ] );
		$this->assertSame( 8, $record[ Jobstats_Record::ITEMS_OK ], 'items accumulate across runs' );
		$this->assertGreaterThanOrEqual( 0, $record[ Jobstats_Record::DURATION_MS ] );
	}

	public function test_queue_latency_is_derived_from_the_enqueue_ts(): void {
		$jw = new Job_Worker_Node();
		$this->register_job_handler( $jw, 'lag', fn () => null );

		// Enqueued 8s before it ran → QUEUE_MS should reflect ~8000, not 0.
		$jw->fill( $this->job_message( 'lag', [], null, \microtime( true ) - 8.0 ) );

		$record = $this->record_for( $jw, 'lag' );
		$this->assertGreaterThanOrEqual( 7500, $record[ Jobstats_Record::QUEUE_MS ] );
	}
}
