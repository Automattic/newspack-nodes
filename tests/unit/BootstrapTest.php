<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Supervisor;
use Newspack_Nodes\SupervisorBase;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Bootstrap::class )]
class BootstrapTest extends TestCase {

	protected function setUp(): void {
		parent::setUp();
		$GLOBALS['_wp_actions']                = [];
		$GLOBALS['_wp_test_scheduled_events']  = [];
		$GLOBALS['_wp_test_unscheduled_events'] = [];
		$GLOBALS['_wp_test_remote_posts']      = [];
		$GLOBALS['_wp_test_next_scheduled']    = false;
	}

	protected function tearDown(): void {
		$GLOBALS['_wp_actions'] = [];
		parent::tearDown();
	}

	// ── get_topologies ────────────────────────────────────────────────────

	public function test_get_topologies_returns_filtered_array(): void {
		\add_filter( 'newspack_nodes/topologies', function ( $topologies ) {
			$topologies['my-group'] = [ 'num_partitions' => 2, 'topology' => '/path/to/file.php' ];
			return $topologies;
		} );

		$result = Bootstrap::get_topologies();
		$this->assertArrayHasKey( 'my-group', $result );
		$this->assertSame( 2, $result['my-group']['num_partitions'] );
	}

	public function test_get_topologies_returns_empty_array_when_no_filter(): void {
		$result = Bootstrap::get_topologies();
		$this->assertSame( [], $result );
	}

	// ── expand_workers ────────────────────────────────────────────────────

	public function test_expand_topologies_yields_one_entry_per_partition(): void {
		\add_filter( 'newspack_nodes/topologies', function ( $topologies ) {
			$topologies['firehose-workers'] = [ 'num_partitions' => 4, 'topology' => '/x.php' ];
			$topologies['job-workers']      = [ 'num_partitions' => 2, 'topology' => '/y.php' ];
			return $topologies;
		} );

		$workers = Bootstrap::expand_workers();
		$this->assertCount( 6, $workers );
		$this->assertSame( 'firehose-workers', $workers[0]['type'] );
		$this->assertSame( 0, $workers[0]['partition'] );
		$this->assertSame( 3, $workers[3]['partition'] );
	}

	public function test_expand_workers_clamps_partition_count_to_max(): void {
		\add_filter( 'newspack_nodes/topologies', function ( $topologies ) {
			// Misconfigured: ridiculous partition count.
			$topologies['huge'] = [ 'num_partitions' => 9999, 'topology' => '/x.php' ];
			return $topologies;
		} );

		$workers = Bootstrap::expand_workers();
		$this->assertCount( SupervisorBase::MAX_PARTITIONS, $workers );
		// Last partition index is MAX_PARTITIONS-1.
		$this->assertSame( SupervisorBase::MAX_PARTITIONS - 1, $workers[ SupervisorBase::MAX_PARTITIONS - 1 ]['partition'] );
	}

	public function test_expand_workers_clamps_zero_partitions_to_one(): void {
		\add_filter( 'newspack_nodes/topologies', function ( $topologies ) {
			// Edge case: explicit 0 → clamp to at least 1 partition.
			$topologies['zero'] = [ 'num_partitions' => 0, 'topology' => '/x.php' ];
			return $topologies;
		} );

		$workers = Bootstrap::expand_workers();
		$this->assertCount( 1, $workers );
		$this->assertSame( 0, $workers[0]['partition'] );
	}

	public function test_expand_workers_clamps_negative_partitions_to_one(): void {
		\add_filter( 'newspack_nodes/topologies', function ( $topologies ) {
			$topologies['neg'] = [ 'num_partitions' => -5, 'topology' => '/x.php' ];
			return $topologies;
		} );

		$workers = Bootstrap::expand_workers();
		$this->assertCount( 1, $workers );
	}

	// ── register_standalone_workers ───────────────────────────────────────

	public function test_register_standalone_workers_includes_supervisor(): void {
		$workers = Bootstrap::register_standalone_workers();
		$this->assertArrayHasKey( 'supervisor', $workers );
		$this->assertSame( Supervisor::class, $workers['supervisor']['class'] );
		$this->assertFalse( $workers['supervisor']['partitions'] );
	}

	// ── is_logging_enabled ────────────────────────────────────────────────

