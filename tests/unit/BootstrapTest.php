<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Node_Names;
use Newspack_Nodes\Spawn_Coordinator;
use Newspack_Nodes\Tests\TestCase;

#[CoversClass( Bootstrap::class )]
class BootstrapTest extends TestCase {

	/** @var \Closure|null Bootstrap-installed curl seam, restored so a capturer cannot leak. */
	private $saved_curl_exec;

	protected function setUp(): void {
		parent::setUp();
		$this->saved_curl_exec                 = \Newspack_Nodes\Core::$curl_exec;
		$GLOBALS['_wp_actions']                = [];
		$GLOBALS['_wp_test_scheduled_events']  = [];
		$GLOBALS['_wp_test_unscheduled_events'] = [];
		$GLOBALS['_test_outbound_posts']      = [];
		$GLOBALS['_wp_test_next_scheduled']    = false;
		unset( $GLOBALS['_wp_test_schedule_event_response'], $GLOBALS['_wp_test_current_filter'], $GLOBALS['wp_filter'] );
		// Bootstrap fleet seams are process-static; clear so a test that sets
		// them doesn't bleed into the next.
		Bootstrap::$fleet_enabled_override = null;
		Bootstrap::$spawn_coordinator_factory          = null;
		// Config is statically cached — clear so each test sees fresh option
		// values. get_topologies() now reads Config::load_config()['num_partitions']
		// to default synthesized entries, so stale cache here leaks
		// num_partitions across tests.
		\Newspack_Nodes\Config::reset();
	}

