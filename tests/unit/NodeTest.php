<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Node;
use Newspack_Nodes\Tests\CaptureSink;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Node::class )]
class NodeTest extends TestCase {
	public function test_name_set_and_get(): void {
		$n = new CaptureSink();
		$n->name( 'alice' );
		$this->assertSame( 'alice', $n->name() );
		$this->assertSame( $n, Core::node( 'alice' ) );
	}

	public function test_rename_updates_registry(): void {
		$n = new CaptureSink();
		$n->name( 'alice' );
		$n->name( 'bob' );
		$this->assertNull( Core::node( 'alice' ) );
		$this->assertSame( $n, Core::node( 'bob' ) );
	}

	public function test_rename_collision_throws(): void {
		$n1 = new CaptureSink();
		$n1->name( 'alice' );
		$n2 = new CaptureSink();
		$this->expectException( \RuntimeException::class );
		$n2->name( 'alice' );
	}

	public function test_sink_set_and_get(): void {
		$src = new CaptureSink();
		$dst = new CaptureSink();
		$src->sink( $dst );
		$this->assertSame( $dst, $src->sink() );
	}

	public function test_target_set_and_get(): void {
		$n = new CaptureSink();
		$n->target( 'next-node' );
		$this->assertSame( 'next-node', $n->target() );
	}

	public function test_fill_increments_counter_before_dispatch(): void {
		$n   = new CaptureSink();
		$msg = Message::new_message();
		$n->fill( $msg );
		$this->assertSame( 1, $n->counter() );
	}

	public function test_default_fill_forwards_to_sink(): void {
		$src = new class extends Node {}; // default fill() forwards
		$dst = new CaptureSink();
		$src->sink( $dst );

		$msg                       = Message::new_message();
		$msg[ Message::VALUE ]     = 'payload';
		$src->fill( $msg );

		$this->assertCount( 1, $dst->captured );
		$this->assertSame( 'payload', $dst->captured[0][ Message::VALUE ] );
	}

	public function test_stamp_message_sets_from_when_empty(): void {
		$n = new CaptureSink();
		$n->name( 'alice' );
		$msg = Message::new_message();
		$this->assertTrue( $n->stamp_message( $msg, 'alice' ) );
		$this->assertSame( 'alice', $msg[ Message::FROM ] );
	}

	public function test_stamp_message_prepends_to_existing_from(): void {
		$n = new CaptureSink();
		$n->name( 'bob' );
		$msg                     = Message::new_message();
		$msg[ Message::FROM ]    = 'alice';
		$this->assertTrue( $n->stamp_message( $msg, 'bob' ) );
		$this->assertSame( 'bob/alice', $msg[ Message::FROM ] );
	}

	public function test_stamp_message_drops_if_FROM_exceeds_MAX_FROM_SIZE(): void {
		$n = new CaptureSink();
		$n->name( 'x' );
		$msg                  = Message::new_message();
		$msg[ Message::FROM ] = \str_repeat( 'a/', 600 ); // ~1200 chars
		$this->assertFalse( $n->stamp_message( $msg, 'x' ) );
	}

	public function test_drop_message_format(): void {
		$buf = '';
		Core::set_stderr_handler( function ( $m ) use ( &$buf ) { $buf .= $m; } );
		$n   = new CaptureSink();
		$n->name( 'alice' );
		$msg                     = Message::new_message();
		$msg[ Message::TYPE ]    = Message::TM_INFO;
		$msg[ Message::FROM ]    = 'producer';
		$msg[ Message::TO ]      = 'consumer';
		$msg[ Message::VALUE ]   = 'data';
		$n->drop_message( $msg, 'BAD_INPUT' );
		$this->assertStringContainsString( 'WARNING: BAD_INPUT', $buf );
		$this->assertStringContainsString( 'TM_INFO', $buf );
		$this->assertStringContainsString( 'from: producer', $buf );
		$this->assertStringContainsString( 'to: consumer', $buf );
		$this->assertStringContainsString( 'payload: data', $buf );
	}

