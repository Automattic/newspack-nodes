<?php
/**
 * Shell_Node naming-fatal tests.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Shell_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Shell_Node::class )]
class ShellNodeTest extends TestCase {

	/** A non-empty name on the Shell is fatal — shells stay anonymous. */
	public function test_shell_refuses_to_be_named(): void {
		$this->expectException( \RuntimeException::class );
		( new Shell_Node() )->name( 'x' );
	}

	/** The empty-string name is also rejected (mirrors the base non-empty contract). */
	public function test_shell_refuses_empty_name(): void {
		$this->expectException( \RuntimeException::class );
		( new Shell_Node() )->name( '' );
	}

	/** Getter form (no argument) returns the empty name without throwing. */
	public function test_shell_name_getter_does_not_throw(): void {
		$this->assertSame( '', ( new Shell_Node() )->name() );
	}
}