	protected function tearDown(): void {
		\Newspack_Nodes\Core::$curl_exec = $this->saved_curl_exec;
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

	public function test_frontmatter_num_partitions_above_config_default_expands_to_that_count(): void {
		// Guards the "support num_partitions = 4 ≠ config" requirement: a
		// per-topology `var num_partitions = 4` that DIFFERS from the substrate
		// default (1) must resolve to 4 AND spawn 4 workers (p0..p3).
		$stock = $this->make_temp_dir( 'tsl-stock-' );
		\file_put_contents( "$stock/wide.tsl", "var num_partitions = 4\n" );
		\Newspack_Nodes\Topology_Registry::reset();
		\Newspack_Nodes\Topology_Registry::register_stock_dir( $stock );
		$GLOBALS['_wp_options']['newspack_nodes_topologies']     = [ 'wide' ];
		$GLOBALS['_wp_options']['newspack_nodes_num_partitions'] = 1;
		\Newspack_Nodes\Config::reset();

		try {
			$result = Bootstrap::get_topologies();
			$this->assertSame( 4, $result['wide']['num_partitions'] );

			$workers = Bootstrap::expand_workers();
			$wide    = \array_values(
				\array_filter(
					$workers,
					static fn ( $w ) => 'wide' === $w['type']
				)
			);
			$this->assertCount( 4, $wide );
			$this->assertSame( [ 0, 1, 2, 3 ], \array_column( $wide, 'partition' ) );
		} finally {
			unset( $GLOBALS['_wp_options']['newspack_nodes_topologies'] );
			unset( $GLOBALS['_wp_options']['newspack_nodes_num_partitions'] );
			\Newspack_Nodes\Config::reset();
			\Newspack_Nodes\Topology_Registry::reset();
			$this->rmdir_recursive( $stock );
		}
	}

	// ── num_partitions_for ─────────────────────────────────────────────────

	public function test_num_partitions_for_reads_frontmatter_var(): void {
		$stock = $this->make_temp_dir( 'tsl-stock-' );
		\file_put_contents( "$stock/wide.tsl", "var num_partitions = 5\n" );
		\Newspack_Nodes\Topology_Registry::reset();
		\Newspack_Nodes\Topology_Registry::register_stock_dir( $stock );

		try {
			$this->assertSame( 5, Bootstrap::num_partitions_for( 'wide' ) );
		} finally {
			\Newspack_Nodes\Topology_Registry::reset();
			$this->rmdir_recursive( $stock );
		}
	}

	public function test_num_partitions_for_prefers_catalog_count(): void {
		\add_filter(
			'newspack_nodes/topologies',
			static function ( array $topologies ): array {
				$topologies['grp'] = [ 'topology' => 'grp', 'num_partitions' => 6, 'stale_timeout' => 60 ];
				return $topologies;
			}
		);
		$this->assertSame( 6, Bootstrap::num_partitions_for( 'grp' ) );
	}

	public function test_num_partitions_for_clamps_to_spawnable_range(): void {
		// The menu count must match what the fleet would SPAWN — and
		// expand_workers clamps to [1, MAX_PARTITIONS]. An out-of-range count
		// (frontmatter typo / bad catalog entry) must clamp the same way, else
		// the Path menu lists workers the fleet never starts.
		\add_filter(
			'newspack_nodes/topologies',
			static function ( array $topologies ): array {
				$topologies['huge'] = [ 'topology' => 'huge', 'num_partitions' => 99, 'stale_timeout' => 60 ];
				return $topologies;
			}
		);
		$this->assertSame(
			\Newspack_Nodes\Spawn_Coordinator::MAX_PARTITIONS,
			Bootstrap::num_partitions_for( 'huge' )
		);
	}

	public function test_num_partitions_for_falls_back_to_config_default(): void {
		$stock = $this->make_temp_dir( 'tsl-stock-' );
		\file_put_contents( "$stock/quiet.tsl", "# no var lines here\n" );
		\Newspack_Nodes\Topology_Registry::reset();
		\Newspack_Nodes\Topology_Registry::register_stock_dir( $stock );
		$GLOBALS['_wp_options']['newspack_nodes_num_partitions'] = 7;
		\Newspack_Nodes\Config::reset();

		try {
			$this->assertSame( 7, Bootstrap::num_partitions_for( 'quiet' ) );
		} finally {
			unset( $GLOBALS['_wp_options']['newspack_nodes_num_partitions'] );
			\Newspack_Nodes\Config::reset();
			\Newspack_Nodes\Topology_Registry::reset();
			$this->rmdir_recursive( $stock );
		}
	}

	public function test_get_topologies_drops_operator_names_that_have_no_tsl_file(): void {
		// Operator option points at a topology with no TSL file (typo or
		// stale selection after the app removed the file). Must not blow
		// up the fleet — silently dropped.
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

		unset( $GLOBALS['_wp_options']['newspack_nodes_topologies'] );
		\putenv( 'LOCAL_NEWSPACK_NODES_CONF=' . $override );
		\Newspack_Nodes\Config::reset();

		try {
			$result = Bootstrap::get_topologies();
			$this->assertArrayHasKey( 'widget', $result, 'config-file topologies is the active set when no wp-option overlay' );
		} finally {
			\putenv( 'LOCAL_NEWSPACK_NODES_CONF=' );
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

		$parts = \Newspack_Nodes\Core::node( 'demo.p0' )->arguments();
		$this->assertSame( (string) ( 1024 * 1024 ), $parts[1], 'mounted IPC input Partition segment_size must be 1 MiB' );
	}

	/**
	 * A sleeping on-demand worker has neither a lock dir nor an IPC tree, and
	 * this mount is what the BROWSER writes commands through — so refusing here
	 * meant a topology that went idle could never be woken from the console
	 * again, only by something else happening to spawn it.
	 */
	public function test_register_worker_partition_mounts_and_wakes_a_sleeping_on_demand_worker(): void {
		$base = $this->make_temp_dir();
		$this->use_base_dir( $base );
		$posts = [];
		\Newspack_Nodes\Core::$curl_exec = static function ( \CurlHandle $ch, array $body ) use ( &$posts ) {
			$posts[] = $body;
			return '';
		};
		\add_filter(
			'newspack_nodes/topologies',
			static fn ( array $t ): array => $t + [
				'demo' => [ 'topology' => 'demo', 'num_partitions' => 1, 'on_demand_idle' => 23 ],
			]
		);
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'demo' ];

		$this->assertTrue( Bootstrap::register_worker_partition( 'demo.p0', $base ) );
		$this->assertSame(
			[ 'demo.p0' ],
			\array_map( static fn ( array $b ): string => $b['type'] . '.p' . $b['partition'], $posts )
		);
	}

	/** A RESIDENT worker with no lock dir is a dead fleet, and still refused. */
	public function test_register_worker_partition_still_refuses_a_resident_worker(): void {
		$base = $this->make_temp_dir();
		$this->use_base_dir( $base );

		$this->assertFalse( Bootstrap::register_worker_partition( 'demo.p0', $base ) );
	}

	public function test_register_worker_partition_sets_patron_to_interpreter_when_present(): void {
		// Rule 2: the mounted IPC Partition is a sibling (plumbing). With a
		// _command_interpreter in scope it must be patron-linked to it so
		// dump_metadata hides it from the canvas.
		$ci = new Command_Interpreter_Node();
		$ci->name( Node_Names::COMMAND_INTERPRETER );

		$base = $this->make_temp_dir();
		\mkdir( "{$base}/locks/demo.p0.lock.d", 0755, true );
		\mkdir( "{$base}/ipc/demo.p0/input", 0755, true );

		$this->assertTrue( Bootstrap::register_worker_partition( 'demo.p0', $base ) );

		$part = Core::node( 'demo.p0' );
		$this->assertSame( $ci, $part->patron(), 'sibling Partition must be patron-linked to the interpreter' );
	}

	public function test_register_worker_partition_sinks_to_interpreter_when_present(): void {
		// Rule 2: the sibling has no specific sink of its own, so it must be
		// sunk into the in-scope _command_interpreter.
		$ci = new Command_Interpreter_Node();
		$ci->name( Node_Names::COMMAND_INTERPRETER );

		$base = $this->make_temp_dir();
		\mkdir( "{$base}/locks/demo.p0.lock.d", 0755, true );
		\mkdir( "{$base}/ipc/demo.p0/input", 0755, true );

		$this->assertTrue( Bootstrap::register_worker_partition( 'demo.p0', $base ) );

		$part = Core::node( 'demo.p0' );
		$this->assertSame( $ci, $part->sink(), 'sibling Partition must be sunk into the interpreter' );
	}

	public function test_register_worker_partition_skips_patron_and_sink_with_no_interpreter(): void {
		// Rule 4: no _command_interpreter in scope → still NAME the sibling but
		// skip the interpreter patron/sink (no owning node to plumb for).
		$base = $this->make_temp_dir();
		\mkdir( "{$base}/locks/demo.p0.lock.d", 0755, true );
		\mkdir( "{$base}/ipc/demo.p0/input", 0755, true );

		$this->assertTrue( Bootstrap::register_worker_partition( 'demo.p0', $base ) );

		$part = Core::node( 'demo.p0' );
		$this->assertSame( 'demo.p0', $part->name(), 'sibling stays named even without an interpreter' );
		$this->assertNull( $part->patron(), 'no interpreter in scope → no patron' );
		$this->assertNull( $part->sink(), 'no interpreter in scope → no sink' );
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
		$this->assertCount( Spawn_Coordinator::MAX_PARTITIONS, $workers );
		// Last partition index is MAX_PARTITIONS-1.
		$this->assertSame( Spawn_Coordinator::MAX_PARTITIONS - 1, $workers[ Spawn_Coordinator::MAX_PARTITIONS - 1 ]['partition'] );
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

	// ── is_fleet_enabled ────────────────────────────────────────────────

	public function test_is_fleet_enabled_defaults_true(): void {
		$this->assertTrue( Bootstrap::is_fleet_enabled() );
	}

	public function test_is_fleet_enabled_override_to_false(): void {
		Bootstrap::$fleet_enabled_override = false;
		$this->assertFalse( Bootstrap::is_fleet_enabled() );
	}

	public function test_spawn_coordinator_factory_seam_overrides_construction(): void {
		$fake                          = new Spawn_Coordinator( '/tmp/seam-4242' );
		Bootstrap::$spawn_coordinator_factory = static fn (): Spawn_Coordinator => $fake;
		$this->assertSame( $fake, Bootstrap::spawn_coordinator() );
	}

	// ── reconcile_fleet gate ──────────────────────────────────────────

	public function test_reconcile_fleet_unschedules_when_logging_disabled(): void {
		Bootstrap::$fleet_enabled_override = false;
		$GLOBALS['_wp_test_next_scheduled']     = 1234567890;
		$GLOBALS['_wp_test_unscheduled_events'] = [];

		Bootstrap::reconcile_fleet();

		$this->assertNotEmpty(
			$GLOBALS['_wp_test_unscheduled_events'],
			'fleet disabled must unschedule the reconcile cron'
		);
		$this->assertSame( 'newspack_nodes/reconcile', $GLOBALS['_wp_test_unscheduled_events'][0]['hook'] );
	}

	public function test_reconcile_fleet_unschedules_only_when_event_present(): void {
		Bootstrap::$fleet_enabled_override = false;
		$GLOBALS['_wp_test_next_scheduled']     = false;
		$GLOBALS['_wp_test_unscheduled_events'] = [];

		Bootstrap::reconcile_fleet();

		$this->assertEmpty(
			$GLOBALS['_wp_test_unscheduled_events'],
			'no scheduled event = nothing to unschedule'
		);
	}

	public function test_reconcile_fleet_returns_without_unscheduling_when_no_topologies(): void {
		// Logging is on, but no topologies are registered — no workers to
		// spawn, no reason to actually run the fleet's 595s loop. But
		// DO leave the cron scheduled so the next tick after the operator
		// flips a gate back on picks up the fresh topology fleet without
		// requiring plugin re-activation. A minute-cadence no-op tick is
		// cheap.
		$GLOBALS['_wp_test_next_scheduled']     = 1234567890;
		$GLOBALS['_wp_test_unscheduled_events'] = [];
		$GLOBALS['_test_outbound_posts']       = [];

		Bootstrap::reconcile_fleet();

		$this->assertEmpty(
			$GLOBALS['_wp_test_unscheduled_events'],
			'empty topology fleet must NOT unschedule (re-enable path needs it)'
		);
		$this->assertEmpty(
			$GLOBALS['_test_outbound_posts'],
			'empty topology fleet must not invoke fleet run()'
		);
	}

	// ── unschedule_reconcile ─────────────────────────────────────────────

	public function test_unschedule_reconcile_clears_existing_event(): void {
		$GLOBALS['_wp_test_next_scheduled']     = 99;
		$GLOBALS['_wp_test_unscheduled_events'] = [];

		Bootstrap::unschedule_reconcile();

		$this->assertCount( 1, $GLOBALS['_wp_test_unscheduled_events'] );
		$this->assertSame( 99, $GLOBALS['_wp_test_unscheduled_events'][0]['timestamp'] );
		$this->assertSame( 'newspack_nodes/reconcile', $GLOBALS['_wp_test_unscheduled_events'][0]['hook'] );
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

	public function test_activate_schedules_reconcile_at_minute_cadence(): void {
		Bootstrap::activate();
		$this->assertNotEmpty( $GLOBALS['_wp_test_scheduled_events'] );
		$evt = $GLOBALS['_wp_test_scheduled_events'][0];
		$this->assertSame( 'newspack_nodes_minute', $evt['recurrence'] );
		$this->assertSame( 'newspack_nodes/reconcile', $evt['hook'] );
	}

	public function test_activate_skipped_when_already_scheduled(): void {
		$GLOBALS['_wp_test_next_scheduled'] = 1234567890;
		Bootstrap::activate();
		$this->assertEmpty( $GLOBALS['_wp_test_scheduled_events'] );
	}

	// ── reconcile cron scheduling diagnostics ───────────────────────────

	/** Capture Core::stderr output for the duration of a callable. */
	private function capture_stderr( callable $fn ): string {
		$lines = [];
		Core::set_stderr_handler( function ( string $message ) use ( &$lines ): void {
			$lines[] = $message;
		} );
		$fn();
		return \implode( '', $lines );
	}

	public function test_activate_logs_code_and_message_on_schedule_error(): void {
		$GLOBALS['_wp_test_schedule_event_response'] = new \WP_Error( 'invalid_schedule', 'Event schedule does not exist.' );

		$log = $this->capture_stderr( static function (): void {
			Bootstrap::activate();
		} );

		$this->assertStringContainsString( 'reconcile cron schedule failed', $log );
		$this->assertStringContainsString( 'code=invalid_schedule', $log );
		$this->assertStringContainsString( 'Event schedule does not exist.', $log );
	}

	public function test_plugin_registers_veto_detector_on_both_pre_schedule_filters(): void {
		$registrations = $GLOBALS['_wp_initial_action_registrations'];

		foreach ( [ 'pre_schedule_event', 'pre_reschedule_event' ] as $filter ) {
			$this->assertContains(
				[
					'callback'      => [ '\\Newspack_Nodes\\Bootstrap', 'log_reconcile_schedule_veto' ],
					'priority'      => PHP_INT_MAX - 2,
					'accepted_args' => 2,
				],
				$registrations[ $filter ] ?? [],
				"missing detector on {$filter}"
			);
		}
	}

	public function test_plugin_registers_schedule_event_veto_detector(): void {
		$registrations = $GLOBALS['_wp_initial_action_registrations'];

		$this->assertContains(
			[
				'callback'      => [ '\\Newspack_Nodes\\Bootstrap', 'remember_schedule_event_context' ],
				'priority'      => PHP_INT_MIN + 2,
				'accepted_args' => 1,
			],
			$registrations['schedule_event'] ?? [],
			'missing schedule_event context capture'
		);
		$this->assertContains(
			[
				'callback'      => [ '\\Newspack_Nodes\\Bootstrap', 'log_reconcile_schedule_event_veto' ],
				'priority'      => PHP_INT_MAX - 2,
				'accepted_args' => 1,
			],
			$registrations['schedule_event'] ?? [],
			'missing schedule_event veto detector'
		);
	}

	public function test_veto_detector_passes_through_unrelated_hooks_without_logging(): void {
		$event = (object) [ 'hook' => 'wp_update_plugins' ];

		$log = '';
		$pre = null;
		$log = $this->capture_stderr( static function () use ( &$pre, $event ): void {
			$pre = Bootstrap::log_reconcile_schedule_veto( false, $event );
		} );

		$this->assertFalse( $pre );
		$this->assertSame( '', $log );
	}

	public function test_veto_detector_passes_through_malformed_events_without_logging(): void {
		$results = [];
		$log     = $this->capture_stderr( static function () use ( &$results ): void {
			$results[] = Bootstrap::log_reconcile_schedule_veto( false, null );
			$results[] = Bootstrap::log_reconcile_schedule_veto( false, (object) [] );
			$results[] = Bootstrap::log_reconcile_schedule_veto( false, 'not-an-object' );
		} );

		$this->assertSame( [ false, false, false ], $results );
		$this->assertSame( '', $log );
	}

	public function test_veto_detector_ignores_null_and_truthy_pre(): void {
		$event = (object) [ 'hook' => 'newspack_nodes/reconcile' ];

		$results = [];
		$log     = $this->capture_stderr( static function () use ( &$results, $event ): void {
			$results[] = Bootstrap::log_reconcile_schedule_veto( null, $event );
			$results[] = Bootstrap::log_reconcile_schedule_veto( true, $event );
		} );

		$this->assertSame( [ null, true ], $results );
		$this->assertSame( '', $log );
	}

	public function test_veto_detector_logs_false_veto_with_current_filter_chain(): void {
		global $wp_filter;

		$GLOBALS['_wp_test_current_filter'] = 'pre_schedule_event';
		$wp_filter                          = [
			'pre_schedule_event' => (object) [
				'callbacks' => [
					10 => [
						'newspack_nodes_test_veto_filter' => [
							'function'      => 'newspack_nodes_test_veto_filter',
							'accepted_args' => 3,
						],
					],
				],
			],
		];
		$event = (object) [ 'hook' => 'newspack_nodes/reconcile' ];

		$pre = null;
		$log = $this->capture_stderr( static function () use ( &$pre, $event ): void {
			$pre = Bootstrap::log_reconcile_schedule_veto( false, $event );
		} );
		unset( $GLOBALS['wp_filter'], $GLOBALS['_wp_test_current_filter'] );

		$this->assertFalse( $pre );
		$this->assertStringContainsString( 'reconcile cron vetoed', $log );
		$this->assertStringContainsString( 'filter=pre_schedule_event', $log );
		$this->assertStringContainsString( 'value=false', $log );
		$this->assertStringContainsString( 'callbacks=[10 newspack_nodes_test_veto_filter]', $log );
	}

	public function test_veto_detector_logs_wp_error_code_and_message(): void {
		$GLOBALS['_wp_test_current_filter'] = 'pre_reschedule_event';
		$event                              = (object) [ 'hook' => 'newspack_nodes/reconcile' ];
		$error                              = new \WP_Error( 'cron_storage_down', 'Could not persist the event.' );

		$pre = null;
		$log = $this->capture_stderr( static function () use ( &$pre, $event, $error ): void {
			$pre = Bootstrap::log_reconcile_schedule_veto( $error, $event );
		} );
		unset( $GLOBALS['_wp_test_current_filter'] );

		$this->assertSame( $error, $pre );
		$this->assertStringContainsString( 'filter=pre_reschedule_event', $log );
		$this->assertStringContainsString( 'value=cron_storage_down: Could not persist the event.', $log );
	}

	public function test_veto_detector_redacts_anonymous_callback_paths(): void {
		global $wp_filter;

		$callback = new class() {
			public function __invoke(): void {}
		};
		$GLOBALS['_wp_test_current_filter'] = 'pre_schedule_event';
		$wp_filter                          = [
			'pre_schedule_event' => (object) [
				'callbacks' => [
					10 => [
						'anon' => [
							'function'      => $callback,
							'accepted_args' => 1,
						],
					],
				],
			],
		];
		$event = (object) [ 'hook' => 'newspack_nodes/reconcile' ];

		$log = $this->capture_stderr( static function () use ( $event ): void {
			Bootstrap::log_reconcile_schedule_veto( false, $event );
		} );
		unset( $GLOBALS['wp_filter'], $GLOBALS['_wp_test_current_filter'] );

		$this->assertStringContainsString( 'callbacks=[10 {anonymous}::__invoke]', $log );
		$this->assertStringNotContainsString( __FILE__, $log );
	}

	public function test_veto_detector_rate_limits_repeat_logs_within_process(): void {
		$GLOBALS['_wp_test_current_filter'] = 'pre_schedule_event';
		$event                              = (object) [ 'hook' => 'newspack_nodes/reconcile' ];

		$log = $this->capture_stderr( static function () use ( $event ): void {
			Bootstrap::log_reconcile_schedule_veto( false, $event );
			Bootstrap::log_reconcile_schedule_veto( false, $event );
		} );
		unset( $GLOBALS['_wp_test_current_filter'] );

		$this->assertSame( 1, \substr_count( $log, 'reconcile cron vetoed' ) );
	}

	public function test_schedule_event_detector_logs_false_veto_with_remembered_reconcile_context(): void {
		global $wp_filter;

		$this->assertTrue( \is_callable( [ Bootstrap::class, 'remember_schedule_event_context' ] ) );
		$this->assertTrue( \is_callable( [ Bootstrap::class, 'log_reconcile_schedule_event_veto' ] ) );

		$GLOBALS['_wp_test_current_filter'] = 'schedule_event';
		$wp_filter                          = [
			'schedule_event' => (object) [
				'callbacks' => [
					10 => [
						'newspack_nodes_test_schedule_event_veto' => [
							'function'      => 'newspack_nodes_test_schedule_event_veto',
							'accepted_args' => 1,
						],
					],
				],
			],
		];
		$event = (object) [ 'hook' => 'newspack_nodes/reconcile' ];

		$pre = null;
		$log = $this->capture_stderr( static function () use ( &$pre, $event ): void {
			Bootstrap::remember_schedule_event_context( $event );
			$pre = Bootstrap::log_reconcile_schedule_event_veto( false );
		} );
		unset( $GLOBALS['wp_filter'], $GLOBALS['_wp_test_current_filter'] );

		$this->assertFalse( $pre );
		$this->assertStringContainsString( 'reconcile cron vetoed', $log );
		$this->assertStringContainsString( 'filter=schedule_event', $log );
		$this->assertStringContainsString( 'value=falsy', $log );
		$this->assertStringContainsString( 'callbacks=[10 newspack_nodes_test_schedule_event_veto]', $log );
	}

	public function test_schedule_event_detector_logs_null_veto_with_remembered_reconcile_context(): void {
		$GLOBALS['_wp_test_current_filter'] = 'schedule_event';
		$event                              = (object) [ 'hook' => 'newspack_nodes/reconcile' ];

		$pre = 'unchanged';
		$log = $this->capture_stderr( static function () use ( &$pre, $event ): void {
			Bootstrap::remember_schedule_event_context( $event );
			$pre = Bootstrap::log_reconcile_schedule_event_veto( null );
		} );
		unset( $GLOBALS['_wp_test_current_filter'] );

		$this->assertNull( $pre );
		$this->assertStringContainsString( 'reconcile cron vetoed', $log );
		$this->assertStringContainsString( 'filter=schedule_event', $log );
		$this->assertStringContainsString( 'value=falsy', $log );
	}

	public function test_schedule_event_detector_ignores_false_veto_without_reconcile_context(): void {
		$this->assertTrue( \is_callable( [ Bootstrap::class, 'remember_schedule_event_context' ] ) );
		$this->assertTrue( \is_callable( [ Bootstrap::class, 'log_reconcile_schedule_event_veto' ] ) );

		$GLOBALS['_wp_test_current_filter'] = 'schedule_event';
		$event                              = (object) [ 'hook' => 'wp_update_plugins' ];

		$pre = null;
		$log = $this->capture_stderr( static function () use ( &$pre, $event ): void {
			Bootstrap::remember_schedule_event_context( $event );
			$pre = Bootstrap::log_reconcile_schedule_event_veto( false );
		} );
		unset( $GLOBALS['_wp_test_current_filter'] );

		$this->assertFalse( $pre );
		$this->assertSame( '', $log );
	}

	// ── self_heal_reconcile_cron ─────────────────────────────────────────

	public function test_self_heal_schedules_when_logging_on_topologies_present_cron_missing(): void {
		\add_filter( 'newspack_nodes/topologies', function ( $topologies ) {
			$topologies['my-fleet'] = [ 'num_partitions' => 1, 'topology' => '/x.php' ];
			return $topologies;
		} );
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'my-fleet' ];
		\Newspack_Nodes\Config::reset();
		$GLOBALS['_wp_test_next_scheduled'] = false;

		Bootstrap::self_heal_reconcile_cron();

		$this->assertNotEmpty(
			$GLOBALS['_wp_test_scheduled_events'],
			'self-heal must call activate() when all 3 conditions are met'
		);
		$this->assertSame( 'newspack_nodes/reconcile', $GLOBALS['_wp_test_scheduled_events'][0]['hook'] );
	}

	public function test_self_heal_skips_when_logging_disabled(): void {
		Bootstrap::$fleet_enabled_override = false;
		\add_filter( 'newspack_nodes/topologies', function ( $topologies ) {
			$topologies['my-fleet'] = [ 'num_partitions' => 1, 'topology' => '/x.php' ];
			return $topologies;
		} );
		$GLOBALS['_wp_test_next_scheduled'] = false;

		Bootstrap::self_heal_reconcile_cron();

		$this->assertEmpty(
			$GLOBALS['_wp_test_scheduled_events'],
			'logging-disabled must short-circuit before scheduling'
		);
	}

	public function test_self_heal_skips_when_no_topologies_selected(): void {
		$GLOBALS['_wp_test_next_scheduled'] = false;

		Bootstrap::self_heal_reconcile_cron();

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

		Bootstrap::self_heal_reconcile_cron();

		$this->assertEmpty(
			$GLOBALS['_wp_test_scheduled_events'],
			'no need to re-schedule when wp_next_scheduled returns a timestamp'
		);
	}

	// ── spawn_coordinator() factory ──────────────────────────────────────────────

	public function test_spawn_coordinator_returns_a_spawn_coordinator(): void {
		$this->assertInstanceOf( Spawn_Coordinator::class, Bootstrap::spawn_coordinator() );
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
		// behavior in the same scenario).
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
		// is unconfigured, so the fleet fails loud instead of running
		// against a phantom default tree.
		$prev_env = \getenv( 'LOCAL_NEWSPACK_NODES_CONF' );
		$tmp      = $this->make_temp_dir( 'bootstrap-no-base-' );
		try {
			$conf = "{$tmp}/empty-base.php";
			\file_put_contents( $conf, "<?php\nreturn [ 'base_directory' => '' ];\n" );
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
		$health_routes = \array_values(
			\array_filter(
				$routes,
				static fn ( array $route ): bool => '/health/cache' === $route['route']
			)
		);
		$this->assertCount( 1, $health_routes, 'exactly one cache-health route must be registered' );
		$this->assertSame( 'POST', $health_routes[0]['args']['methods'] );
		// All routes are namespaced under newspack-nodes/v1.
		foreach ( $routes as $route ) {
			$this->assertSame( 'newspack-nodes/v1', $route['namespace'] );
		}
	}

	public function test_register_rest_routes_wires_the_sse_slot_pool_seams(): void {
		// The slot-pool seams are consumed only by SSE_Out_Node, which is instantiated
		// only on the REST path — so wiring them belongs here, NOT in ensure_runtime_wired
		// (whose admin/cron callers would else force-load the SSE controller for nothing).
		$acquire_ref = new \ReflectionProperty( \Newspack_Nodes\Rest\SSE_Out_Node::class, 'acquire_slot' );
		$saved       = $acquire_ref->getValue();
		try {
			$acquire_ref->setValue( null, null );
			Bootstrap::register_rest_routes();
			$this->assertInstanceOf( \Closure::class, $acquire_ref->getValue(), 'REST wiring installs the SSE slot-pool acquire seam' );
		} finally {
			$acquire_ref->setValue( null, $saved );
		}
	}

	public function test_ensure_runtime_wired_does_not_force_load_the_sse_controller(): void {
		// The SSE slot-pool seams must NOT be wired by ensure_runtime_wired — touching
		// SSE_Out_Node::$acquire_slot there force-autoloads the 500-line REST controller
		// on every admin page and reconcile-cron tick that never streams.
		$acquire_ref = new \ReflectionProperty( \Newspack_Nodes\Rest\SSE_Out_Node::class, 'acquire_slot' );
		$saved       = $acquire_ref->getValue();
		$wired_ref   = new \ReflectionProperty( Bootstrap::class, 'runtime_wired' );
		$saved_wired = $wired_ref->getValue();
		try {
			$acquire_ref->setValue( null, null );
			$wired_ref->setValue( null, false );
			Bootstrap::ensure_runtime_wired();
			$this->assertNull( $acquire_ref->getValue(), 'ensure_runtime_wired must not wire the SSE slot-pool seams' );
		} finally {
			$acquire_ref->setValue( null, $saved );
			$wired_ref->setValue( null, $saved_wired );
		}
	}

	public function test_ensure_runtime_wired_installs_the_worker_token_provider(): void {
		$wired_ref   = new \ReflectionProperty( Bootstrap::class, 'runtime_wired' );
		$saved_wired = $wired_ref->getValue();
		try {
			$wired_ref->setValue( null, false );
			\Newspack_Nodes\Worker_Base::$token_provider = null;
			Bootstrap::ensure_runtime_wired();

			$provider = \Newspack_Nodes\Worker_Base::$token_provider;
			$this->assertNotNull( $provider, 'production wiring must mint self-respawn tokens at POST time' );
			$this->assertTrue(
				Bootstrap::spawn_coordinator()->validate_spawn_token( (string) $provider(), \time() ),
				'the minted token must pass the current HMAC window'
			);
		} finally {
			$wired_ref->setValue( null, $saved_wired );
		}
	}

	// ── deactivate ─────────────────────────────────────────────────────────

	public function test_deactivate_clears_reconcile_cron_hook(): void {
		// Deactivation calls wp_clear_scheduled_hook for the fleet.
		// The stub doesn't capture invocations, so we just verify the call
		// runs to completion without throwing — the same idempotency the
		// real WP function provides.
		Bootstrap::deactivate();
		Bootstrap::deactivate(); // idempotent.
		$this->assertTrue( true, 'deactivate() must run to completion (idempotent)' );
	}

	// ── reconcile_fleet: the cold-start pass ─────────────────────────

	/**
	 * Declare an active fleet rooted at a fresh runtime dir, and return it.
	 *
	 * @param array<string, array<string, mixed>> $topologies Catalog entries.
	 */
	private function cold_start_fleet( array $topologies ): string {
		$dir = $this->make_temp_dir( 'cold-start-' );
		$this->use_base_dir( $dir );
		\add_filter( 'newspack_nodes/topologies', static fn () => $topologies );
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = \array_keys( $topologies );
		$GLOBALS['_test_outbound_posts']                     = [];
		\Newspack_Nodes\Config::reset();
		return $dir;
	}

	public function test_reconcile_fleet_reports_an_unusable_base_instead_of_throwing(): void {
		// This is the LAST revival path when no worker is alive, and it runs on
		// a cron callback every minute. A misconfigured base must log once and
		// return, as the two sibling entry points already do — not throw out of
		// the callback sixty times an hour.
		$prev_env    = \getenv( 'LOCAL_NEWSPACK_NODES_CONF' );
		$tmp         = $this->make_temp_dir( 'cold-start-no-base-' );
		$runtime_ref = new \ReflectionProperty( Bootstrap::class, 'runtime_wired' );
		$saved_wired = $runtime_ref->getValue();
		$buf         = '';
		Core::set_stderr_handler( static function ( $m ) use ( &$buf ): void {
			$buf .= $m;
		} );
		try {
			$conf = "{$tmp}/empty-base.php";
			\file_put_contents( $conf, "<?php\nreturn [ 'base_directory' => '' ];\n" );
			\putenv( 'LOCAL_NEWSPACK_NODES_CONF=' . $conf );
			\update_option( 'newspack_nodes_base_directory', '' );
			$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'cold-start-workers' ];
			\Newspack_Nodes\Config::reset();
			// A cron minute is a fresh request: the wiring has not run yet, and
			// that is the call that resolves the base.
			$runtime_ref->setValue( null, false );

			Bootstrap::reconcile_fleet();

			$this->assertStringContainsString( 'runtime wiring unavailable', $buf );
		} finally {
			$runtime_ref->setValue( null, $saved_wired );
			\putenv( 'LOCAL_NEWSPACK_NODES_CONF=' . ( false === $prev_env ? '' : $prev_env ) );
			\Newspack_Nodes\Config::reset();
			$this->rmdir_recursive( $tmp );
		}
	}

	public function test_reconcile_fleet_spawns_every_worker_whose_lock_is_missing(): void {
		$dir = $this->cold_start_fleet( [
			'cold-start-workers' => [ 'num_partitions' => 3, 'topology' => '/cs.tsl', 'stale_timeout' => 45 ],
		] );

		Bootstrap::reconcile_fleet();

		$posts = $GLOBALS['_test_outbound_posts'];
		$this->assertCount( 3, $posts, 'a dead fleet must be revived partition by partition' );
		$this->assertSame( 'cold-start-workers', $posts[0]['args']['body']['type'] );

		$this->rmdir_recursive( $dir );
	}

	public function test_reconcile_fleet_skips_a_worker_with_a_fresh_heartbeat(): void {
		$dir = $this->cold_start_fleet( [
			'cold-start-workers' => [ 'num_partitions' => 1, 'topology' => '/cs.tsl', 'stale_timeout' => 45 ],
		] );
		\mkdir( "{$dir}/locks/cold-start-workers.p0.lock.d", 0755, true );
		\touch( "{$dir}/locks/cold-start-workers.p0.lock.d/heartbeat" );

		Bootstrap::reconcile_fleet();

		$this->assertEmpty( $GLOBALS['_test_outbound_posts'], 'a live worker needs no cron rescue' );

		$this->rmdir_recursive( $dir );
	}

	/**
	 * The cron pass is a single sweep, not a resident process: it holds no
	 * singleton lock, so a second runner can never be locked out of reviving a
	 * fleet that has nothing left running.
	 */
	public function test_reconcile_fleet_holds_no_singleton_lock(): void {
		$dir = $this->cold_start_fleet( [
			'cold-start-workers' => [ 'num_partitions' => 1, 'topology' => '/cs.tsl' ],
		] );

		Bootstrap::reconcile_fleet();

		$this->assertDirectoryDoesNotExist( "{$dir}/locks/fleet.lock.d" );

		$this->rmdir_recursive( $dir );
	}

	/**
	 * `expand_workers()` fires the third-party `newspack_nodes/topologies`
	 * filter. The tier of last resort must not fatal every cron minute because
	 * one provider threw.
	 */
	public function test_reconcile_fleet_survives_a_throwing_topologies_provider(): void {
		$dir = $this->make_temp_dir( 'cold-start-hostile-' );
		$this->use_base_dir( $dir );
		\add_filter( 'newspack_nodes/topologies', static function (): array {
			throw new \RuntimeException( 'hostile topology provider' );
		} );
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'cold-start-workers' ];
		\Newspack_Nodes\Config::reset();

		$stderr = [];
		Core::set_stderr_handler( static function ( string $line ) use ( &$stderr ): void {
			$stderr[] = $line;
		} );
		$after = 0;
		\add_action( 'newspack_nodes/after_reconcile', function () use ( &$after ) { ++$after; } );

		Bootstrap::reconcile_fleet();

		$this->assertSame( 1, $after, 'the lifecycle action must still fire from finally' );
		$this->assertStringContainsString(
			'hostile topology provider',
			\implode( "\n", $stderr ),
			'the swallowed throwable must be logged, not silently dropped'
		);

		$this->rmdir_recursive( $dir );
	}

	// ── reconcile_fleet: the housekeeping it absorbed ────────────────────

	public function test_reconcile_fleet_fires_the_periodic_hook(): void {
		// Housekeeping no longer rides a job on the `job-worker` pool, so it runs
		// even when the fleet is down — which is when disk most needs reclaiming.
		$dir   = $this->cold_start_fleet( [
			'cold-start-workers' => [ 'num_partitions' => 1, 'topology' => '/cs.tsl' ],
		] );
		$fired = 0;
		\add_action( 'newspack_nodes/periodic', static function () use ( &$fired ): void {
			++$fired;
		} );

		Bootstrap::reconcile_fleet();

		$this->assertSame( 1, $fired );
		$this->rmdir_recursive( $dir );
	}

	public function test_reconcile_fleet_flags_a_lock_dir_past_the_active_partition_count(): void {
		$dir = $this->cold_start_fleet( [
			'cold-start-workers' => [ 'num_partitions' => 2, 'topology' => '/cs.tsl' ],
		] );
		\mkdir( "{$dir}/locks/cold-start-workers.p5.lock.d", 0755, true );
		\touch( "{$dir}/locks/cold-start-workers.p5.lock.d/heartbeat" );

		Bootstrap::reconcile_fleet();

		$this->assertFileExists( "{$dir}/locks/cold-start-workers.p5.lock.d/restart" );
		$this->rmdir_recursive( $dir );
	}

	public function test_reconcile_fleet_reaps_an_orphan_ipc_dir(): void {
		$dir = $this->cold_start_fleet( [
			'cold-start-workers' => [ 'num_partitions' => 1, 'topology' => '/cs.tsl' ],
		] );
		\mkdir( "{$dir}/ipc/cold-start-workers.p0/input", 0755, true );
		\mkdir( "{$dir}/ipc/retired-workers.p7/input", 0755, true );

		Bootstrap::reconcile_fleet();

		$this->assertDirectoryExists( "{$dir}/ipc/cold-start-workers.p0" );
		$this->assertDirectoryDoesNotExist( "{$dir}/ipc/retired-workers.p7" );
		$this->rmdir_recursive( $dir );
	}

	public function test_reconcile_fleet_runs_log_retention(): void {
		// DELETE_GRACE_S is 3600 and the pass is a minute apart, so retention ran
		// 240 times per eligible deletion on the old 15s sweep.
		$dir = $this->make_temp_dir( 'cold-start-retention-' );
		$this->use_base_dir( $dir );
		\Newspack_Nodes\Config::register_token_namespace();
		$stock = "{$dir}/topologies";
		\mkdir( $stock, 0755, true );
		\file_put_contents(
			"{$stock}/ledger.tsl",
			"var num_partitions = 1\n"
			. 'make_node Partition ledger:partition <config:logs_dir>/ledger.p<partition>'
			. " <config:segment_size> <config:min_segments> <config:max_segments> 0 0\n"
		);
		\Newspack_Nodes\Topology_Registry::reset();
		\Newspack_Nodes\Topology_Registry::register_stock_dir( $stock );
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'ledger' ];
		\Newspack_Nodes\Config::reset();

		$orphan = "{$dir}/logs/retired-log.p0";
		\mkdir( $orphan, 0755, true );
		\file_put_contents( "{$orphan}/0.log", "x\n" );
		$stale = \time() - ( \Newspack_Nodes\Log_Cleaner::DELETE_GRACE_S + 600 );
		\touch( "{$orphan}/0.log", $stale );
		\touch( $orphan, $stale );

		Bootstrap::reconcile_fleet();

		$this->assertDirectoryDoesNotExist( $orphan, 'an undeclared log dir past the grace is reclaimed' );
		\Newspack_Nodes\Topology_Registry::reset();
		$this->rmdir_recursive( $dir );
	}

