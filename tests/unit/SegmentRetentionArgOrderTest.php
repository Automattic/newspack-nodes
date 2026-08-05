<?php
/**
 * The positional constructor contract shared by every segmented-storage node.
 *
 * `parse_schema_args()` maps a TSL token list onto `node_schema()['arguments']`
 * BY POSITION, so this order is the wire contract every `.tsl` in every plugin
 * is written against. Partition, Log and Topic must agree on it — a node that
 * orders its retention arguments differently silently reinterprets the same
 * token list.
 *
 * @package Newspack_Nodes
 */

declare( strict_types = 1 );

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Log_Node;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Topic_Node;

class SegmentRetentionArgOrderTest extends TestCase {

	/** @return list<string> */
	private function retention_args( string $class ): array {
		$names = [];
		foreach ( $class::node_schema()['arguments'] as $arg ) {
			if ( \in_array(
				$arg['name'],
				[ 'segment_size', 'min_segments', 'num_segments', 'max_segments', 'min_lifetime', 'lifetime' ],
				true
			) ) {
				$names[] = $arg['name'];
			}
		}
		return $names;
	}

	/** @return array<string, array{class-string}> */
	public static function segmented_nodes(): array {
		return [
			'Partition' => [ Partition_Node::class ],
			'Log'       => [ Log_Node::class ],
			'Topic'     => [ Topic_Node::class ],
		];
	}

	/**
	 * @dataProvider segmented_nodes
	 * @param class-string $class Node class under test.
	 */
	public function test_retention_arguments_are_declared_in_the_canonical_order( string $class ): void {
		$this->assertSame(
			[ 'segment_size', 'min_segments', 'num_segments', 'max_segments', 'min_lifetime', 'lifetime' ],
			$this->retention_args( $class ),
			"{$class} must declare the retention arguments in the shared positional order"
		);
	}

	public function test_a_topic_hands_each_child_partition_the_same_axes(): void {
		// Topic rebuilds its children's arg list by hand, so a reordering that
		// misses it silently swaps max_segments with min_lifetime per partition.
		$base = $this->make_temp_dir();
		$this->use_base_dir( $base );
		$topic = new Topic_Node();
		$topic->arguments( [ $base . '/t.p{partition}', '1', '1048576', '2', '8', '0', '86400', '86400' ] );

		$method = new \ReflectionMethod( Topic_Node::class, 'partition' );
		$method->setAccessible( true );
		$child = $method->invoke( $topic, 0 );
		$read  = static function ( string $prop ) use ( $child ) {
			return ( new \ReflectionProperty( Partition_Node::class, $prop ) )->getValue( $child );
		};
		$this->assertSame( 8, $read( 'num_segments' ) );
		$this->assertSame( 16, $read( 'max_segments' ), '0 derives to 2 x num_segments' );
		$this->assertSame( 86400, $read( 'min_lifetime' ) );
		$this->assertSame( 86400, $read( 'lifetime' ) );
	}

	public function test_a_positional_arg_list_lands_max_segments_before_the_lifetimes(): void {
		$base = $this->make_temp_dir();
		$this->use_base_dir( $base );
		$dir  = $base . '/argorder.p0';
		$node = new Partition_Node();
		// segment_size, min_segments, num_segments, max_segments, min_lifetime, lifetime
		$node->arguments( [ $dir, '1048576', '2', '8', '0', '86400', '86400' ] );

		$read = static function ( string $prop ) use ( $node ) {
			$p = new \ReflectionProperty( Partition_Node::class, $prop );
			return $p->getValue( $node );
		};

		$this->assertSame( 8, $read( 'num_segments' ) );
		// max_segments 0 derives to 2 x num_segments, NOT the 86400 that used
		// to sit in this slot.
		$this->assertSame( 16, $read( 'max_segments' ) );
		$this->assertSame( 86400, $read( 'min_lifetime' ) );
		$this->assertSame( 86400, $read( 'lifetime' ) );
	}
}
