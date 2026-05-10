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
}