	public function test_reconcile_fleet_spawns_before_it_keeps_house(): void {
		// Spawn is the revival path and the only time-critical step; janitorial
		// work must never preempt it. Observed from inside the LAST step.
		$dir             = $this->cold_start_fleet( [
			'cold-start-workers' => [ 'num_partitions' => 1, 'topology' => '/cs.tsl' ],
		] );
		$posts_at_periodic = null;
		\add_action( 'newspack_nodes/periodic', static function () use ( &$posts_at_periodic ): void {
			$posts_at_periodic = \count( $GLOBALS['_test_outbound_posts'] ?? [] );
		} );

		Bootstrap::reconcile_fleet();

		$this->assertSame( 1, $posts_at_periodic, 'the spawn POST must already have gone out' );
		$this->rmdir_recursive( $dir );
	}

	// ── reconcile_fleet: hostile input ───────────────────────────────────

	public function test_a_throwing_before_reconcile_subscriber_costs_neither_the_spawn_nor_the_callback(): void {
		// `before_reconcile` is third-party surface — event-logger-nodes already
		// subscribes. It fired OUTSIDE the try, so one throwing subscriber both
		// escaped the cron callback and skipped the spawn, deterministically,
		// every minute, with doctor still green (it checks the event is
		// SCHEDULED, never that a pass succeeded).
		$dir = $this->cold_start_fleet( [
			'cold-start-workers' => [ 'num_partitions' => 1, 'topology' => '/cs.tsl' ],
		] );
		\add_action( 'newspack_nodes/before_reconcile', static function (): void {
			throw new \RuntimeException( 'a before_reconcile subscriber exploded' );
		} );

		Bootstrap::reconcile_fleet();

		$this->assertCount(
			1,
			$GLOBALS['_test_outbound_posts'] ?? [],
			'a throwing before_reconcile subscriber must not cost the spawn'
		);
		$this->rmdir_recursive( $dir );
	}

