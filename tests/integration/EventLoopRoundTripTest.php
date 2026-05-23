<?php
namespace Newspack_Nodes\Tests\Integration;

use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Event_Framework;
use Newspack_Nodes\Message;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\Tests\CaptureSink;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Timer_Node;

class EventLoopRoundTripTest extends TestCase {
	protected function setUp(): void {
		parent::setUp();
		Event_Framework::reset();
	}

	public function test_eventframework_driven_timer_fires_during_drain(): void {
		$router = new Router_Node();
		$router->name( '_router' );
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );
		$ci->sink( $router );

		$timer = new Timer_Node();
		$timer->name( 'tick' );
		$capture = new CaptureSink();
		$timer->sink( $capture );
		$timer->set_timer( 30 );

		$start = \microtime( true );
		Event_Framework::instance()->drain( function () use ( $start ): bool {
			Core::$now = \microtime(true);
			return ( \microtime( true ) - $start ) < 0.2;
		} );

		$this->assertGreaterThan( 2, \count( $capture->captured ) );
		$this->assertSame( Message::TM_BYTESTREAM, $capture->captured[0][ Message::TYPE ] );
	}

	public function test_router_hitchhike_timer_fires_when_router_ticks(): void {
		$router = new Router_Node();
		$router->name( '_router' );

		$piggy   = new Timer_Node();
		$piggy->name( 'piggy' );
		$capture = new CaptureSink();
		$piggy->sink( $capture );
		$piggy->set_timer();

		for ( $i = 0; $i < 5; ++$i ) {
			$router->fire_cb();
		}

		$this->assertSame( 5, $piggy->fire_count() );
		$this->assertCount( 5, $capture->captured );
	}
}
