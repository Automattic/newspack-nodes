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

	public function test_fill_writes_bytestream_value_with_single_trailing_newline(): void {
		$mem  = \fopen( 'php://memory', 'r+' );
		$node = new Stdout_Node( $mem );
		$m    = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$m[ Message::VALUE ] = 'hello';
		$node->fill( $m );
		\rewind( $mem );
		$this->assertSame( "hello\n", \stream_get_contents( $mem ) );
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

	public function test_fill_of_default_empty_value_emits_a_bare_newline(): void {
		$mem  = \fopen( 'php://memory', 'r+' );
		$node = new Stdout_Node( $mem );
		$m    = Message::new_message(); // VALUE defaults to '' — the common empty-payload shape.
		$node->fill( $m );
		\rewind( $mem );
		$this->assertSame( "\n", \stream_get_contents( $mem ) );
	}

	public function test_fill_writes_non_bytestream_value_with_no_type_dispatch(): void {
		$mem  = \fopen( 'php://memory', 'r+' );
		$node = new Stdout_Node( $mem );
		$m    = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT;
		$m[ Message::VALUE ] = 'plain';
		$node->fill( $m );
		\rewind( $mem );
		$this->assertSame( "plain\n", \stream_get_contents( $mem ) );
	}
}