	public function test_a_throwing_periodic_subscriber_costs_neither_the_spawn_nor_retention(): void {
		// Third-party code: pyrobase and nuclear-gyrobase both subscribe. One bad
		// subscriber must not escape the cron callback or undo the pass.
		$dir = $this->cold_start_fleet( [
			'cold-start-workers' => [ 'num_partitions' => 1, 'topology' => '/cs.tsl' ],
		] );
		\mkdir( "{$dir}/ipc/retired-workers.p7/input", 0755, true );
		\add_action( 'newspack_nodes/periodic', static function (): void {
			throw new \RuntimeException( 'a periodic subscriber exploded' );
		} );
		$after = 0;
		\add_action( 'newspack_nodes/after_reconcile', function () use ( &$after ) { ++$after; } );

		Bootstrap::reconcile_fleet();

		$this->assertCount( 1, $GLOBALS['_test_outbound_posts'], 'the spawn already ran and stands' );
		$this->assertDirectoryDoesNotExist( "{$dir}/ipc/retired-workers.p7", 'ipc reaping already ran and stands' );
		$this->assertSame( 1, $after );
		$this->rmdir_recursive( $dir );
	}

	public function test_a_throwing_topologies_filter_still_leaves_the_periodic_hook_its_window(): void {
		// spawn, lock reconcile, retention and ipc reaping all read the active
		// set, so a hostile provider fails all four. Per-step isolation is what
		// keeps the fifth — every third-party `periodic` subscriber — running.
		$dir = $this->make_temp_dir( 'cold-start-isolation-' );
		$this->use_base_dir( $dir );
		\add_filter( 'newspack_nodes/topologies', static function (): array {
			throw new \RuntimeException( 'hostile topology provider' );
		} );
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'cold-start-workers' ];
		\Newspack_Nodes\Config::reset();
		$fired = 0;
		\add_action( 'newspack_nodes/periodic', static function () use ( &$fired ): void {
			++$fired;
		} );

