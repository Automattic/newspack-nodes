<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;

#[CoversClass( Router_Node::class )]
class RouterTest extends TestCase {
	public function test_routes_to_named_target_and_strips_first_segment(): void {
		$router = new Router_Node();
		$router->name( '_router' );

		$dst = new Capture_Sink_Node();
		$dst->name( 'alice' );

		$message                = Message::new_message();
		$message[ Message::TO ] = 'alice/some/path';

		$router->fill( $message );

		$this->assertCount( 1, $dst->captured );
		$this->assertSame( 'some/path', $dst->captured[0][ Message::TO ] );
	}

	public function test_empty_TO_is_dropped_as_message_not_addressed(): void {
		// Perl Router::fill drops an unaddressed (empty TO) message before routing —
		// no NOT_AVAILABLE bounce back to FROM.
		$router = new Router_Node();
		$router->name( '_router' );
		$producer = new Capture_Sink_Node();
		$producer->name( 'producer' );

		$message                  = Message::new_message(); // TO=''
		$message[ Message::FROM ] = 'producer';
		$router->fill( $message );

		$this->assertCount( 0, $producer->captured );
	}

	public function test_oversized_FROM_is_dropped_before_routing(): void {
		// Perl Router::fill drops a message whose FROM trail exceeded MAX_FROM_SIZE
		// (path explosion on a routing cycle) before peeling the TO head.
		$router = new Router_Node();
		$router->name( '_router' );
		$dst = new Capture_Sink_Node();
		$dst->name( 'alice' );

		$message                  = Message::new_message();
		$message[ Message::TO ]   = 'alice';
		$message[ Message::FROM ] = \str_repeat( 'x', Router_Node::MAX_FROM_SIZE + 1 );
		$router->fill( $message );

		$this->assertCount( 0, $dst->captured );
	}

	public function test_unknown_target_sends_NOT_AVAILABLE_error(): void {
		$router = new Router_Node();
		$router->name( '_router' );
		$producer = new Capture_Sink_Node();
		$producer->name( 'producer' );

		$message                  = Message::new_message();
		$message[ Message::TO ]   = 'nonexistent';
		$message[ Message::FROM ] = 'producer';
		$message[ Message::ID ]   = 'req-1';

		$router->fill( $message );

		// Per spec: error re-enters TO-routing and walks the FROM trail. Router strips
		// 'producer' off the TO head when re-dispatching, leaving TO='' when the producer
		// finally captures it. The error's FROM is the unreachable destination
		// (Tachikoma: $err[FROM] = $message[TO]), here 'nonexistent'.
		$this->assertCount( 1, $producer->captured );
		$err = $producer->captured[0];
		$this->assertSame( Message::TM_ERROR, $err[ Message::TYPE ] );
		$this->assertSame( "NOT_AVAILABLE\n", $err[ Message::VALUE ] );
		$this->assertSame( '', $err[ Message::TO ] );
		$this->assertSame( 'nonexistent', $err[ Message::FROM ] );
	}

	/**
	 * A non-scalar TO is NOT_AVAILABLE, not "unaddressed". The empty-TO guard
	 * compares the RAW value, so an array TO falls through it, coerces to '',
	 * and finds no node. Coercing BEFORE that guard — the tempting shape when
	 * the coercion was inlined for speed — silently reclassifies it as a drop,
	 * and the producer stops being told its destination did not resolve.
	 */
	public function test_a_non_scalar_to_is_unavailable_not_unaddressed(): void {
		$router = new Router_Node();
		$router->name( '_router' );
		$producer = new Capture_Sink_Node();
		$producer->name( 'producer' );

		$message                  = Message::new_message();
		$message[ Message::TO ]   = [ 'not', 'a', 'path' ];
		$message[ Message::FROM ] = 'producer';

		$router->fill( $message );

		$this->assertCount( 1, $producer->captured );
		$this->assertSame( Message::TM_ERROR, $producer->captured[0][ Message::TYPE ] );
		$this->assertSame( "NOT_AVAILABLE\n", $producer->captured[0][ Message::VALUE ] );
	}

	/** A multi-segment TO peels exactly one head and keeps the rest intact. */
	public function test_routing_peels_one_segment_and_preserves_the_remainder(): void {
		$router = new Router_Node();
		$router->name( '_router' );
		$hop = new Capture_Sink_Node();
		$hop->name( 'first' );

		$message                = Message::new_message();
		$message[ Message::TO ] = 'first/second/third';

		$router->fill( $message );

		$this->assertCount( 1, $hop->captured );
		$this->assertSame( 'second/third', $hop->captured[0][ Message::TO ] );
	}

	/**
	 * A SCALAR FROM coerces for the MAX_FROM_SIZE check — the case the fast
	 * path's fallback exists for. (An array FROM is a contract violation, not
	 * a coercion case; see the note on Core::as_string in fill().)
	 */
	public function test_a_scalar_from_is_coerced_for_the_length_guard(): void {
		$router = new Router_Node();
		$router->name( '_router' );
		$dst = new Capture_Sink_Node();
		$dst->name( 'dst' );

		$message                  = Message::new_message();
		$message[ Message::TO ]   = 'dst';
		$message[ Message::FROM ] = 4;

		$router->fill( $message );

		$this->assertCount( 1, $dst->captured );
	}

	/**
	 * TO = int 0 is a real address, not "unaddressed". `'' === 0` is false under
	 * strict comparison, so it survives the empty guard, coerces to '0', and
	 * routes to a node named '0'. Any guard here written as `empty()` or `! $to`
	 * would swallow it — `'0'` is PHP-falsy.
	 */
	public function test_integer_zero_TO_routes_to_the_node_named_zero(): void {
		$router = new Router_Node();
		$router->name( '_router' );
		$zero = new Capture_Sink_Node();
		$zero->name( '0' );

		$message                = Message::new_message();
		$message[ Message::TO ] = 0;

		$router->fill( $message );

		$this->assertCount( 1, $zero->captured );
	}

