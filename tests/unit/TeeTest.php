<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Router;
use Newspack_Nodes\Tee;
use Newspack_Nodes\Tests\CaptureSink;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Tee::class )]
class TeeTest extends TestCase {
	public function test_connect_node_appends_to_target_list(): void {
		$tee = new Tee();
		$tee->connect_node( 'a' );
		$tee->connect_node( 'b' );
		$this->assertSame( [ 'a', 'b' ], $tee->target() );
	}

	public function test_fill_dispatches_to_each_target(): void {
		$router = new Router();
		$router->name( '_router' );

		$a = new CaptureSink();
		$a->name( 'a' );
		$b = new CaptureSink();
		$b->name( 'b' );

		$tee = new Tee();
		$tee->name( 'tee' );
		$tee->sink( $router );
		$tee->connect_node( 'a' );
		$tee->connect_node( 'b' );

		$msg = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$msg[ Message::VALUE ] = 'fanout';
		$tee->fill( $msg );

		$this->assertCount( 1, $a->captured );
		$this->assertCount( 1, $b->captured );
		$this->assertSame( 'fanout', $a->captured[0][ Message::VALUE ] );
	}

	public function test_disconnect_node_removes_one_target(): void {
		$tee = new Tee();
		$tee->connect_node( 'a' );
		$tee->connect_node( 'b' );
		$tee->disconnect_node( 'a' );
		$this->assertSame( [ 'b' ], \array_values( $tee->target() ) );
	}

	public function test_dead_target_pruned_silently(): void {
		$router = new Router();
		$router->name( '_router' );

		$alive = new CaptureSink();
		$alive->name( 'alive' );

		$tee = new Tee();
		$tee->name( 'tee' );
		$tee->sink( $router );
		$tee->connect_node( 'alive' );
		$tee->connect_node( 'gone' );

		$msg = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$msg[ Message::VALUE ] = 'data';
		$tee->fill( $msg );

		$this->assertCount( 1, $alive->captured );
	}
}
