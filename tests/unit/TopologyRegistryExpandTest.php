<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Topology_Registry;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * Topology_Registry::expand() — the console's composed-graph baseline for an
 * include SET, with provenance (`origin` lists every top-level include that
 * provides a node; `via` is the path it first entered through).
 */
#[CoversClass( Topology_Registry::class )]
class TopologyRegistryExpandTest extends TestCase {

	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		Topology_Registry::reset();
		$this->tmp = $this->make_temp_dir( 'topology-expand-' );
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

	public function test_expand_tags_a_diamond_shared_node_with_both_origins(): void {
		$this->write_tsl( 'wombat-base', "make_node Tee shared-tee\n" );
		$this->write_tsl( 'wombat-left', "include wombat-base\nmake_node Echo left-echo\nconnect_node left-echo shared-tee\n" );
		$this->write_tsl( 'wombat-right', "include wombat-base\nmake_node Echo right-echo\n" );

		$out    = Topology_Registry::expand( [ 'wombat-left', 'wombat-right' ] );
		$byName = [];
		foreach ( $out['nodes'] as $node ) {
			$byName[ $node['name'] ] = $node;
		}

		$this->assertSame( [ 'wombat-left', 'wombat-right' ], $byName['shared-tee']['origin'] );
		$this->assertSame( [ 'wombat-left', 'wombat-base' ], $byName['shared-tee']['via'] );
		$this->assertSame( [ 'wombat-left' ], $byName['left-echo']['origin'] );
		$this->assertSame( 'Echo', $byName['right-echo']['class'] );
		$this->assertContains(
			[ 'from' => 'left-echo', 'to' => 'shared-tee', 'origin' => [ 'wombat-left' ] ],
			$out['edges']
		);
		// The tree is DECLARED structure, not expansion order: wombat-right
		// declares `include wombat-base` too, so it shows there as well, even
		// though `#pragma once` expanded those statements only under -left.
		$this->assertSame(
			[
				'wombat-left'  => [ 'wombat-base' => [] ],
				'wombat-right' => [ 'wombat-base' => [] ],
			],
			$out['tree']
		);
	}

	public function test_expand_carries_ctor_args_and_target_edges(): void {
		$this->write_tsl(
			'wombat-args',
			"make_node Grep zebra-grep giraffe-pattern\n"
			. "make_node Partition zebra:partition /var/wombat/zebra.log <partition> 1 2 0\n"
			. "cmd zebra-grep:config set_errors_target zebra:partition\n"
		);

		$out    = Topology_Registry::expand( [ 'wombat-args' ] );
		$byName = [];
		foreach ( $out['nodes'] as $node ) {
			$byName[ $node['name'] ] = $node;
		}

		$this->assertSame( [ 'giraffe-pattern' ], $byName['zebra-grep']['args'] );
		$this->assertContains(
			[ 'from' => 'zebra-grep', 'to' => 'zebra:partition', 'origin' => [ 'wombat-args' ] ],
			$out['edges']
		);
	}

	public function test_expand_throws_on_an_unknown_include(): void {
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'no-such-topology' );
		Topology_Registry::expand( [ 'no-such-topology' ] );
	}
}
