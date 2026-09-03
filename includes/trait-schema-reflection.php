<?php
/**
 * Schema_Reflection: a node's `node_schema()` IS its configuration surface.
 *
 * A node opting in declares its positional arguments and its runtime verbs once,
 * and this trait reads that one declaration three ways. `parse_schema_args()`
 * assigns the positional tokens onto the declared properties (ADR-11).
 * `auto_wire_interpreter()` builds the sibling `{name}:config` interpreter from
 * the declared commands. The `dump_declared()` / `declared_setter()` pair turns a
 * `toggle` or `setter` key into both the verb's handler and its `dump_config()`
 * fragment, so a setting is a declaration rather than the hand-rolled trio —
 * handler, dump fragment, argument parse — each class would otherwise carry.
 *
 * Reflection is the whole of it. Wiring, `fill()` and the rate limiters stay on
 * Node.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

trait Schema_Reflection {

	/**
	 * Walk `node_schema()['arguments']` and assign each declared positional to the
	 * matching `$this->{$name}` property, coerced to its declared type — the
	 * assignment half of Tachikoma's per-node `arguments()` parsing, and the one
	 * place defaults and required-argument enforcement live (ADR-11). Tokens
	 * beyond the declared positions are ignored; a missing token takes the arg's
	 * schema `default`, throws when the arg is `required` (so an under-argged
	 * `make_node` fails loudly), and otherwise leaves the property's declaration
	 * default standing. A node declaring no arguments is a no-op.
	 *
	 * Recording the raw tokens into `$this->arguments` is what makes
	 * `dump_config()` round-trip: it emits the `make_node` line from those tokens,
	 * so a walk that assigned the properties without storing them would replay as
	 * a differently-configured node.
	 *
	 * A declared name that is not a real property is refused rather than assigned:
	 * PHP would take the typo as a dynamic property, which nothing then reads.
	 *
	 * @param list<string> $args Raw positional argument tokens.
	 * @throws \InvalidArgumentException When a spec carries no name, names no
	 *                                   property, a required token is missing, or
	 *                                   a token is not of its declared type.
	 */
	protected function parse_schema_args( array $args ): void {
		$declared = static::node_schema()['arguments'] ?? [];
		if ( ! \is_array( $declared ) || empty( $declared ) ) {
			return;
		}
		foreach ( $declared as $i => $arg_spec ) {
			if ( ! \is_array( $arg_spec ) ) {
				continue;
			}
			$name     = Core::as_string( $arg_spec['name'] ?? '' );
			$type_raw = $arg_spec['type'] ?? 'string';
			$type     = Core::str( $type_raw, 'string' );
			if ( '' === $name ) {
				throw new \InvalidArgumentException( \esc_html( "Invalid argument specification: missing name at position {$i}" ) );
			}
			if ( ! \property_exists( $this, $name ) ) {
				throw new \InvalidArgumentException( \esc_html( "Invalid argument specification: {$name}" ) );
			}
			$token = $args[ $i ] ?? null;
			// A blank numeric positional is a placeholder for "not supplied".
			if ( '' === $token && ( 'int' === $type || 'float' === $type ) ) {
				$token = null;
			}
			if ( null !== $token ) {
				$this->{$name} = $this->coerce_argument( $token, $type, $name );
			} elseif ( \array_key_exists( 'default', $arg_spec ) ) {
				$this->{$name} = $this->resolve_default( $arg_spec['default'], $type, $name );
			} elseif ( \array_key_exists( 'required', $arg_spec ) && $arg_spec['required'] ) {
				throw new \InvalidArgumentException( \esc_html( "Missing required argument: {$name}" ) );
			}
		}
		$this->arguments = $args;
	}

	/**
	 * Resolve a schema-arg default. A `<ns:key>` token default (e.g.
	 * `<config:max_segments>`) is resolved through its namespace resolver and
	 * coerced to the declared type — a schema default lives in PHP and never
	 * passes through the TSL loader that resolves tokens on make_node lines, so
	 * a positional token arrives pre-resolved but a default does not. Resolution
	 * is strict, so a wrong namespace or a typo'd key fails at construction
	 * instead of coercing to a feature-off default. Any other default — a
	 * constant, an array, a plain string — is used verbatim.
	 *
	 * @param mixed  $default The arg spec's declared default.
	 * @param string $type    Declared schema type, applied to the token case only.
	 * @param string $name    Argument name, for the refusal.
	 * @return mixed The value to assign.
	 */
	private function resolve_default( mixed $default, string $type, string $name ): mixed {
		if ( \is_string( $default ) && \preg_match( '/<[a-zA-Z_]\w*:[a-zA-Z_]\w*>/', $default ) ) {
			return $this->coerce_argument( Core::resolve_config_tokens( $default, true ), $type, $name );
		}
		return $default;
	}

	/**
	 * Coerce a raw token to the declared schema type; an unknown type passes
	 * through as a string.
	 *
	 * The numeric types REFUSE rather than cast, because 0 is a live value for
	 * every retention knob and every timer cadence: a cast would make a mistyped
	 * token indistinguishable from a disabled rule or a free-spinning own slot.
	 * `int` reads through `Core::canonical_decimal()`, which also rejects a
	 * fractional token and one past the platform maximum, and takes no sign —
	 * every declared int argument is a size, a count or a duration. `float`
	 * accepts any numeric.
	 *
	 * @param string $token Raw positional token.
	 * @param string $type  Declared schema type.
	 * @param string $name  Argument name, for the refusal.
	 * @return mixed The token as its declared type.
	 * @throws \InvalidArgumentException When a numeric token is not of its declared type.
	 */
	private function coerce_argument( string $token, string $type, string $name ): mixed {
		switch ( $type ) {
			case 'int':
				$int = Core::canonical_decimal( $token );
				if ( null !== $int ) {
					return $int;
				}
				$wanted = 'a whole number';
				break;
			case 'float':
				if ( \is_numeric( $token ) ) {
					return (float) $token;
				}
				$wanted = 'a number';
				break;
			case 'bool':
				return self::truthy( $token );
			default:
				return $token;
		}
		$this->refuse_argument( "{$name} wants {$wanted}, got '{$token}'" );
	}

	/**
	 * THE refusal a node raises for an argument it will not take, naming itself
	 * the way the make_node line does: class as the shell spells it, then
	 * instance name — a boot with five Partitions says which one.
	 *
	 * It throws rather than returning the exception so that the ONE `throw`
	 * carries its own escaping in plain sight; a caller throwing what this
	 * returned would put an unescaped string at every call site instead.
	 *
	 * @param string $detail What was wrong, in the caller's words.
	 * @throws \InvalidArgumentException Always — the caller does not continue.
	 */
	protected function refuse_argument( string $detail ): never {
		$who = Command_Interpreter_Node::shell_name_for( $this );
		if ( '' !== $this->name ) {
			$who .= " '{$this->name}'";
		}
		throw new \InvalidArgumentException( \esc_html( "Bad arguments for {$who}: {$detail}" ) );
	}

	/**
	 * THE bool parse for schema args and toggle verbs: `1`, `true`, `yes` and
	 * `on` read as true in any case, everything else as false. A verb spelling
	 * that list again locally is how it ends up accepting half of it. The JS
	 * mirror is `truthy` in `src/runtime/node.js`.
	 *
	 * @param string $token Raw argument token.
	 * @return bool Whether the token reads as true.
	 */
	protected static function truthy( string $token ): bool {
		return \in_array( \strtolower( $token ), [ '1', 'true', 'yes', 'on' ], true );
	}

	/**
	 * Round-trippable `command_node {name}:config <verb> true` lines for every
	 * schema-declared toggle currently ON — the `dump_config()` half of what a
	 * `toggle` declaration stands for, `declared_setter()` being the handler
	 * half.
	 *
	 * Emits `true`, not `1`: the dump is TSL a person reads, and the arg is
	 * declared `bool`. `truthy()` accepts either coming back.
	 *
	 * @return string Zero or more newline-terminated TSL lines.
	 */
	protected function dump_toggles(): string {
		return $this->dump_declared( 'toggle', static fn ( mixed $value ): string => $value ? 'true' : '' );
	}

	/**
	 * Round-trippable `command_node {name}:config <verb> <value>` lines for every
	 * schema-declared setter currently holding one — the string twin of
	 * `dump_toggles()`. An empty setter dumps nothing: replaying its default is
	 * what `make_node` already does.
	 *
	 * @return string Zero or more newline-terminated TSL lines.
	 */
	protected function dump_setters(): string {
		return $this->dump_declared( 'setter', static fn ( mixed $value ): string => Core::as_string( $value ?? '' ) );
	}

	/**
	 * The one walk both dumps make: every verb declaring $schema_key names a
	 * property, and $render turns that property's value into the argument to
	 * emit — '' meaning nothing to say, so the line is skipped. A verb declaring
	 * `dump => false` is skipped outright, for a setting another dump path owns.
	 *
	 * @param string                 $schema_key Verb declaration key naming the property.
	 * @param callable(mixed):string $render     Property value to emitted argument.
	 * @return string Zero or more newline-terminated TSL lines.
	 */
	private function dump_declared( string $schema_key, callable $render ): string {
		$out      = '';
		$commands = static::node_schema()['commands'] ?? [];
		foreach ( \is_array( $commands ) ? $commands : [] as $verb ) {
			if ( ! \is_array( $verb ) || ! ( $verb['dump'] ?? true ) ) {
				continue;
			}
			$prop = Core::as_string( $verb[ $schema_key ] ?? '' );
			if ( '' === $prop ) {
				continue;
			}
			$value = $render( $this->{$prop} ?? null );
			if ( '' !== $value ) {
				$out .= $this->config_line( Core::as_string( $verb['name'] ?? '' ), $value );
			}
		}
		return $out;
	}

	/**
	 * Auto-wire the sibling `{name}:config` interpreter from
	 * `node_schema()['commands']` and publish it, which is what enrols it in the
	 * rename, sink and teardown cascades. A consuming node calls this from its own
	 * constructor — Node carries none of this trait's behavior.
	 *
	 * No-op for a Command_Interpreter itself, for a node that already attached its
	 * own interpreter (so a second call is idempotent), and for a schema with no
	 * handler-bearing verbs.
	 */
	protected function auto_wire_interpreter(): void {
		if ( $this instanceof Command_Interpreter_Node ) {
			return;
		}
		if ( null !== $this->interpreter ) {
			return;
		}
		$verbs = self::verbs_with_handlers( static::node_schema() );
		if ( empty( $verbs ) ) {
			return;
		}
		$interpreter = new Command_Interpreter_Node();
		$interpreter->patron( $this );
		$interpreter->commands( $verbs );
		$this->interpreter = $interpreter;
		$this->publish_sibling( 'config', $interpreter );
	}

	/**
	 * Build the `{node}:config` dispatch table from `node_schema()['commands']`.
	 * A verb takes its handler from the first of three declarations it carries: a
	 * `toggle`, then a `setter` — each naming a property `declared_setter()`
	 * synthesizes a handler for — then an explicit callable `handler`.
	 *
	 * A verb carrying none of the three is catalog-only and is skipped silently,
	 * not flagged, because a plain node legitimately declares description-only
	 * verbs for the palette. (Service_CI_Node, where every verb MUST dispatch,
	 * keeps its own warn-on-missing-handler builder.)
	 *
	 * @param array<string,mixed> $schema The node's `node_schema()`.
	 * @return array<string,callable> Verb name => handler.
	 */
	private static function verbs_with_handlers( array $schema ): array {
		$table    = [];
		$commands = $schema['commands'] ?? [];
		if ( ! \is_array( $commands ) ) {
			return $table;
		}
		foreach ( $commands as $verb ) {
			if ( ! \is_array( $verb ) ) {
				continue;
			}
			$name = Core::as_string( $verb['name'] ?? '' );
			if ( '' === $name ) {
				continue;
			}
			$prop = Core::as_string( $verb['toggle'] ?? '' );
			if ( '' !== $prop ) {
				$table[ $name ] = self::declared_setter( $prop, self::truthy( ... ) );
				continue;
			}
			$prop = Core::as_string( $verb['setter'] ?? '' );
			if ( '' !== $prop ) {
				// The string twin: trim and assign. An empty arg clears it.
				$table[ $name ] = self::declared_setter( $prop, \trim( ... ) );
				continue;
			}
			if ( ! isset( $verb['handler'] ) || ! \is_callable( $verb['handler'] ) ) {
				continue;
			}
			$table[ $name ] = $verb['handler'];
		}
		return $table;
	}

	/**
	 * Synthesize the handler a `toggle` or `setter` declaration stands for:
	 * coerce the one argument, then hand it to the patron's `set_{$prop}()` — the
	 * class's own typed entry point, so the coerced value lands under the
	 * property's declared type rather than beside it.
	 *
	 * The handler refuses a patron of any other class. An interpreter re-pointed
	 * at a foreign node would otherwise call a `set_` method that class never
	 * declared, and the fatal would name the method rather than the mis-wiring.
	 *
	 * @param string                 $prop   Property the verb writes, minus the `set_` prefix.
	 * @param callable(string):mixed $coerce Raw argument to the setter's type.
	 * @return callable(Command_Interpreter_Node,array<array-key,mixed>):string The verb handler.
	 */
	private static function declared_setter( string $prop, callable $coerce ): callable {
		return static function ( Command_Interpreter_Node $interpreter, array $args ) use ( $prop, $coerce ): string {
			$patron = $interpreter->patron();
			if ( ! $patron instanceof static ) {
				throw new \RuntimeException(
					\esc_html( "set_{$prop}: not a " . static::class )
				);
			}
			$patron->{"set_{$prop}"}( $coerce( Core::as_string( $args[0] ?? '' ) ) );
			return "ok\n";
		};
	}
}
