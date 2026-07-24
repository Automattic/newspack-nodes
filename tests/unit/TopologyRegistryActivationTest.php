<?php
/**
 * TopologyRegistryActivationTest: unit tests for the shared activation logic
 * extracted onto Topology_Registry — the option-write + cache-invalidate +
 * spawn/drain that BOTH the Topologies_CI_Node verbs and the
 * `wp nodes activate` / `deactivate` CLI verbs call.
 *
 * `activate()` materializes the effective active set (Bootstrap::get_topologies()),
 * refuses a write-conflict, adds the name, writes the option, invalidates the
 * config cache, then spawns the fleet via Supervisor::spawn_fleet() — captured
 * via the bootstrap-installed Core::$curl_exec seam into
 * $GLOBALS['_test_outbound_posts']. `deactivate()` is the symmetric drain:
 * remove the name, write, invalidate, then kill the fleet via
 * Supervisor::kill_readers() (asserted via the restart flags on each lock dir).
 *
 * @package Newspack_Nodes
 */

declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Config;
use Newspack_Nodes\Lock_Node;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Topology_Registry;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Topology_Registry::class )]
class TopologyRegistryActivationTest extends TestCase {

	private string $base_dir;
	private string $stock;
	private string $user;

	protected function setUp(): void {
		parent::setUp();
		$this->base_dir = $this->make_temp_dir( 'topology-activation-' );
		$this->use_base_dir( $this->base_dir );

		$this->stock = $this->make_temp_dir( 'topology-activation-stock-' );
		$this->user  = $this->make_temp_dir( 'topology-activation-user-' );
		Topology_Registry::reset();
		Topology_Registry::register_stock_dir( $this->stock );
		Topology_Registry::register_user_dir( $this->user );

		$GLOBALS['_wp_actions']          = [];
		$GLOBALS['_test_outbound_posts'] = [];
	}

	protected function tearDown(): void {
		Topology_Registry::reset();
		$this->rmdir_recursive( $this->stock );
		$this->rmdir_recursive( $this->user );
		$this->rmdir_recursive( $this->base_dir );
		$GLOBALS['_wp_actions']          = [];
		$GLOBALS['_test_outbound_posts'] = [];
		unset( $GLOBALS['_wp_options']['newspack_nodes_topologies'] );
		Config::reset();
		parent::tearDown();
	}

	// ── activate ───────────────────────────────────────────────────────────────

	public function test_activate_adds_name_to_option_and_spawns_fleet(): void {
		\file_put_contents( "{$this->stock}/alpha.tsl", "var num_partitions = 2\nmake_node Echo e\n" );

		$result = Topology_Registry::activate( 'alpha' );

		$this->assertSame( 'alpha', $result['name'] );
		$this->assertTrue( $result['active'] );
		$this->assertSame( 2, $result['spawned'] );

		$this->assertContains( 'alpha', (array) \get_option( 'newspack_nodes_topologies', [] ) );

		$posts = $GLOBALS['_test_outbound_posts'] ?? [];
		$this->assertCount( 2, $posts );
		foreach ( $posts as $post ) {
			$this->assertSame( 'alpha', $post['args']['body']['type'] );
		}
	}

	public function test_activate_is_idempotent_no_duplicate_entry(): void {
		\file_put_contents( "{$this->stock}/alpha.tsl", "make_node Echo a\n" );
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'alpha' ];
		Config::reset();

		Topology_Registry::activate( 'alpha' );

		$active = (array) \get_option( 'newspack_nodes_topologies', [] );
		$this->assertSame( [ 'alpha' ], \array_values( $active ) );
	}

	public function test_activate_preserves_already_active_names(): void {
		\file_put_contents( "{$this->stock}/alpha.tsl", "make_node Echo a\n" );
		\file_put_contents( "{$this->stock}/beta.tsl", "make_node Echo b\n" );
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'beta' ];
		Config::reset();

		Topology_Registry::activate( 'alpha' );

		$active = (array) \get_option( 'newspack_nodes_topologies', [] );
		$this->assertContains( 'alpha', $active );
		$this->assertContains( 'beta', $active );
	}

	public function test_activate_throws_on_unknown_topology_without_writing(): void {
		try {
			Topology_Registry::activate( 'does-not-exist' );
			$this->fail( 'expected RuntimeException for unknown topology' );
		} catch ( \RuntimeException $e ) {
			$this->assertStringContainsString( 'unknown topology', $e->getMessage() );
			$this->assertStringContainsString( 'does-not-exist', $e->getMessage() );
		}

		$this->assertArrayNotHasKey( 'newspack_nodes_topologies', $GLOBALS['_wp_options'] );
		$this->assertEmpty( $GLOBALS['_test_outbound_posts'] ?? [] );
	}

	public function test_activate_throws_on_write_conflict_without_writing(): void {
		$partition = 'make_node Partition requests:partition <config:logs_dir>/requests.p<partition> <config:segment_size> <config:min_segments> <config:max_segments> <config:min_lifetime> <config:max_lifetime>';
		\file_put_contents( "{$this->stock}/alpha.tsl", "var num_partitions = 2\n{$partition}\n" );
		\file_put_contents( "{$this->stock}/beta.tsl", "var num_partitions = 2\nmake_node Partition requests:partition <config:logs_dir>/requests.p<partition> 1048576 2 4 0 0\n" );
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'alpha' ];
		Config::reset();

		try {
			Topology_Registry::activate( 'beta' );
			$this->fail( 'expected RuntimeException for write-conflict' );
		} catch ( \RuntimeException $e ) {
			$this->assertStringContainsString( 'conflict', $e->getMessage() );
			$this->assertStringContainsString( 'beta', $e->getMessage() );
		}

		$active = (array) \get_option( 'newspack_nodes_topologies', [] );
		$this->assertContains( 'alpha', $active );
		$this->assertNotContains( 'beta', $active );
		$this->assertEmpty( $GLOBALS['_test_outbound_posts'] ?? [] );
	}

	// ── deactivate ───────────────────────────────────────────────────────────

	public function test_deactivate_removes_name_from_option_and_drains_fleet(): void {
		\file_put_contents( "{$this->stock}/alpha.tsl", "var num_partitions = 2\nmake_node Echo e\n" );
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'alpha' ];
		Config::reset();

		foreach ( [ 0, 1 ] as $p ) {
			$dir = "{$this->base_dir}/locks/alpha.p{$p}.lock.d";
			\mkdir( $dir, 0755, true );
			\file_put_contents( "{$dir}/heartbeat", (string) \getmypid() );
		}

		$result = Topology_Registry::deactivate( 'alpha' );

		$this->assertSame( 'alpha', $result['name'] );
		$this->assertFalse( $result['active'] );

		$this->assertNotContains( 'alpha', (array) \get_option( 'newspack_nodes_topologies', [] ) );

		foreach ( [ 0, 1 ] as $p ) {
			$this->assertTrue(
				Lock_Node::is_restart_pending( "{$this->base_dir}/locks/alpha.p{$p}.lock.d" ),
				"partition p{$p} must have restart flag dropped"
			);
		}
	}

	public function test_deactivate_preserves_other_active_names(): void {
		\file_put_contents( "{$this->stock}/alpha.tsl", "make_node Echo a\n" );
		\file_put_contents( "{$this->stock}/beta.tsl", "make_node Echo b\n" );
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'alpha', 'beta' ];
		Config::reset();

		Topology_Registry::deactivate( 'alpha' );

		$active = (array) \get_option( 'newspack_nodes_topologies', [] );
		$this->assertNotContains( 'alpha', $active );
		$this->assertContains( 'beta', $active );
	}
}
