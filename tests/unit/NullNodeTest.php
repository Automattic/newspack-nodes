<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Message;
use Newspack_Nodes\Null_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * Null — the black hole. Port of Tachikoma's Nodes::Null, whose fill() counts
 * and returns. It exists so a node that must declare a target has somewhere
 * harmless to point: HTTP_Out's wire-inbound clause only engages once a target
 * is set, and the arm worth having is the REFUSAL of a non-response the remote
 * addressed at our graph. Everything the other arm stamps lands here and stops.
 */
#[CoversClass( Null_Node::class )]
class NullNodeTest extends TestCase {

	public function test_fill_swallows_the_message(): void {
		$node = new Null_Node();
		$node->name( 'devnull' );
		$sink = new Capture_Sink_Node();
		$sink->name( 'downstream' );
		$node->sink( $sink );

		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$m[ Message::VALUE ] = "spoke stderr\n";
		$node->fill( $m );

		$this->assertSame( [], $sink->captured, 'nothing leaves a Null' );
	}

	/** Counted, not merely dropped: `ls` shows the traffic a Null absorbed. */
	public function test_fill_counts_what_it_swallows(): void {
		$node = new Null_Node();
		$node->name( 'devnull' );

		$node->fill( Message::new_message() );
		$node->fill( Message::new_message() );

		$this->assertSame( 2, $node->counter() );
	}

	public function test_it_declares_no_target(): void {
		$schema = Null_Node::node_schema();

		$this->assertFalse( $schema['has_target'], 'nothing leaves, so nothing to target' );
	}
}