	public function test_drop_message_uses_bitwise_test_for_combined_flags(): void {
		$buf = '';
		Core::set_stderr_handler( function ( $m ) use ( &$buf ) { $buf .= $m; } );
		$n   = new CaptureSink();
		$n->name( 'alice' );
		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_INFO | Message::TM_PERSIST;
		$msg[ Message::VALUE ] = 'should-show';
		$n->drop_message( $msg, 'X' );
		$this->assertStringContainsString( 'payload: should-show', $buf );
	}

	public function test_answer_silent_when_no_FROM(): void {
		$n   = new CaptureSink();
		$n->name( 'alice' );
		$dst = new CaptureSink();
		$dst->name( '_router' ); // Where answer/cancel get filled
		$n->sink( $dst );

		$msg = Message::new_message();
		$msg[ Message::TYPE ] = Message::TM_PERSIST;
		// No FROM set
		$n->answer( $msg );

		$this->assertCount( 0, $dst->captured, 'answer must be silently dropped when FROM is empty' );
	}

	public function test_cancel_silent_when_no_FROM(): void {
		$n   = new CaptureSink();
		$n->name( 'alice' );
		$dst = new CaptureSink();
		$dst->name( '_router' );
		$n->sink( $dst );

		$msg = Message::new_message();
		$msg[ Message::TYPE ] = Message::TM_PERSIST;
		$n->cancel( $msg );

		$this->assertCount( 0, $dst->captured );
	}

	public function test_answer_sends_TM_PERSIST_TM_RESPONSE_to_FROM(): void {
		$n = new CaptureSink();
		$n->name( 'alice' );
		$router = new CaptureSink();
		$router->name( '_router' );
		$n->sink( $router );

		$msg                  = Message::new_message();
		$msg[ Message::TYPE ] = Message::TM_PERSIST;
		$msg[ Message::FROM ] = 'producer';
		$msg[ Message::ID ]   = '123';
		$n->answer( $msg );

		$this->assertCount( 1, $router->captured );
		$response = $router->captured[0];
		$this->assertSame( Message::TM_PERSIST | Message::TM_RESPONSE, $response[ Message::TYPE ] );
		$this->assertSame( 'producer', $response[ Message::TO ] );
		$this->assertSame( '123',      $response[ Message::ID ] );
		$this->assertSame( 'answer',   $response[ Message::VALUE ] );
	}

	public function test_cancel_sends_payload_cancel(): void {
		$n = new CaptureSink();
		$n->name( 'alice' );
		$router = new CaptureSink();
		$router->name( '_router' );
		$n->sink( $router );

		$msg                  = Message::new_message();
		$msg[ Message::TYPE ] = Message::TM_PERSIST;
		$msg[ Message::FROM ] = 'producer';
		$n->cancel( $msg );

		$this->assertSame( 'cancel', $router->captured[0][ Message::VALUE ] );
	}

	public function test_register_throws_on_undeclared_event(): void {
		$n = new class extends Node {};
		$n->name( 'p' );
		$this->expectException( \RuntimeException::class );
		$n->register( 'NEVER', 'listener' );
	}

	public function test_register_and_notify_with_closure_listener(): void {
		$n = new class extends Node {
			public function __construct() {
				$this->registrations = [ 'PING' => [] ];
			}
		};
		$n->name( 'p' );
		$received = null;
		$n->register( 'PING', 'cb', function ( $payload ) use ( &$received ) { $received = $payload; } );
		$n->notify( 'PING', 'hello' );
		$this->assertSame( 'hello', $received );
	}

	public function test_register_replays_cached_state_to_late_subscribers(): void {
		$n = new class extends Node {
			public function __construct() {
				$this->registrations = [ 'READY' => [] ];
			}
		};
		$n->name( 'p' );
		$n->set_state( 'READY', 'now-ready' );

		$received = null;
		$n->register( 'READY', 'late', function ( $payload ) use ( &$received ) { $received = $payload; } );
		$this->assertSame( 'now-ready', $received );
	}

