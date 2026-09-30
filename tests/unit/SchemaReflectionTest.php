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
		// VerbButton with no args, and the synthesized toggle handler reads that
		// as off. So a toggle that declares no argument is a button that can
		// only ever DISABLE the thing it names, with no way to turn it back on
		// from the canvas.
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

	public function test_a_subclass_takes_a_positional_its_parent_holds_private_and_unset(): void {
		$node = new class extends Private_Span_Node {};

		$node->parse( [ '37' ] );

		$this->assertSame( 37, $node->span() );
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

	public function test_parse_schema_args_refusal_assigns_nothing(): void {
		// A refused reconfiguration must leave the node as it was, not half-set.
		$node = $this->numeric_node();
		$node->parse( [ '55', '1.5' ] );

		try {
			$node->parse( [ '12', 'later' ] );
			$this->fail( 'a non-numeric float must refuse' );
		} catch ( \InvalidArgumentException $e ) {
			$this->assertStringContainsString( 'ratio', $e->getMessage() );
		}

		$this->assertSame( 55, $node->count );
		$this->assertSame( 1.5, $node->ratio );
		$this->assertSame( [ '55', '1.5' ], $node->arguments() );
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
							'args'        => [ [ 'name' => 'on', 'type' => 'bool' ] ],
							'toggle'      => 'turbo_mode',
						],
					],
				];
			}
		};
	}

	public function test_schema_setter_synthesizes_the_verb_handler(): void {
		// The string twin of `toggle`. Without it every plugin hand-rolls the
		// same trim-and-assign closure per target verb, and the matching
		// `dump_config` line with it.
		$node = $this->setter_node();
		$node->name( 'setter-probe' );
		$node->wire();

		$commands = $node->interpreter()->commands();
		$this->assertArrayHasKey( 'set_relay_target', $commands );

		$this->assertSame( "ok\n", $node->interpreter()->dispatch( 'set_relay_target', [ '  alerts:partition  ' ] ) );
		$this->assertSame( 'alerts:partition', $this->read_private( $node, 'relay_target' ), 'trimmed' );
		$this->assertSame(
			"command_node setter-probe:config set_relay_target alerts:partition\n",
			$node->dump()
		);

		$node->interpreter()->dispatch( 'set_relay_target', [ '' ] );
		$this->assertSame( '', $this->read_private( $node, 'relay_target' ), 'an empty arg clears it' );
		$this->assertSame( '', $node->dump(), 'and a cleared setter dumps nothing' );
	}

	public function test_a_setter_aimed_at_a_foreign_node_refuses(): void {
		// A refusal THROWS; returning "ok" for a write that never happened is
		// the silent guard `Dead_Letter_Queue` answers loudly.
		$node = $this->setter_node();
		$node->name( 'setter-probe' );
		$node->wire();
		$commands = $node->interpreter()->commands();

		$foreign = new Command_Interpreter_Node();
		$foreign->name( 'wrong-node:config' );

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'set_relay_target' );
		$commands['set_relay_target']( $foreign, [ 'target' => 'binnacle:partition' ] );
	}

	/** A node whose only verb is a declarative string setter. */
	private function setter_node(): object {
		return new class extends Node {
			use Schema_Reflection;

			protected string $relay_target = '';

			public function set_relay_target( string $name ): void {
				$this->relay_target = $name;
			}

			public function wire(): void {
				$this->auto_wire_interpreter();
			}

			public function dump(): string {
				return $this->dump_setters();
			}

			public static function node_schema(): array {
				return [
					'category'    => 'Test',
					'description' => 'setter probe',
					'arguments'   => [],
					'commands'    => [
						[
							'name'        => 'set_relay_target',
							'description' => 'Name the relay target.',
							'args'        => [ [ 'name' => 'target', 'type' => 'string' ] ],
							'setter'      => 'relay_target',
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

		$this->assertSame( "ok\n", $interpreter->dispatch( 'set_turbo_mode', [ 'yes' ] ) );
		$this->assertTrue( $this->read_private( $node, 'turbo_mode' ) );

		$interpreter->dispatch( 'set_turbo_mode', [ 'off' ] );
		$this->assertFalse( $this->read_private( $node, 'turbo_mode' ), 'a non-truthy arg disables' );
	}

	public function test_schema_toggle_emits_the_dump_config_fragment(): void {
		$node = $this->toggle_node();
		$node->name( 'toggle-probe' );
		$node->wire();

		$this->assertSame( '', $node->dump(), 'default-off toggles emit nothing' );

		$node->interpreter()->dispatch( 'set_turbo_mode', [ '1' ] );
		// `true`, not `1`: the dump is TSL a person reads and edits, and the
		// arg is declared `bool`. `truthy()` accepts either on the way back.
		$this->assertSame( "command_node toggle-probe:config set_turbo_mode true\n", $node->dump() );
	}

	/** The value rides the verb's one declared arg; with none, nothing carries it. */
	public function test_a_toggle_declaring_no_arg_refuses_at_wiring(): void {
		$node = new class extends Node {
			use Schema_Reflection;

			protected bool $moa_mode = false;

			public function wire(): void {
				$this->auto_wire_interpreter();
			}

			public static function node_schema(): array {
				return [ 'commands' => [ [ 'name' => 'set_moa_mode', 'toggle' => 'moa_mode' ] ] ];
			}
		};

		$this->expectException( \LogicException::class );
		$this->expectExceptionMessage( 'set_moa_mode: the verb declares no arg to carry its value' );
		$node->wire();
	}

	public function test_a_variadic_positional_takes_every_token_from_its_slot_typed(): void {
		$node = new Variadic_Span_Node();
		$node->parse( [ '600', '41', '43' ] );
		$this->assertSame( [ 600, [ 41, 43 ] ], $node->read() );
		$this->assertSame( [ '600', '41', '43' ], $node->arguments(), 'the tokens round-trip' );

		$node->parse( [ '3' ] );
		$this->assertSame( [ 3, [] ], $node->read(), 'no token binds the empty list' );

		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( 'Bad arguments for Variadic_Span: spans wants a whole number' );
		$node->parse( [ '3', '41', 'kea' ] );
	}

	public function test_a_variadic_positional_declared_before_another_is_refused(): void {
		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( 'Invalid argument specification: variadic spans is not the last positional' );
		( new Misplaced_Variadic_Node() )->parse( [ '41', '43', '600' ] );
	}

	// ── declarative request verbs: the `requests` table answers ────────────

	/** Anon node whose one request verb answers from a private field. */
	private function request_node(): Node {
		return new class extends Node {
			use Schema_Reflection;

			private string $probe = 'kea-7713-state';

			public function fill( array $message ): void {
				if ( $this->answer_request( $message ) ) {
					return;
				}
				parent::fill( $message );
			}

			public static function node_schema(): array {
				return [
					'category'    => 'Test',
					'description' => 'request probe',
					'requests'    => [
						[ 'name' => 'GET_DOC_ONLY', 'description' => 'Catalog-only.' ],
						[
							'name'        => 'GET_KEA7713',
							'description' => 'Answers the probe field.',
							'handler'     => static fn ( self $node ): array => [ 'probe' => $node->probe ],
						],
					],
				];
			}
		};
	}

	/**
	 * @param string $value Request VALUE.
	 * @return array<int,mixed>
	 */
	private function request_message( string $value ): array {
		$message                   = \Newspack_Nodes\Message::new_message();
		$message[ \Newspack_Nodes\Message::TYPE ]  = \Newspack_Nodes\Message::TM_REQUEST;
		$message[ \Newspack_Nodes\Message::FROM ]  = 'asker/kea';
		$message[ \Newspack_Nodes\Message::ID ]    = 'id-7713';
		$message[ \Newspack_Nodes\Message::KEY ]   = 'key-7713';
		$message[ \Newspack_Nodes\Message::VALUE ] = $value;
		return $message;
	}

	public function test_a_declared_request_handler_answers_its_verb(): void {
		$node    = $this->request_node();
		$capture = new \Newspack_Nodes\Tests\Capture_Sink_Node();
		$node->name( 'kea-probe' );
		$node->sink( $capture );

		$node->fill( $this->request_message( '  get_kea7713 extra words' ) );

		$this->assertCount( 1, $capture->captured );
		$reply = $capture->captured[0];
		$this->assertSame( \Newspack_Nodes\Message::TM_STRUCT | \Newspack_Nodes\Message::TM_RESPONSE, $reply[ \Newspack_Nodes\Message::TYPE ] );
		$this->assertSame( 'kea-probe', $reply[ \Newspack_Nodes\Message::FROM ] );
		$this->assertSame( 'asker/kea', $reply[ \Newspack_Nodes\Message::TO ] );
		$this->assertSame( 'id-7713', $reply[ \Newspack_Nodes\Message::ID ] );
		$this->assertSame( 'key-7713', $reply[ \Newspack_Nodes\Message::KEY ] );
		$this->assertSame(
			[ 'verb' => 'GET_KEA7713', 'data' => [ 'probe' => 'kea-7713-state' ] ],
			$reply[ \Newspack_Nodes\Message::VALUE ]
		);
	}

	public function test_an_undeclared_or_handlerless_request_verb_is_refused_on_the_error_plane(): void {
		$node    = $this->request_node();
		$capture = new \Newspack_Nodes\Tests\Capture_Sink_Node();
		$node->name( 'kea-probe' );
		$node->sink( $capture );

		$node->fill( $this->request_message( 'NOT_KEA' ) );
		$node->fill( $this->request_message( 'get_doc_only' ) );

		$this->assertSame(
			[ "unknown request verb: NOT_KEA\n", "unknown request verb: GET_DOC_ONLY\n" ],
			\array_column( $capture->captured, \Newspack_Nodes\Message::VALUE )
		);
		$reply = $capture->captured[0];
		$this->assertSame( \Newspack_Nodes\Message::TM_ERROR, $reply[ \Newspack_Nodes\Message::TYPE ] );
		$this->assertSame( 'kea-probe', $reply[ \Newspack_Nodes\Message::FROM ] );
		$this->assertSame( 'asker/kea', $reply[ \Newspack_Nodes\Message::TO ] );
		$this->assertSame( 'id-7713', $reply[ \Newspack_Nodes\Message::ID ] );
		$this->assertSame( 'key-7713', $reply[ \Newspack_Nodes\Message::KEY ] );
	}

	public function test_a_message_without_the_request_flag_is_left_to_the_node(): void {
		$node    = $this->request_node();
		$capture = new \Newspack_Nodes\Tests\Capture_Sink_Node();
		$node->name( 'kea-probe' );
		$node->sink( $capture );
		$message = $this->request_message( 'GET_KEA7713' );
		$message[ \Newspack_Nodes\Message::TYPE ] = \Newspack_Nodes\Message::TM_STRUCT | \Newspack_Nodes\Message::TM_RESPONSE;

		$node->fill( $message );

		$this->assertSame( [ $message ], $capture->captured, 'forwarded untouched by parent::fill' );
	}

	/** Anon node declaring a structured request and a string one, each echoing its argument. */
	private function struct_request_node(): Node {
		return new class extends Node {
			use Schema_Reflection;

			public function fill( array $message ): void {
				if ( $this->answer_request( $message ) ) {
					return;
				}
				parent::fill( $message );
			}

			public static function node_schema(): array {
				return [
					'category'    => 'Test',
					'description' => 'struct request probe',
					'requests'    => [
						[
							'name'        => 'PUT_KEA',
							'description' => 'Echoes its map, refusing an empty one.',
							'value'       => 'struct',
							'handler'     => static fn ( self $node, mixed $map ): array => match ( true ) {
								[] === $map                   => throw new \InvalidArgumentException( 'needs one sku' ),
								[ 'sku-99' => 0 ] === $map    => throw new \RuntimeException( 'kea store down' ),
								default                       => [ 'got' => $map ],
							},
						],
						[
							'name'        => 'CHECK_KEA',
							'description' => 'Takes no argument; its own failure is not a refusal.',
							'handler'     => static fn ( self $node ): array => throw new \InvalidArgumentException( 'kea ledger corrupt' ),
						],
						[
							'name'        => 'ECHO_KEA',
							'description' => 'Echoes the words after its verb.',
							'handler'     => static fn ( self $node, mixed $words ): array => [ 'words' => $words ],
						],
					],
				];
			}
		};
	}

	/**
	 * @param string|array<array-key,mixed> $value Request VALUE.
	 * @return list<mixed> The one reply's TYPE and VALUE.
	 */
	private function asked( Node $node, string|array $value, int $type ): array {
		$capture = new \Newspack_Nodes\Tests\Capture_Sink_Node();
		$node->sink( $capture );
		$message = $this->request_message( '' );
		$message[ \Newspack_Nodes\Message::TYPE ]  = $type;
		$message[ \Newspack_Nodes\Message::VALUE ] = $value;
		$node->fill( $message );
		$this->assertCount( 1, $capture->captured );
		$this->assertSame( [ 'kea-probe', 'asker/kea', 'id-7713' ], [ $capture->captured[0][ \Newspack_Nodes\Message::FROM ], $capture->captured[0][ \Newspack_Nodes\Message::TO ], $capture->captured[0][ \Newspack_Nodes\Message::ID ] ] );
		return [ $capture->captured[0][ \Newspack_Nodes\Message::TYPE ], $capture->captured[0][ \Newspack_Nodes\Message::VALUE ] ];
	}

	public function test_a_declared_struct_request_hands_its_handler_the_map_it_names(): void {
		$node = $this->struct_request_node();
		$node->name( 'kea-probe' );
		$struct = \Newspack_Nodes\Message::TM_REQUEST | \Newspack_Nodes\Message::TM_STRUCT;

		$this->assertSame(
			[ \Newspack_Nodes\Message::TM_STRUCT | \Newspack_Nodes\Message::TM_RESPONSE, [ 'verb' => 'PUT_KEA', 'data' => [ 'got' => [ 'sku-41' => 3 ] ] ] ],
			$this->asked( $node, [ 'PUT_KEA' => [ 'sku-41' => 3 ] ], $struct )
		);
		$this->assertSame(
			[ \Newspack_Nodes\Message::TM_STRUCT | \Newspack_Nodes\Message::TM_RESPONSE, [ 'verb' => 'ECHO_KEA', 'data' => [ 'words' => 'aisle-9  aisle-12' ] ] ],
			$this->asked( $node, ' echo_kea aisle-9  aisle-12 ', \Newspack_Nodes\Message::TM_REQUEST ),
			'a string request hands its handler the words after the verb'
		);
	}

	public function test_a_request_in_the_wrong_form_or_refused_by_its_handler_answers_an_error(): void {
		$node   = $this->struct_request_node();
		$struct = \Newspack_Nodes\Message::TM_REQUEST | \Newspack_Nodes\Message::TM_STRUCT;
		$node->name( 'kea-probe' );

		$this->assertSame( [ \Newspack_Nodes\Message::TM_ERROR, "PUT_KEA: needs a TM_REQUEST|TM_STRUCT map naming one verb\n" ], $this->asked( $node, 'PUT_KEA sku-41', \Newspack_Nodes\Message::TM_REQUEST ) );
		$this->assertSame( [ \Newspack_Nodes\Message::TM_ERROR, "PUT_KEA: needs a TM_REQUEST|TM_STRUCT map naming one verb\n" ], $this->asked( $node, [ 'PUT_KEA' => [ 'sku-41' => 3 ] ], \Newspack_Nodes\Message::TM_REQUEST ), 'a map without the TM_STRUCT bit' );
		$this->assertSame( [ \Newspack_Nodes\Message::TM_ERROR, "PUT_KEA: needs a TM_REQUEST|TM_STRUCT map naming one verb\n" ], $this->asked( $node, [ 'PUT_KEA' => [], 'ECHO_KEA' => [] ], $struct ), 'a map naming two verbs' );
		$this->assertSame( [ \Newspack_Nodes\Message::TM_ERROR, "ECHO_KEA: takes a string request, not a structure\n" ], $this->asked( $node, [ 'ECHO_KEA' => [ 'aisle-9' ] ], $struct ) );
		$this->assertSame( [ \Newspack_Nodes\Message::TM_ERROR, "PUT_KEA: needs one sku\n" ], $this->asked( $node, [ 'PUT_KEA' => [] ], $struct ), 'a handler refuses by throwing' );
		$this->assertSame( [ \Newspack_Nodes\Message::TM_ERROR, "unknown request verb: NOT_KEA\n" ], $this->asked( $node, [ 'NOT_KEA' => [] ], $struct ) );
	}

	public function test_a_handler_failing_on_its_own_account_throws_rather_than_answering(): void {
		$node    = $this->struct_request_node();
		$capture = new \Newspack_Nodes\Tests\Capture_Sink_Node();
		$node->name( 'kea-probe' );
		$node->sink( $capture );
		$message = $this->request_message( '' );
		$message[ \Newspack_Nodes\Message::TYPE ]  = \Newspack_Nodes\Message::TM_REQUEST | \Newspack_Nodes\Message::TM_STRUCT;
		$message[ \Newspack_Nodes\Message::VALUE ] = [ 'PUT_KEA' => [ 'sku-99' => 0 ] ];
		try {
			$node->fill( $message );
			$this->fail( 'a store failure was answered as a refusal' );
		} catch ( \RuntimeException $e ) {
			$this->assertSame( 'kea store down', $e->getMessage(), 'it reaches whatever retries the message' );
		}
		$this->assertSame( [], $capture->captured );
	}

	public function test_a_throw_from_a_handler_taking_no_argument_propagates_whatever_its_class(): void {
		$node    = $this->struct_request_node();
		$capture = new \Newspack_Nodes\Tests\Capture_Sink_Node();
		$node->name( 'kea-probe' );
		$node->sink( $capture );
		try {
			$node->fill( $this->request_message( 'CHECK_KEA' ) );
			$this->fail( 'an argument-free handler\'s failure was answered as a refusal' );
		} catch ( \InvalidArgumentException $e ) {
			$this->assertSame( 'kea ledger corrupt', $e->getMessage() );
		}
		$this->assertSame( [], $capture->captured );
	}

	public function test_a_request_with_no_sink_to_reply_through_throws(): void {
		$node = $this->request_node();
		$node->name( 'kea-probe' );

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'fill requires a wired sink' );
		$node->fill( $this->request_message( 'GET_KEA7713' ) );
	}
}

/** A trait user whose last positional is variadic, typed int. */
class Variadic_Span_Node extends Node {
	use Schema_Reflection;

	/** @var list<int> */
	private array $spans = [ 99 ];

	private int $step = 0;

	public function parse( array $args ): void {
		$this->parse_schema_args( $args );
	}

	/** @return array{0: int, 1: list<int>} */
	public function read(): array {
		return [ $this->step, $this->spans ];
	}

	public static function node_schema(): array {
		return [
			'arguments' => [
				[ 'name' => 'step', 'type' => 'int', 'required' => true ],
				[ 'name' => 'spans', 'type' => 'int', 'variadic' => true ],
			],
		];
	}
}

/** A trait user whose variadic positional is declared before another. */
class Misplaced_Variadic_Node extends Node {
	use Schema_Reflection;

	/** @var list<int> */
	private array $spans = [];

	private int $step = 0;

	public function parse( array $args ): void {
		$this->parse_schema_args( $args );
	}

	public static function node_schema(): array {
		return [
			'arguments' => [
				[ 'name' => 'spans', 'type' => 'int', 'variadic' => true ],
				[ 'name' => 'step', 'type' => 'int', 'required' => true ],
			],
		];
	}
}

/** A trait user whose positional is a private typed field with no initial value. */
class Private_Span_Node extends Node {
	use Schema_Reflection;

	private int $span;

	public function parse( array $args ): void {
		$this->parse_schema_args( $args );
	}

	public function span(): int {
		return $this->span;
	}

	public static function node_schema(): array {
		return [
			'arguments' => [
				[ 'name' => 'span', 'type' => 'int', 'required' => true ],
			],
		];
	}
}
