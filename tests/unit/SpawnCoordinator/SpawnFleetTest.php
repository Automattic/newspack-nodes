<?php
namespace Newspack_Nodes\Tests\Unit\SpawnCoordinator;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Spawn_Coordinator;
use Newspack_Nodes\Tests\TestCase;

#[CoversClass( Spawn_Coordinator::class )]
class SpawnFleetTest extends TestCase {
	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		$this->tmp                              = $this->make_temp_dir();
		$GLOBALS['_test_outbound_posts']        = [];
		Bootstrap::$supervisor_enabled_override = null;
		Bootstrap::$supervisor_factory          = null;
		$this->use_base_dir( $this->tmp );
		// Active set = catalog ∩ this overlay.
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [
			'firehose-workers',
			'job-workers',
		];
		\Newspack_Nodes\Config::reset();
	}

	protected function tearDown(): void {
		$this->rmdir_recursive( $this->tmp );
		$GLOBALS['_test_outbound_posts'] = [];
		unset( $GLOBALS['_wp_options']['newspack_nodes_topologies'] );
		\Newspack_Nodes\Config::reset();
		parent::tearDown();
	}

	private function with_topology( array $topologies ): void {
		\add_filter( 'newspack_nodes/topologies', function () use ( $topologies ) {
			return $topologies;
		} );
	}

	public function test_spawn_fleet_posts_one_spawn_per_partition(): void {
		$this->with_topology( [
			'firehose-workers' => [ 'num_partitions' => 3, 'topology' => '/x.php' ],
			'job-workers'      => [ 'num_partitions' => 1, 'topology' => '/y.php' ],
		] );
		$s = new Spawn_Coordinator( $this->tmp, 'NONCE_SALT_FOR_TEST' );

		$count = $s->spawn_fleet( 'firehose-workers' );

		$this->assertSame( 3, $count, 'three partitions → returns 3' );

		$posts = $GLOBALS['_test_outbound_posts'] ?? [];
		$this->assertCount( 3, $posts, 'three partitions → three spawn POSTs' );

		$pairs = array_map(
			fn ( $p ) => [ $p['args']['body']['type'], $p['args']['body']['partition'] ],
			$posts
		);
		$this->assertEqualsCanonicalizing(
			[
				[ 'firehose-workers', 0 ],
				[ 'firehose-workers', 1 ],
				[ 'firehose-workers', 2 ],
			],
			$pairs,
			'one spawn per partition of the named fleet, none for other fleets'
		);
	}

	public function test_spawn_fleet_uses_a_valid_spawn_token(): void {
		$this->with_topology( [
			'firehose-workers' => [ 'num_partitions' => 1, 'topology' => '/x.php' ],
		] );
		$s = new Spawn_Coordinator( $this->tmp, 'NONCE_SALT_FOR_TEST' );

		$s->spawn_fleet( 'firehose-workers' );

		$posts = $GLOBALS['_test_outbound_posts'] ?? [];
		$this->assertCount( 1, $posts );
		$token = $posts[0]['args']['body']['nonce'];
		$this->assertTrue(
			$s->validate_spawn_token( $token, \time() ),
			'spawn_fleet reuses the coordinator spawn token'
		);
	}

	public function test_spawn_fleet_unknown_name_spawns_nothing(): void {
		$this->with_topology( [
			'firehose-workers' => [ 'num_partitions' => 2, 'topology' => '/x.php' ],
		] );
		$s = new Spawn_Coordinator( $this->tmp, 'NONCE_SALT_FOR_TEST' );

		$count = $s->spawn_fleet( 'does-not-exist' );

		$this->assertSame( 0, $count );
		$this->assertCount( 0, $GLOBALS['_test_outbound_posts'] ?? [] );
	}

	public function test_spawn_fleet_refuses_a_conflicting_fleet(): void {
		// Two topologies that WRITE the same partition log. With both in the
		// active set, spawn_fleet must refuse rather than put a second fleet on a
		// log a peer already owns (defense-in-depth behind the activate verb).
		// find_conflicts/write_set read real .tsl from disk, so the conflicting
		// set must be backed by a stock dir, not synthetic with_topology() descriptors.
		$stock     = $this->make_temp_dir( 'spawn-fleet-conflict-stock-' );
		$partition = 'make_node Partition requests:partition <config:logs_dir>/requests.p<partition> <config:segment_size> <config:min_segments> <config:max_segments> <config:min_lifetime> <config:max_lifetime>';
		\file_put_contents( "{$stock}/alpha.tsl", "var num_partitions = 2\n{$partition}\n" );
		\file_put_contents( "{$stock}/beta.tsl", "var num_partitions = 2\nmake_node Partition requests:partition <config:logs_dir>/requests.p<partition> 1048576 2 4 0 0\n" );
		\Newspack_Nodes\Topology_Registry::reset();
		\Newspack_Nodes\Topology_Registry::register_stock_dir( $stock );
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'alpha', 'beta' ];
		\Newspack_Nodes\Config::reset();

		$s = new Spawn_Coordinator( $this->tmp, 'NONCE_SALT_FOR_TEST' );

		$count = $s->spawn_fleet( 'beta' );

		$this->assertSame( 0, $count, 'a conflicting fleet must not spawn' );
		$this->assertCount( 0, $GLOBALS['_test_outbound_posts'] ?? [], 'no spawn POST for a conflicting fleet' );

		\Newspack_Nodes\Topology_Registry::reset();
		$this->rmdir_recursive( $stock );
	}
}
