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

	public function test_connect_node_promotes_string_target_to_array(): void {
		// Defense-in-depth path: if a Node was assigned a single-target string before
		// being promoted to a Tee (e.g., subclass swap), connect_node must convert
		// the existing target to an array, not lose it.
		$tee = new Tee();
		$ref = new \ReflectionProperty( $tee, 'target' );
		$ref->setAccessible( true );
		$ref->setValue( $tee, 'preexisting' );

		$tee->connect_node( 'new' );
		$this->assertSame( [ 'preexisting', 'new' ], $tee->target() );
	}

	public function test_connect_node_with_empty_string_target_resets_to_empty_array(): void {
		// Empty-string target represents "no target" in Node — Tee should treat it
		// as an empty list rather than including '' in the list.
		$tee = new Tee();
		$ref = new \ReflectionProperty( $tee, 'target' );
		$ref->setAccessible( true );
		$ref->setValue( $tee, '' );

		$tee->connect_node( 'a' );
		$this->assertSame( [ 'a' ], $tee->target() );
	}

	public function test_connect_node_is_idempotent(): void {
		// Adding a target twice must not duplicate.
		$tee = new Tee();
		$tee->connect_node( 'a' );
		$tee->connect_node( 'a' );
		$this->assertSame( [ 'a' ], $tee->target() );
	}

	public function test_disconnect_node_resets_string_target_to_empty(): void {
		// String target → disconnect → empty array (and nothing else happens).
		$tee = new Tee();
		$ref = new \ReflectionProperty( $tee, 'target' );
		$ref->setAccessible( true );
		$ref->setValue( $tee, 'string-target' );

		$tee->disconnect_node( 'string-target' );
		$this->assertSame( [], $tee->target() );
	}

	public function test_fill_isolates_per_target_exceptions(): void {
		// One target throws during dispatch; sibling target must still receive the
		// message. Wires a router → Lock-style sink that throws on a specific name.
		$router = new Router();
		$router->name( '_router' );

		$alive = new CaptureSink();
		$alive->name( 'alive' );

		$throwing = new class() extends \Newspack_Nodes\Node {
			public function fill( array &$message ): void {
				throw new \RuntimeException( 'simulated failure' );
			}
		};
		$throwing->name( 'throwing' );

		$tee = new Tee();
		$tee->name( 'tee' );
		$tee->sink( $router );
		$tee->connect_node( 'throwing' );
		$tee->connect_node( 'alive' );

		// Suppress the rate-limited error trail so this test doesn't pollute output.
		Core::set_stderr_handler( fn( $msg ) => null );

		$msg = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$msg[ Message::VALUE ] = 'data';
		$tee->fill( $msg );

		// Live target still got the message even though sibling threw.
		$this->assertCount( 1, $alive->captured );
		$this->assertSame( 'data', $alive->captured[0][ Message::VALUE ] );
	}

	// ============================================================================
	// fill() — TM_REQUEST handler: GET_TARGETS / unknown verb.
	// ============================================================================

	public function test_fill_routes_TM_REQUEST_to_handle_request(): void {
		// fill() must detect TM_REQUEST (without TM_RESPONSE) and reply with
		// GET_TARGETS data instead of fanning out. Spec lines 53-57.
		$alive_a = new CaptureSink();
		$alive_a->name( 'alive-a' );
		$alive_b = new CaptureSink();
		$alive_b->name( 'alive-b' );

		$reply_sink = new CaptureSink();
		$tee        = new Tee();
		$tee->name( 'tee' );
		$tee->sink( $reply_sink );
		$tee->connect_node( 'alive-a' );
		$tee->connect_node( 'alive-b' );

		$req                   = Message::new_message();
		$req[ Message::TYPE ]  = Message::TM_REQUEST;
		$req[ Message::FROM ]  = 'asker';
		$req[ Message::ID ]    = 'req-1';
		$req[ Message::KEY ]   = 'k';
		$req[ Message::VALUE ] = 'GET_TARGETS';
		$tee->fill( $req );

		// alive-a / alive-b must NOT have received anything — request replies
		// inline, not via fan-out.
		$this->assertCount( 0, $alive_a->captured, 'GET_TARGETS must not fan-out' );
		$this->assertCount( 0, $alive_b->captured );

		// Exactly one reply lands on the sink.
		$this->assertCount( 1, $reply_sink->captured );
		$reply = $reply_sink->captured[0];
		$this->assertSame(
			Message::TM_STRUCT | Message::TM_RESPONSE,
			$reply[ Message::TYPE ],
			'reply TYPE must be TM_STRUCT|TM_RESPONSE'
		);
		$this->assertSame( 'tee', $reply[ Message::FROM ], 'reply FROM = Tee name' );
		$this->assertSame( 'asker', $reply[ Message::TO ], 'reply TO walks breadcrumb back' );
		$this->assertSame( 'req-1', $reply[ Message::ID ] );
		$this->assertSame( 'k', $reply[ Message::KEY ] );
		$this->assertSame( 'GET_TARGETS', $reply[ Message::VALUE ]['verb'] );
		$this->assertSame( 2, $reply[ Message::VALUE ]['data']['count'] );
		$this->assertSame( [ 'alive-a', 'alive-b' ], $reply[ Message::VALUE ]['data']['targets'] );
	}

	public function test_fill_TM_REQUEST_GET_TARGETS_empty_target_list(): void {
		// Tee with no targets — GET_TARGETS still replies, with count=0
		// and targets=[].
		$reply_sink = new CaptureSink();

		$tee = new Tee();
		$tee->name( 'tee' );
		$tee->sink( $reply_sink );

		$req                   = Message::new_message();
		$req[ Message::TYPE ]  = Message::TM_REQUEST;
		$req[ Message::FROM ]  = 'asker';
		$req[ Message::VALUE ] = 'GET_TARGETS';
		$tee->fill( $req );

		$this->assertCount( 1, $reply_sink->captured );
		$data = $reply_sink->captured[0][ Message::VALUE ]['data'];
		$this->assertSame( 0, $data['count'] );
		$this->assertSame( [], $data['targets'] );
	}

	public function test_fill_TM_REQUEST_unknown_verb_returns_error_payload(): void {
		// Unknown verbs reply with `[ 'error' => "unknown request verb: $VERB" ]`.
		$reply_sink = new CaptureSink();
		$tee        = new Tee();
		$tee->name( 'tee' );
		$tee->sink( $reply_sink );
		$tee->connect_node( 'whatever' );

		$req                   = Message::new_message();
		$req[ Message::TYPE ]  = Message::TM_REQUEST;
		$req[ Message::FROM ]  = 'asker';
		$req[ Message::VALUE ] = 'UNKNOWN_VERB';
		$tee->fill( $req );

		$this->assertCount( 1, $reply_sink->captured );
		$value = $reply_sink->captured[0][ Message::VALUE ];
		$this->assertSame( 'UNKNOWN_VERB', $value['verb'] );
		$this->assertArrayHasKey( 'error', $value['data'] );
		$this->assertStringContainsString( 'UNKNOWN_VERB', $value['data']['error'] );
	}

	public function test_fill_TM_REQUEST_verb_is_case_insensitive_and_strips_args(): void {
		// Verb extraction is strtoupper(explode(' ', trim($value), 2)[0]).
		// "  get_targets  trailing  " → GET_TARGETS.
		$reply_sink = new CaptureSink();
		$tee        = new Tee();
		$tee->name( 'tee' );
		$tee->sink( $reply_sink );

		$req                   = Message::new_message();
		$req[ Message::TYPE ]  = Message::TM_REQUEST;
		$req[ Message::FROM ]  = 'asker';
		$req[ Message::VALUE ] = '  get_targets  trailing  ';
		$tee->fill( $req );

		$this->assertCount( 1, $reply_sink->captured );
		$value = $reply_sink->captured[0][ Message::VALUE ];
		$this->assertSame( 'GET_TARGETS', $value['verb'] );
		// Verifies the verb dispatched to GET_TARGETS, not the error branch.
		$this->assertArrayHasKey( 'count', $value['data'] );
	}

	// ============================================================================
	// disconnect_node — non-array target shape (already tested elsewhere too).
	// ============================================================================

	public function test_disconnect_node_no_change_skips_state_emit(): void {
		// Spec: "if ( $before !== $this->target ) { set_state }" — when the
		// disconnect is a no-op (target isn't in the list), no state event
		// should fire. Verified by watching that no TARGETS event reaches a
		// registered listener.
		$tee = new Tee();
		$tee->name( 'tee' );

		$tee->connect_node( 'a' );
		$tee->connect_node( 'b' );

		// Register a listener on TARGETS so we can count emits. The
		// connect_nodes above each fired their own TARGETS event — register
		// AFTER so we observe only post-register churn.
		$ref = new \ReflectionClass( $tee );
		$rp  = $ref->getProperty( 'registrations' );
		$rp->setAccessible( true );
		$regs              = $rp->getValue( $tee );
		$regs['TARGETS']   = [];
		$rp->setValue( $tee, $regs );

		$count = 0;
		$tee->register( 'TARGETS', 'spy', static function () use ( &$count ): bool {
			++$count;
			return true;
		} );
		// register replays cached state once.
		$initial = $count;

		// Disconnect a target that ISN'T in the list — no change, no emit.
		$tee->disconnect_node( 'not-there' );
		$this->assertSame( $initial, $count, 'no-op disconnect must not fire TARGETS' );

		// Disconnect a real target — IS a change, MUST emit.
		$tee->disconnect_node( 'a' );
		$this->assertSame( $initial + 1, $count, 'real disconnect must fire TARGETS' );
	}

	public function test_connect_node_emits_TARGETS_state_event(): void {
		// connect_node caches a TARGETS event so debug_state subscribers see
		// the current target list without replaying every connect.
		$tee = new Tee();
		$tee->name( 'tee' );

		// Register listener BEFORE connecting; observe that each connect fires.
		$ref = new \ReflectionClass( $tee );
		$rp  = $ref->getProperty( 'registrations' );
		$rp->setAccessible( true );
		$regs              = $rp->getValue( $tee );
		$regs['TARGETS']   = [];
		$rp->setValue( $tee, $regs );

		$payloads = [];
		$tee->register( 'TARGETS', 'spy', static function ( $v ) use ( &$payloads ): bool {
			$payloads[] = $v;
			return true;
		} );

		$tee->connect_node( 'a' );
		$tee->connect_node( 'b' );
		// Idempotent connect — must NOT re-emit.
		$tee->connect_node( 'a' );

		$this->assertSame(
			[ [ 'a' ], [ 'a', 'b' ] ],
			$payloads,
			'TARGETS fires only on real list changes'
		);
	}
}
