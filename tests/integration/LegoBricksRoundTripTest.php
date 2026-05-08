<?php
namespace Newspack_Nodes\Tests\Integration;

use Newspack_Nodes\Callback;
use Newspack_Nodes\Hook;
use Newspack_Nodes\Message;
use Newspack_Nodes\Router;
use Newspack_Nodes\Tee;
use Newspack_Nodes\Tests\CaptureSink;
use Newspack_Nodes\Tests\TestCase;

class LegoBricksRoundTripTest extends TestCase {
	protected function setUp(): void {
		parent::setUp();
		$GLOBALS['_wp_actions'] = [];
	}

	public function test_tee_fans_to_hook_then_capture(): void {
		$router = new Router();
		$router->name( '_router' );

		$tee = new Tee();
		$tee->name( 'fanout' );
		$tee->sink( $router );

		$hook = new Hook( 'newspack_nodes/test_event' );
		$hook->name( 'on-event' );
		$hook_sink = new CaptureSink();
		$hook->sink( $hook_sink );

		$direct = new CaptureSink();
		$direct->name( 'direct' );

		$tee->connect_node( 'on-event' );
		$tee->connect_node( 'direct' );

		$action_fired = false;
		\add_action( 'newspack_nodes/test_event', function () use ( &$action_fired ) {
			$action_fired = true;
		} );

		$msg = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$msg[ Message::VALUE ] = 'broadcast';
		$tee->fill( $msg );

		$this->assertTrue( $action_fired );
		$this->assertCount( 1, $direct->captured );
		$this->assertCount( 1, $hook_sink->captured );
		$this->assertSame( 'broadcast', $direct->captured[0][ Message::VALUE ] );
	}

	public function test_callback_can_filter_in_a_chain(): void {
		$capture = new CaptureSink();
		$transformer = new Callback( function ( array &$m ) {
			$m[ Message::VALUE ] = 'X-' . $m[ Message::VALUE ];
		} );
		$transformer->sink( $capture );

		$chain = new Callback( function ( array &$m ) use ( $transformer ) {
			$transformer->fill( $m );
			$transformer->sink()->fill( $m );
		} );

		$msg = Message::new_message();
		$msg[ Message::VALUE ] = 'hello';
		$chain->fill( $msg );

		$this->assertCount( 1, $capture->captured );
		$this->assertSame( 'X-hello', $capture->captured[0][ Message::VALUE ] );
	}
}
