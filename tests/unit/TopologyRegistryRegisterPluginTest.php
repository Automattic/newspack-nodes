<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Lock_Node;
use Newspack_Nodes\Topology_Registry;
use Newspack_Nodes\Tests\TestCase;

/**
 * Topologies are NOT plugin-owned. `register_plugin` only registers a
 * namespace + a stock dir; the catalog is built from `Topology_Registry::list()`
 * (user dir ∪ every stock dir) by `publish_catalog`, and `spawn_worker` spawns
 * anything in the active set (`expand_workers`) regardless of which plugin — if
 * any — shipped it. A user-authored topology saved by the editor into the user
 * dir is a first-class citizen: catalogued, activatable, spawnable.
 */
class TopologyRegistryRegisterPluginTest extends TestCase {

	protected function setUp(): void {
		parent::setUp();
		// add_filter/add_action append to this global and TestCase::setUp does
		// NOT clear it; reset so catalog/spawn registrations don't leak across
		// tests in this class (or in from prior suites).
		$GLOBALS['_wp_actions'] = [];
		Topology_Registry::reset();
		Topology_Registry::$spawn_runner = null;
		unset( $GLOBALS['_wp_options']['newspack_nodes_topologies'] );
		\Newspack_Nodes\Config::reset();
		// Mirror production wiring (newspack-nodes.php): the substrate populates
		// the catalog from list() via this one filter.
		\add_filter( 'newspack_nodes/topologies', [ Topology_Registry::class, 'publish_catalog' ] );
	}

	protected function tearDown(): void {
		Topology_Registry::reset();
		Topology_Registry::$spawn_runner = null;
		unset( $GLOBALS['_wp_options']['newspack_nodes_topologies'] );
		\Newspack_Nodes\Config::reset();
		parent::tearDown();
	}

	/** Declare the active topology set (the operator overlay); spawn is gated on it. */
	private function activate( array $names ): void {
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = $names;
		\Newspack_Nodes\Config::reset();
	}

	/** Write a trivial $name.tsl into $dir. */
	private function seed_topology( string $dir, string $name ): void {
		\file_put_contents( "{$dir}/{$name}.tsl", "make_node Echo e\n" );
	}

	// ── register_plugin: namespace + stock dir only ───────────────────────

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

	public function test_register_plugin_is_idempotent(): void {
		$dir = $this->make_temp_dir();
		$this->seed_topology( $dir, 'widget' );
		Topology_Registry::register_plugin( 'Acme\\', $dir );
		Topology_Registry::register_plugin( 'Acme\\', $dir );
		// list() dedups by name; one stock-dir registration, no duplicate.
		$this->assertSame( [ 'widget' ], Topology_Registry::list() );
	}

	// ── publish_catalog: catalog is list(), NOT plugin-curated ────────────

	public function test_catalog_includes_every_stock_tsl_no_curation(): void {
		$dir = $this->make_temp_dir();
		$this->seed_topology( $dir, 'a' );
		$this->seed_topology( $dir, 'b' );
		Topology_Registry::register_plugin( 'Acme\\', $dir );

		$catalog = \apply_filters( 'newspack_nodes/topologies', [] );

		$this->assertArrayHasKey( 'a', $catalog, 'every stock .tsl is catalogued' );
		$this->assertArrayHasKey( 'b', $catalog, 'no per-plugin allowlist drops one' );
	}

	public function test_catalog_includes_user_dir_topologies(): void {
		// The editor's "New" writes a .tsl into the user dir, owned by no plugin.
		$user_dir = $this->make_temp_dir();
		Topology_Registry::register_user_dir( $user_dir );
		$this->seed_topology( $user_dir, 'my-custom' );

		$catalog = \apply_filters( 'newspack_nodes/topologies', [] );

		$this->assertArrayHasKey( 'my-custom', $catalog, 'a user-authored topology must be catalogued' );
	}

