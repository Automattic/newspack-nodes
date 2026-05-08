<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Bootstrap::class )]
class BootstrapTest extends TestCase {
	public function test_get_topologies_returns_filtered_array(): void {
		$GLOBALS['_wp_actions'] = [];
		\add_filter( 'newspack_nodes/topologies', function ( $topologies ) {
			$topologies['my-group'] = [ 'num_partitions' => 2, 'topology' => '/path/to/file.php' ];
			return $topologies;
		} );

		$result = Bootstrap::get_topologies();
		$this->assertArrayHasKey( 'my-group', $result );
		$this->assertSame( 2, $result['my-group']['num_partitions'] );
	}

	public function test_get_topologies_returns_empty_array_when_no_filter(): void {
		$GLOBALS['_wp_actions'] = [];
		$result = Bootstrap::get_topologies();
		$this->assertSame( [], $result );
	}

	public function test_expand_topologies_yields_one_entry_per_partition(): void {
		$GLOBALS['_wp_actions'] = [];
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
}
