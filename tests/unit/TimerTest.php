<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
use Newspack_Nodes\Event_Framework;
use Newspack_Nodes\Message;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Timer_Node;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * TimerTest — Timer_Node behavior the Router-hitchhike fan-out tests
 * (RouterTimerTest) don't reach: arguments() string parsing, key stamping,
 * own-slot lifecycle, the fire() message shape + owner/CI guard + counter++,
 * the no-sink early return in fire_cb, oneshot, and the inherited Node::fill
 * passthrough (Timer no longer overrides fill — TIMER is a direct fire_cb
 * dispatch from the Router, never a routed message).
 */
#[CoversClass( Timer_Node::class )]
class TimerTest extends TestCase {
	protected function setUp(): void {
		parent::setUp();
		Event_Framework::reset();
	}

	private function mode_of( Timer_Node $timer ): string {
		$prop = ( new \ReflectionObject( $timer ) )->getProperty( 'mode' );
		$prop->setAccessible( true );
		return (string) $prop->getValue( $timer );
	}

	// ── arguments() — the round-trippable make_node config string ─────────────

	public function test_arguments_getter_returns_stored_value(): void {
		$timer = new Timer_Node();
		$timer->name( 't' );
		$timer->arguments( '250' );
		$this->assertSame( '250', $timer->arguments() );
		$timer->stop_timer();
	}

	public function test_arguments_null_is_pure_getter(): void {
		$timer = new Timer_Node();
		$timer->name( 't' );
		$this->assertSame( '', $timer->arguments( null ) );
	}

	public function test_arguments_empty_string_triggers_router_hitchhike(): void {
		$router = new Router_Node();
		$router->name( '_router' );
		$timer = new Timer_Node();
		$timer->name( 'hb' );
		$timer->arguments( '' );
		$this->assertSame( 'router', $this->mode_of( $timer ) );
	}

	public function test_arguments_numeric_starts_own_slot(): void {
		$timer = new Timer_Node();
		$timer->name( 't' );
		$timer->arguments( '250' );
		$this->assertSame( 'event_framework', $this->mode_of( $timer ) );
		$timer->stop_timer();
	}

	public function test_arguments_non_numeric_throws(): void {
		$timer = new Timer_Node();
		$timer->name( 't' );
		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( 'Bad arguments for Timer' );
		$timer->arguments( 'fast' );
	}

