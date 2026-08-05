<?php
/**
 * StdinNodeTest — bare fgets stdin source: line drain -> TM_BYTESTREAM,
 * EOF -> single TM_EOF + self-exit deadline, null-sink no-op.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Message;
use Newspack_Nodes\Node_Names;
use Newspack_Nodes\Stdin_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;

#[CoversClass( Stdin_Node::class )]
class StdinNodeTest extends TestCase {

	/** @return resource */
	private function memory_stream( string $contents ) {
		$mem = \fopen( 'php://memory', 'r+' );
		\fwrite( $mem, $contents );
		\rewind( $mem );
		return $mem;
	}

	public function test_fgets_lines_emit_bytestream_then_eof(): void {
		$mem  = $this->memory_stream( "a\nb\n" );
		$node = new Stdin_Node( $mem );
		$cap  = new Capture_Sink_Node();
		$node->sink( $cap );

		$node->fire();
		$node->fire();
		$node->fire();

		$types  = \array_map( fn( $m ) => $m[ Message::TYPE ], $cap->captured );
		$values = \array_map( fn( $m ) => $m[ Message::VALUE ], $cap->captured );

		$this->assertSame( [ 'a', 'b' ], \array_map( 'rtrim', \array_slice( $values, 0, 2 ) ) );
		$this->assertSame( Message::TM_EOF, \end( $types ) );
		$this->assertSame( Node_Names::STDIN, $cap->captured[0][ Message::FROM ] );
	}

	public function test_null_sink_does_not_throw(): void {
		$mem  = $this->memory_stream( "a\n" );
		$node = new Stdin_Node( $mem );

		$node->fire();

		$this->assertFalse( $node->exit );
	}

	public function test_exit_flips_true_once_eof_deadline_elapses(): void {
		$mem  = $this->memory_stream( '' );
		$node = new Stdin_Node( $mem, 0.0 );
		$cap  = new Capture_Sink_Node();
		$node->sink( $cap );

		// First fire hits EOF immediately (empty stream) and sends TM_EOF, arming
		// the (already-elapsed, 0.0s) deadline.
		$node->fire();
		$this->assertFalse( $node->exit );

		// Second fire sees the deadline has passed and flips exit.
		$node->fire();
		$this->assertTrue( $node->exit );
	}
}
