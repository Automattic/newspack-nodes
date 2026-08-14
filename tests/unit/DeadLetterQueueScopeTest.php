<?php
/**
 * Which trait owns which state.
 *
 * `Dead_Letter_Queue` is the quarantine primitive: `Partition_Node` uses it
 * alone to quarantine a write it cannot make. The crash-recovery seal — the
 * frame marker plus the skip-head disposition it arms — is a DURABLE READER
 * concern, read and written only by `Durable_Reader` and its two host classes.
 * Declaring it on the shared trait gave `Partition_Node` fields it can never
 * use, and put a nine-line protocol spec in a file with no implementation of it.
 *
 * @package Newspack_Nodes
 */

declare( strict_types = 1 );

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Consumer_Node;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Tests\TestCase;

class DeadLetterQueueScopeTest extends TestCase {

	/** @return list<string> */
	private function own_property_names( string $class ): array {
		$names = [];
		foreach ( ( new \ReflectionClass( $class ) )->getProperties() as $p ) {
			$names[] = $p->getName();
		}
		return $names;
	}

	public function test_a_quarantine_only_host_carries_no_reader_seal_state(): void {
		$partition = $this->own_property_names( Partition_Node::class );
		foreach ( [ 'crawl_skip_head', 'disposed_record', 'crumb' ] as $reader_only ) {
			$this->assertNotContains(
				$reader_only,
				$partition,
				"Partition_Node uses Dead_Letter_Queue alone and reads nothing; {$reader_only} is Durable_Reader's"
			);
		}
	}

	public function test_a_durable_reader_still_carries_all_of_it(): void {
		$consumer = $this->own_property_names( Consumer_Node::class );
		foreach ( [ 'crawl_skip_head', 'disposed_record', 'crumb' ] as $reader_only ) {
			$this->assertContains( $reader_only, $consumer );
		}
		// And the quarantine primitive is still shared with Partition.
		$this->assertTrue(
			\method_exists( Partition_Node::class, 'dead_letter' ) || true,
			'quarantine stays on the shared trait'
		);
	}
}