	public function test_fire_throws_when_it_must_emit_but_has_no_sink(): void {
		// fire() throws if it has work to emit (a non-empty target) but no sink.
		// fire_cb() guards the null-sink case before delegating, so this path is
		// only reachable by invoking the protected fire() directly — pin the
		// exception so that guard contract stays explicit.
		$timer = new Timer_Node();
		$timer->name( 't' );
		$timer->target( 'somewhere' );
		$fire = new \ReflectionMethod( Timer_Node::class, 'fire' );
		$fire->setAccessible( true );
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'Timer::fire requires a wired sink' );
		$fire->invoke( $timer );
	}

	// ── key stamping + fire() message shape ───────────────────────────────────

	public function test_set_key_round_trips(): void {
		$timer = new Timer_Node();
		$this->assertSame( '', $timer->key() );
		$timer->key( 'tick' );
		$this->assertSame( 'tick', $timer->key() );
	}

	public function test_fire_stamps_key_and_bytestream_timestamp(): void {
		$timer = new Timer_Node();
		$timer->name( 'k' );
		$timer->key( 'heartbeat' );
		$capture = new Capture_Sink_Node();
		$timer->sink( $capture );
		$timer->fire_cb();
		$this->assertCount( 1, $capture->captured );
		$message = $capture->captured[0];
		$this->assertSame( 'heartbeat', $message[ Message::KEY ] );
		$this->assertTrue( (bool) ( $message[ Message::TYPE ] & Message::TM_BYTESTREAM ) );
		$this->assertIsString( $message[ Message::VALUE ] );
	}

	public function test_fire_omits_key_when_unset(): void {
		$timer = new Timer_Node();
		$timer->name( 'k' );
		$capture = new Capture_Sink_Node();
		$timer->sink( $capture );
		$timer->fire_cb();
		$this->assertSame( '', $capture->captured[0][ Message::KEY ] );
	}

	public function test_fire_cb_with_no_sink_does_not_throw(): void {
		$timer = new Timer_Node();
		$timer->name( 't' );
		$capture = new Capture_Sink_Node();
		$timer->sink( $capture );
		$timer->fire_cb();
		$this->assertSame( 1, $timer->counter() );
	}

	public function test_fire_cb_with_no_sink_returns_without_firing(): void {
		$timer = new Timer_Node();
		$timer->name( 't' );

		$timer->fire_cb();

		$this->assertSame( 0, $timer->counter() );
	}

	// ── lifecycle ──────────────────────────────────────────────────────────────

	public function test_set_timer_with_ms_enters_event_framework_and_stops_clean(): void {
		$timer = new Timer_Node();
		$timer->name( 't' );
		$this->assertSame( 'inactive', $this->mode_of( $timer ) );
		$timer->set_timer( 100 );
		$this->assertSame( 'event_framework', $this->mode_of( $timer ) );
		$timer->stop_timer();
		$this->assertSame( 'inactive', $this->mode_of( $timer ) );
	}

	public function test_stop_timer_on_inactive_is_a_noop(): void {
		$timer = new Timer_Node();
		$timer->name( 't' );
		$timer->stop_timer();
		$this->assertSame( 'inactive', $this->mode_of( $timer ) );
	}

	public function test_router_hitchhike_requires_named_timer(): void {
		$timer = new Timer_Node();

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'Router-hitchhike requires Timer to have a name' );

		$timer->set_timer();
	}

	public function test_router_hitchhike_requires_router_node(): void {
		$timer = new Timer_Node();
		$timer->name( 't' );

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'Router-hitchhike requires _router to be present' );

		$timer->set_timer();
	}

	public function test_timer_switches_between_router_and_event_framework_modes(): void {
		$router = new Router_Node();
		$router->name( '_router' );
		$router->interval_ms = 250;
		$timer = new Timer_Node();
		$timer->name( 'hb' );

		$timer->set_timer();
		$this->assertSame( 'router', $this->mode_of( $timer ) );
		$this->assertSame( 250, $timer->interval_ms );

		$timer->set_timer( 100 );
		$this->assertSame( 'event_framework', $this->mode_of( $timer ) );

		$timer->set_timer();
		$this->assertSame( 'router', $this->mode_of( $timer ) );
	}

	// ── hitchhike + throttle (set_timer($ms) with $ms >= 1000) ────────────────

	public function test_set_timer_at_or_over_1000_hitchhikes_the_router(): void {
		$router = new Router_Node();
		$router->name( '_router' );
		$router->interval_ms = 1000;
		$timer = new Timer_Node();
		$timer->name( 'slow' );

		// 1000 is the boundary: at-or-over the router tick, hitchhike it.
		$timer->set_timer( 1000 );

		$this->assertSame( 'router', $this->mode_of( $timer ) );
		$this->assertSame( 1000, $timer->interval_ms );
		// No own-slot was scheduled in the Event_Framework.
		$ef   = ( new \ReflectionObject( Event_Framework::instance() ) )->getProperty( 'timers' );
		$ef->setAccessible( true );
		$this->assertCount( 0, $ef->getValue( Event_Framework::instance() ) );
		$timer->stop_timer();
	}

	public function test_fire_cb_throttles_to_interval_ms_across_router_ticks(): void {
		$router = new Router_Node();
		$router->name( '_router' );
		$router->interval_ms = 1000;
		$timer = new Timer_Node();
		$timer->name( 'slow-throttle' );
		$capture = new Capture_Sink_Node();
		$timer->sink( $capture );
		$timer->set_timer( 5000 );

		// Five 1s router ticks; only the tick at-or-past 5s emits.
		for ( $i = 1; $i <= 5; $i++ ) {
			Core::$now = (float) $i;
			$timer->fire_cb();
		}
		$this->assertCount( 1, $capture->captured );

		// Five more ticks → one more emit at the 10s boundary.
		for ( $i = 6; $i <= 10; $i++ ) {
			Core::$now = (float) $i;
			$timer->fire_cb();
		}
		$this->assertCount( 2, $capture->captured );
		$timer->stop_timer();
	}

	public function test_set_timer_below_1000_uses_own_slot(): void {
		$timer = new Timer_Node();
		$timer->name( 'fast' );
		$timer->set_timer( 999 );
		$this->assertSame( 'event_framework', $this->mode_of( $timer ) );
		$timer->stop_timer();
	}

	public function test_router_self_arm_uses_own_slot_not_hitchhike(): void {
		// The router can't hitchhike its own TIMER — at the >=1000 boundary it must
		// still own an event-framework slot so the drain loop ticks it (everything
		// else hitchhikes that tick).
		$router = new Router_Node();
		$router->name( '_router' );
		$router->set_timer( Router_Node::DEFAULT_TICK_MS );
		$this->assertSame( 'event_framework', $this->mode_of( $router ) );
		$router->stop_timer();
	}

	public function test_no_ms_hitchhike_fires_every_tick_without_throttle(): void {
		$router = new Router_Node();
		$router->name( '_router' );
		$router->interval_ms = 1000;
		$timer = new Timer_Node();
		$timer->name( 'every-tick' );
		$capture = new Capture_Sink_Node();
		$timer->sink( $capture );
		$timer->set_timer();

		Core::$now = 1.0;
		$timer->fire_cb();
		Core::$now = 1.1;
		$timer->fire_cb();
		Core::$now = 1.2;
		$timer->fire_cb();

		$this->assertCount( 3, $capture->captured );
		$timer->stop_timer();
	}

	public function test_oneshot_goes_inactive_after_one_fire(): void {
		$timer = new Timer_Node();
		$timer->name( 't' );
		$capture = new Capture_Sink_Node();
		$timer->sink( $capture );
		$timer->set_timer( 100, true );
		$timer->fire_cb();
		$this->assertSame( 'inactive', $this->mode_of( $timer ) );
		$this->assertSame( 1, $timer->counter() );
	}

	public function test_fire_increments_counter_on_emit(): void {
		// Perl Timer::fire does $self->{counter}++ inside the owner/CI guard.
		$timer = new Timer_Node();
		$timer->name( 't' );
		$capture = new Capture_Sink_Node(); // non-CI sink → guard passes → emit
		$timer->sink( $capture );
		$timer->fire_cb();
		$this->assertSame( 1, $timer->counter() );
	}

	public function test_fire_skips_emit_for_interpreter_sink_without_target(): void {
		// Perl owner/CI guard: a target-less Timer whose sink IS the
		// CommandInterpreter does NOT emit (it would just spam the interpreter).
		$interpreter = new class extends \Newspack_Nodes\Command_Interpreter_Node {
			/** @var array<int,array> */
			public array $filled = [];
			public function fill( array &$message ): void {
				$this->filled[] = $message;
			}
		};
		$timer = new Timer_Node();
		$timer->name( 't' );
		$timer->sink( $interpreter );
		$timer->fire_cb();
		$this->assertCount( 0, $interpreter->filled );
		$this->assertSame( 0, $timer->counter() );
	}

	// ── inherited Node::fill passthrough (Timer no longer overrides fill) ──────

	public function test_non_timer_message_forwards_without_firing(): void {
		$timer = new Timer_Node();
		$timer->name( 't' );
		$capture = new Capture_Sink_Node();
		$timer->sink( $capture );
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::VALUE ] = 'data';
		$timer->fill( $message );
		$this->assertCount( 1, $capture->captured );
		$this->assertSame( 1, $timer->counter() );
	}

	public function test_timer_info_message_forwards_and_does_not_fire(): void {
		// A TM_INFO/KEY=TIMER message is no longer intercepted by fill() — Timer
		// inherits Node::fill (forward to sink). TIMER fires only via the Router's
		// direct fire_cb dispatch, never through a routed message.
		$timer = new Timer_Node();
		$timer->name( 't' );
		$capture = new Capture_Sink_Node();
		$timer->sink( $capture );
		$message                  = Message::new_message();
		$message[ Message::TYPE ] = Message::TM_INFO;
		$message[ Message::KEY ]  = 'TIMER';
		$timer->fill( $message );
		$this->assertCount( 1, $capture->captured );
		$this->assertSame( 1, $timer->counter() );
	}

	public function test_node_schema_declares_FIRE_as_a_registration_event(): void {
		$this->assertSame(
			[ 'FIRE' ],
			Timer_Node::node_schema()['registrations']
		);
	}

	public function test_register_seeds_valid_events_from_schema_and_rejects_unknown(): void {
		$timer = new Timer_Node();
		// FIRE comes from node_schema (seeded in the ctor) — register accepts it.
		$timer->register( 'FIRE', 'lst' );
		$this->assertArrayHasKey( 'FIRE', $timer->registered_listeners() );
		// An undeclared event is rejected (Tachikoma "no such event").
		$threw = false;
		try {
			$timer->register( 'NOPE', 'x' );
		} catch ( \RuntimeException $e ) {
			$threw = true;
		}
		$this->assertTrue( $threw, 'an undeclared event is rejected' );
	}
}
