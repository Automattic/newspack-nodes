<?php
/**
 * Stdout_Node: bare terminal sink — fwrites a message VALUE to its stream.
 *
 * @package Newspack_Nodes
 */

declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Message;
use Newspack_Nodes\Stdout_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Stdout_Node::class )]
class StdoutNodeTest extends TestCase {

	public function test_fill_writes_the_bytestream_value_verbatim(): void {
		$mem  = \fopen( 'php://memory', 'r+' );
		$node = new Stdout_Node( $mem );
		$m    = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$m[ Message::VALUE ] = 'hello';
		$node->fill( $m );
		\rewind( $mem );
		$this->assertSame( 'hello', \stream_get_contents( $mem ) );
	}

	public function test_fill_does_not_double_a_trailing_newline(): void {
		$mem  = \fopen( 'php://memory', 'r+' );
		$node = new Stdout_Node( $mem );
		$m    = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$m[ Message::VALUE ] = "hello\n";
		$node->fill( $m );
		\rewind( $mem );
		$this->assertSame( "hello\n", \stream_get_contents( $mem ) );
	}

	public function test_fill_of_default_empty_value_writes_nothing(): void {
		$mem  = \fopen( 'php://memory', 'r+' );
		$node = new Stdout_Node( $mem );
		$m    = Message::new_message(); // VALUE defaults to '' — the common empty-payload shape.
		$node->fill( $m );
		\rewind( $mem );
		$this->assertSame( '', \stream_get_contents( $mem ) );
	}

	public function test_fill_writes_non_bytestream_value_with_no_type_dispatch(): void {
		$mem  = \fopen( 'php://memory', 'r+' );
		$node = new Stdout_Node( $mem );
		$m    = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT;
		$m[ Message::VALUE ] = 'plain';
		$node->fill( $m );
		\rewind( $mem );
		$this->assertSame( 'plain', \stream_get_contents( $mem ) );
	}

	/**
	 * Fill a message whose VALUE is $value and return the bytes written.
	 *
	 * @param mixed $value Raw Message VALUE to coerce and write.
	 */
	private function fill_value( $value ): string {
		$mem  = \fopen( 'php://memory', 'r+' );
		$node = new Stdout_Node( $mem );
		$m    = Message::new_message();
		$m[ Message::VALUE ] = $value;
		$node->fill( $m );
		\rewind( $mem );
		return \stream_get_contents( $mem );
	}

	public function test_fill_coerces_null_value_to_a_bare_newline(): void {
		$this->assertSame( '', $this->fill_value( null ) );
	}

	public function test_fill_coerces_array_value_to_the_word_Array(): void {
		$this->assertSame( 'Array', $this->fill_value( [ 'a', 'b' ] ) );
	}

	public function test_fill_coerces_stringable_object_via_to_string(): void {
		$obj = new class() implements \Stringable {
			public function __toString(): string {
				return 'stringy';
			}
		};
		$this->assertSame( 'stringy', $this->fill_value( $obj ) );
	}

	public function test_fill_coerces_non_stringable_object_to_empty(): void {
		$this->assertSame( '', $this->fill_value( new \stdClass() ) );
	}

	public function test_fill_coerces_scalar_int_to_its_string_form(): void {
		$this->assertSame( '42', $this->fill_value( 42 ) );
	}

	public function test_fill_coerces_scalar_bool_true_to_one(): void {
		$this->assertSame( '1', $this->fill_value( true ) );
	}

	public function test_fill_coerces_non_scalar_resource_to_empty(): void {
		$res = \fopen( 'php://memory', 'r' );
		$this->assertSame( '', $this->fill_value( $res ) );
		\fclose( $res );
	}
}
