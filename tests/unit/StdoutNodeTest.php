<?php
/**
 * Stdout_Node: bare terminal sink — fwrites a message VALUE to its stream.
 *
 * @package Newspack_Nodes
 */

declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Message;
use Newspack_Nodes\Stdout_Node;
use Newspack_Nodes\Tests\TestCase;

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

	public function test_fill_writes_nothing_for_an_array_value(): void {
		// The canonical scalar read every terminal sink shares (Stderr_Node
		// already used it): a non-scalar VALUE is not this sink's to render,
		// so it writes nothing rather than the useless word `Array`.
		$this->assertSame( '', $this->fill_value( [ 'a', 'b' ] ) );
	}

	public function test_fill_writes_nothing_for_a_stringable_object(): void {
		$obj = new class() implements \Stringable {
			public function __toString(): string {
				return 'stringy';
			}
		};
		$this->assertSame( '', $this->fill_value( $obj ) );
	}

	public function test_fill_writes_nothing_for_a_non_stringable_object(): void {
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

	public function test_fill_renders_an_escape_byte_in_the_value_as_a_visible_token(): void {
		// A visitor's User-Agent reaches an operator's terminal through the log
		// tail; the escape has to arrive as text, never as an instruction.
		$this->assertSame( '<1B>]0;quarry<07>', $this->fill_value( "\x1B]0;quarry\x07" ) );
	}

	public function test_fill_renders_a_carriage_return_in_the_value_as_a_visible_token(): void {
		$this->assertSame( 'denied<0D>granted', $this->fill_value( "denied\rgranted" ) );
	}

	public function test_fill_leaves_newlines_and_tabs_in_the_value_alone(): void {
		$this->assertSame( "quarry\tp4419\n", $this->fill_value( "quarry\tp4419\n" ) );
	}

	public function test_fill_writes_a_multibyte_value_byte_identical(): void {
		$text = "\u{5834}\u{6240} caf\u{e9} \u{2713}";
		$this->assertSame( $text, $this->fill_value( $text ) );
	}

	public function test_fill_adds_no_ansi_off_a_terminal(): void {
		// A php://memory stream is no terminal, so the token stands alone.
		$this->assertStringNotContainsString( "\033[7m", $this->fill_value( "\x1Bx" ) );
	}

	public function test_write_raw_puts_control_bytes_on_the_stream_unrendered(): void {
		// The one bypass around the rendering, for a caller composing a control
		// sequence on purpose. Everything on the message path keeps rendering.
		$mem  = \fopen( 'php://memory', 'r+' );
		$node = new Stdout_Node( $mem, true );
		$node->write_raw( "\033[2J\033[H" );
		\rewind( $mem );
		$this->assertSame( "\033[2J\033[H", \stream_get_contents( $mem ) );
	}
}
