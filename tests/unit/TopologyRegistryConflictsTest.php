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
		$this->write_tsl( 'rb', "make_node Consumer firehose:consumer <config:logs_dir>/firehose.p<partition> <config:offsets_dir>/firehose.rb.p<partition>\nmake_node Partition requests:partition <config:logs_dir>/requests.p<partition> <config:segment_size> <config:num_segments> <config:max_lifespan>" );
		$this->write_tsl( 'jr', "make_node Consumer firehose:consumer <config:logs_dir>/firehose.p<partition> <config:offsets_dir>/firehose.jr.p<partition>\nmake_node Partition jobs:partition <config:logs_dir>/jobs.p<partition> <config:segment_size> <config:num_segments> <config:max_lifespan>" );

		$this->assertSame( [], Topology_Registry::find_conflicts( [ 'rb', 'jr' ] ) );
	}

	public function test_conflict_when_two_topologies_write_the_same_partition(): void {
		$this->write_tsl( 'combined', "make_node Partition requests:partition <config:logs_dir>/requests.p<partition> <config:segment_size> <config:num_segments> <config:max_lifespan>\nmake_node Partition jobs:partition <config:logs_dir>/jobs.p<partition> <config:segment_size> <config:num_segments> <config:max_lifespan>" );
		$this->write_tsl( 'rb', "make_node Partition requests:partition <config:logs_dir>/requests.p<partition> <config:segment_size> <config:num_segments> <config:max_lifespan>" );

		$conflicts = Topology_Registry::find_conflicts( [ 'combined', 'rb' ] );
		$this->assertCount( 1, $conflicts );
		$this->assertSame( 'combined', $conflicts[0]['a'] );
		$this->assertSame( 'rb', $conflicts[0]['b'] );
		$this->assertContains( 'partition:<config:logs_dir>/requests.p<partition>', $conflicts[0]['shared'] );
	}

	public function test_conflict_when_two_consumers_share_an_offsetlog(): void {
		// Different data partitions, but two readers sharing one cursor file still
		// clobber each other — the firehose-offsetlog hazard.
		$this->write_tsl( 'reader-a', "make_node Consumer firehose:consumer <config:logs_dir>/firehose.p<partition> <config:offsets_dir>/firehose.p<partition>\nmake_node Partition a:partition <config:logs_dir>/a.p<partition> <config:segment_size> <config:num_segments> <config:max_lifespan>" );
		$this->write_tsl( 'reader-b', "make_node Consumer firehose:consumer <config:logs_dir>/firehose.p<partition> <config:offsets_dir>/firehose.p<partition>\nmake_node Partition b:partition <config:logs_dir>/b.p<partition> <config:segment_size> <config:num_segments> <config:max_lifespan>" );

		$conflicts = Topology_Registry::find_conflicts( [ 'reader-a', 'reader-b' ] );
		$this->assertCount( 1, $conflicts );
		$this->assertContains( 'offsetlog:<config:offsets_dir>/firehose.p<partition>', $conflicts[0]['shared'] );
	}

	public function test_topic_is_a_writer_in_the_write_set(): void {
		// A Topic appends to the partitions under its path exactly like Partition,
		// so it belongs in the write-set under the same `partition:` namespace —
		// otherwise a Topic-vs-Partition collision on the same log is invisible.
		$this->write_tsl( 'producer', "make_node Topic firehose:topic <config:logs_dir>/firehose.p{partition} <config:num_partitions> <config:segment_size> <config:num_segments> <config:max_lifespan>" );

		$this->assertContains(
			'partition:<config:logs_dir>/firehose.p{partition}',
			Topology_Registry::write_set( 'producer' )
		);
	}

	public function test_conflict_when_topic_and_partition_write_the_same_log(): void {
		$this->write_tsl( 'producer', "make_node Topic firehose:topic <config:logs_dir>/firehose.p{partition} <config:num_partitions> <config:segment_size> <config:num_segments> <config:max_lifespan>" );
		$this->write_tsl( 'writer', "make_node Partition firehose:partition <config:logs_dir>/firehose.p{partition} <config:segment_size> <config:num_segments> <config:max_lifespan>" );

		$conflicts = Topology_Registry::find_conflicts( [ 'producer', 'writer' ] );
		$this->assertCount( 1, $conflicts );
		$this->assertContains( 'partition:<config:logs_dir>/firehose.p{partition}', $conflicts[0]['shared'] );
	}

	public function test_write_set_is_memoized_until_cache_reset(): void {
		$this->write_tsl( 'w', "make_node Partition a:partition <config:logs_dir>/a.p<partition> <config:segment_size> <config:num_segments> <config:max_lifespan>" );
		$first = Topology_Registry::write_set( 'w' );
		$this->assertContains( 'partition:<config:logs_dir>/a.p<partition>', $first );

		// Rewrite the .tsl to a different path WITHOUT clearing the cache — the
		// memoized result persists (proves the disk read is cached, not redone).
		$this->write_tsl( 'w', "make_node Partition b:partition <config:logs_dir>/b.p<partition> <config:segment_size> <config:num_segments> <config:max_lifespan>" );
		$this->assertSame( $first, Topology_Registry::write_set( 'w' ), 'cached until the per-tick reset' );

		// reset_basename_cache() (Config::RESET_ACTION on each supervisor tick) picks up the edit.
		Topology_Registry::reset_basename_cache();
		$this->assertContains( 'partition:<config:logs_dir>/b.p<partition>', Topology_Registry::write_set( 'w' ) );
	}

	public function test_describe_conflicts_renders_pairs_with_shared_resource(): void {
		$desc = Topology_Registry::describe_conflicts( [
			[ 'a' => 'combined', 'b' => 'rb', 'shared' => [ 'partition:x/requests.log' ] ],
			[ 'a' => 'combined', 'b' => 'jr', 'shared' => [ 'offsetlog:y/firehose.p0' ] ],
		] );
		$this->assertStringContainsString( 'combined', $desc );
		$this->assertStringContainsString( 'rb', $desc );
		$this->assertStringContainsString( 'partition:x/requests.log', $desc );
		$this->assertStringContainsString( 'jr', $desc );
	}

	public function test_describe_conflicts_empty_is_empty_string(): void {
		$this->assertSame( '', Topology_Registry::describe_conflicts( [] ) );
	}
}
