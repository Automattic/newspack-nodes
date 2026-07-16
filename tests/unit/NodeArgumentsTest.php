<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

// Concrete subclass with a positional-args schema. Declared in the test
// file (alongside the test class) so it stays a fixture and doesn't
// pollute the main autoloader / composer classmap (palette catalog).
class Test_Args_Node extends Node {
	use \Newspack_Nodes\Schema_Reflection;

	public string $name_field = '';
	public int    $count      = 0;
	public bool   $flag       = false;

	/** Standard override: store the tokens, then walk the schema via the trait. */
	public function arguments( ?array $args = null ): array {
		if ( null === $args ) {
			return parent::arguments();
		}
		$this->parse_schema_args( $args );
		return $args;
	}

	public static function node_schema(): array {
		return [
			'category'     => 'Test',
			'description'  => 'Sibling fixture exercising parse_schema_args() via its arguments() override.',
			'arguments'    => [
				[ 'name' => 'name_field', 'type' => 'string', 'required' => true ],
				[ 'name' => 'count',      'type' => 'int',    'default'  => 0 ],
				[ 'name' => 'flag',       'type' => 'bool',   'default'  => false ],
			],
			'commands'     => [],
			'accepts_fill' => true,
			'has_target'   => true,
		];
	}
}

#[CoversClass( Node::class )]
class NodeArgumentsTest extends TestCase {
	public function test_setter_parses_tokens_and_assigns_to_named_properties(): void {
		$n = new Test_Args_Node();
		$n->arguments( [ 'hello', '7', 'true' ] );
		$this->assertSame( 'hello', $n->name_field );
		$this->assertSame( 7,       $n->count );
		$this->assertSame( true,    $n->flag );
	}

	public function test_getter_returns_last_set_tokens(): void {
		$n = new Test_Args_Node();
		$n->arguments( [ 'hello', '7', 'true' ] );
		$this->assertSame( [ 'hello', '7', 'true' ], $n->arguments() );
	}

	public function test_missing_optional_tokens_use_schema_defaults(): void {
		$n = new Test_Args_Node();
		$n->arguments( [ 'hello' ] );
		$this->assertSame( 'hello', $n->name_field );
		$this->assertSame( 0,       $n->count );
		$this->assertSame( false,   $n->flag );
	}

	public function test_empty_arguments_throws_exception_for_required_field(): void {
		$n = new Test_Args_Node();
		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( 'Missing required argument: name_field' );
		$n->arguments( [] );
	}

	public function test_bool_coercion_accepts_truthy_strings(): void {
		$n = new Test_Args_Node();
		$n->arguments( [ 'x', '0', 'yes' ] );
		$this->assertTrue( $n->flag );
		$n->arguments( [ 'x', '0', '1' ] );
		$this->assertTrue( $n->flag );
		$n->arguments( [ 'x', '0', 'false' ] );
		$this->assertFalse( $n->flag );
	}

	public function test_excess_tokens_are_ignored(): void {
		$n = new Test_Args_Node();
		$n->arguments( [ 'hello', '7', 'true', 'extra', 'extra2' ] );
		$this->assertSame( 'hello', $n->name_field );
		$this->assertSame( 7, $n->count );
		$this->assertTrue( $n->flag );
	}

	public function test_dump_config_requotes_a_spaced_token_for_round_trip(): void {
		// Serialization is the ONE place tokens re-join; a spaced token is
		// single-quoted so parseTsl/the Shell re-read it as one token.
		$n = new Test_Args_Node();
		$n->name( 'zebra' );
		$n->arguments( [ 'a b', 'c' ] );
		$this->assertStringContainsString( "make_node Test_Args zebra 'a b' c", $n->dump_config() );
	}
}
