<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
use Newspack_Nodes\Event_Framework;
use Newspack_Nodes\Message;
use Newspack_Nodes\Tests\CaptureSink;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Timer_Node;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Timer_Node::class )]
class TimerTest extends TestCase {
	protected function setUp(): void {
		parent::setUp();
		Event_Framework::reset();
	}

	public function test_set_timer_with_ms_registers_with_event_framework(): void {
		$timer = new Timer_Node();
		$timer->name( 't1' );
		$timer->set_timer( 50 );

		$start = \microtime( true );
		Event_Framework::instance()->drain( function () use ( $start ) {
			Core::$now = \microtime(true);
			return ( \microtime( true ) - $start ) < 0.15;
		} );
		$this->assertGreaterThan( 0, $timer->fire_count() );
	}

	public function test_fire_cb_dispatches_FIRE_event(): void {
		$timer = new Timer_Node();
		$timer->name( 't1' );

		$received = null;
		$timer->register( 'FIRE', 'cb', function ( $payload ) use ( &$received ) {
			$received = $payload;
		} );

		$timer->fire_cb();
		$this->assertNotNull( $received );
	}

	public function test_fire_cb_sends_TM_BYTESTREAM_to_sink(): void {
		$timer = new Timer_Node();
		$timer->name( 't1' );
		$sink = new CaptureSink();
		$timer->sink( $sink );

		$timer->fire_cb();
		$this->assertCount( 1, $sink->captured );
		$this->assertSame( Message::TM_BYTESTREAM, $sink->captured[0][ Message::TYPE ] );
	}

	public function test_oneshot_clears_active_state(): void {
		$timer = new Timer_Node();
		$timer->name( 't1' );
		$timer->set_timer( 10, true );

		$start = \microtime( true );
		Event_Framework::instance()->drain( function () use ( $start ) {
			Core::$now = \microtime(true);
			return ( \microtime( true ) - $start ) < 0.1;
		} );
		$this->assertSame( 1, $timer->fire_count() );
		$this->assertFalse( $timer->is_active() );
	}
}
