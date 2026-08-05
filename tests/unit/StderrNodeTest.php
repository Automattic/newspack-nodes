<?php
/**
 * Stderr_Node: routes a TM_BYTESTREAM VALUE through the node stderr chain so a
 * Tee -> Dumper -> Grep -> Stderr debug tap lands in the diagnostic log without
 * touching STDOUT.
 *
 * @package Newspack_Nodes
 */

declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Stderr_Node;
use Newspack_Nodes\Tests\TestCase;

#[CoversClass( Stderr_Node::class )]
class StderrNodeTest extends TestCase {

	public function test_bytestream_value_is_written_through_the_stderr_log(): void {
		Core::$recent_log = [];
		$node = new Stderr_Node();
		$node->name( 'dbg' );

		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$m[ Message::VALUE ] = 'diagnostic line';
		$node->fill( $m );

		$log = \implode( "\n", Core::$recent_log );
		$this->assertStringContainsString( 'diagnostic line', $log );
		$this->assertStringContainsString( 'dbg:', $log, 'the node-name midfix tags the line' );
	}

	public function test_non_bytestream_message_is_dropped(): void {
		Core::$recent_log = [];
		$node = new Stderr_Node();
		$node->name( 'dbg' );

		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT;
		$m[ Message::VALUE ] = [ 'not' => 'a line' ];
		$node->fill( $m );

		$this->assertEmpty( Core::$recent_log, 'only TM_BYTESTREAM is written to stderr' );
	}

	public function test_is_a_placeable_io_sink(): void {
		$schema = Stderr_Node::node_schema();
		$this->assertSame( 'I/O', $schema['category'] );
		$this->assertFalse( $schema['has_target'] );
	}
}