	/**
	 * FROM = int 0 survives the MAX_FROM_SIZE guard and still counts as a
	 * reply-able origin, so an unroutable message bounces NOT_AVAILABLE back to
	 * it. `Core::has_value()` is strict for exactly this reason; `empty('0')` is
	 * true and would silently swallow the error.
	 */
	public function test_integer_zero_FROM_still_receives_the_error_bounce(): void {
		$router = new Router_Node();
		$router->name( '_router' );
		$origin = new Capture_Sink_Node();
		$origin->name( '0' );

		$message                  = Message::new_message();
		$message[ Message::TO ]   = 'nonexistent';
		$message[ Message::FROM ] = 0;

		$router->fill( $message );

		$this->assertCount( 1, $origin->captured );
		$this->assertSame( Message::TM_ERROR, $origin->captured[0][ Message::TYPE ] );
	}

	public function test_send_error_caches_unreachable_node_name_in_NOT_AVAILABLE_state(): void {
		// send_error() caches a NOT_AVAILABLE state whose `node` field is the
		// unreachable destination peeled off TO. The name lives in fill(); a
		// regression once referenced an undefined $node_name in send_error(),
		// emitting an "Undefined variable" warning and caching node => null.
		$router = new Router_Node();
		$router->name( '_router' );

		$message                  = Message::new_message();
		$message[ Message::TO ]   = 'nonexistent';
		$message[ Message::FROM ] = 'producer';

		$router->fill( $message );

		$ref = new \ReflectionProperty( $router, 'set_state' );
		$state = $ref->getValue( $router );
		// The NOT_AVAILABLE payload is now a flat string; the unreachable node name leads it.
		$this->assertIsString( $state['NOT_AVAILABLE'] );
		$this->assertStringContainsString( 'nonexistent', $state['NOT_AVAILABLE'] );
	}

	public function test_send_error_NOT_AVAILABLE_state_is_flat_key_value_string(): void {
		// Pins the exact flat "KEY VALUE ..." NOT_AVAILABLE state payload so the
		// scalar->string rendering of every field stays byte-stable.
		$router = new Router_Node();
		$router->name( '_router' );

		$message                  = Message::new_message();
		$message[ Message::TYPE ] = Message::TM_INFO;
		$message[ Message::TO ]   = 'ghost/sub';
		$message[ Message::FROM ] = 'producer';
		$message[ Message::ID ]   = 'req1';
		$message[ Message::KEY ]  = 'ev';

		$router->fill( $message );

		$ref   = new \ReflectionProperty( $router, 'set_state' );
		$state = $ref->getValue( $router );
		$this->assertSame(
			'NODE ghost TYPE 64 FROM producer TO ghost/sub ID req1 KEY ev',
			$state['NOT_AVAILABLE']
		);
	}

	public function test_unknown_target_drops_TM_ERROR_messages_silently(): void {
		// Don't bounce errors-on-errors: a TM_ERROR to an unknown target is dropped,
		// not walked back to FROM. (Verified via the FROM node, since the Router
		// has no sink.)
		$router = new Router_Node();
		$router->name( '_router' );
		$origin = new Capture_Sink_Node();
		$origin->name( 'someone' );

		$message                  = Message::new_message();
		$message[ Message::TYPE ] = Message::TM_ERROR;
		$message[ Message::TO ]   = 'gone';
		$message[ Message::FROM ] = 'someone';

		$router->fill( $message );
		$this->assertCount( 0, $origin->captured );
	}

	public function test_router_getter_returns_null_sink(): void {
		$router = new Router_Node();
		$router->name( '_router' );
		$this->assertNull( $router->sink() );
	}

	public function test_setting_a_sink_throws(): void {
		// The Router routes by peeling TO and drops what it cannot peel — it must
		// never have a sink.
		$router = new Router_Node();
		$router->name( '_router' );
		$this->expectException( \InvalidArgumentException::class );
		$router->sink( new Capture_Sink_Node() );
	}
	/**
	 * A command surface nobody has declared a policy for is worth saying so,
	 * every tick, until someone declares. A graph-only process (secure_level
	 * null — no interpreter was ever named) has no policy to declare and must
	 * stay quiet, or every `wp nodes ingest` run would nag.
	 */
	public function test_an_undeclared_command_surface_warns_on_tick(): void {
		$buf = '';
		Core::set_stderr_handler( function ( $m ) use ( &$buf ) { $buf .= $m; } );
		Core::$secure_level = 0;
		$router = new Router_Node();
		$router->name( '_router' );

		$router->fire_cb();

		$this->assertStringContainsString( 'no secure level declared', $buf );
	}

	public function test_a_graph_only_process_never_warns(): void {
		$buf = '';
		Core::set_stderr_handler( function ( $m ) use ( &$buf ) { $buf .= $m; } );
		Core::$secure_level = null;
		$router = new Router_Node();
		$router->name( '_router' );

		$router->fire_cb();

		$this->assertStringNotContainsString( 'secure level', $buf );
	}

	public function test_a_declared_level_stops_the_warning(): void {
		$buf = '';
		Core::set_stderr_handler( function ( $m ) use ( &$buf ) { $buf .= $m; } );
		Core::$secure_level = -1;
		$router = new Router_Node();
		$router->name( '_router' );

		$router->fire_cb();

		$this->assertStringNotContainsString( 'secure level', $buf );
	}

}
