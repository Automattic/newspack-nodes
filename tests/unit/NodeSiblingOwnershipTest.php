<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

/** A builder that publishes an UNPATRONED sibling, as Vault_Group does. */
final class Sibling_Publisher_Fixture_Node extends Node {
	public function publish_open( string $kind ): Node {
		$child = new Node();
		$this->publish_sibling( $kind, $child );
		return $child;
	}
	public function retract_open( string $kind ): void {
		$this->retract_sibling( $kind );
	}
	/** @return array<string,Node> */
	public function read_siblings(): array {
		return $this->siblings();
	}
}

#[CoversClass( Node::class )]
final class NodeSiblingOwnershipTest extends TestCase {

	public function test_publisher_names_the_builder_until_retracted(): void {
		$builder = new Sibling_Publisher_Fixture_Node();
		$builder->name( 'relay-7' );
		$child = $builder->publish_open( 'tw9' );
		$this->assertSame( 'relay-7:tw9', $child->name() );
		$this->assertSame( $builder, $child->publisher() );
		$this->assertNull( $child->patron() );
		$builder->retract_open( 'tw9' );
		$this->assertNull( $child->publisher() );
	}

	public function test_dump_config_omits_an_unpatroned_published_sibling(): void {
		Command_Interpreter_Node::register_namespace( 'Newspack_Nodes\\Tests\\Unit\\' );
		$ci      = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );
		$builder = $ci->make_node( 'Sibling_Publisher_Fixture', 'relay-7' );
		$builder->publish_open( 'tw9' );
		$dump = $ci->dispatch( 'dump_config' );
		$this->assertStringContainsString( 'relay-7', $dump );
		$this->assertStringNotContainsString( 'relay-7:tw9', $dump );
	}

	public function test_siblings_reads_every_published_slot_by_kind(): void {
		$builder = new Sibling_Publisher_Fixture_Node();
		$builder->name( 'relay-7' );
		$builder->publish_open( 'tw9' );
		$tw4 = $builder->publish_open( 'tw4' );
		$builder->retract_open( 'tw9' );
		$this->assertSame( [ 'tw4' => $tw4 ], $builder->read_siblings() );
	}

	public function test_sibling_name_of_is_the_one_spelling_every_namer_reads(): void {
		$this->assertSame( 'relay-7:tw4:offsetlog', Node::sibling_name_of( 'relay-7', 'tw4:offsetlog' ) );
		$builder = new Sibling_Publisher_Fixture_Node();
		$builder->name( 'relay-7' );
		$this->assertSame( Node::sibling_name_of( 'relay-7', 'tw4' ), $builder->publish_open( 'tw4' )->name() );
	}
}