		Bootstrap::reconcile_fleet();

		$this->assertSame( 1, $fired, 'one failing step must not cost the others their window' );
		$this->rmdir_recursive( $dir );
	}

	// ── reconcile_fleet: full execution ──────────────────────────────

	public function test_reconcile_fleet_wraps_the_pass_in_its_lifecycle_actions(): void {
		$dir = $this->cold_start_fleet( [
			'cold-start-workers' => [ 'num_partitions' => 1, 'topology' => '/cs.tsl' ],
		] );
		unset(
			$_SERVER['NEWSPACK_NODES_WORKER_TYPE'],
			$_SERVER['NEWSPACK_NODES_WORKER_PARTITION']
		);
		$before = 0;
		$after  = 0;
		\add_action( 'newspack_nodes/before_reconcile', function () use ( &$before ) { ++$before; } );
		\add_action( 'newspack_nodes/after_reconcile', function () use ( &$after ) { ++$after; } );

		Bootstrap::reconcile_fleet();

		$this->assertSame( 'reconcile', $_SERVER['NEWSPACK_NODES_WORKER_TYPE'] );
		$this->assertSame( '0', $_SERVER['NEWSPACK_NODES_WORKER_PARTITION'] );
		$this->assertSame( 1, $before );
		$this->assertSame( 1, $after );

		unset(
			$_SERVER['NEWSPACK_NODES_WORKER_TYPE'],
			$_SERVER['NEWSPACK_NODES_WORKER_PARTITION']
		);
		$this->rmdir_recursive( $dir );
	}

	// ── init_memcached: substrate-owned Core::$memd bootstrap ──────────────

	public function test_init_memcached_builds_handle_from_configured_servers(): void {
		$GLOBALS['_wp_options']['newspack_nodes_memcache_servers'] = [ 'cachehost:11299' ];
		\Newspack_Nodes\Config::reset();
		$saved_memd                  = Core::$memd;
		$saved_factory               = Bootstrap::$memcached_factory;
		Bootstrap::$memcached_factory = static fn (): \Memcached => new \Newspack_Nodes\Tests\Helpers\InMemoryMemcached();
		Core::$memd                  = null;

		try {
			Bootstrap::init_memcached();

			$this->assertInstanceOf( \Memcached::class, Core::$memd );
			$servers = Core::$memd->getServerList();
			$this->assertSame( 'cachehost', $servers[0]['host'] );
			$this->assertSame( 11299, $servers[0]['port'] );
		} finally {
			Core::$memd                  = $saved_memd;
			Bootstrap::$memcached_factory = $saved_factory;
			unset( $GLOBALS['_wp_options']['newspack_nodes_memcache_servers'] );
			\Newspack_Nodes\Config::reset();
		}
	}

	public function test_init_memcached_nulls_handle_on_empty_servers(): void {
		// Empty servers must NULL the handle, not build a fallback — null is what
		// command-auth's `instanceof` check keys on to log + fail closed. A
		// non-null fallback would silently fail closed (the bug this replaces).
		$GLOBALS['_wp_options']['newspack_nodes_memcache_servers'] = [];
		\Newspack_Nodes\Config::reset();
		$saved_memd = Core::$memd;
		Core::$memd = new \Newspack_Nodes\Tests\Helpers\InMemoryMemcached();

		try {
			Bootstrap::init_memcached();
			$this->assertNull( Core::$memd );
		} finally {
			Core::$memd = $saved_memd;
			unset( $GLOBALS['_wp_options']['newspack_nodes_memcache_servers'] );
			\Newspack_Nodes\Config::reset();
		}
	}

	// ── ensure_runtime_wired: deferred file-scope wiring (off the frontend hot path) ──

	public function test_ensure_runtime_wired_registers_substrate_namespaces(): void {
		$ns_ref = new \ReflectionProperty( \Newspack_Nodes\Command_Interpreter_Node::class, 'namespaces' );
		$saved_ns    = $ns_ref->getValue();
		$wired_ref   = new \ReflectionProperty( Bootstrap::class, 'runtime_wired' );
		$saved_wired = $wired_ref->getValue();

		try {
			$ns_ref->setValue( null, [] );
			$wired_ref->setValue( null, false );
			Bootstrap::ensure_runtime_wired();
			$ns = \Newspack_Nodes\Command_Interpreter_Node::registered_namespaces();
			$this->assertContains( 'Newspack_Nodes\\', $ns );
			$this->assertContains( 'Newspack_Nodes\\Rest\\', $ns );
		} finally {
			$ns_ref->setValue( null, $saved_ns );
			$wired_ref->setValue( null, $saved_wired );
		}
	}

	public function test_ensure_runtime_wired_builds_memcached_handle(): void {
		$GLOBALS['_wp_options']['newspack_nodes_memcache_servers'] = [ 'cachehost:11299' ];
		\Newspack_Nodes\Config::reset();
		$saved_memd    = Core::$memd;
		$saved_factory = Bootstrap::$memcached_factory;
		$wired_ref       = new \ReflectionProperty( Bootstrap::class, 'runtime_wired' );
		$diagnostics_ref = new \ReflectionProperty( Bootstrap::class, 'diagnostics_wired' );
		$saved_wired     = $wired_ref->getValue();
		$saved_diagnostics = $diagnostics_ref->getValue();

		Bootstrap::$memcached_factory = static fn (): \Memcached => new \Newspack_Nodes\Tests\Helpers\InMemoryMemcached();
		Core::$memd                   = null;

		try {
			$wired_ref->setValue( null, false );
			$diagnostics_ref->setValue( null, false );
			Bootstrap::ensure_runtime_wired();
			$this->assertInstanceOf( \Memcached::class, Core::$memd );
		} finally {
			$wired_ref->setValue( null, $saved_wired );
			$diagnostics_ref->setValue( null, $saved_diagnostics );
			Core::$memd                   = $saved_memd;
			Bootstrap::$memcached_factory = $saved_factory;
			unset( $GLOBALS['_wp_options']['newspack_nodes_memcache_servers'] );
			\Newspack_Nodes\Config::reset();
		}
	}

	public function test_ensure_runtime_wired_is_idempotent(): void {
		// After the first call wires the runtime, a second call must NOT rebuild
		// Core::$memd — the guard short-circuits so multiple entry-point hooks
		// firing in one request don't repeat the config load + memcache connect.
		$wired_ref = new \ReflectionProperty( Bootstrap::class, 'runtime_wired' );
		$saved_wired = $wired_ref->getValue();
		$saved_memd  = Core::$memd;

		try {
			$wired_ref->setValue( null, false );
			Bootstrap::ensure_runtime_wired();
			$sentinel   = new \Newspack_Nodes\Tests\Helpers\InMemoryMemcached();
			Core::$memd = $sentinel;
			Bootstrap::ensure_runtime_wired();
			$this->assertSame( $sentinel, Core::$memd, 'second ensure_runtime_wired() must be a no-op' );
		} finally {
			$wired_ref->setValue( null, $saved_wired );
			Core::$memd = $saved_memd;
		}
	}

	// ── version_at_least ─────────────────────────────────────────────────

	public function test_version_at_least_passes_and_stays_silent(): void {
		$this->assertTrue( Bootstrap::version_at_least( '0.1.0', 'Example Consumer' ) );
		$this->assertArrayNotHasKey( 'admin_notices', $GLOBALS['_wp_actions'] );
	}

	public function test_version_at_least_fails_future_min_with_admin_notice(): void {
		$this->assertFalse( Bootstrap::version_at_least( '99.1.7', 'Example Consumer' ) );

		$notices = $GLOBALS['_wp_actions']['admin_notices'] ?? [];
		$this->assertCount( 1, $notices );
		\ob_start();
		$notices[0]();
		$html = \ob_get_clean();
		$this->assertStringContainsString( 'Example Consumer', $html );
		$this->assertStringContainsString( '99.1.7', $html );
		$this->assertStringContainsString( NEWSPACK_NODES_VERSION, $html );
	}
	/**
	 * The key is declared by the schema but has no value unless an operator
	 * sets one — and `(bool) null` is false, which would silently turn spawn-POST
	 * TLS verification OFF on every install that never touched the setting.
	 * Unset must mean verify.
	 */
	public function test_spawn_tls_verification_defaults_on_when_unset(): void {
		$runtime_ref     = new \ReflectionProperty( Bootstrap::class, 'runtime_wired' );
		$diagnostics_ref = new \ReflectionProperty( Bootstrap::class, 'diagnostics_wired' );
		$saved_runtime   = $runtime_ref->getValue();
		$saved_diagnostics = $diagnostics_ref->getValue();
		$saved_verify    = Core::$verify_spawn_tls;

		try {
			Core::$verify_spawn_tls = false;
			$runtime_ref->setValue( null, false );
			$diagnostics_ref->setValue( null, false );

			Bootstrap::ensure_runtime_wired();

			$this->assertTrue( Core::$verify_spawn_tls );
		} finally {
			$runtime_ref->setValue( null, $saved_runtime );
			$diagnostics_ref->setValue( null, $saved_diagnostics );
			Core::$verify_spawn_tls = $saved_verify;
		}
	}

	// ── node_dirs / node_partitions ────────────────────────────────────────

	/**
	 * Make `$names` the active set, each backed by a TSL in a fresh stock dir.
	 *
	 * @param array<string,string> $tsl  Topology name => TSL body.
	 * @param array<string,int>    $counts Topology name => worker count.
	 */
	private function activate_topologies( array $tsl, array $counts ): string {
		$stock = $this->make_temp_dir( 'tsl-stock-' );
		foreach ( $tsl as $name => $body ) {
			\file_put_contents( "{$stock}/{$name}.tsl", $body );
		}
		\Newspack_Nodes\Topology_Registry::reset();
		\Newspack_Nodes\Topology_Registry::register_stock_dir( $stock );
		\add_filter(
			'newspack_nodes/topologies',
			static function ( array $topologies ) use ( $counts ): array {
				foreach ( $counts as $name => $count ) {
					$topologies[ $name ] = [ 'topology' => $name, 'num_partitions' => $count, 'stale_timeout' => 60 ];
				}
				return $topologies;
			}
		);
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = \array_keys( $counts );
		\Newspack_Nodes\Config::reset();
		return $stock;
	}

	public function test_node_dirs_unions_the_partitions_of_every_active_topology(): void {
		// combined runs 4 workers, performance 2 — the union is 0..3, and a
		// count of 4 is distinct from the config default of 1 either way.
		$decl  = "make_node Partition requests:partition <config:logs_dir>/requests.p<partition>\n";
		$stock = $this->activate_topologies(
			[ 'combined' => $decl, 'performance' => $decl ],
			[ 'combined' => 4, 'performance' => 2 ]
		);

		try {
			$dirs = Bootstrap::node_dirs( 'requests:partition' );

			$this->assertSame( [ 0, 1, 2, 3 ], \array_keys( $dirs ) );
			$root = Core::resolve_config_token( 'config', 'logs_dir' );
			$this->assertSame( "{$root}/requests.p3", $dirs[3] );
		} finally {
			\Newspack_Nodes\Topology_Registry::reset();
			$this->rmdir_recursive( $stock );
		}
	}

	public function test_node_dirs_of_a_node_no_active_topology_declares_is_empty(): void {
		$stock = $this->activate_topologies(
			[ 'combined' => "make_node Partition requests:partition <config:logs_dir>/requests.p<partition>\n" ],
			[ 'combined' => 4 ]
		);

		try {
			$this->assertSame( [], Bootstrap::node_dirs( 'flames:partition' ) );
		} finally {
			\Newspack_Nodes\Topology_Registry::reset();
			$this->rmdir_recursive( $stock );
		}
	}

	public function test_node_partitions_is_the_worker_index_space_of_the_declaring_topologies(): void {
		// flame-builder writes nothing to disk — its stats store is keyed by the
		// worker index, so the index space has to come from the topology count.
		$stock = $this->activate_topologies(
			[ 'combined' => "make_node Flame_Builder flame-builder\n", 'job-router' => "make_node Age_Sieve jobs:sieve\n" ],
			[ 'combined' => 3, 'job-router' => 8 ]
		);

		try {
			$this->assertSame( [ 0, 1, 2 ], Bootstrap::node_partitions( 'flame-builder' ) );
		} finally {
			\Newspack_Nodes\Topology_Registry::reset();
			$this->rmdir_recursive( $stock );
		}
	}

}
