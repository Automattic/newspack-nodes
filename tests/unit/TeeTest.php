<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\Tee_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Tee_Node::class )]
class TeeTest extends TestCase {
	public function test_connect_node_appends_to_target_list(): void {
		$tee = new Tee_Node();
		$tee->connect_node( 'a' );
		$tee->connect_node( 'b' );
		$this->assertSame( [ 'a', 'b' ], $tee->target() );
	}

	public function test_fill_dispatches_to_each_target(): void {
		$router = new Router_Node();
		$router->name( '_router' );

		$a = new Capture_Sink_Node();
		$a->name( 'a' );
		$b = new Capture_Sink_Node();
		$b->name( 'b' );

		$tee = new Tee_Node();
		$tee->name( 'tee' );
		$tee->sink( $router );
		$tee->connect_node( 'a' );
		$tee->connect_node( 'b' );

		$message = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::VALUE ] = 'fanout';
		$tee->fill( $message );

		$this->assertCount( 1, $a->captured );
		$this->assertCount( 1, $b->captured );
		$this->assertSame( 'fanout', $a->captured[0][ Message::VALUE ] );
	}

	public function test_fill_prepends_subpath_to_each_target_for_nonempty_TO(): void {
		// A message in transit toward a sub-path (non-empty TO) fans out as
		// `<target>/<TO>` — mirrors OG Tachikoma `join '/', grep length, owner, TO`.
		// The Router peels the target head, so each delivered node sees the sub-path.
		$router = new Router_Node();
		$router->name( '_router' );
		$a = new Capture_Sink_Node();
		$a->name( 'a' );
		$b = new Capture_Sink_Node();
		$b->name( 'b' );

		$tee = new Tee_Node();
		$tee->name( 'tee' );
		$tee->sink( $router );
		$tee->connect_node( 'a' );
		$tee->connect_node( 'b' );

		$message = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::TO ]    = 'sub';
		$message[ Message::VALUE ] = 'fanout';
		$tee->fill( $message );

		$this->assertCount( 1, $a->captured );
		$this->assertCount( 1, $b->captured );
		$this->assertSame( 'sub', $a->captured[0][ Message::TO ] );
		$this->assertSame( 'sub', $b->captured[0][ Message::TO ] );
	}

	public function test_fill_fans_out_a_nonempty_TO_request_instead_of_handling_it(): void {
		// A TM_REQUEST is only the Tee's own GET_TARGETS request when TO is empty.
		// With a non-empty TO it's in transit toward a sub-path, so it fans out
		// (TO=<target>/<TO>) rather than being consumed by handle_request.
		$router = new Router_Node();
		$router->name( '_router' );
		$a = new Capture_Sink_Node();
		$a->name( 'a' );

		$tee = new Tee_Node();
		$tee->name( 'tee' );
		$tee->sink( $router );
		$tee->connect_node( 'a' );

		$req = Message::new_message();
		$req[ Message::TYPE ]  = Message::TM_REQUEST;
		$req[ Message::TO ]    = 'sub';
		$req[ Message::VALUE ] = 'GET_TARGETS';
		$tee->fill( $req );

		// Fanned out to a/sub (Router peels 'a' → TO='sub'), still a TM_REQUEST —
		// NOT turned into a GET_TARGETS reply.
		$this->assertCount( 1, $a->captured );
		$this->assertSame( 'sub', $a->captured[0][ Message::TO ] );
		$this->assertSame( Message::TM_REQUEST, $a->captured[0][ Message::TYPE ] );
	}

	public function test_disconnect_node_removes_one_target(): void {
		$tee = new Tee_Node();
		$tee->connect_node( 'a' );
		$tee->connect_node( 'b' );
		$tee->disconnect_node( 'a' );
		$this->assertSame( [ 'b' ], \array_values( $tee->target() ) );
	}

	public function test_dead_target_pruned_silently(): void {
		$router = new Router_Node();
		$router->name( '_router' );

		$alive = new Capture_Sink_Node();
		$alive->name( 'alive' );

		$tee = new Tee_Node();
		$tee->name( 'tee' );
		$tee->sink( $router );
		$tee->connect_node( 'alive' );
		$tee->connect_node( 'gone' );

		$message = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::VALUE ] = 'data';
		$tee->fill( $message );

		$this->assertCount( 1, $alive->captured );
	}

	public function test_path_shaped_target_with_live_head_survives_fill(): void {
		// A path-shaped target like `alive/workers` (only `alive` is registered)
		// must survive the prune: the HEAD node is live, so the sink can route it.
		$router = new Router_Node();
		$router->name( '_router' );

		$alive = new Capture_Sink_Node();
		$alive->name( 'alive' );

		$tee = new Tee_Node();
		$tee->name( 'tee' );
		$tee->sink( $router );
		$tee->connect_node( 'alive/workers' );

		$message = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::VALUE ] = 'data';
		$tee->fill( $message );

		$this->assertSame( [ 'alive/workers' ], \array_values( $tee->target() ) );
	}

	public function test_path_shaped_target_with_dead_head_is_pruned(): void {
		// A path-shaped target whose HEAD node is not registered gets pruned.
		$router = new Router_Node();
		$router->name( '_router' );

		$tee = new Tee_Node();
		$tee->name( 'tee' );
		$tee->sink( $router );
		$tee->connect_node( 'gone/workers' );

		$message = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::VALUE ] = 'data';
		$tee->fill( $message );

		$this->assertSame( [], \array_values( $tee->target() ) );
	}

	public function test_connect_node_promotes_string_target_to_array(): void {
		// Defense-in-depth path: if a Node was assigned a single-target string before
		// being promoted to a Tee (e.g., subclass swap), connect_node must convert
		// the existing target to an array, not lose it.
		$tee = new Tee_Node();
		$ref = new \ReflectionProperty( $tee, 'target' );
		$ref->setAccessible( true );
		$ref->setValue( $tee, 'preexisting' );

		$tee->connect_node( 'new' );
		$this->assertSame( [ 'preexisting', 'new' ], $tee->target() );
	}

	public function test_connect_node_with_empty_string_target_resets_to_empty_array(): void {
		// Empty-string target represents "no target" in Node — Tee should treat it
		// as an empty list rather than including '' in the list.
		$tee = new Tee_Node();
		$ref = new \ReflectionProperty( $tee, 'target' );
		$ref->setAccessible( true );
		$ref->setValue( $tee, '' );

		$tee->connect_node( 'a' );
		$this->assertSame( [ 'a' ], $tee->target() );
	}

	public function test_connect_node_is_idempotent(): void {
		// Adding a target twice must not duplicate.
		$tee = new Tee_Node();
		$tee->connect_node( 'a' );
		$tee->connect_node( 'a' );
		$this->assertSame( [ 'a' ], $tee->target() );
	}

	public function test_disconnect_node_resets_string_target_to_empty(): void {
		// String target → disconnect → empty array (and nothing else happens).
		$tee = new Tee_Node();
		$ref = new \ReflectionProperty( $tee, 'target' );
		$ref->setAccessible( true );
		$ref->setValue( $tee, 'string-target' );

		$tee->disconnect_node( 'string-target' );
		$this->assertSame( [], $tee->target() );
	}

	public function test_fill_isolates_per_target_exceptions(): void {
		// One target throws during dispatch; sibling target must still receive the
		// message. Wires a router → Lock-style sink that throws on a specific name.
		$router = new Router_Node();
		$router->name( '_router' );

		$alive = new Capture_Sink_Node();
		$alive->name( 'alive' );

		$throwing = new class() extends \Newspack_Nodes\Node {
			public function fill( array &$message ): void {
				throw new \RuntimeException( 'simulated failure' );
			}
		};
		$throwing->name( 'throwing' );

		$tee = new Tee_Node();
		$tee->name( 'tee' );
		$tee->sink( $router );
		$tee->connect_node( 'throwing' );
		$tee->connect_node( 'alive' );

		// Suppress the rate-limited error trail so this test doesn't pollute output.
		Core::set_stderr_handler( fn( $message ) => null );

		$message = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::VALUE ] = 'data';
		$tee->fill( $message );

		// Live target still got the message even though sibling threw.
		$this->assertCount( 1, $alive->captured );
		$this->assertSame( 'data', $alive->captured[0][ Message::VALUE ] );
	}

}
