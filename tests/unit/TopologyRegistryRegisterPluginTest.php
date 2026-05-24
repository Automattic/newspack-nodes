<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Topology_Registry;
use Newspack_Nodes\Tests\TestCase;

class TopologyRegistryRegisterPluginTest extends TestCase {

	protected function setUp(): void {
		parent::setUp();
		// add_filter/add_action append to this global and TestCase::setUp does
		// NOT clear it; reset so catalog/spawn registrations don't leak across
		// tests in this class (or in from prior suites).
		$GLOBALS['_wp_actions'] = [];
		Topology_Registry::reset();
		Topology_Registry::$spawn_runner = null;
	}

	protected function tearDown(): void {
		Topology_Registry::reset();
		Topology_Registry::$spawn_runner = null;
		parent::tearDown();
	}

	/** Write a trivial $name.tsl into $dir and return $dir. */
	private function seed_topology( string $dir, string $name ): void {
		\file_put_contents( "{$dir}/{$name}.tsl", "make_node Echo e\n" );
	}

	public function test_register_plugin_registers_namespace(): void {
		$dir = $this->make_temp_dir();
		Topology_Registry::register_plugin( 'Acme\\', $dir );
		$this->assertContains( 'Acme\\', Command_Interpreter_Node::registered_namespaces() );
	}

	public function test_register_plugin_registers_stock_dir(): void {
		$dir = $this->make_temp_dir();
		$this->seed_topology( $dir, 'widget' );
		Topology_Registry::register_plugin( 'Acme\\', $dir );
		$this->assertSame( "{$dir}/widget.tsl", Topology_Registry::resolve( 'widget' ) );
	}

	public function test_register_plugin_publishes_catalog_entry(): void {
		$dir = $this->make_temp_dir();
		$this->seed_topology( $dir, 'widget' );
		Topology_Registry::register_plugin( 'Acme\\', $dir );
		$catalog = \apply_filters( 'newspack_nodes/topologies', [] );
		$this->assertArrayHasKey( 'widget', $catalog );
	}

	public function test_register_plugin_explicit_names_subset(): void {
		$dir = $this->make_temp_dir();
		$this->seed_topology( $dir, 'a' );
		$this->seed_topology( $dir, 'b' );
		Topology_Registry::register_plugin( 'Acme\\', $dir, [ 'a' ] );
		$catalog = \apply_filters( 'newspack_nodes/topologies', [] );
		$this->assertArrayHasKey( 'a', $catalog );
		$this->assertArrayNotHasKey( 'b', $catalog );
	}

	public function test_spawn_handler_invokes_seam_for_owned_type(): void {
		$dir = $this->make_temp_dir();
		$this->seed_topology( $dir, 'widget' );

		$captured = [];
		Topology_Registry::$spawn_runner = static function (
			string $type,
			int $partition,
			string $topology_name,
			int $stale_timeout
		) use ( &$captured ): void {
			$captured[] = [ $type, $partition, $topology_name, $stale_timeout ];
		};

		Topology_Registry::register_plugin( 'Acme\\', $dir, null, 1, 77 );

		\do_action( 'newspack_nodes/spawn_worker', 'widget', 0 );

		$this->assertCount( 1, $captured );
		$this->assertSame( [ 'widget', 0, 'widget', 77 ], $captured[0] );
	}

	public function test_spawn_handler_ignores_foreign_type(): void {
		$dir = $this->make_temp_dir();
		$this->seed_topology( $dir, 'widget' );

		$captured = [];
		Topology_Registry::$spawn_runner = static function (
			string $type,
			int $partition,
			string $topology_name,
			int $stale_timeout
		) use ( &$captured ): void {
			$captured[] = [ $type, $partition, $topology_name, $stale_timeout ];
		};

		Topology_Registry::register_plugin( 'Acme\\', $dir );

		\do_action( 'newspack_nodes/spawn_worker', 'not-ours', 0 );

		$this->assertSame( [], $captured );
	}

	public function test_register_plugin_is_idempotent_no_double_spawn(): void {
		$dir = $this->make_temp_dir();
		\file_put_contents( $dir . '/widget.tsl', "make_node Echo e\n" );

		$spawns = [];
		Topology_Registry::$spawn_runner = static function ( string $t, int $p, string $name, int $stale ) use ( &$spawns ): void {
			$spawns[] = [ $t, $p, $name ];
		};

		// Two calls (e.g. a double plugins_loaded, or a plugin + a test re-register).
		Topology_Registry::register_plugin( 'Acme\\', $dir );
		Topology_Registry::register_plugin( 'Acme\\', $dir );

		\do_action( 'newspack_nodes/spawn_worker', 'widget', 0 );

		$this->assertCount( 1, $spawns, 'a second register_plugin must not register a second spawn handler' );
	}

