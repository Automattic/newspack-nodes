<?php
/**
 * Schema_Reflection: builds a node's config by reflecting its node_schema().
 *
 * Two halves of one concern, split off the Node god-object: parse_schema_args()
 * walks node_schema()['arguments'] to assign positional config onto declared
 * properties, and auto_wire_interpreter() builds the sibling `{name}:config`
 * Command_Interpreter from node_schema()['commands']. Both are pure reflection
 * of the schema; the rest of Node (wiring, fill, rate-limiters) is left alone.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

trait Schema_Reflection {

	/**
	 * Walk node_schema()['arguments'] and assign each declared positional arg to
	 * the matching $this->{$name} property, coerced to its declared type. Tokens
	 * beyond the declared positions are ignored; a missing token falls back to the
	 * arg's schema default, or throws if the arg is `required` (so an under-argged
	 * make_node fails loudly). No-ops only for a node with no declared arguments —
	 * the assignment half of Tachikoma's per-node arguments() parsing.
	 *
	 * @param list<string> $args Raw positional argument tokens.
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
	 * a positional token arrives pre-resolved but a default does not. Any other
	 * default (constant, array, plain string) is used verbatim.
	 */
	private function resolve_default( mixed $default, string $type, string $name ): mixed {
		if ( \is_string( $default ) && \preg_match( '/<[a-zA-Z_]\w*:[a-zA-Z_]\w*>/', $default ) ) {
			return $this->coerce_argument( Core::resolve_config_tokens( $default, true ), $type, $name );
		}
		return $default;
	}

	/**
	 * Coerce a raw token to the declared schema type; unknown types pass through
	 * as string.
	 *
	 * The numeric types REFUSE rather than cast, because 0 is a live value for
	 * every retention knob and every timer cadence: a cast would make a mistyped
	 * token indistinguishable from a disabled rule or a free-spinning own slot.
	 * `int` reads through `Core::canonical_decimal()`, which also rejects a
	 * fractional token and one past the platform maximum, and takes no sign —
	 * every declared int argument is a size, a count or a duration. `float`
	 * accepts any numeric.
	 *
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
		throw $this->bad_argument( "{$name} wants {$wanted}, got '{$token}'" );
	}

	/**
	 * THE refusal a node raises for an argument it will not take, naming itself
	 * the way the make_node line does: class as the shell spells it, then
	 * instance name — a boot with five Partitions says which one.
	 *
	 * @param string $detail What was wrong, in the caller's words.
	 */
	protected function bad_argument( string $detail ): \InvalidArgumentException {
		$who = Command_Interpreter_Node::shell_name_for( $this );
		if ( '' !== $this->name ) {
			$who .= " '{$this->name}'";
		}
		return new \InvalidArgumentException( \esc_html( "Bad arguments for {$who}: {$detail}" ) );
	}

	/** THE bool parse for schema args and toggle verbs (JS mirror: `truthy` in runtime/node.js). */
	protected static function truthy( string $token ): bool {
		return \in_array( \strtolower( $token ), [ '1', 'true', 'yes', 'on' ], true );
	}

	/**
	 * Round-trippable `command_node {name}:config <verb> 1` lines for every schema-declared
	 * toggle currently ON — the dump_config fragment the old per-toggle ritual
	 * (handler + fragment + truthy-parse) hand-rolled per class. node_schema()'s
	 * `toggle` key is the whole declaration.
	 */
	protected function dump_toggles(): string {
		$out      = '';
		$commands = static::node_schema()['commands'] ?? [];
		foreach ( \is_array( $commands ) ? $commands : [] as $verb ) {
			if ( ! \is_array( $verb ) ) {
				continue;
			}
			$prop = Core::as_string( $verb['toggle'] ?? '' );
			if ( '' !== $prop && ( $verb['dump'] ?? true ) && ( $this->{$prop} ?? false ) ) {
				$out .= $this->config_line( Core::as_string( $verb['name'] ?? '' ), '1' );
			}
		}
		return $out;
	}

	/**
	 * Auto-wire the sibling `{name}:config` interpreter from node_schema()['commands'].
	 * Called from the Node constructor. No-op for a Command_Interpreter itself, for a
	 * node that already attached its own interpreter (idempotent), or for a schema with
	 * no handler-bearing verbs.
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
		if ( '' !== $this->name ) {
			$this->interpreter->name( $this->name . ':config' );
		}
	}

	/**
	 * Collect the node_schema verbs[] that carry a callable handler — the
	 * `{node}:config` dispatch table. Silent: catalog-only verbs (no handler)
	 * are skipped, not flagged, because a plain node legitimately declares
	 * description-only verbs for the palette. (Service_CI_Node, where every verb
	 * MUST dispatch, keeps its own warn-on-missing-handler builder.)
	 *
	 * @param array<string,mixed> $schema
	 * @return array<string,callable>
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
				// Declarative toggle: synthesize the truthy-set handler.
				$table[ $name ] = static function ( Command_Interpreter_Node $interpreter, array $args ) use ( $prop ): string {
					$patron = $interpreter->patron();
					if ( $patron instanceof static ) {
						$patron->{"set_{$prop}"}( self::truthy( Core::as_string( $args[0] ?? '' ) ) );
					}
					return "ok\n";
				};
				continue;
			}
			if ( ! isset( $verb['handler'] ) || ! \is_callable( $verb['handler'] ) ) {
				continue;
			}
			$table[ $name ] = $verb['handler'];
		}
		return $table;
	}
}
