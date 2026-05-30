<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
use Newspack_Nodes\Event_Framework;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Timer_Node;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Router_Node::class )]
class RouterTimerTest extends TestCase {
	protected function setUp(): void {
		parent::setUp();
		Event_Framework::reset();
	}

	public function test_router_pre_declares_TIMER_event(): void {
		$router = new Router_Node();
		$router->name( '_router' );
		$listener = new Timer_Node();
		$listener->name( 't1' );

		$router->register( 'TIMER', 't1' );
		$this->assertTrue( true );
	}

	public function test_router_fires_TIMER_to_registrants_on_each_tick(): void {
		$router = new Router_Node();
		$router->name( '_router' );

		$received = 0;
		$router->register( 'TIMER', 'cb', function () use ( &$received ) { ++$received; } );

		$router->fire_cb();
		$router->fire_cb();
		$router->fire_cb();

		$this->assertSame( 3, $received );
	}

	public function test_timer_with_no_args_registers_with_router_TIMER_event(): void {
		$router = new Router_Node();
		$router->name( '_router' );

		$timer = new Timer_Node();
		$timer->name( 'piggyback' );
		$timer->set_timer();

		$before = $timer->fire_count();
		$router->fire_cb();
		$this->assertSame( $before + 1, $timer->fire_count() );
	}

	/**
	 * Regression for "TIMER hitchhike fires once then dies" bug: the original closure-based
	 * implementation returned void → null → falsy, so Node::notify auto-unregistered the
	 * listener after tick 1. Node-name dispatch keeps the registration alive across ticks.
	 */
	public function test_hitchhiked_timer_fires_on_every_tick_not_just_first(): void {
		$router = new Router_Node();
		$router->name( '_router' );

		$timer = new Timer_Node();
		$timer->name( 'persistent' );
		$timer->set_timer();

		$router->fire_cb();
		$router->fire_cb();
		$router->fire_cb();
		$router->fire_cb();
		$router->fire_cb();

		$this->assertSame( 5, $timer->fire_count(), 'hitchhiked Timer should fire on every Router tick, not self-unregister after the first' );
	}

	public function test_set_timer_no_args_throws_when_timer_has_no_name(): void {
		$router = new Router_Node();
		$router->name( '_router' );

		$timer = new Timer_Node(); // no name() call

		$this->expectException( \RuntimeException::class );
		$timer->set_timer();
	}

	/**
	 * Regression: stop_timer must clean up Router-hitchhike registrations as well as
	 * EventFramework slots. Previously stop_timer only deleted from EventFramework, leaving
	 * the registration in Router's TIMER list, so the Timer kept firing forever.
	 */
	public function test_stop_timer_unregisters_from_router_when_hitchhiked(): void {
		$router = new Router_Node();
		$router->name( '_router' );

		$timer = new Timer_Node();
		$timer->name( 'pulse' );
		$timer->set_timer();

		$router->fire_cb();
		$this->assertSame( 1, $timer->fire_count() );

		$timer->stop_timer();

		$router->fire_cb();
		$router->fire_cb();
		$this->assertSame( 1, $timer->fire_count(), 'stop_timer must unregister hitchhiked Timer so it stops firing' );
		$this->assertFalse( $timer->is_active() );
	}

	/**
	 * stop_timer unregisters the hitchhiked Timer from the Router immediately — no
	 * closing-queue drain needed. PHP foreach iterates a copy of the registration
	 * list (Node::notify even unset()s entries mid-loop), so synchronous unregister
	 * is safe; the Timer must not fire on the next tick.
	 */
	public function test_stop_timer_unregisters_immediately(): void {
		$router = new Router_Node();
		$router->name( '_router' );

		$timer = new Timer_Node();
		$timer->name( 'sync' );
		$timer->set_timer();

		$timer->stop_timer();
		// No run_closing(): teardown already happened synchronously.
		$router->fire_cb();
		$this->assertSame( 0, $timer->fire_count(), 'stop_timer must unregister immediately so the Timer never fires' );
		$this->assertFalse( $timer->is_active() );
	}
}
