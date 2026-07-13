<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Command_Interpreter_Node::class )]
class MakeNodeDedupTest extends TestCase {

	private Command_Interpreter_Node $ci;

	protected function setUp(): void {
		parent::setUp();
		$this->ci = new Command_Interpreter_Node();
		$this->ci->name( 'dedup-ci' );
	}

	public function test_identical_make_node_returns_the_existing_node_without_throwing(): void {
		// Distinct from defaults: a Grep with a pattern no other fixture uses.
		$first  = $this->ci->make_node( 'Grep', 'wombat-grep', 'zebra-pattern' );
		$second = $this->ci->make_node( 'Grep', 'wombat-grep', 'zebra-pattern' );

		$this->assertNotNull( $first );
		$this->assertSame( $first, $second, 'an identical redeclaration must collapse to the same node' );
		$this->assertSame( $first, Core::node( 'wombat-grep' ) );
	}

	public function test_conflicting_args_throw_naming_the_node(): void {
		$this->ci->make_node( 'Grep', 'wombat-grep', 'zebra-pattern' );

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'wombat-grep' );

		$this->ci->make_node( 'Grep', 'wombat-grep', 'giraffe-pattern' );
	}

	public function test_conflicting_type_throws(): void {
		$this->ci->make_node( 'Grep', 'wombat-grep', 'zebra-pattern' );

		$this->expectException( \RuntimeException::class );

		$this->ci->make_node( 'Echo', 'wombat-grep' );
	}
}
