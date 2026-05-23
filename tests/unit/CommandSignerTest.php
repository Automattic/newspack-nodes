<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Command_Auth;
use Newspack_Nodes\Command_Signer_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Command_Signer_Node::class )]
class CommandSignerTest extends TestCase {
	public function test_signs_command_then_forwards_to_sink(): void {
		$signer = new Command_Signer_Node();
		$sink   = new Capture_Sink_Node();
		$signer->sink( $sink );

		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_COMMAND;
		$m[ Message::VALUE ] = [ 'name' => 'make_node', 'arguments' => 'Tee t', 'payload' => '' ];
		$signer->fill( $m );

		$this->assertCount( 1, $sink->captured );
		$forwarded = $sink->captured[0];
		$this->assertArrayHasKey( 'auth', $forwarded[ Message::VALUE ] );
		$this->assertTrue( Command_Auth::verify( $forwarded ) );
	}

	public function test_passes_non_command_through_unsigned(): void {
		$signer = new Command_Signer_Node();
		$sink   = new Capture_Sink_Node();
		$signer->sink( $sink );

		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$m[ Message::VALUE ] = "data\n";
		$signer->fill( $m );

		$this->assertCount( 1, $sink->captured );
		$this->assertSame( "data\n", $sink->captured[0][ Message::VALUE ] );
	}

	public function test_does_not_sign_a_response_command(): void {
		$signer = new Command_Signer_Node();
		$sink   = new Capture_Sink_Node();
		$signer->sink( $sink );

		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$m[ Message::VALUE ] = [ 'name' => 'make_node', 'payload' => 'ok' ];
		$signer->fill( $m );

		$this->assertArrayNotHasKey( 'auth', $sink->captured[0][ Message::VALUE ] );
	}
}
