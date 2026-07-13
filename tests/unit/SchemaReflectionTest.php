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

			public function parse( string $args ): void {
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

		$node->parse( '' );

		$this->assertSame( 7777, $node->count );
	}

	public function test_parse_schema_args_leaves_a_non_token_default_verbatim(): void {
		$node = new class extends Node {
			use Schema_Reflection;

			public string $label = '';

			public function parse( string $args ): void {
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

		$node->parse( '' );

		$this->assertSame( 'plain-default', $node->label );
	}

	public function test_parse_schema_args_noops_when_arguments_schema_is_not_a_list(): void {
		$node = new class extends Node {
			use Schema_Reflection;

			public function parse( string $args ): void {
				$this->parse_schema_args( $args );
			}

			public static function node_schema(): array {
				return [ 'arguments' => 'not-a-list' ];
			}
		};

		$node->parse( 'ignored' );

		$this->assertSame( '', $node->arguments() );
	}

	public function test_parse_schema_args_skips_non_array_entries_and_coerces_float(): void {
		$node = new class extends Node {
			use Schema_Reflection;

			public float $ratio = 0.0;

			public function parse( string $args ): void {
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

		$node->parse( 'ignored 2.5' );

		$this->assertSame( 2.5, $node->ratio );
		$this->assertSame( 'ignored 2.5', $node->arguments() );
	}

	public function test_parse_schema_args_rejects_argument_spec_without_name(): void {
		$node = new class extends Node {
			use Schema_Reflection;

			public function parse( string $args ): void {
				$this->parse_schema_args( $args );
			}

			public static function node_schema(): array {
				return [ 'arguments' => [ [ 'type' => 'string' ] ] ];
			}
		};

		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( 'missing name' );

		$node->parse( 'value' );
	}

	public function test_parse_schema_args_rejects_argument_without_matching_property(): void {
		$node = new class extends Node {
			use Schema_Reflection;

			public function parse( string $args ): void {
				$this->parse_schema_args( $args );
			}

			public static function node_schema(): array {
				return [ 'arguments' => [ [ 'name' => 'missing_property' ] ] ];
			}
		};

		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( 'missing_property' );

		$node->parse( 'value' );
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
}