	public function test_is_logging_enabled_defaults_true(): void {
		$this->assertTrue( Bootstrap::is_logging_enabled() );
	}

	public function test_is_logging_enabled_filterable_to_false(): void {
		\add_filter( 'newspack_nodes/enable_logging', fn() => false );
		$this->assertFalse( Bootstrap::is_logging_enabled() );
	}

	// ── run_supervisor_tick gate ──────────────────────────────────────────

	public function test_run_supervisor_tick_unschedules_when_logging_disabled(): void {
		\add_filter( 'newspack_nodes/enable_logging', fn() => false );
		$GLOBALS['_wp_test_next_scheduled']     = 1234567890;
		$GLOBALS['_wp_test_unscheduled_events'] = [];

		Bootstrap::run_supervisor_tick();

		$this->assertNotEmpty(
			$GLOBALS['_wp_test_unscheduled_events'],
			'enable_logging=false must unschedule the supervisor cron'
		);
		$this->assertSame( 'newspack_nodes/supervisor', $GLOBALS['_wp_test_unscheduled_events'][0]['hook'] );
	}

	public function test_run_supervisor_tick_unschedules_only_when_event_present(): void {
		\add_filter( 'newspack_nodes/enable_logging', fn() => false );
		$GLOBALS['_wp_test_next_scheduled']     = false;
		$GLOBALS['_wp_test_unscheduled_events'] = [];

		Bootstrap::run_supervisor_tick();

		$this->assertEmpty(
			$GLOBALS['_wp_test_unscheduled_events'],
			'no scheduled event = nothing to unschedule'
		);
	}

	// ── unschedule_supervisor ─────────────────────────────────────────────

	public function test_unschedule_supervisor_clears_existing_event(): void {
		$GLOBALS['_wp_test_next_scheduled']     = 99;
		$GLOBALS['_wp_test_unscheduled_events'] = [];

		Bootstrap::unschedule_supervisor();

		$this->assertCount( 1, $GLOBALS['_wp_test_unscheduled_events'] );
		$this->assertSame( 99, $GLOBALS['_wp_test_unscheduled_events'][0]['timestamp'] );
		$this->assertSame( 'newspack_nodes/supervisor', $GLOBALS['_wp_test_unscheduled_events'][0]['hook'] );
	}

	// ── cron_schedules ────────────────────────────────────────────────────

	public function test_register_cron_schedules_adds_minute_interval(): void {
		$schedules = Bootstrap::register_cron_schedules( [] );
		$this->assertArrayHasKey( 'newspack_nodes_minute', $schedules );
		$this->assertSame( 60, $schedules['newspack_nodes_minute']['interval'] );
	}

	public function test_register_cron_schedules_preserves_existing_entries(): void {
		$existing = [ 'hourly' => [ 'interval' => 3600, 'display' => 'Hourly' ] ];
		$result   = Bootstrap::register_cron_schedules( $existing );
		$this->assertArrayHasKey( 'hourly', $result );
		$this->assertArrayHasKey( 'newspack_nodes_minute', $result );
	}

	public function test_register_cron_schedules_is_idempotent(): void {
		$first  = Bootstrap::register_cron_schedules( [] );
		$second = Bootstrap::register_cron_schedules( $first );
		$this->assertSame( $first, $second, 'second call must not override existing entry' );
	}

	// ── activate / deactivate ─────────────────────────────────────────────

	public function test_activate_schedules_supervisor_at_minute_cadence(): void {
		Bootstrap::activate();
		$this->assertNotEmpty( $GLOBALS['_wp_test_scheduled_events'] );
		$evt = $GLOBALS['_wp_test_scheduled_events'][0];
		$this->assertSame( 'newspack_nodes_minute', $evt['recurrence'] );
		$this->assertSame( 'newspack_nodes/supervisor', $evt['hook'] );
	}

	public function test_activate_skipped_when_already_scheduled(): void {
		$GLOBALS['_wp_test_next_scheduled'] = 1234567890;
		Bootstrap::activate();
		$this->assertEmpty( $GLOBALS['_wp_test_scheduled_events'] );
	}

	// ── supervisor() factory ──────────────────────────────────────────────

	public function test_supervisor_returns_supervisor_instance(): void {
		$s = Bootstrap::supervisor();
		$this->assertInstanceOf( Supervisor::class, $s );
	}
}
