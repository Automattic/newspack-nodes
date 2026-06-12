<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Topology_Registry;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * Topology conflict detection: two enabled topologies must not both WRITE the
 * same file (a data partition or a Consumer offsetlog). Two writers to one file
 * corrupt it — the hazard void_warranty() no longer catches with a lock, so it's
 * caught upfront at enable-time + supervisor-spawn-time instead.
 */
#[CoversClass( Topology_Registry::class )]
class TopologyRegistryConflictsTest extends TestCase {

	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		Topology_Registry::reset();
		$this->tmp = $this->make_temp_dir( 'topology-conflicts-' );
		Topology_Registry::register_stock_dir( $this->tmp );
	}

	protected function tearDown(): void {
		Topology_Registry::reset();
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	private function write_tsl( string $name, string $contents ): void {
		\file_put_contents( "{$this->tmp}/{$name}.tsl", $contents );
	}

	public function test_no_conflict_when_write_sets_are_disjoint(): void {
		// The decomposed set: distinct data partitions AND distinct firehose
		// offsetlogs — safe to run together.
		$this->write_tsl( 'rb', "make_node Consumer firehose:consumer <config:logs_dir>/firehose.log <partition> <config:offsets_dir>/firehose.rb.p<partition>\nmake_node Partition requests:partition <config:logs_dir>/requests.log <partition>" );
		$this->write_tsl( 'jr', "make_node Consumer firehose:consumer <config:logs_dir>/firehose.log <partition> <config:offsets_dir>/firehose.jr.p<partition>\nmake_node Partition jobs:partition <config:logs_dir>/jobs.log <partition>" );

		$this->assertSame( [], Topology_Registry::find_conflicts( [ 'rb', 'jr' ] ) );
	}

	public function test_conflict_when_two_topologies_write_the_same_partition(): void {
		$this->write_tsl( 'combined', "make_node Partition requests:partition <config:logs_dir>/requests.log <partition>\nmake_node Partition jobs:partition <config:logs_dir>/jobs.log <partition>" );
		$this->write_tsl( 'rb', "make_node Partition requests:partition <config:logs_dir>/requests.log <partition>" );

		$conflicts = Topology_Registry::find_conflicts( [ 'combined', 'rb' ] );
		$this->assertCount( 1, $conflicts );
		$this->assertSame( 'combined', $conflicts[0]['a'] );
		$this->assertSame( 'rb', $conflicts[0]['b'] );
		$this->assertContains( 'partition:<config:logs_dir>/requests.log', $conflicts[0]['shared'] );
	}

	public function test_conflict_when_two_consumers_share_an_offsetlog(): void {
		// Different data partitions, but two readers sharing one cursor file still
		// clobber each other — the firehose-offsetlog hazard.
		$this->write_tsl( 'reader-a', "make_node Consumer firehose:consumer <config:logs_dir>/firehose.log <partition> <config:offsets_dir>/firehose.p<partition>\nmake_node Partition a:partition <config:logs_dir>/a.log <partition>" );
		$this->write_tsl( 'reader-b', "make_node Consumer firehose:consumer <config:logs_dir>/firehose.log <partition> <config:offsets_dir>/firehose.p<partition>\nmake_node Partition b:partition <config:logs_dir>/b.log <partition>" );

		$conflicts = Topology_Registry::find_conflicts( [ 'reader-a', 'reader-b' ] );
		$this->assertCount( 1, $conflicts );
		$this->assertContains( 'offsetlog:<config:offsets_dir>/firehose.p<partition>', $conflicts[0]['shared'] );
	}
}
