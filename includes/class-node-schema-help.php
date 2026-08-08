<?php
/**
 * Node_Schema_Help: render a node's node_schema() as an errors-as-docs text
 * help block. The DX presentation layer over a schema owned by
 * Schema_Reflection — extracted from Command_Interpreter_Node, whose `help`
 * node-type branch delegates here. Reuses the ONE table renderer,
 * Command_Interpreter_Node::tabulate().
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Node_Schema_Help {

	/**
	 * Render a node's node_schema() as a text help block: header (type + category),
	 * description, capability flags, then argument / command / request / registration
	 * sections — each present only when the schema declares it.
	 *
	 * @param string               $type   Shell type token (e.g. `Partition`).
	 * @param array<string, mixed> $schema The node's node_schema().
	 */
	public static function render( string $type, array $schema ): string {
		$category = isset( $schema['category'] ) ? ' — ' . Core::as_string( $schema['category'] ) : '';
		$out      = [ "### {$type}{$category} ###" ];
		if ( isset( $schema['description'] ) ) {
			$out[] = Core::as_string( $schema['description'] );
		}

		$flags = [];
		foreach ( [ 'accepts_fill', 'has_target' ] as $flag ) {
			if ( isset( $schema[ $flag ] ) ) {
				$flags[] = $flag . '=' . ( $schema[ $flag ] ? 'true' : 'false' );
			}
		}
		if ( ! empty( $flags ) ) {
			$out[] = \implode( '  ', $flags );
		}

		$arg_rows = [];
		foreach ( self::schema_list( $schema, 'arguments' ) as $arg ) {
			if ( ! \is_array( $arg ) ) {
				continue;
			}
			$spec = ! empty( $arg['required'] )
				? 'required'
				: ( \array_key_exists( 'default', $arg ) ? '=' . self::render_default( $arg['default'] ) : '' );
			$arg_rows[] = [ Core::as_string( $arg['name'] ?? '' ), Core::as_string( $arg['type'] ?? '' ), $spec, Core::as_string( $arg['description'] ?? '' ) ];
		}
		if ( ! empty( $arg_rows ) ) {
			$out[] = 'ARGUMENTS';
			$out[] = Command_Interpreter_Node::tabulate( [ 'left', 'left', 'left', 'left' ], null, $arg_rows );
		}

		foreach ( [ 'commands' => 'COMMANDS', 'requests' => 'REQUESTS' ] as $field => $label ) {
			$rows = [];
			foreach ( self::schema_list( $schema, $field ) as $entry ) {
				if ( ! \is_array( $entry ) ) {
					continue;
				}
				$rows[] = [ Core::as_string( $entry['name'] ?? '' ), Core::as_string( $entry['description'] ?? '' ) ];
			}
			if ( ! empty( $rows ) ) {
				$out[] = $label;
				$out[] = Command_Interpreter_Node::tabulate( [ 'left', 'left' ], null, $rows );
			}
		}

		$registrations = self::schema_list( $schema, 'registrations' );
		if ( ! empty( $registrations ) ) {
			$out[] = 'REGISTRATIONS: ' . \implode( ', ', \array_map( static fn ( $r ): string => Core::as_string( $r ), $registrations ) );
		}
		return \implode( "\n", $out ) . "\n";
	}

	/** Render an argument's default for the help table: bools as true/false, arrays as [], else the scalar. */
	private static function render_default( mixed $default ): string {
		if ( \is_bool( $default ) ) {
			return $default ? 'true' : 'false';
		}
		if ( \is_array( $default ) ) {
			return '[]';
		}
		return Core::as_string( $default );
	}

	/**
	 * Extract a node_schema() section (a `mixed` value) as a plain list; a
	 * non-array section yields []. Callers guard each entry's own shape.
	 *
	 * @param array<string, mixed> $schema
	 * @return list<mixed>
	 */
	private static function schema_list( array $schema, string $key ): array {
		$list = $schema[ $key ] ?? null;
		return \is_array( $list ) ? \array_values( $list ) : [];
	}
}
