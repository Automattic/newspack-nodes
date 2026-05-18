<?php
namespace Newspack_Nodes\Tests\Integration;

use Newspack_Nodes\CommandInterpreter;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Router;
use Newspack_Nodes\Tests\CaptureSink;
use Newspack_Nodes\Tests\TestCase;

class SubstrateRoundTripTest extends TestCase {
	public function test_full_graph_construction_and_message_routing(): void {
		// Standard worker scaffolding.
		$router = new Router();
		$router->name( '_router' );

		$ci = new CommandInterpreter();
		$ci->name( '_command_interpreter' );
		$ci->sink( $router );

		// Build app graph via shell verbs.
		CommandInterpreter::register_class( 'CaptureSink', CaptureSink::class );
		$this->assertSame( 'ok', $ci->dispatch( 'make_node', 'CaptureSink alice' ) );
		$this->assertSame( 'ok', $ci->dispatch( 'make_node', 'CaptureSink bob' ) );
		$this->assertSame( 'ok', $ci->dispatch( 'connect_node', 'alice bob' ) );

		// Send addressed message: TO=alice, expects router → alice (capture).
		$msg                  = Message::new_message();
		$msg[ Message::TYPE ] = Message::TM_BYTESTREAM;
		$msg[ Message::TO ]   = 'alice';
		$msg[ Message::FROM ] = 'test';
		$msg[ Message::VALUE ] = 'payload-x';
		$router->fill( $msg );

		$alice = Core::node( 'alice' );
		$this->assertCount( 1, $alice->captured );
		$this->assertSame( 'payload-x', $alice->captured[0][ Message::VALUE ] );
	}

	public function test_unknown_target_produces_NOT_AVAILABLE(): void {
		$router = new Router();
		$router->name( '_router' );

		// Producer captures the error.
		$producer = new CaptureSink();
		$producer->name( 'producer' );
		$router->sink( $producer );

		$msg                  = Message::new_message();
		$msg[ Message::TO ]   = 'nowhere';
		$msg[ Message::FROM ] = 'producer';
		$router->fill( $msg );

		$this->assertCount( 1, $producer->captured );
		$err = $producer->captured[0];
		$this->assertSame( Message::TM_ERROR, $err[ Message::TYPE ] );
		$this->assertSame( "NOT_AVAILABLE\n", $err[ Message::VALUE ] );
	}
}
