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

	public function test_closure_can_mutate_message_in_place(): void {
		$cb = new Callback_Node( function ( array &$m ) {
			$m[ Message::VALUE ] = 'transformed';
		} );
		$message = Message::new_message();
		$message[ Message::VALUE ] = 'orig';
		$cb->fill( $message );
		$this->assertSame( 'transformed', $message[ Message::VALUE ] );
	}

	public function test_counter_increments_per_fill(): void {
		$cb = new Callback_Node( fn ( array &$m ) => null );
		$message = Message::new_message();
		$cb->fill( $message );
		$cb->fill( $message );
		$this->assertSame( 2, $cb->counter() );
	}
}
