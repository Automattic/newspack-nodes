<?php
namespace Newspack_Nodes\Tests\Integration;

use Newspack_Nodes\CommandInterpreter;
use Newspack_Nodes\Core;
use Newspack_Nodes\EventFramework;
use Newspack_Nodes\Message;
use Newspack_Nodes\Router;
use Newspack_Nodes\Tests\CaptureSink;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Timer;

class EventLoopRoundTripTest extends TestCase {
	protected function setUp(): void {
		parent::setUp();
		EventFramework::reset();
	}

	public function test_eventframework_driven_timer_fires_during_drain(): void {
		$router = new Router();
		$router->name( '_router' );
		$ci = new CommandInterpreter();
		$ci->name( '_command_interpreter' );
		$ci->sink( $router );

		$timer = new Timer();
		$timer->name( 'tick' );
		$capture = new CaptureSink();
		$timer->sink( $capture );
		$timer->set_timer( 30 );

		$start = \microtime( true );
		EventFramework::instance()->drain( function () use ( $start ): bool {
			Core::update_time();
			return ( \microtime( true ) - $start ) < 0.2;
		} );

		$this->assertGreaterThan( 2, \count( $capture->captured ) );
		$this->assertSame( Message::TM_BYTESTREAM, $capture->captured[0][ Message::TYPE ] );
	}

	public function test_router_hitchhike_timer_fires_when_router_ticks(): void {
		$router = new Router();
		$router->name( '_router' );

		$piggy   = new Timer();
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
