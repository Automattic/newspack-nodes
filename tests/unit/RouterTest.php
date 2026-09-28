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

	/**
	 * Tachikoma's `send_error` ends with `$self->drop_message( $message, $error )`,
	 * so the message that failed to route always leaves an audit line — and
	 * because that call sits inside `if ( not TYPE & TM_ERROR )`, the bounce
	 * itself never does. Without it a route miss vanishes with nothing on
	 * stderr, which is the silent failure the substrate forbids.
	 */
	public function test_a_route_miss_leaves_an_audit_line(): void {
		$buf = '';
		Core::set_stderr_handler( function ( $m ) use ( &$buf ) { $buf .= $m; } );
		$router = new Router_Node();
		$router->name( '_router' );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_INFO;
		$message[ Message::TO ]    = 'sprocket';
		$message[ Message::FROM ]  = '';
		$message[ Message::VALUE ] = 'winding';

		$router->fill( $message );

		$this->assertStringContainsString( 'NOT_AVAILABLE - TM_INFO', $buf );
		// `to:` carries the whole path asked for. The head that did not
		// resolve rides the bounce's own FROM, where Tachikoma reads it.
		$this->assertStringContainsString( 'to: sprocket', $buf );
		$this->assertStringContainsString( 'payload: winding', $buf );
	}

	/**
	 * The bounce is a TM_ERROR, and Tachikoma's guard skips the whole body for
	 * one — no second bounce and no audit line. That guard is what keeps a
	 * route miss from logging its own reason back as a payload.
	 */
	public function test_an_undeliverable_bounce_is_silent(): void {
		$buf = '';
		Core::set_stderr_handler( function ( $m ) use ( &$buf ) { $buf .= $m; } );
		$router = new Router_Node();
		$router->name( '_router' );

		$bounce                   = Message::new_message();
		$bounce[ Message::TYPE ]  = Message::TM_ERROR;
		$bounce[ Message::TO ]    = 'sprocket';
		$bounce[ Message::FROM ]  = '_router';
		$bounce[ Message::VALUE ] = "NOT_AVAILABLE\n";

		$router->fill( $bounce );

		$this->assertStringNotContainsString( 'payload: NOT_AVAILABLE', $buf );
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
		// Tachikoma's own addressing: `$response->[FROM] = $message->[TO]`.
		// Nothing keys on the Router as the sender any more — `HTTP_Out` used
		// to, to tell a self-minted bounce from a forwarded error, and that
		// guard is gone because `send_error()` already refuses to answer one.
		$this->assertSame( 'nonexistent', $err[ Message::FROM ] );
	}

	public function test_a_noreply_command_no_node_answers_throws_and_bounces_nothing(): void {
		$router = new Router_Node();
		$router->name( '_router' );
		$producer = new Capture_Sink_Node();
		$producer->name( 'producer-8813' );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_NOREPLY;
		$message[ Message::TO ]    = 'absent-8813:config';
		$message[ Message::FROM ]  = 'producer-8813';
		$message[ Message::VALUE ] = [ 'name' => 'set_line_mode', 'arguments' => [ 'true' ] ];

		$e = $this->caught(
			fn () => $router->fill( $message ),
			'a TM_NOREPLY command no node answers must throw'
		);
		$this->assertStringContainsString( 'NOT_AVAILABLE', $e->getMessage() );
		$this->assertStringContainsString( 'absent-8813:config', $e->getMessage() );
		$this->assertStringContainsString( 'set_line_mode', $e->getMessage() );
		$this->assertCount( 0, $producer->captured, 'no reply was asked for' );
	}

	public function test_a_command_that_wants_a_reply_still_bounces(): void {
		$router = new Router_Node();
		$router->name( '_router' );
		$producer = new Capture_Sink_Node();
		$producer->name( 'producer-8814' );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_COMMAND;
		$message[ Message::TO ]    = 'absent-8814:config';
		$message[ Message::FROM ]  = 'producer-8814';
		$message[ Message::VALUE ] = [ 'name' => 'set_line_mode', 'arguments' => [ 'true' ] ];

		$router->fill( $message );

		$this->assertCount( 1, $producer->captured );
		$this->assertSame( "NOT_AVAILABLE\n", $producer->captured[0][ Message::VALUE ] );
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

	/**
	 * The tick's housekeeping is independent work: a wake that throws must not
	 * cost the rate-limiter re-window or the profile trim, and its failure
	 * escapes once every step has run.
	 */
	public function test_a_failed_wake_still_prunes_logs_and_trims_profiles_then_raises(): void {
		$tmp = $this->make_temp_dir();
		$this->use_base_dir( $tmp );
		\Newspack_Nodes\Partition_Node::forget_pending_wakes();
		$p = new \Newspack_Nodes\Partition_Node();
		$p->arguments( [ "{$tmp}/logs/heron.p0" ] );
		$p->fill( $this->produce( 'wake-me' ) );
		$p->flush();
		$refused = new \RuntimeException( 'wake refused 6614' );
		\Newspack_Nodes\Bootstrap::$spawn_coordinator_factory = static fn (): \Newspack_Nodes\Spawn_Coordinator => new class( $tmp, $refused ) extends \Newspack_Nodes\Spawn_Coordinator {
			public function __construct( string $base, private \RuntimeException $refused ) {
				parent::__construct( $base );
			}
			public function wake_on_demand( string $dir, float $now ): int {
				throw $this->refused;
			}
		};
		Core::$now                                    = 50000.0;
		Core::$recent_log_timers['stale warning 91'] = 50000.0 - Core::$log_timeout - 1;
		Router_Node::profiles( [ 'idle-node' => [ 'time' => 1.0, 'count' => 3, 'avg' => 0.3, 'oldest' => 1.0, 'timestamp' => 50000.0 - Router_Node::PROFILE_TTL_S - 1 ] ] );
		Core::$secure_level = null;
		$router = new Router_Node();
		$router->name( '_router' );

		$caught = null;
		try {
			$router->fire_cb();
		} catch ( \RuntimeException $e ) {
			$caught = $e;
		} finally {
			$profiles = Router_Node::profiles();
			Router_Node::profiles( null );
		}

		$this->assertSame( $refused, $caught );
		$this->assertArrayNotHasKey( 'stale warning 91', Core::$recent_log_timers, 'prune_logs() still ran' );
		$this->assertSame( [], $profiles, 'trim_profiles() still ran' );
		$this->assertSame( 1, $router->get_fire_count() );
	}
}
