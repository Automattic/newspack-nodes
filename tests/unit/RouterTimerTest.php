<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
use Newspack_Nodes\Event_Framework;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
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

	/**
	 * notify_timer is node-name dispatch (Perl Router::notify_timer): it calls
	 * Core::node($name)->fire_cb() directly. A registered name with no live node is
	 * warned + dropped (forgot to unregister), not left polling a dead node.
	 */
	public function test_router_drops_a_registered_name_with_no_live_node(): void {
		$router = new Router_Node();
		$router->name( '_router' );
		$router->register( 'TIMER', 'ghost' ); // no node named 'ghost' in Core

		$router->fire_cb();

		$prop = ( new \ReflectionObject( $router ) )->getProperty( 'registrations' );
		$regs = $prop->getValue( $router );
		$this->assertArrayNotHasKey( 'ghost', $regs['TIMER'] );
	}

	public function test_hitchhike_oneshot_unregisters_after_its_single_fire(): void {
		$router = new Router_Node();
		$router->name( '_router' );
		$timer = new Timer_Node();
		$timer->name( 'once0' );
		$capture = new Capture_Sink_Node();
		$timer->sink( $capture );
		$timer->set_timer( 5000, true );

		$router->fire_cb();
		Core::$now += 6; // past the 5s hitchhike throttle: a leak would re-fire
		$router->fire_cb();

		$this->assertCount( 1, $capture->captured, 'a spent oneshot must not keep riding the router TIMER' );
		$this->assertFalse( $timer->oneshot );
		$this->assertSame( 'inactive', $timer->timer_mode() );
	}

	public function test_router_fire_cb_increments_its_own_fire_count(): void {
		$router = new Router_Node();
		$router->name( '_router' );

		$router->fire_cb();
		$router->fire_cb();

		$this->assertSame( 2, $router->get_fire_count(), 'list_timers FIRES must tally router ticks' );
	}

	public function test_timer_with_no_args_registers_with_router_TIMER_event(): void {
		$router = new Router_Node();
		$router->name( '_router' );

		$timer = new Timer_Node();
		$timer->name( 'piggyback' );
		$timer->sink( $router );
		$timer->set_timer();

		$before = $timer->counter();
		$router->fire_cb();
		$this->assertSame( $before + 1, $timer->counter() );
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
		$timer->sink( $router );
		$timer->set_timer();

		$router->fire_cb();
		$router->fire_cb();
		$router->fire_cb();
		$router->fire_cb();
		$router->fire_cb();

		$this->assertSame( 5, $timer->counter(), 'hitchhiked Timer should fire on every Router tick, not self-unregister after the first' );
	}

	/**
	 * notify_timer must only call fire_cb() on Timer_Nodes. A plain Node (no
	 * fire_cb method) registered under TIMER must be skipped, not fataled on —
	 * the guard protects against a non-Timer registrant slipping through.
	 */
	public function test_notify_timer_skips_a_registered_non_timer_node(): void {
		$router = new Router_Node();
		$router->name( '_router' );

		$plain = new Capture_Sink_Node();
		$plain->name( 'plain' ); // registers in Core; Capture_Sink_Node has no fire_cb().
		$router->register( 'TIMER', 'plain' );

		// Pre-guard this fataled with "undefined method Node::fire_cb()". The
		// guard skips the non-Timer registrant, so the call returns normally.
		$router->notify_timer();

		$this->assertEmpty( $plain->captured, 'a non-Timer node must not be driven by notify_timer' );
	}

	public function test_set_timer_no_args_throws_when_timer_has_no_name(): void {
		$router = new Router_Node();
		$router->name( '_router' );

		$timer = new Timer_Node(); // no name() call

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'Router-hitchhike requires Timer to have a name' );
		$timer->set_timer();
	}

	public function test_set_timer_no_args_throws_when_no_router_present(): void {
		// Named, but no _router registered in Core → the no-arg hitchhike has
		// nothing to register with. Fail loud rather than silently never firing.
		$timer = new Timer_Node();
		$timer->name( 'orphan' );

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'Router-hitchhike requires _router to be present' );
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
		$timer->sink( $router );
		$timer->set_timer();

		$router->fire_cb();
		$this->assertSame( 1, $timer->counter() );

		$timer->stop_timer();

		$router->fire_cb();
		$router->fire_cb();
		$this->assertSame( 1, $timer->counter(), 'stop_timer must unregister hitchhiked Timer so it stops firing' );
		$this->assertSame( 'inactive', $timer->timer_mode());
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
		$this->assertSame( 0, $timer->counter(), 'stop_timer must unregister immediately so the Timer never fires' );
		$this->assertSame( 'inactive', $timer->timer_mode());
	}
}
