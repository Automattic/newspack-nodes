<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\CommandInterpreter;
use Newspack_Nodes\Tests\TestCase;

class NodeSchemaCoverageTest extends TestCase {
	public function test_every_registered_class_returns_schema_with_category(): void {
		$missing = [];
		foreach ( CommandInterpreter::class_map() as $shell_name => $fqcn ) {
			if ( ! \method_exists( $fqcn, 'node_schema' ) ) {
				$missing[ $shell_name ] = 'no node_schema() method';
				continue;
			}
			$schema = $fqcn::node_schema();
			$cat    = $schema['category'] ?? '';
			if ( ! \is_array( $schema ) || '' === $cat ) {
				$missing[ $shell_name ] = 'schema missing non-empty category';
			}
		}
		$this->assertSame(
			[],
			$missing,
			"Classes without node_schema()/category: " . \print_r( $missing, true )
		);
	}

	public function test_default_node_schema_advertises_both_ports(): void {
		// Plain Node has both fill() and target() — defaults must be true so
		// the schematic renderer keeps drawing IN/OUT ports for every class
		// that hasn't explicitly opted out.
		$schema = \Newspack_Nodes\Node::node_schema();
		$this->assertArrayHasKey( 'accepts_fill', $schema );
		$this->assertArrayHasKey( 'has_target', $schema );
		$this->assertTrue( $schema['accepts_fill'] );
		$this->assertTrue( $schema['has_target'] );
	}

	public function test_tail_does_not_accept_fill(): void {
		// Tail is a pure producer — it polls a file and emits messages.
		// fill() is unused, so the IN port should not render.
		$schema = \Newspack_Nodes\Tail::node_schema();
		$this->assertFalse( $schema['accepts_fill'] ?? true );
		$this->assertTrue( $schema['has_target'] ?? false );
	}

	public function test_consumer_does_not_accept_fill(): void {
		// Consumer tails a Partition — also a pure producer.
		$schema = \Newspack_Nodes\Consumer::node_schema();
		$this->assertFalse( $schema['accepts_fill'] ?? true );
		$this->assertTrue( $schema['has_target'] ?? false );
	}

	public function test_partition_has_no_target(): void {
		// Partition is terminal storage — accepts fill() but doesn't forward.
		$schema = \Newspack_Nodes\Partition::node_schema();
		$this->assertTrue( $schema['accepts_fill'] ?? false );
		$this->assertFalse( $schema['has_target'] ?? true );
	}

	public function test_log_has_no_target(): void {
		// Log is terminal storage — accepts fill() but doesn't forward.
		$schema = \Newspack_Nodes\Log::node_schema();
		$this->assertTrue( $schema['accepts_fill'] ?? false );
		$this->assertFalse( $schema['has_target'] ?? true );
	}
}
