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
		$msg[ Message::TYPE ]  = Message::TM_INFO | Message::TM_RESPONSE;
		$msg[ Message::VALUE ] = 'should-show';
		$n->drop_message( $msg, 'X' );
		$this->assertStringContainsString( 'payload: should-show', $buf );
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

	public function test_debug_state_default_zero_no_trace_emitted(): void {
		// Baseline: with debug_state=0, set_state does NOT emit any trace to
		// _router (cli/SSE fan-out is silent until explicitly enabled).
		$router = new CaptureSink();
		$router->name( '_router' );

		$n = new class extends Node {
			public function __construct() {
				$this->registrations = [ 'READY' => [] ];
			}
		};
		$n->name( 'producer' );
		$this->assertSame( 0, $n->debug_state(), 'default off' );
		$n->set_state( 'READY', 'payload' );

		$this->assertCount( 0, $router->captured, 'no trace emitted at level 0' );
	}

	public function test_debug_state_level_1_emits_trace_to_repl_sse(): void {
		// Level 1: set_state fires the normal notify AND additionally emits
		// a TM_STRUCT trace addressed to _repl/sse so cli (with show_sse on)
		// and the SSE controller both see the transition.
		$router = new CaptureSink();
		$router->name( '_router' );

		$n = new class extends Node {
			public function __construct() {
				$this->registrations = [ 'READY' => [] ];
			}
		};
		$n->name( 'producer' );
		$n->debug_state( 1 );
		$n->set_state( 'READY', 'payload-x' );

		$this->assertCount( 1, $router->captured );
		$msg = $router->captured[0];
		$this->assertSame( Message::TM_STRUCT, $msg[ Message::TYPE ] );
		$this->assertSame( '_repl',             $msg[ Message::TO ] );
		$this->assertSame( 'producer',          $msg[ Message::FROM ] );

		$v = $msg[ Message::VALUE ];
		$this->assertIsArray( $v );
		$this->assertSame( 'debug_state', $v['k'] );
		$this->assertSame( 'producer',    $v['node'] );
		$this->assertSame( 'READY',       $v['event'] );
		$this->assertSame( 'payload-x',   $v['value'] );
		// `class` exposes the FQCN so dashboards / readers can render
		// subclass-specific metadata without reflecting on the node itself.
		$this->assertArrayHasKey( 'class', $v );
	}

	public function test_debug_state_silent_when_no_router_registered(): void {
		// Defensive: nodes constructed in isolation (unit tests, ad-hoc
		// scripts) often have no _router registered. set_state with
		// debug_state on must not crash — silent no-op for the trace path;
		// the normal notify still fires.
		$received = null;
		$n = new class extends Node {
			public function __construct() {
				$this->registrations = [ 'READY' => [] ];
			}
		};
		$n->name( 'producer' );
		$n->debug_state( 1 );
		$n->register( 'READY', 'subscriber', function ( $p ) use ( &$received ) { $received = $p; } );
		$n->set_state( 'READY', 'still-fires' );

		// notify still ran (state cache replays to the late subscriber);
		// no trace was emitted because _router isn't registered.
		$this->assertSame( 'still-fires', $received );
	}

	public function test_debug_state_clamps_to_non_negative(): void {
		// debug_state is always >= 0; negative values clamp to 0 (off).
		$n = new Node();
		$this->assertSame( 0, $n->debug_state(), 'default' );
		$this->assertSame( 2, $n->debug_state( 2 ) );
		$this->assertSame( 0, $n->debug_state( -1 ), 'negative clamps to 0' );
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
