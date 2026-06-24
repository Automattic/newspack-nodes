<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\Tap_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Tap_Node::class )]
class TapTest extends TestCase {
	public function test_path_shaped_target_with_live_head_survives_fill(): void {
		// A path-shaped target like `alive/workers` (only `alive` is registered)
		// must survive the prune: the HEAD node is live, so the sink can route it.
		$router = new Router_Node();
		$router->name( '_router' );

		$alive = new Capture_Sink_Node();
		$alive->name( 'alive' );

		$tap = new Tap_Node();
		$tap->name( 'tap' );
		$tap->sink( $router );
		$tap->connect_node( 'alive/workers' );

		$message = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::VALUE ] = 'data';
		$tap->fill( $message );

		$this->assertSame( [ 'alive/workers' ], \array_values( $tap->target() ) );
	}

	public function test_path_shaped_target_with_dead_head_is_pruned(): void {
		// A path-shaped target whose HEAD node is not registered gets pruned.
		$router = new Router_Node();
		$router->name( '_router' );

		$tap = new Tap_Node();
		$tap->name( 'tap' );
		$tap->sink( $router );
		$tap->connect_node( 'gone/workers' );

		$message = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::VALUE ] = 'data';
		$tap->fill( $message );

		$this->assertSame( [], \array_values( $tap->target() ) );
	}

	public function test_passthrough_still_forwards_to_sink(): void {
		// Tap's defining behavior: after fanning out, the original message passes
		// through unchanged to the sink.
		$router = new Router_Node();
		$router->name( '_router' );

		$sink = new Capture_Sink_Node();
		$tap  = new Tap_Node();
		$tap->name( 'tap' );
		$tap->sink( $sink );

		$message = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::VALUE ] = 'data';
		$tap->fill( $message );

		$this->assertCount( 1, $sink->captured );
		$this->assertSame( 'data', $sink->captured[0][ Message::VALUE ] );
	}
}
