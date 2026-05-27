<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Supervisor;
use Newspack_Nodes\Supervisor_Base;
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
		unset( $GLOBALS['_wp_options']['newspack_nodes_topologies'] );
		\Newspack_Nodes\Config::reset();
		parent::tearDown();
	}

	// ── get_topologies ────────────────────────────────────────────────────

	public function test_get_topologies_returns_filtered_array(): void {
		\add_filter( 'newspack_nodes/topologies', function ( $topologies ) {
			$topologies['my-group'] = [ 'num_partitions' => 2, 'topology' => '/path/to/file.php' ];
			return $topologies;
		} );
		// Catalog membership no longer implies active; declare my-group active.
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'my-group' ];
		\Newspack_Nodes\Config::reset();

		try {
			$result = Bootstrap::get_topologies();
			$this->assertArrayHasKey( 'my-group', $result );
			$this->assertSame( 2, $result['my-group']['num_partitions'] );
		} finally {
			unset( $GLOBALS['_wp_options']['newspack_nodes_topologies'] );
			\Newspack_Nodes\Config::reset();
		}
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
			$this->assertSame( \Newspack_Nodes\Lock_Node::STALE_TIMEOUT, $result['quiet']['stale_timeout'] );
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

	public function test_get_topologies_uses_config_file_topologies_when_wp_option_unset(): void {
		// `topologies` is a substrate Config key: the file default is the active
		// set when no operator overlay (`newspack_nodes_topologies`) is set.
		\Newspack_Nodes\Topology_Registry::reset();
		$stock = $this->make_temp_dir();
		\file_put_contents( "{$stock}/widget.tsl", "make_node Echo e\n" );
		\Newspack_Nodes\Topology_Registry::register_stock_dir( $stock );

		$conf_dir = $this->make_temp_dir();
		$override = "{$conf_dir}/np-override.php";
		\file_put_contents( $override, "<?php return [ 'topologies' => [ 'widget' ] ];\n" );
		$ref = new \ReflectionProperty( \Newspack_Nodes\Config::class, 'allowed_config_dirs' );
		$ref->setAccessible( true );
		$orig_allowed = $ref->getValue();
		$ref->setValue( null, \array_merge( $orig_allowed, [ $conf_dir ] ) );

		unset( $GLOBALS['_wp_options']['newspack_nodes_topologies'] );
		\putenv( 'LOCAL_NEWSPACK_NODES_CONF=' . $override );
		\Newspack_Nodes\Config::reset();

		try {
			$result = Bootstrap::get_topologies();
			$this->assertArrayHasKey( 'widget', $result, 'config-file topologies is the active set when no wp-option overlay' );
		} finally {
			\putenv( 'LOCAL_NEWSPACK_NODES_CONF=' );
			$ref->setValue( null, $orig_allowed );
			\Newspack_Nodes\Config::reset();
			\Newspack_Nodes\Topology_Registry::reset();
		}
	}

	public function test_get_topologies_wp_option_overrides_config_file_topologies(): void {
		// The operator overlay wins; the config-file default is used ONLY when
		// the wp-option is unset.
		\Newspack_Nodes\Topology_Registry::reset();
		$stock = $this->make_temp_dir();
		\file_put_contents( "{$stock}/widget.tsl", "make_node Echo e\n" );
		\file_put_contents( "{$stock}/other.tsl", "make_node Echo e\n" );
		\Newspack_Nodes\Topology_Registry::register_stock_dir( $stock );

		$conf_dir = $this->make_temp_dir();
		$override = "{$conf_dir}/np-override.php";
		\file_put_contents( $override, "<?php return [ 'topologies' => [ 'widget' ] ];\n" );
		$ref = new \ReflectionProperty( \Newspack_Nodes\Config::class, 'allowed_config_dirs' );
		$ref->setAccessible( true );
		$orig_allowed = $ref->getValue();
		$ref->setValue( null, \array_merge( $orig_allowed, [ $conf_dir ] ) );

		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'other' ];
		\putenv( 'LOCAL_NEWSPACK_NODES_CONF=' . $override );
		\Newspack_Nodes\Config::reset();

		try {
			$result = Bootstrap::get_topologies();
			$this->assertArrayHasKey( 'other', $result, 'wp-option overlay selects the active set' );
			$this->assertArrayNotHasKey( 'widget', $result, 'config-file default is ignored once the wp-option is set' );
		} finally {
			unset( $GLOBALS['_wp_options']['newspack_nodes_topologies'] );
			\putenv( 'LOCAL_NEWSPACK_NODES_CONF=' );
			$ref->setValue( null, $orig_allowed );
			\Newspack_Nodes\Config::reset();
			\Newspack_Nodes\Topology_Registry::reset();
		}
	}

	public function test_register_worker_partition_mounts_input_with_1mb_segment_size(): void {
		// All IPC logs (input + output) use a 1 MiB segment_size; the server-side
		// input mount must match the worker's output side.
		$base = $this->make_temp_dir();
		\mkdir( "{$base}/locks/demo.p0.lock.d", 0755, true );
		\mkdir( "{$base}/ipc/demo.p0/input", 0755, true );

		$this->assertTrue( Bootstrap::register_worker_partition( 'demo.p0', $base ) );

		$parts = \explode( ' ', \Newspack_Nodes\Core::node( 'demo.p0' )->arguments() );
		$this->assertSame( (string) ( 1024 * 1024 ), $parts[2], 'mounted IPC input Partition segment_size must be 1 MiB' );
	}

	// ── expand_workers ────────────────────────────────────────────────────

	public function test_expand_topologies_yields_one_entry_per_partition(): void {
		\add_filter( 'newspack_nodes/topologies', function ( $topologies ) {
			$topologies['firehose-workers'] = [ 'num_partitions' => 4, 'topology' => '/x.php' ];
			$topologies['job-workers']      = [ 'num_partitions' => 2, 'topology' => '/y.php' ];
			return $topologies;
		} );
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'firehose-workers', 'job-workers' ];
		\Newspack_Nodes\Config::reset();

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
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'huge' ];
		\Newspack_Nodes\Config::reset();

		$workers = Bootstrap::expand_workers();
		$this->assertCount( Supervisor_Base::MAX_PARTITIONS, $workers );
		// Last partition index is MAX_PARTITIONS-1.
		$this->assertSame( Supervisor_Base::MAX_PARTITIONS - 1, $workers[ Supervisor_Base::MAX_PARTITIONS - 1 ]['partition'] );
	}

	public function test_expand_workers_clamps_zero_partitions_to_one(): void {
		\add_filter( 'newspack_nodes/topologies', function ( $topologies ) {
			// Edge case: explicit 0 → clamp to at least 1 partition.
			$topologies['zero'] = [ 'num_partitions' => 0, 'topology' => '/x.php' ];
			return $topologies;
		} );
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'zero' ];
		\Newspack_Nodes\Config::reset();

		$workers = Bootstrap::expand_workers();
		$this->assertCount( 1, $workers );
		$this->assertSame( 0, $workers[0]['partition'] );
	}

	public function test_expand_workers_clamps_negative_partitions_to_one(): void {
		\add_filter( 'newspack_nodes/topologies', function ( $topologies ) {
			$topologies['neg'] = [ 'num_partitions' => -5, 'topology' => '/x.php' ];
			return $topologies;
		} );
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'neg' ];
		\Newspack_Nodes\Config::reset();

		$workers = Bootstrap::expand_workers();
		$this->assertCount( 1, $workers );
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

	// ── self_heal_supervisor_cron ─────────────────────────────────────────

	public function test_self_heal_schedules_when_logging_on_topologies_present_cron_missing(): void {
		\add_filter( 'newspack_nodes/topologies', function ( $topologies ) {
			$topologies['my-fleet'] = [ 'num_partitions' => 1, 'topology' => '/x.php' ];
			return $topologies;
		} );
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'my-fleet' ];
		\Newspack_Nodes\Config::reset();
		$GLOBALS['_wp_test_next_scheduled'] = false;

		Bootstrap::self_heal_supervisor_cron();

		$this->assertNotEmpty(
			$GLOBALS['_wp_test_scheduled_events'],
			'self-heal must call activate() when all 3 conditions are met'
		);
		$this->assertSame( 'newspack_nodes/supervisor', $GLOBALS['_wp_test_scheduled_events'][0]['hook'] );
	}

	public function test_self_heal_skips_when_logging_disabled(): void {
		\add_filter( 'newspack_nodes/enable_logging', fn() => false );
		\add_filter( 'newspack_nodes/topologies', function ( $topologies ) {
			$topologies['my-fleet'] = [ 'num_partitions' => 1, 'topology' => '/x.php' ];
			return $topologies;
		} );
		$GLOBALS['_wp_test_next_scheduled'] = false;

		Bootstrap::self_heal_supervisor_cron();

		$this->assertEmpty(
			$GLOBALS['_wp_test_scheduled_events'],
			'logging-disabled must short-circuit before scheduling'
		);
	}

	public function test_self_heal_skips_when_no_topologies_selected(): void {
		$GLOBALS['_wp_test_next_scheduled'] = false;

		Bootstrap::self_heal_supervisor_cron();

		$this->assertEmpty(
			$GLOBALS['_wp_test_scheduled_events'],
			'empty topology set must short-circuit before scheduling'
		);
	}

	public function test_self_heal_skips_when_cron_already_scheduled(): void {
		\add_filter( 'newspack_nodes/topologies', function ( $topologies ) {
			$topologies['my-fleet'] = [ 'num_partitions' => 1, 'topology' => '/x.php' ];
			return $topologies;
		} );
		$GLOBALS['_wp_test_next_scheduled'] = 1234567890;

		Bootstrap::self_heal_supervisor_cron();

		$this->assertEmpty(
			$GLOBALS['_wp_test_scheduled_events'],
			'no need to re-schedule when wp_next_scheduled returns a timestamp'
		);
	}

	// ── supervisor() factory ──────────────────────────────────────────────

	public function test_supervisor_returns_supervisor_instance(): void {
		$s = Bootstrap::supervisor();
		$this->assertInstanceOf( Supervisor::class, $s );
	}

	// ── get_topology_catalog ──────────────────────────────────────────────

	public function test_get_topology_catalog_returns_unfiltered_set(): void {
		// get_topology_catalog ignores the active-overlay option entirely:
		// admin UI checkboxes render against this so operators can see every
		// available topology, including ones currently unchecked.
		\add_filter( 'newspack_nodes/topologies', function ( $topologies ) {
			$topologies['firehose-workers'] = [ 'num_partitions' => 2, 'topology' => '/x.php' ];
			$topologies['job-workers']      = [ 'num_partitions' => 1, 'topology' => '/y.php' ];
			return $topologies;
		} );
		// Stored option says: only firehose-workers is "active".
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'firehose-workers' ];

		try {
			$catalog = Bootstrap::get_topology_catalog();

			// Full catalog returned — the option overlay is ignored.
			$this->assertCount( 2, $catalog );
			$this->assertArrayHasKey( 'firehose-workers', $catalog );
			$this->assertArrayHasKey( 'job-workers', $catalog );
		} finally {
			unset( $GLOBALS['_wp_options']['newspack_nodes_topologies'] );
		}
	}

	public function test_get_topology_catalog_returns_empty_array_when_no_filter(): void {
		// No filter registered → catalog is empty (matches get_topologies
		// behaviour in the same scenario).
		$this->assertSame( [], Bootstrap::get_topology_catalog() );
	}

	// ── base_dir ──────────────────────────────────────────────────────────

	public function test_base_dir_returns_config_base_directory(): void {
		// Bootstrap::base_dir() pulls base_directory out of
		// Config::load_config(). use_base_dir() writes a per-test config file
		// pointing at $tmp; verify the static reads the same source.
		$prev_env = \getenv( 'LOCAL_NEWSPACK_NODES_CONF' );
		$tmp      = $this->make_temp_dir( 'bootstrap-base-dir-' );
		try {
			$this->use_base_dir( $tmp );
			$this->assertSame( $tmp, Bootstrap::base_dir() );
		} finally {
			// Restore the env var so subsequent tests aren't pointed at
			// a now-deleted config file.
			\putenv( 'LOCAL_NEWSPACK_NODES_CONF=' . ( false === $prev_env ? '' : $prev_env ) );
			\Newspack_Nodes\Config::reset();
			$this->rmdir_recursive( $tmp );
		}
	}

	public function test_base_dir_returns_string(): void {
		// With the bootstrap-default config file in play (set by phpunit's
		// env var), base_dir resolves to /tmp/newspack-nodes-test. Either
		// way the contract is: returns a non-empty string ready for use.
		$dir = Bootstrap::base_dir();
		$this->assertIsString( $dir );
		$this->assertNotSame( '', $dir );
	}

	public function test_base_dir_propagates_throw_when_unconfigured(): void {
		// No silent `/tmp/newspack-nodes` fallback: base_dir() must propagate
		// Config::get_base_directory()'s RuntimeException when base_directory
		// is unconfigured, so the supervisor fails loud instead of running
		// against a phantom default tree.
		$prev_env = \getenv( 'LOCAL_NEWSPACK_NODES_CONF' );
		$tmp      = $this->make_temp_dir( 'bootstrap-no-base-' );
		try {
			$conf = "{$tmp}/empty-base.php";
			\file_put_contents( $conf, "<?php\nreturn [ 'base_directory' => '' ];\n" );
			$ref  = new \ReflectionProperty( \Newspack_Nodes\Config::class, 'allowed_config_dirs' );
			$ref->setAccessible( true );
			$dirs   = $ref->getValue();
			$dirs[] = $tmp;
			$ref->setValue( null, $dirs );
			\putenv( 'LOCAL_NEWSPACK_NODES_CONF=' . $conf );
			\update_option( 'newspack_nodes_base_directory', '' );
			\Newspack_Nodes\Config::reset();

			$this->expectException( \RuntimeException::class );
			$this->expectExceptionMessageMatches( '/base_directory not configured/' );
			Bootstrap::base_dir();
		} finally {
			\putenv( 'LOCAL_NEWSPACK_NODES_CONF=' . ( false === $prev_env ? '' : $prev_env ) );
			\Newspack_Nodes\Config::reset();
			$this->rmdir_recursive( $tmp );
		}
	}

	// ── register_rest_routes ──────────────────────────────────────────────

	public function test_register_rest_routes_registers_all_substrate_routes(): void {
		// register_rest_routes news up each REST controller and calls
		// register_routes() on it. We verify by inspecting the global
		// stub registry — every controller should land at least one route.
		$GLOBALS['_wp_test_registered_routes'] = [];

		Bootstrap::register_rest_routes();

		$routes     = $GLOBALS['_wp_test_registered_routes'];
		$this->assertNotEmpty( $routes, 'register_rest_routes must register at least one route' );

		// Spawn endpoint is the only canonical one we can pin down by route
		// path; the rest of the controllers register at least one route each
		// (count >= 5 controllers worth of registrations).
		$paths = \array_column( $routes, 'route' );
		$this->assertContains( '/workers/spawn', $paths, 'spawn route must be registered' );
		// All routes are namespaced under newspack-nodes/v1.
		foreach ( $routes as $route ) {
			$this->assertSame( 'newspack-nodes/v1', $route['namespace'] );
		}
	}

	// ── deactivate ─────────────────────────────────────────────────────────

	public function test_deactivate_clears_supervisor_cron_hook(): void {
		// Deactivation calls wp_clear_scheduled_hook for the supervisor.
		// The stub doesn't capture invocations, so we just verify the call
		// runs to completion without throwing — the same idempotency the
		// real WP function provides.
		Bootstrap::deactivate();
		Bootstrap::deactivate(); // idempotent.
		$this->assertTrue( true, 'deactivate() must run to completion (idempotent)' );
	}

	// ── run_supervisor_tick: full execution ──────────────────────────────

	public function test_run_supervisor_tick_invokes_supervisor_run_when_topology_present(): void {
		// Happy-path branch: logging enabled, topologies non-empty → wraps the
		// `newspack_nodes/before_supervisor_run` and `/after_supervisor_run`
		// actions around a Supervisor::run() invocation, and tags $_SERVER
		// with worker_type=supervisor.
		\add_filter( 'newspack_nodes/topologies', function () {
			return [
				'firehose-workers' => [ 'num_partitions' => 1, 'topology' => '/x.php' ],
			];
		} );
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'firehose-workers' ];
		\Newspack_Nodes\Config::reset();
		// Disable logging from inside the supervisor so run() bails after the
		// $_SERVER tag + before-action fire but before tick_loop hits sleep(1).
		// This keeps the test fast (<1s) while still proving the wrapper code
		// path is executed.
		\add_filter( 'newspack_nodes/enable_logging', function ( $allowed ) {
			static $called = 0;
			++$called;
			// First call comes from is_logging_enabled() at the top of
			// run_supervisor_tick — must return true to proceed past the
			// guard. Subsequent calls (Supervisor::check_config) return
			// false so run() bails fast.
			return 1 === $called;
		} );

		// Pre-flight: clean state.
		unset(
			$_SERVER['NEWSPACK_NODES_WORKER_TYPE'],
			$_SERVER['NEWSPACK_NODES_WORKER_PARTITION']
		);
		$before = 0;
		$after  = 0;
		\add_action( 'newspack_nodes/before_supervisor_run', function () use ( &$before ) { ++$before; } );
		\add_action( 'newspack_nodes/after_supervisor_run', function () use ( &$after ) { ++$after; } );

		Bootstrap::run_supervisor_tick();

		$this->assertSame( 'supervisor', $_SERVER['NEWSPACK_NODES_WORKER_TYPE'] );
		$this->assertSame( '0', $_SERVER['NEWSPACK_NODES_WORKER_PARTITION'] );
		$this->assertSame( 1, $before, 'before_supervisor_run action must fire' );
		$this->assertSame( 1, $after, 'after_supervisor_run action must fire even when supervisor bails fast' );

		// Clean up env after.
		unset(
			$_SERVER['NEWSPACK_NODES_WORKER_TYPE'],
			$_SERVER['NEWSPACK_NODES_WORKER_PARTITION']
		);
	}

	public function test_run_supervisor_tick_after_action_fires_even_when_run_throws(): void {
		// The finally block must fire `after_supervisor_run` even when
		// Supervisor::run() throws — the action is part of the lifecycle
		// contract, not gated on success.
		\add_filter( 'newspack_nodes/topologies', function () {
			return [ 'noop' => [ 'num_partitions' => 1, 'topology' => '/x.php' ] ];
		} );
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'noop' ];
		\Newspack_Nodes\Config::reset();
		// First call (run_supervisor_tick guard) → true; later (Supervisor)
		// throws synthetically before sleeping.
		\add_filter( 'newspack_nodes/enable_logging', function ( $allowed ) {
			static $n = 0;
			++$n;
			if ( 1 === $n ) {
				return true;
			}
			throw new \RuntimeException( 'simulated supervisor failure' );
		} );

		$after = 0;
		\add_action( 'newspack_nodes/after_supervisor_run', function () use ( &$after ) { ++$after; } );

		try {
			Bootstrap::run_supervisor_tick();
		} catch ( \RuntimeException $e ) {
			// Expected — propagated through finally.
		}

		$this->assertSame( 1, $after, 'after_supervisor_run must fire from finally on throw' );

		unset(
			$_SERVER['NEWSPACK_NODES_WORKER_TYPE'],
			$_SERVER['NEWSPACK_NODES_WORKER_PARTITION']
		);
	}
}
