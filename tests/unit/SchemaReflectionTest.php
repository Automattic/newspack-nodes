<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Node;
use Newspack_Nodes\Schema_Reflection;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Schema_Reflection::class )]
class SchemaReflectionTest extends TestCase {

	public function test_parse_schema_args_resolves_and_coerces_a_config_token_default(): void {
		// A <ns:key> token default is resolved via its namespace resolver and
		// coerced to the declared type — a schema default never passes through
		// the TSL loader, so parse_schema_args must resolve it itself. 7777 is
		// distinct from every DEFAULT_* retention constant.
		Core::register_config_namespace( 'tconf', static fn ( string $k ): mixed => 'probe_count' === $k ? 7777 : null );

		$node = new class extends Node {
			use Schema_Reflection;

			public int $count = 0;

			public function parse( array $args ): void {
				$this->parse_schema_args( $args );
			}

			public static function node_schema(): array {
				return [
					'arguments' => [
						[ 'name' => 'count', 'type' => 'int', 'default' => '<tconf:probe_count>' ],
					],
				];
			}
		};

		$node->parse( [] );

		$this->assertSame( 7777, $node->count );
	}

	public function test_parse_schema_args_throws_on_unresolvable_token_default(): void {
		// A schema default whose <ns:key> token can't resolve (unowned key — the
		// exact <config:is_hub> footgun) is a developer bug: fail loud at
		// construction, don't silently coerce '' (which for a bool default
		// disables the feature). 'tconf' owns nothing, so it returns null.
		Core::register_config_namespace( 'tconf', static fn ( string $k ) => null );

		$node = new class extends Node {
			use Schema_Reflection;

			public bool $flag = false;

			public function parse( array $args ): void {
				$this->parse_schema_args( $args );
			}

			public static function node_schema(): array {
				return [
					'arguments' => [
						[ 'name' => 'flag', 'type' => 'bool', 'default' => '<tconf:is_hub>' ],
					],
				];
			}
		};

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'tconf:is_hub' );

