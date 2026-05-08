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

	public function test_persist_aggregation_answers_when_all_targets_answer(): void {
		$router = new Router();
		$router->name( '_router' );

		$producer = new CaptureSink();
		$producer->name( 'producer' );
		$router->sink( $producer );

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
		$msg[ Message::TYPE ] = Message::TM_PERSIST;
		$msg[ Message::FROM ] = 'producer';
		$msg[ Message::ID ]   = 'msg-1';
		$tee->fill( $msg );

		$this->assertCount( 0, $producer->captured );

		$a_resp = Message::new_message();
		$a_resp[ Message::TYPE ]  = Message::TM_PERSIST | Message::TM_RESPONSE;
		$a_resp[ Message::ID ]    = 'msg-1';
		$a_resp[ Message::VALUE ] = 'answer';
		$tee->fill( $a_resp );
		$this->assertCount( 0, $producer->captured, 'still waiting on b' );

		$b_resp = Message::new_message();
		$b_resp[ Message::TYPE ]  = Message::TM_PERSIST | Message::TM_RESPONSE;
		$b_resp[ Message::ID ]    = 'msg-1';
		$b_resp[ Message::VALUE ] = 'answer';
		$tee->fill( $b_resp );

		$this->assertCount( 1, $producer->captured );
		$this->assertSame( 'answer', $producer->captured[0][ Message::VALUE ] );
	}

	public function test_persist_aggregation_cancel_dominates(): void {
		$router = new Router();
		$router->name( '_router' );
		$producer = new CaptureSink();
		$producer->name( 'producer' );
		$router->sink( $producer );

		$a = new CaptureSink(); $a->name( 'a' );
		$b = new CaptureSink(); $b->name( 'b' );

		$tee = new Tee();
		$tee->name( 'tee' );
		$tee->sink( $router );
		$tee->connect_node( 'a' );
		$tee->connect_node( 'b' );

		$msg = Message::new_message();
		$msg[ Message::TYPE ] = Message::TM_PERSIST;
		$msg[ Message::FROM ] = 'producer';
		$msg[ Message::ID ]   = 'msg-1';
		$tee->fill( $msg );

		$cancel = Message::new_message();
		$cancel[ Message::TYPE ]  = Message::TM_PERSIST | Message::TM_RESPONSE;
		$cancel[ Message::ID ]    = 'msg-1';
		$cancel[ Message::VALUE ] = 'cancel';
		$tee->fill( $cancel );

		$this->assertCount( 1, $producer->captured );
		$this->assertSame( 'cancel', $producer->captured[0][ Message::VALUE ] );
	}
}
