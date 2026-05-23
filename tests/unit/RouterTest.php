<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\Tests\CaptureSink;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Router_Node::class )]
class RouterTest extends TestCase {
	public function test_routes_to_named_target_and_strips_first_segment(): void {
		$router = new Router_Node();
		$router->name( '_router' );

		$dst = new CaptureSink();
		$dst->name( 'alice' );

		$msg                = Message::new_message();
		$msg[ Message::TO ] = 'alice/some/path';

		$router->fill( $msg );

		$this->assertCount( 1, $dst->captured );
		$this->assertSame( 'some/path', $dst->captured[0][ Message::TO ] );
	}

	public function test_empty_TO_with_FROM_sends_NOT_AVAILABLE_back_to_FROM(): void {
		// No empty-TO->sink shortcut: empty TO -> NOT_AVAILABLE; with FROM set the error walks back to that node.
		$router = new Router_Node();
		$router->name( '_router' );
		$producer = new CaptureSink();
		$producer->name( 'producer' );

		$msg                  = Message::new_message(); // TO=''
		$msg[ Message::FROM ] = 'producer';
		$router->fill( $msg );

		$this->assertCount( 1, $producer->captured );
		$err = $producer->captured[0];
		$this->assertSame( Message::TM_ERROR, $err[ Message::TYPE ] );
		$this->assertSame( "NOT_AVAILABLE\n", $err[ Message::VALUE ] );
	}

	public function test_unknown_target_sends_NOT_AVAILABLE_error(): void {
		$router = new Router_Node();
		$router->name( '_router' );
		$producer = new CaptureSink();
		$producer->name( 'producer' );

		$msg                  = Message::new_message();
		$msg[ Message::TO ]   = 'nonexistent';
		$msg[ Message::FROM ] = 'producer';
		$msg[ Message::ID ]   = 'req-1';

		$router->fill( $msg );

		// Per spec: error re-enters TO-routing and walks the FROM trail. Router strips
		// 'producer' off the TO head when re-dispatching, leaving TO='' when the producer
		// finally captures it.
		$this->assertCount( 1, $producer->captured );
		$err = $producer->captured[0];
		$this->assertSame( Message::TM_ERROR, $err[ Message::TYPE ] );
		$this->assertSame( "NOT_AVAILABLE\n", $err[ Message::VALUE ] );
		$this->assertSame( '', $err[ Message::TO ] );
		$this->assertSame( '_router', $err[ Message::FROM ] );
	}

	public function test_unknown_target_drops_TM_ERROR_messages_silently(): void {
		// Don't bounce errors-on-errors: a TM_ERROR to an unknown target is dropped,
		// not walked back to FROM. (Verified via the FROM node, since the Router
		// has no sink.)
		$router = new Router_Node();
		$router->name( '_router' );
		$origin = new CaptureSink();
		$origin->name( 'someone' );

		$msg                  = Message::new_message();
		$msg[ Message::TYPE ] = Message::TM_ERROR;
		$msg[ Message::TO ]   = 'gone';
		$msg[ Message::FROM ] = 'someone';

		$router->fill( $msg );
		$this->assertCount( 0, $origin->captured );
	}

	public function test_router_getter_returns_null_sink(): void {
		$router = new Router_Node();
		$router->name( '_router' );
		$this->assertNull( $router->sink() );
	}

	public function test_setting_a_sink_throws(): void {
		// The Router routes by peeling TO and drops what it cannot peel — it must
		// never have a sink.
		$router = new Router_Node();
		$router->name( '_router' );
		$this->expectException( \InvalidArgumentException::class );
		$router->sink( new CaptureSink() );
	}
}
