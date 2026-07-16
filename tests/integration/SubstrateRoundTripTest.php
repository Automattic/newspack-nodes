<?php
namespace Newspack_Nodes\Tests\Integration;

use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;

class SubstrateRoundTripTest extends TestCase {
	public function test_full_graph_construction_and_message_routing(): void {
		// Standard worker scaffolding.
		$router = new Router_Node();
		$router->name( '_router' );

		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		$interpreter->sink( $router );

		// Build app graph via shell verbs.
		$this->assertSame( 'ok', $interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'alice' ] ) );
		$this->assertSame( 'ok', $interpreter->dispatch( 'make_node', [ 'Capture_Sink', 'bob' ] ) );
		$this->assertSame( 'ok', $interpreter->dispatch( 'connect_node', [ 'alice', 'bob' ] ) );

		// Send addressed message: TO=alice, expects router → alice (capture).
		$message                  = Message::new_message();
		$message[ Message::TYPE ] = Message::TM_BYTESTREAM;
		$message[ Message::TO ]   = 'alice';
		$message[ Message::FROM ] = 'test';
		$message[ Message::VALUE ] = 'payload-x';
		$router->fill( $message );

		$alice = Core::node( 'alice' );
		$this->assertCount( 1, $alice->captured );
		$this->assertSame( 'payload-x', $alice->captured[0][ Message::VALUE ] );
	}

	public function test_unknown_target_produces_NOT_AVAILABLE(): void {
		$router = new Router_Node();
		$router->name( '_router' );

		// Producer captures the error: the NOT_AVAILABLE bounce routes back via
		// TO=FROM='producer' (the Router has no sink — the producer is reached by name).
		$producer = new Capture_Sink_Node();
		$producer->name( 'producer' );

		$message                  = Message::new_message();
		$message[ Message::TO ]   = 'nowhere';
		$message[ Message::FROM ] = 'producer';
		$router->fill( $message );

		$this->assertCount( 1, $producer->captured );
		$err = $producer->captured[0];
		$this->assertSame( Message::TM_ERROR, $err[ Message::TYPE ] );
		$this->assertSame( "NOT_AVAILABLE\n", $err[ Message::VALUE ] );
	}
}
