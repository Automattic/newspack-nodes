<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Message;
use Newspack_Nodes\Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Node::class )]
class NodeCommandTest extends TestCase {
	public function test_command_returns_a_tm_command_message_carrying_the_command_envelope(): void {
		$node = new Node();
		$msg  = $node->command( 'connect_node', 'a b' );
		$this->assertSame( Message::TM_COMMAND, $msg[ Message::TYPE ] & Message::TM_COMMAND );
		$this->assertSame( [
			'name'      => 'connect_node',
			'arguments' => 'a b',
			'payload'   => null,
		], $msg[ Message::VALUE ] );
	}

	public function test_command_carries_optional_payload(): void {
		$node = new Node();
		$msg  = $node->command( 'set_target', 'foo', [ 'extra' => 1 ] );
		$this->assertSame( [ 'extra' => 1 ], $msg[ Message::VALUE ]['payload'] );
	}
}
