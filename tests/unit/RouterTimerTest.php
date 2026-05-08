<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
use Newspack_Nodes\EventFramework;
use Newspack_Nodes\Router;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Timer;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Router::class )]
class RouterTimerTest extends TestCase {
	protected function setUp(): void {
		parent::setUp();
		EventFramework::reset();
	}

	public function test_router_pre_declares_TIMER_event(): void {
		$router = new Router();
		$router->name( '_router' );
		$listener = new Timer();
		$listener->name( 't1' );

		$router->register( 'TIMER', 't1' );
		$this->assertTrue( true );
	}

	public function test_router_fires_TIMER_to_registrants_on_each_tick(): void {
		$router = new Router();
		$router->name( '_router' );

		$received = 0;
		$router->register( 'TIMER', 'cb', function () use ( &$received ) { ++$received; } );

		$router->fire_cb();
		$router->fire_cb();
		$router->fire_cb();

		$this->assertSame( 3, $received );
	}

	public function test_timer_with_no_args_registers_with_router_TIMER_event(): void {
		$router = new Router();
		$router->name( '_router' );

		$timer = new Timer();
		$timer->name( 'piggyback' );
		$timer->set_timer();

		$before = $timer->fire_count();
		$router->fire_cb();
		$this->assertSame( $before + 1, $timer->fire_count() );
	}
}
