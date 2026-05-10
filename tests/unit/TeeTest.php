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

	public function test_persist_aggregation_cancels_when_all_targets_cancel(): void {
		// Mirrors real Tachikoma Tee::handle_response: `answer` and `cancel`
		// counters track separately, and whichever first reaches `count`
		// rolls up. All targets must cancel for the producer to see a cancel.
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

		// One cancel alone shouldn't trigger anything.
		$c1 = Message::new_message();
		$c1[ Message::TYPE ]  = Message::TM_PERSIST | Message::TM_RESPONSE;
		$c1[ Message::ID ]    = 'msg-1';
		$c1[ Message::VALUE ] = 'cancel';
		$tee->fill( $c1 );
		$this->assertCount( 0, $producer->captured, 'first cancel alone must not roll up' );

		// Second cancel completes the count → forward cancel.
		$c2 = Message::new_message();
		$c2[ Message::TYPE ]  = Message::TM_PERSIST | Message::TM_RESPONSE;
		$c2[ Message::ID ]    = 'msg-1';
		$c2[ Message::VALUE ] = 'cancel';
		$tee->fill( $c2 );

		$this->assertCount( 1, $producer->captured );
		$this->assertSame( 'cancel', $producer->captured[0][ Message::VALUE ] );
	}

	public function test_persist_aggregation_mixed_responses_forward_nothing(): void {
		// When responses split between answer and cancel and neither type reaches
		// `count`, Tee cleans up tracking after the last response and forwards
		// nothing. Producer's max_unanswered slot relies on its own timeout.
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

		$c = Message::new_message();
		$c[ Message::TYPE ]  = Message::TM_PERSIST | Message::TM_RESPONSE;
		$c[ Message::ID ]    = 'msg-1';
		$c[ Message::VALUE ] = 'cancel';
		$tee->fill( $c );

		$a_resp = Message::new_message();
		$a_resp[ Message::TYPE ]  = Message::TM_PERSIST | Message::TM_RESPONSE;
		$a_resp[ Message::ID ]    = 'msg-1';
		$a_resp[ Message::VALUE ] = 'answer';
		$tee->fill( $a_resp );

		$this->assertCount( 0, $producer->captured, 'mixed responses must not synthesize a verdict' );
	}
}
