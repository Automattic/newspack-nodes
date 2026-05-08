<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Responder;
use Newspack_Nodes\Router;
use Newspack_Nodes\Tests\CaptureSink;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Responder::class )]
class ResponderTest extends TestCase {
	public function test_TM_PERSIST_terminal_sends_cancel_to_FROM(): void {
		$router = new Router();
		$router->name( '_router' );
		$producer = new CaptureSink();
		$producer->name( 'producer' );
		$router->sink( $producer );

		$resp = new Responder();
		$resp->name( '_responder' );
		$resp->sink( $router );

		$msg                  = Message::new_message();
		$msg[ Message::TYPE ] = Message::TM_PERSIST;
		$msg[ Message::FROM ] = 'producer';
		$msg[ Message::ID ]   = 'req-1';

		$resp->fill( $msg );

		$this->assertCount( 1, $producer->captured );
		$ack = $producer->captured[0];
		$this->assertSame( Message::TM_PERSIST | Message::TM_RESPONSE, $ack[ Message::TYPE ] );
		$this->assertSame( 'cancel', $ack[ Message::VALUE ] );
	}

	public function test_TM_PERSIST_with_TM_ERROR_sends_answer_not_cancel(): void {
		$router = new Router();
		$router->name( '_router' );
		$producer = new CaptureSink();
		$producer->name( 'producer' );
		$router->sink( $producer );

		$resp = new Responder();
		$resp->name( '_responder' );
		$resp->sink( $router );

		$msg                  = Message::new_message();
		$msg[ Message::TYPE ] = Message::TM_PERSIST | Message::TM_ERROR;
		$msg[ Message::FROM ] = 'producer';

		$resp->fill( $msg );

		$this->assertSame( 'answer', $producer->captured[0][ Message::VALUE ] );
	}

	public function test_shell_callback_invoked_on_ID_match_and_dispatch_stops_there(): void {
		$resp = new Responder();
		$resp->name( '_responder' );
		$dumper = new CaptureSink();
		$resp->sink( $dumper );

		$called = null;
		$resp->register_shell_callback( 'req-9', function ( array $info ) use ( &$called ) {
			$called = $info;
			return false; // single-shot
		} );

		$msg                  = Message::new_message();
		$msg[ Message::TYPE ] = Message::TM_RESPONSE;
		$msg[ Message::ID ]   = 'req-9';
		$msg[ Message::FROM ] = 'someone';

		$resp->fill( $msg );

		$this->assertNotNull( $called );
		$this->assertSame( 'someone', $called['from'] );
		$this->assertCount( 0, $dumper->captured, 'must NOT forward to sink when callback handled it' );
	}

	public function test_no_callback_match_forwards_to_sink(): void {
		$resp = new Responder();
		$resp->name( '_responder' );
		$dumper = new CaptureSink();
		$resp->sink( $dumper );

		$msg                  = Message::new_message();
		$msg[ Message::TYPE ] = Message::TM_INFO;
		$msg[ Message::ID ]   = 'unknown-id';

		$resp->fill( $msg );

		$this->assertCount( 1, $dumper->captured, 'unmatched message should forward' );
	}
}
