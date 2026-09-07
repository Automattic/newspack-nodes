<?php
/**
 * The `help <NodeType>` block for the REPL. `Command_Interpreter_Node`'s `help`
 * verb falls through to here when a topic names no command but resolves to a
 * node class, so an operator gets that class's `node_schema()` as text rather
 * than `no such topic`.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Errors-as-docs presentation over a `node_schema()`. Ownership of the schema
 * stays with `Schema_Reflection`, whose `parse_schema_args()` assigns the same
 * `arguments` this renders and whose `auto_wire_interpreter()` builds the
 * sibling `{name}:config` verb table from the same `commands`, so one
 * declaration feeds the runtime and the help text alike. Tables render through
 * `Command_Interpreter_Node::tabulate()`, the ONE text-table renderer, which is
 * what keeps a help block column-aligned with the `ls` and `stats` listings and
 * `Log_Sources`' `taillog` table.
 *
 * `CommandInterpreterNode._renderNodeSchema()` in
 * `src/runtime/command-interpreter-node.js` mirrors this renderer for the
 * browser-local interpreter, section for section and column for column. A
 * change here wants the same change there.
 */
class Node_Schema_Help {

	/**
	 * Render a node's schema as a help block: a `### Type — Category ###`
	 * header, the description, the `accepts_fill` and `has_target` flags, then
	 * the ARGUMENTS, COMMANDS, REQUESTS and REGISTRATIONS sections. `tabulate()`
	 * ends its last row with a newline, so a blank line falls between a table
	 * and the label under it.
	 *
	 * A section the schema omits prints nothing — no label, no empty table —
	 * because an empty ARGUMENTS heading reads as a node that takes arguments
	 * and forgot to describe them. In the ARGUMENTS spec column `required` wins
	 * over `default`, since a required argument has no default to show. An entry
	 * that is not an array is skipped, and every cell the schema supplies reads
	 * through `Core::as_string()`: a schema is hand-written in a subclass and
	 * reaches here unvalidated, and `help` must not fatal on a malformed one.
	 *
	 * @param string              $type   Shell type token, as `help` received it (e.g. `Partition`).
	 * @param array<string,mixed> $schema The class's `node_schema()`.
	 * @return string Newline-terminated help block.
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

	/**
	 * Render one argument's declared default for the ARGUMENTS table: `true` or
	 * `false` for a bool, `[]` for an array, otherwise the scalar. An array has
	 * no useful one-line form, and spelling its contents out would wreck the
	 * column alignment. A `<ns:key>` default such as `<config:max_segments>`
	 * passes through verbatim: `Schema_Reflection` resolves it at construction,
	 * and the declaration is what an operator needs to see.
	 *
	 * @param mixed $default The `default` the schema declares for one argument.
	 * @return string A single-line table cell.
	 */
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
	 * Read one `node_schema()` section as a plain list. A section the schema
	 * omits, or declares as something other than an array, yields an empty list
	 * and `render()` then skips it. `array_values()` discards the keys, so a
	 * section written as a map still renders in declaration order. Each entry's
	 * own shape is the caller's guard.
	 *
	 * @param array<string,mixed> $schema The class's `node_schema()`.
	 * @param string              $key    Section name: `arguments`, `commands`, `requests` or `registrations`.
	 * @return list<mixed> The section's entries, keys discarded.
	 */
	private static function schema_list( array $schema, string $key ): array {
		$list = $schema[ $key ] ?? null;
		return \is_array( $list ) ? \array_values( $list ) : [];
	}
}