		$node->parse( [] );
	}

	public function test_parse_schema_args_leaves_a_non_token_default_verbatim(): void {
		$node = new class extends Node {
			use Schema_Reflection;

			public string $label = '';

			public function parse( array $args ): void {
				$this->parse_schema_args( $args );
			}

			public static function node_schema(): array {
				return [
					'arguments' => [
						[ 'name' => 'label', 'type' => 'string', 'default' => 'plain-default' ],
					],
				];
			}
		};

		$node->parse( [] );

		$this->assertSame( 'plain-default', $node->label );
	}

	public function test_parse_schema_args_noops_when_arguments_schema_is_not_a_list(): void {
		$node = new class extends Node {
			use Schema_Reflection;

			public function parse( array $args ): void {
				$this->parse_schema_args( $args );
			}

			public static function node_schema(): array {
				return [ 'arguments' => 'not-a-list' ];
			}
		};

		$node->parse( [ 'ignored' ] );

		$this->assertSame( [], $node->arguments() );
	}

	public function test_parse_schema_args_skips_non_array_entries_and_coerces_float(): void {
		$node = new class extends Node {
			use Schema_Reflection;

			public float $ratio = 0.0;

			public function parse( array $args ): void {
				$this->parse_schema_args( $args );
			}

			public static function node_schema(): array {
				return [
					'arguments' => [
						'not-an-argument',
						[ 'name' => 'ratio', 'type' => 'float' ],
					],
				];
			}
		};

		$node->parse( [ 'ignored', '2.5' ] );

		$this->assertSame( 2.5, $node->ratio );
		$this->assertSame( [ 'ignored', '2.5' ], $node->arguments() );
	}

	public function test_parse_schema_args_rejects_argument_spec_without_name(): void {
		$node = new class extends Node {
			use Schema_Reflection;

			public function parse( array $args ): void {
				$this->parse_schema_args( $args );
			}

			public static function node_schema(): array {
				return [ 'arguments' => [ [ 'type' => 'string' ] ] ];
			}
		};

		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( 'missing name' );

		$node->parse( [ 'value' ] );
	}

	public function test_parse_schema_args_rejects_argument_without_matching_property(): void {
		$node = new class extends Node {
			use Schema_Reflection;

			public function parse( array $args ): void {
				$this->parse_schema_args( $args );
			}

			public static function node_schema(): array {
				return [ 'arguments' => [ [ 'name' => 'missing_property' ] ] ];
			}
		};

		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( 'missing_property' );

		$node->parse( [ 'value' ] );
	}

	public function test_auto_wire_interpreter_noops_for_command_interpreters(): void {
		$node = new class extends Command_Interpreter_Node {
			use Schema_Reflection;

			public function wire(): void {
				$this->auto_wire_interpreter();
			}
		};

		$node->wire();

		$this->assertNull( $this->read_private( $node, 'interpreter' ) );
	}

	public function test_auto_wire_interpreter_noops_when_commands_schema_is_not_a_list(): void {
		$node = new class extends Node {
			use Schema_Reflection;

			public function wire(): void {
				$this->auto_wire_interpreter();
			}

			public static function node_schema(): array {
				return [ 'commands' => 'not-a-list' ];
			}
		};

		$node->wire();

		$this->assertNull( $this->read_private( $node, 'interpreter' ) );
	}

	public function test_auto_wire_interpreter_skips_catalog_only_entries_and_names_config_sibling(): void {
		$node = new class extends Node {
			use Schema_Reflection;

			public function wire(): void {
				$this->auto_wire_interpreter();
			}

			public function interpreter(): ?Command_Interpreter_Node {
				return $this->interpreter;
			}

			public static function node_schema(): array {
				return [
					'commands' => [
						'not-an-array',
						[ 'name' => '' ],
						[ 'name' => 'doc_only' ],
						[
							'name'    => 'real',
							'handler' => static fn (): string => 'ok',
						],
					],
				];
			}
		};
		$node->name( 'schema-probe' );

		$node->wire();
		$node->wire();

		$interpreter = $node->interpreter();
		$this->assertInstanceOf( Command_Interpreter_Node::class, $interpreter );
		$this->assertSame( 'schema-probe:config', $interpreter->name() );
		$this->assertSame( [ 'real', 'help' ], \array_keys( $interpreter->commands() ) );
	}

	// ── declarative toggle verbs: node_schema is the WHOLE ritual ──────────

	/** Anon node class with one schema-declared toggle and NO handler/fragment. */
	private function toggle_node(): Node {
		return new class extends Node {
			use Schema_Reflection;

			protected bool $turbo_mode = false;

			public function set_turbo_mode( bool $flag ): void {
				$this->turbo_mode = $flag;
			}

			public function wire(): void {
				$this->auto_wire_interpreter();
			}

			public function interpreter(): ?Command_Interpreter_Node {
				return $this->interpreter;
			}

			public function dump(): string {
				return $this->dump_toggles();
			}

			public static function node_schema(): array {
				return [
					'category'    => 'Test',
					'description' => 'toggle probe',
					'arguments'   => [],
					'commands'    => [
						[
							'name'        => 'set_turbo_mode',
							'description' => 'Truthy enables.',
							'toggle'      => 'turbo_mode',
						],
					],
				];
			}
		};
	}

	public function test_schema_toggle_synthesizes_the_verb_handler(): void {
		$node = $this->toggle_node();
		$node->name( 'toggle-probe' );
		$node->wire();

		$interpreter = $node->interpreter();
		$this->assertNotNull( $interpreter );
		$commands = $interpreter->commands();
		$this->assertArrayHasKey( 'set_turbo_mode', $commands );

		$this->assertSame( 'ok', $commands['set_turbo_mode']( $interpreter, [ 'yes' ] ) );
		$this->assertTrue( $this->read_private( $node, 'turbo_mode' ) );

		$commands['set_turbo_mode']( $interpreter, [ 'off' ] );
		$this->assertFalse( $this->read_private( $node, 'turbo_mode' ), 'a non-truthy arg disables' );
	}

	public function test_schema_toggle_emits_the_dump_config_fragment(): void {
		$node = $this->toggle_node();
		$node->name( 'toggle-probe' );
		$node->wire();

		$this->assertSame( '', $node->dump(), 'default-off toggles emit nothing' );

		$commands = $node->interpreter()->commands();
		$commands['set_turbo_mode']( $node->interpreter(), [ '1' ] );
		$this->assertSame( "command_node toggle-probe:config set_turbo_mode 1\n", $node->dump() );
	}

	public function test_truthy_is_the_one_canonical_bool_parse(): void {
		$this->assertTrue( Schema_Reflection_Probe::truthy_probe( 'YES' ) );
		$this->assertTrue( Schema_Reflection_Probe::truthy_probe( '1' ) );
		$this->assertFalse( Schema_Reflection_Probe::truthy_probe( '0' ) );
		$this->assertFalse( Schema_Reflection_Probe::truthy_probe( '' ) );
		$this->assertFalse( Schema_Reflection_Probe::truthy_probe( 'nope' ) );
	}
}

/** Concrete host exposing Schema_Reflection::truthy() for the parse test. */
class Schema_Reflection_Probe {
	use Schema_Reflection;

	public static function truthy_probe( string $token ): bool {
		return self::truthy( $token );
	}
}