	public function test_catalog_num_partitions_defaults_to_substrate_option(): void {
		$dir = $this->make_temp_dir();
		$this->seed_topology( $dir, 'widget' );
		\update_option( 'newspack_nodes_num_partitions', 4 );
		\Newspack_Nodes\Config::reset();
		Topology_Registry::register_plugin( 'Acme\\', $dir );

		$catalog = \apply_filters( 'newspack_nodes/topologies', [] );

		$this->assertSame( 4, $catalog['widget']['num_partitions'], 'omitted num_partitions resolves to the substrate option' );
	}

	public function test_catalog_num_partitions_clamps_to_16(): void {
		$dir = $this->make_temp_dir();
		$this->seed_topology( $dir, 'widget' );
		\update_option( 'newspack_nodes_num_partitions', 99 );
		\Newspack_Nodes\Config::reset();
		Topology_Registry::register_plugin( 'Acme\\', $dir );

		$catalog = \apply_filters( 'newspack_nodes/topologies', [] );

		$this->assertSame( 16, $catalog['widget']['num_partitions'], 'num_partitions clamps to 16' );
	}

	// ── spawn_worker: ungated, driven by the active set ───────────────────

	public function test_spawn_worker_runs_seam_for_a_plugin_topology(): void {
		$dir = $this->make_temp_dir();
		$this->seed_topology( $dir, 'widget' );

		$captured                        = [];
		Topology_Registry::$spawn_runner = static function ( string $t, int $p, string $name, int $stale ) use ( &$captured ): void {
			$captured[] = [ $t, $p, $name, $stale ];
		};

		Topology_Registry::register_plugin( 'Acme\\', $dir );
		$this->activate( [ 'widget' ] );

		Topology_Registry::spawn_worker( 'widget', 0 );

		$this->assertCount( 1, $captured );
		$this->assertSame( [ 'widget', 0, 'widget', Lock_Node::STALE_TIMEOUT ], $captured[0] );
	}

	public function test_spawn_worker_runs_for_a_user_created_topology(): void {
		// No plugin owns it — proves spawn is gated on the active set, not ownership.
		$user_dir = $this->make_temp_dir();
		Topology_Registry::register_user_dir( $user_dir );
		$this->seed_topology( $user_dir, 'hand-rolled' );

		$captured                        = [];
		Topology_Registry::$spawn_runner = static function ( string $t, int $p, string $name, int $stale ) use ( &$captured ): void {
			$captured[] = [ $t, $p, $name, $stale ];
		};

		$this->activate( [ 'hand-rolled' ] );
		Topology_Registry::spawn_worker( 'hand-rolled', 0 );

		$this->assertCount( 1, $captured, 'a user-created topology with no owning plugin still spawns' );
		$this->assertSame( 'hand-rolled', $captured[0][2] );
	}

	public function test_spawn_worker_noops_for_a_type_not_in_the_active_set(): void {
		$dir = $this->make_temp_dir();
		$this->seed_topology( $dir, 'widget' );

		$captured                        = [];
		Topology_Registry::$spawn_runner = static function ( string $t, int $p, string $name, int $stale ) use ( &$captured ): void {
			$captured[] = [ $t, $p, $name, $stale ];
		};

		Topology_Registry::register_plugin( 'Acme\\', $dir );

		Topology_Registry::spawn_worker( 'nonexistent', 0 );

		$this->assertSame( [], $captured, 'a type with no resolvable topology is a no-op' );
	}

	public function test_before_worker_spawn_fires_before_the_spawn_runner(): void {
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
		Topology_Registry::$spawn_runner = static function ( string $t, int $p, string $name, int $stale ) use ( &$order ): void {
			$order[] = "runner:{$t}:{$p}";
		};

		Topology_Registry::register_plugin( 'Acme\\', $dir );
		$this->activate( [ 'widget' ] );

		Topology_Registry::spawn_worker( 'widget', 0 );

		$this->assertSame( [ 'before:widget:0', 'runner:widget:0' ], $order );
	}

	public function test_before_worker_spawn_does_not_fire_for_an_inactive_type(): void {
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

		Topology_Registry::spawn_worker( 'nonexistent', 0 );

		$this->assertSame( [], $fired, 'before_worker_spawn must not fire for a type not in the active set' );
	}
}