	public function test_notify_dispatches_to_node_name_via_TM_INFO(): void {
		$n = new class extends Node {
			public function __construct() {
				$this->registrations = [ 'EVT' => [] ];
			}
		};
		$n->name( 'p' );
		$listener = new CaptureSink();
		$listener->name( 'l' );
		$n->register( 'EVT', 'l' );
		$n->notify( 'EVT', 'payload-x' );

		$this->assertCount( 1, $listener->captured );
		$msg = $listener->captured[0];
		$this->assertSame( Message::TM_INFO, $msg[ Message::TYPE ] );
		$this->assertSame( 'EVT', $msg[ Message::KEY ] );
		$this->assertSame( 'payload-x', $msg[ Message::VALUE ] );
	}

	public function test_unregister_removes_listener(): void {
		$n = new class extends Node {
			public function __construct() {
				$this->registrations = [ 'EVT' => [] ];
			}
		};
		$n->name( 'p' );
		$received = 0;
		$n->register( 'EVT', 'cb', function () use ( &$received ) { ++$received; } );
		$n->notify( 'EVT', null );
		$n->unregister( 'EVT', 'cb' );
		$n->notify( 'EVT', null );
		$this->assertSame( 1, $received );
	}

	public function test_closure_falsy_return_unregisters(): void {
		$n = new class extends Node {
			public function __construct() {
				$this->registrations = [ 'EVT' => [] ];
			}
		};
		$n->name( 'p' );
		$count = 0;
		$n->register( 'EVT', 'once', function () use ( &$count ) { ++$count; return false; } );
		$n->notify( 'EVT', null );
		$n->notify( 'EVT', null );
		$this->assertSame( 1, $count, 'Returning falsy single-shots the registration' );
	}

	public function test_connect_node_sets_owner(): void {
		$n = new CaptureSink();
		$n->name( 'src' );
		$n->connect_node( 'dst' );
		$this->assertSame( 'dst', $n->target() );
	}

	public function test_disconnect_node_clears_owner(): void {
		$n = new CaptureSink();
		$n->name( 'src' );
		$n->connect_node( 'dst' );
		$n->disconnect_node();
		$this->assertSame( '', $n->target() );
	}

	public function test_remove_node_unregisters_and_clears_state(): void {
		$n = new CaptureSink();
		$n->name( 'alice' );
		$dst = new CaptureSink();
		$n->sink( $dst );
		$n->connect_node( 'someone' );

		$n->remove_node();

		$this->assertNull( Core::node( 'alice' ) );
		$this->assertSame( '', $n->name() );
		$this->assertNull( $n->sink() );
		$this->assertSame( '', $n->target() );
	}

	public function test_dump_config_emits_make_node(): void {
		$n = new CaptureSink();
		$n->name( 'alice' );
		$out = $n->dump_config();
		$this->assertStringContainsString( "make_node CaptureSink alice", $out );
	}

	public function test_dump_config_suppresses_set_sink_for_default_command_interpreter_sink(): void {
		$ci = new CaptureSink();
		$ci->name( '_command_interpreter' );
		$n  = new CaptureSink();
		$n->name( 'alice' );
		$n->sink( $ci );

		$out = $n->dump_config();
		$this->assertStringNotContainsString( 'set_sink', $out );
	}

	public function test_dump_config_emits_set_sink_when_sink_overridden(): void {
		$other = new CaptureSink();
		$other->name( 'other' );
		$n     = new CaptureSink();
		$n->name( 'alice' );
		$n->sink( $other );

		$out = $n->dump_config();
		$this->assertStringContainsString( 'set_sink alice other', $out );
	}

	public function test_dump_config_emits_connect_node(): void {
		$n = new CaptureSink();
		$n->name( 'alice' );
		$n->connect_node( 'bob' );
		$out = $n->dump_config();
		$this->assertStringContainsString( 'connect_node alice bob', $out );
	}
}