	// ── Change A: before_worker_spawn action ───────────────────────────────

	public function test_before_worker_spawn_fires_before_spawn_runner_for_owned_type(): void {
		$dir = $this->make_temp_dir();
		$this->seed_topology( $dir, 'widget' );

		$order = [];
		\add_action(
			'newspack_nodes/before_worker_spawn',
			static function ( string $type, int $partition ) use ( &$order ): void {
				$order[] = "before:{$type}:{$partition}";
			},
			10,
			2
		);
		Topology_Registry::$spawn_runner = static function (
			string $type,
			int $partition,
			string $topology_name,
			int $stale_timeout
		) use ( &$order ): void {
			$order[] = "runner:{$type}:{$partition}";
		};

		Topology_Registry::register_plugin( 'Acme\\', $dir );

		\do_action( 'newspack_nodes/spawn_worker', 'widget', 0 );

		// Both ran, and the action fired BEFORE the spawn runner seam.
		$this->assertSame( [ 'before:widget:0', 'runner:widget:0' ], $order );
	}

	public function test_before_worker_spawn_does_not_fire_for_foreign_type(): void {
		$dir = $this->make_temp_dir();
		$this->seed_topology( $dir, 'widget' );

		$fired = [];
		\add_action(
			'newspack_nodes/before_worker_spawn',
			static function ( string $type, int $partition ) use ( &$fired ): void {
				$fired[] = [ $type, $partition ];
			},
			10,
			2
		);

		Topology_Registry::register_plugin( 'Acme\\', $dir );

		\do_action( 'newspack_nodes/spawn_worker', 'not-ours', 0 );

		$this->assertSame( [], $fired, 'before_worker_spawn must not fire for a type the plugin does not own' );
	}

	// ── Change B: num_partitions defaults to the substrate option ──────────

	public function test_register_plugin_num_partitions_defaults_to_substrate_option(): void {
		$dir = $this->make_temp_dir();
		$this->seed_topology( $dir, 'widget' );

		// Operator-overridable partition count; reset Config so it re-reads.
		\update_option( 'newspack_nodes_num_partitions', 4 );
		\Newspack_Nodes\Config::reset();

		// Omit num_partitions entirely — it should resolve from the option.
		Topology_Registry::register_plugin( 'Acme\\', $dir );

		$catalog = \apply_filters( 'newspack_nodes/topologies', [] );
		$this->assertSame( 4, $catalog['widget']['num_partitions'], 'omitted num_partitions must resolve to the substrate option' );

		// And expand_workers must emit one descriptor per resolved partition.
		$workers = \Newspack_Nodes\Bootstrap::expand_workers();
		$widget  = \array_values( \array_filter( $workers, static fn ( $w ) => 'widget' === $w['type'] ) );
		$this->assertCount( 4, $widget, 'widget must spawn p0..p3' );
	}

	public function test_register_plugin_explicit_num_partitions_honored_over_option(): void {
		$dir = $this->make_temp_dir();
		$this->seed_topology( $dir, 'widget' );

		\update_option( 'newspack_nodes_num_partitions', 4 );
		\Newspack_Nodes\Config::reset();

		// Explicit arg wins over the substrate option.
		Topology_Registry::register_plugin( 'Acme\\', $dir, null, 2 );

		$catalog = \apply_filters( 'newspack_nodes/topologies', [] );
		$this->assertSame( 2, $catalog['widget']['num_partitions'] );
	}

	public function test_register_plugin_clamps_num_partitions_to_max_16(): void {
		$dir = $this->make_temp_dir();
		$this->seed_topology( $dir, 'widget' );

		Topology_Registry::register_plugin( 'Acme\\', $dir, null, 99 );

		$catalog = \apply_filters( 'newspack_nodes/topologies', [] );
		$this->assertSame( 16, $catalog['widget']['num_partitions'], 'num_partitions must clamp to 16' );
	}

	public function test_register_plugin_clamps_num_partitions_to_min_1(): void {
		$dir = $this->make_temp_dir();
		$this->seed_topology( $dir, 'widget' );

		Topology_Registry::register_plugin( 'Acme\\', $dir, null, 0 );

		$catalog = \apply_filters( 'newspack_nodes/topologies', [] );
		$this->assertSame( 1, $catalog['widget']['num_partitions'], 'num_partitions must clamp up to 1' );
	}
}
