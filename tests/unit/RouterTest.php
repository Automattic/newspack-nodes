<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Router;
use Newspack_Nodes\Tests\CaptureSink;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Router::class )]
class RouterTest extends TestCase {
	public function test_routes_to_named_target_and_strips_first_segment(): void {
		$router = new Router();
		$router->name( '_router' );

		$dst = new CaptureSink();
		$dst->name( 'alice' );

		$msg                = Message::new_message();
		$msg[ Message::TO ] = 'alice/some/path';

		$router->fill( $msg );

		$this->assertCount( 1, $dst->captured );
		$this->assertSame( 'some/path', $dst->captured[0][ Message::TO ] );
	}

	public function test_empty_TO_passes_through_to_sink(): void {
		$router = new Router();
		$router->name( '_router' );

		$captured = new CaptureSink();
		$router->sink( $captured );

		$msg = Message::new_message(); // TO=''
		$router->fill( $msg );

		$this->assertCount( 1, $captured->captured );
	}

	public function test_unknown_target_sends_NOT_AVAILABLE_error(): void {
		$router = new Router();
		$router->name( '_router' );
		$producer = new CaptureSink();
		$producer->name( 'producer' );
		$router->sink( $producer );

		$msg                  = Message::new_message();
		$msg[ Message::TO ]   = 'nonexistent';
		$msg[ Message::FROM ] = 'producer';
		$msg[ Message::ID ]   = 'req-1';

		$router->fill( $msg );

		// Error message routed back to FROM via the router's sink (which gets it because TO='producer'
		// is the producer's name; for this minimal test, sink is the receiving capture).
		$this->assertCount( 1, $producer->captured );
		$err = $producer->captured[0];
		$this->assertSame( Message::TM_ERROR, $err[ Message::TYPE ] );
		$this->assertSame( "NOT_AVAILABLE\n", $err[ Message::VALUE ] );
		$this->assertSame( 'producer', $err[ Message::TO ] );
	}

	public function test_unknown_target_drops_TM_ERROR_messages_silently(): void {
		// Don't bounce errors-on-errors.
		$router = new Router();
		$router->name( '_router' );
		$out = new CaptureSink();
		$router->sink( $out );

		$msg                  = Message::new_message();
		$msg[ Message::TYPE ] = Message::TM_ERROR;
		$msg[ Message::TO ]   = 'gone';
		$msg[ Message::FROM ] = 'someone';

		$router->fill( $msg );
		$this->assertCount( 0, $out->captured );
	}
}
