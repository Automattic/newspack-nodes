<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Node;
use Newspack_Nodes\Schema_Reflection;
use Newspack_Nodes\Tests\TestCase;

#[CoversClass( Schema_Reflection::class )]
class SchemaReflectionTest extends TestCase {

	public function test_every_toggle_verb_declares_the_argument_it_toggles_on(): void {
		// A verb with no declared args is fired IMMEDIATELY by the console's
		// VerbButton with `positional: ''`, and the synthesized toggle handler
		// reads that as truthy('') — off. So a toggle that declares no argument
		// is a button that can only ever DISABLE the thing it names, with no way
		// to turn it back on from the canvas.
		$argless = [];
		foreach ( $this->concrete_node_classes() as $fqcn ) {
			foreach ( Core::arr( $fqcn::node_schema()['commands'] ?? [] ) as $verb ) {
				if ( ! \is_array( $verb ) || '' === Core::as_string( $verb['toggle'] ?? '' ) ) {
					continue;
				}
				if ( empty( $verb['args'] ) ) {
					$argless[] = $fqcn . '::' . Core::as_string( $verb['name'] ?? '?' );
				}
			}
		}

		$this->assertSame( [], $argless, 'every toggle verb must declare its enable/disable argument' );
	}

	/**
	 * Every concrete substrate Node class, read from the composer classmap — the
	 * same source the console palette enumerates.
	 *
	 * @return list<class-string>
	 */
	private function concrete_node_classes(): array {
		$classes = [];
		foreach ( \Composer\Autoload\ClassLoader::getRegisteredLoaders() as $loader ) {
			foreach ( \array_keys( $loader->getClassMap() ) as $fqcn ) {
				if ( ! \str_starts_with( $fqcn, 'Newspack_Nodes\\' ) || ! \str_ends_with( $fqcn, '_Node' ) ) {
					continue;
				}
				if ( ! \is_subclass_of( $fqcn, Node::class ) || ( new \ReflectionClass( $fqcn ) )->isAbstract() ) {
					continue;
				}
				$classes[] = $fqcn;
			}
		}
		// A stale classmap would make this sweep vacuously green.
		$this->assertNotEmpty( $classes, 'the composer classmap lists no node classes (run composer dump-autoload -o)' );
		return $classes;
	}

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

	/** Anon node with one `int` and one `float` positional, both defaulted well away from 0. */
	private function numeric_node(): Node {
		return new class extends Node {
			use Schema_Reflection;

			public int $count   = 0;
			public float $ratio = 0.0;

			public function parse( array $args ): void {
				$this->parse_schema_args( $args );
			}

			public static function node_schema(): array {
				return [
					'arguments' => [
						[ 'name' => 'count', 'type' => 'int', 'default' => 6421 ],
						[ 'name' => 'ratio', 'type' => 'float', 'default' => 3.75 ],
					],
				];
			}
		};
	}

	public function test_parse_schema_args_refuses_a_non_numeric_int_token(): void {
		// (int) 'abc' is 0, and 0 is a live value for every retention knob and
		// every timer cadence — a typo'd make_node token became a disabled rule
		// or a free-spinning own slot with no trace. It must fail at construction.
		$node = $this->numeric_node();
		$node->name( 'numeric-probe' );

		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( 'count' );

		$node->parse( [ 'abc' ] );
	}

	public function test_parse_schema_args_refuses_a_fractional_int_token(): void {
		// (int) '9.9' silently truncates to 9; the operator asked for neither.
		$node = $this->numeric_node();

		$this->expectException( \InvalidArgumentException::class );

		$node->parse( [ '9.9' ] );
	}

	public function test_parse_schema_args_refuses_an_int_token_past_the_platform_max(): void {
		// A cast saturates at PHP_INT_MAX, which reads as a deliberate ceiling.
		$node = $this->numeric_node();

		$this->expectException( \InvalidArgumentException::class );

		$node->parse( [ '99999999999999999999' ] );
	}

	public function test_parse_schema_args_refuses_a_non_numeric_float_token(): void {
		$node = $this->numeric_node();

		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( 'ratio' );

		$node->parse( [ '12', 'later' ] );
	}

	public function test_parse_schema_args_reads_an_empty_numeric_token_as_absent(): void {
		// A blank positional is a placeholder for "not supplied" — every
		// self-pacing Timer subclass spelled that rule by hand before the trait
		// owned it. Blank must take the schema default, not coerce to zero.
		$node = $this->numeric_node();

		$node->parse( [ '', '' ] );

		$this->assertSame( 6421, $node->count );
		$this->assertSame( 3.75, $node->ratio );
	}

	public function test_parse_schema_args_names_the_node_in_a_refusal(): void {
		// The operator typed a make_node line; the refusal must say which one.
		$node = $this->numeric_node();
		$node->name( 'numeric-probe' );

		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( 'numeric-probe' );

		$node->parse( [ 'nope' ] );
	}

	public function test_parse_schema_args_refuses_an_unresolvable_numeric_default(): void {
		// A <config:key> default that resolves to junk is a deployment bug, and
		// the cast turned it into 0 at every boot.
		Core::register_config_namespace( 'tconf', static fn ( string $k ): mixed => 'junk_count' === $k ? 'not-a-number' : null );

		$node = new class extends Node {
			use Schema_Reflection;

			public int $count = 0;

			public function parse( array $args ): void {
				$this->parse_schema_args( $args );
			}

			public static function node_schema(): array {
				return [
					'arguments' => [
						[ 'name' => 'count', 'type' => 'int', 'default' => '<tconf:junk_count>' ],
					],
				];
			}
		};

		$this->expectException( \InvalidArgumentException::class );

		$node->parse( [] );
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

		$this->assertSame( "ok\n", $commands['set_turbo_mode']( $interpreter, [ 'yes' ] ) );
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
