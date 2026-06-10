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
	 * beyond the declared positions are ignored; missing optional tokens fall back
	 * to their schema default. No-ops on an empty string or a node with no declared
	 * arguments — the assignment half of Tachikoma's per-node arguments() parsing.
	 *
	 * @param string $args Raw positional argument string.
	 */
	protected function parse_schema_args( string $args ): void {
		if ( '' === $args ) {
			return;
		}
		$declared = static::node_schema()['arguments'] ?? [];
		if ( ! \is_array( $declared ) || empty( $declared ) ) {
			return;
		}
		$tokens = \preg_split( '/\s+/', \trim( $args ), -1, \PREG_SPLIT_NO_EMPTY );
		foreach ( $declared as $i => $arg_spec ) {
			if ( ! \is_array( $arg_spec ) ) {
				continue;
			}
			$name     = Core::as_string( $arg_spec['name'] ?? '' );
			$type_raw = $arg_spec['type'] ?? 'string';
			$type     = \is_string( $type_raw ) ? $type_raw : 'string';
			if ( '' === $name || ! \property_exists( $this, $name ) ) {
				continue;
			}
			if ( isset( $tokens[ $i ] ) ) {
				$this->{$name} = self::coerce_argument( $tokens[ $i ], $type );
			} elseif ( \array_key_exists( 'default', $arg_spec ) ) {
				$this->{$name} = $arg_spec['default'];
			}
		}
	}

	/** Coerce a raw string token to the declared schema type; unknown types pass through as string. */
	private static function coerce_argument( string $token, string $type ): mixed {
		return match ( $type ) {
			'int'   => (int) $token,
			'float' => (float) $token,
			'bool'  => \in_array( \strtolower( $token ), [ '1', 'true', 'yes', 'on' ], true ),
			default => $token,
		};
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
			if ( '' === $name || ! isset( $verb['handler'] ) || ! \is_callable( $verb['handler'] ) ) {
				continue;
			}
			$table[ $name ] = $verb['handler'];
		}
		return $table;
	}
}
