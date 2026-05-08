<?php
namespace Newspack_Nodes\Tests\Integration;

use Newspack_Nodes\CommandInterpreter;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Responder;
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

		$resp = new Responder();
		$resp->name( '_responder' );
		$resp->sink( $router );

		// Build app graph via shell verbs.
		CommandInterpreter::register_class( 'CaptureSink', CaptureSink::class );
		$this->assertSame( 'ok', $ci->execute( 'make_node CaptureSink alice' ) );
		$this->assertSame( 'ok', $ci->execute( 'make_node CaptureSink bob' ) );
		$this->assertSame( 'ok', $ci->execute( 'connect_node alice bob' ) );

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

	public function test_TM_PERSIST_terminating_at_responder_cancels(): void {
		$router = new Router();
		$router->name( '_router' );
		$producer = new CaptureSink();
		$producer->name( 'producer' );
		$router->sink( $producer );

		$resp = new Responder();
		$resp->name( '_responder' );
		$resp->sink( $router );

		// Topology: producer → _router → _responder (terminal cancel-sink).
		$msg                  = Message::new_message();
		$msg[ Message::TYPE ] = Message::TM_PERSIST;
		$msg[ Message::TO ]   = '_responder';
		$msg[ Message::FROM ] = 'producer';
		$msg[ Message::ID ]   = 'p-1';
		$router->fill( $msg );

		// producer should have received the cancel.
		$this->assertCount( 1, $producer->captured );
		$cancel = $producer->captured[0];
		$this->assertSame( Message::TM_PERSIST | Message::TM_RESPONSE, $cancel[ Message::TYPE ] );
		$this->assertSame( 'cancel', $cancel[ Message::VALUE ] );
	}
}
