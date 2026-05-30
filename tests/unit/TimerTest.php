<?php
namespace Newspack_Nodes\Tests\Unit;

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
 * own-slot lifecycle, the fire() message shape + null-sink guard, oneshot,
 * and the non-TIMER fill() passthrough.
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
		$timer->arguments( 'fast' );
	}

	// ── key stamping + fire() message shape ───────────────────────────────────

	public function test_set_key_round_trips(): void {
		$timer = new Timer_Node();
		$this->assertSame( '', $timer->key() );
		$timer->set_key( 'tick' );
		$this->assertSame( 'tick', $timer->key() );
	}

	public function test_fire_stamps_key_and_bytestream_timestamp(): void {
		$timer = new Timer_Node();
		$timer->name( 'k' );
		$timer->set_key( 'heartbeat' );
		$capture = new Capture_Sink_Node();
		$timer->sink( $capture );
		$timer->fire_cb();
		$this->assertCount( 1, $capture->captured );
		$msg = $capture->captured[0];
		$this->assertSame( 'heartbeat', $msg[ Message::KEY ] );
		$this->assertTrue( (bool) ( $msg[ Message::TYPE ] & Message::TM_BYTESTREAM ) );
		$this->assertIsString( $msg[ Message::VALUE ] );
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
		$timer->fire_cb();
		$this->assertSame( 1, $timer->fire_count() );
	}

	// ── lifecycle ──────────────────────────────────────────────────────────────

	public function test_set_timer_with_ms_enters_event_framework_and_stops_clean(): void {
		$timer = new Timer_Node();
		$timer->name( 't' );
		$this->assertFalse( $timer->is_active() );
		$timer->set_timer( 100 );
		$this->assertTrue( $timer->is_active() );
		$this->assertSame( 'event_framework', $this->mode_of( $timer ) );
		$timer->stop_timer();
		$this->assertFalse( $timer->is_active() );
		$this->assertSame( 'inactive', $this->mode_of( $timer ) );
	}

	public function test_stop_timer_on_inactive_is_a_noop(): void {
		$timer = new Timer_Node();
		$timer->name( 't' );
		$timer->stop_timer();
		$this->assertSame( 'inactive', $this->mode_of( $timer ) );
	}

	public function test_oneshot_goes_inactive_after_one_fire(): void {
		$timer = new Timer_Node();
		$timer->name( 't' );
		$capture = new Capture_Sink_Node();
		$timer->sink( $capture );
		$timer->set_timer( 100, true );
		$timer->fire_cb();
		$this->assertFalse( $timer->is_active() );
		$this->assertSame( 'inactive', $this->mode_of( $timer ) );
		$this->assertSame( 1, $timer->fire_count() );
	}

	// ── non-TIMER fill() passthrough ─────────────────────────────────────────

	public function test_non_timer_message_forwards_without_firing(): void {
		$timer = new Timer_Node();
		$timer->name( 't' );
		$capture = new Capture_Sink_Node();
		$timer->sink( $capture );
		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$msg[ Message::VALUE ] = 'data';
		$timer->fill( $msg );
		$this->assertCount( 1, $capture->captured );
		$this->assertSame( 0, $timer->fire_count() );
	}
}
