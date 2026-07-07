<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Callback_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Callback_Node::class )]
class CallbackTest extends TestCase {
	public function test_constructor_takes_closure(): void {
		$cb = new Callback_Node( fn ( array &$m ) => null );
		$this->assertInstanceOf( Callback_Node::class, $cb );
	}

	public function test_fill_invokes_closure_with_message_reference(): void {
		$received = null;
		$cb = new Callback_Node( function ( array &$m ) use ( &$received ) {
			$received = $m[ Message::VALUE ];
		} );
		$message = Message::new_message();
		$message[ Message::VALUE ] = 'hello';
		$cb->fill( $message );
		$this->assertSame( 'hello', $received );
	}

	public function test_callback_mutation_does_not_escape_to_the_caller(): void {
		// fill() is by-value: whatever a callback does to its message stays in the
		// callback's copy — the caller's message is untouched (to transform-and-
		// forward, a callback mutates its copy then fills its own sink).
		$cb = new Callback_Node( function ( array $m ) {
			$m[ Message::VALUE ] = 'transformed';
		} );
		$message = Message::new_message();
		$message[ Message::VALUE ] = 'orig';
		$cb->fill( $message );
		$this->assertSame( 'orig', $message[ Message::VALUE ] );
	}

	public function test_counter_increments_per_fill(): void {
		$cb = new Callback_Node( fn ( array &$m ) => null );
		$message = Message::new_message();
		$cb->fill( $message );
		$cb->fill( $message );
		$this->assertSame( 2, $cb->counter() );
	}
}
