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
		$GLOBALS['_test_outbound_posts']      = [];
		$GLOBALS['_wp_test_next_scheduled']    = false;
		// Config is statically cached — clear so each test sees fresh option
		// values. get_topologies() now reads Config::load_config()['num_partitions']
		// to default synthesized entries, so stale cache here leaks
		// num_partitions across tests.
		\Newspack_Nodes\Config::reset();
	}

	protected function tearDown(): void {
		$GLOBALS['_wp_actions'] = [];
		\Newspack_Nodes\Config::reset();
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

	public function test_get_topologies_synthesizes_entry_for_operator_selection_not_in_catalog(): void {
		\add_filter( 'newspack_nodes/topologies', function ( $topologies ) {
			$topologies['request-workers'] = [ 'topology' => 'request-workers', 'num_partitions' => 2, 'stale_timeout' => 60 ];
			return $topologies;
		} );
		// Operator checks aggregator (a real TSL file the app didn't publish)
		// + request-workers via the admin UI; both must survive get_topologies().
		$stock = $this->make_temp_dir( 'tsl-stock-' );
		\file_put_contents(
			"$stock/aggregator.tsl",
			"var num_partitions = 3\nvar stale_timeout = 120\n"
		);
		\Newspack_Nodes\Topology_Registry::reset();
		\Newspack_Nodes\Topology_Registry::register_stock_dir( $stock );
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'aggregator', 'request-workers' ];

		try {
			$result = Bootstrap::get_topologies();
			$this->assertArrayHasKey( 'aggregator', $result, 'operator-checked non-catalog topology must be honored' );
			$this->assertSame( 'aggregator', $result['aggregator']['topology'] );
			$this->assertSame( 3, $result['aggregator']['num_partitions'] );
			$this->assertSame( 120, $result['aggregator']['stale_timeout'] );
			$this->assertArrayHasKey( 'request-workers', $result );
			$this->assertSame( 2, $result['request-workers']['num_partitions'] );
		} finally {
			unset( $GLOBALS['_wp_options']['newspack_nodes_topologies'] );
			\Newspack_Nodes\Topology_Registry::reset();
			$this->rmdir_recursive( $stock );
		}
	}

	public function test_get_topologies_synthesizes_defaults_when_frontmatter_silent(): void {
		$stock = $this->make_temp_dir( 'tsl-stock-' );
		\file_put_contents( "$stock/quiet.tsl", "# no var lines here\n" );
		\Newspack_Nodes\Topology_Registry::reset();
		\Newspack_Nodes\Topology_Registry::register_stock_dir( $stock );
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'quiet' ];

		try {
			$result = Bootstrap::get_topologies();
			$this->assertArrayHasKey( 'quiet', $result );
			$this->assertSame( 1, $result['quiet']['num_partitions'] );
			$this->assertSame( \Newspack_Nodes\Lock::STALE_TIMEOUT, $result['quiet']['stale_timeout'] );
		} finally {
			unset( $GLOBALS['_wp_options']['newspack_nodes_topologies'] );
			\Newspack_Nodes\Topology_Registry::reset();
			$this->rmdir_recursive( $stock );
		}
	}

	public function test_get_topologies_inherits_substrate_num_partitions_for_synthesized_entries(): void {
		// Operator bumps num_partitions to 2 and checks a TSL file the app
		// didn't publish in its catalog (here `aggregator`, mirroring the
		// real event-logger setup where `aggregator` is commented out of
		// the file-default `topologies` list). Synthesis MUST honor the
		// substrate's live num_partitions or only `aggregator.p0` will
		// spawn while the rest of the stack runs p0+p1.
		$stock = $this->make_temp_dir( 'tsl-stock-' );
		\file_put_contents( "$stock/aggregator.tsl", "# no var lines here\n" );
		\Newspack_Nodes\Topology_Registry::reset();
		\Newspack_Nodes\Topology_Registry::register_stock_dir( $stock );
		$GLOBALS['_wp_options']['newspack_nodes_topologies']     = [ 'aggregator' ];
		$GLOBALS['_wp_options']['newspack_nodes_num_partitions'] = 2;
		\Newspack_Nodes\Config::reset();

		try {
			$result = Bootstrap::get_topologies();
			$this->assertArrayHasKey( 'aggregator', $result );
			$this->assertSame( 2, $result['aggregator']['num_partitions'], 'synthesized entry must inherit substrate num_partitions' );

			// And expand_workers must emit one descriptor per partition.
			$workers = Bootstrap::expand_workers();
			$agg     = \array_values( \array_filter( $workers, fn ( $w ) => 'aggregator' === $w['type'] ) );
			$this->assertCount( 2, $agg, 'aggregator must spawn p0 and p1' );
			$this->assertSame( 0, $agg[0]['partition'] );
			$this->assertSame( 1, $agg[1]['partition'] );
		} finally {
			unset( $GLOBALS['_wp_options']['newspack_nodes_topologies'] );
			unset( $GLOBALS['_wp_options']['newspack_nodes_num_partitions'] );
			\Newspack_Nodes\Config::reset();
			\Newspack_Nodes\Topology_Registry::reset();
			$this->rmdir_recursive( $stock );
		}
	}

	public function test_get_topologies_frontmatter_wins_over_substrate_num_partitions(): void {
		// A TSL file that DOES declare `var num_partitions` in frontmatter
		// stays authoritative — substrate-num_partitions default only kicks
		// in for frontmatter-silent files.
		$stock = $this->make_temp_dir( 'tsl-stock-' );
		\file_put_contents( "$stock/single.tsl", "var num_partitions = 1\n" );
		\Newspack_Nodes\Topology_Registry::reset();
		\Newspack_Nodes\Topology_Registry::register_stock_dir( $stock );
		$GLOBALS['_wp_options']['newspack_nodes_topologies']     = [ 'single' ];
		$GLOBALS['_wp_options']['newspack_nodes_num_partitions'] = 4;
		\Newspack_Nodes\Config::reset();

		try {
			$result = Bootstrap::get_topologies();
			$this->assertSame( 1, $result['single']['num_partitions'] );
		} finally {
			unset( $GLOBALS['_wp_options']['newspack_nodes_topologies'] );
			unset( $GLOBALS['_wp_options']['newspack_nodes_num_partitions'] );
			\Newspack_Nodes\Config::reset();
			\Newspack_Nodes\Topology_Registry::reset();
			$this->rmdir_recursive( $stock );
		}
	}

	public function test_get_topologies_drops_operator_names_that_have_no_tsl_file(): void {
		// Operator option points at a topology with no TSL file (typo or
		// stale selection after the app removed the file). Must not blow
		// up the supervisor — silently dropped.
		\Newspack_Nodes\Topology_Registry::reset();
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'no-such-topology', 'also-missing' ];

		try {
			$result = Bootstrap::get_topologies();
			$this->assertSame( [], $result );
		} finally {
			unset( $GLOBALS['_wp_options']['newspack_nodes_topologies'] );
		}
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

	public function test_run_supervisor_tick_returns_without_unscheduling_when_no_topologies(): void {
		// Logging is on, but no topologies are registered — no workers to
		// spawn, no reason to actually run the supervisor's 595s loop. But
		// DO leave the cron scheduled so the next tick after the operator
		// flips a gate back on picks up the fresh topology fleet without
		// requiring plugin re-activation. A minute-cadence no-op tick is
		// cheap.
		$GLOBALS['_wp_test_next_scheduled']     = 1234567890;
		$GLOBALS['_wp_test_unscheduled_events'] = [];
		$GLOBALS['_test_outbound_posts']       = [];

		Bootstrap::run_supervisor_tick();

		$this->assertEmpty(
			$GLOBALS['_wp_test_unscheduled_events'],
			'empty topology fleet must NOT unschedule (re-enable path needs it)'
		);
		$this->assertEmpty(
			$GLOBALS['_test_outbound_posts'],
			'empty topology fleet must not invoke supervisor->run()'
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
