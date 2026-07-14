<?php
/**
 * TopologyDurability: audit a topologies dir for readers wired without durability.
 *
 * A reader's offsetlog and dead-letter dirs are ARGUMENTS, and an omitted one is
 * SILENT — no cursor means it replays from the head on every restart; no
 * quarantine means poison is logged and dropped. Nothing at runtime complains, so
 * the guard belongs here: every reader a topology declares must declare both.
 *
 * Positions come from the node's own `node_schema()`, so this follows an argument
 * rename or reorder instead of hardcoding a column.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Helpers;

use Newspack_Nodes\Command_Interpreter_Node;

class TopologyDurability {

	/** The args that make a reader durable. Absent = silently disabled. */
	public const REQUIRED_ARGS = [ 'offsetlog_dir', 'deadletter_dir' ];

	/**
	 * @param string $dir Directory of `.tsl` files.
	 * @return string[] One message per reader missing a durability arg; empty = clean.
	 */
	public static function audit( string $dir ): array {
		$violations = [];
		foreach ( \glob( \rtrim( $dir, '/' ) . '/*.tsl' ) ?: [] as $file ) {
			$lines = \file( $file, \FILE_IGNORE_NEW_LINES ) ?: [];
			foreach ( $lines as $i => $line ) {
				$found = self::audit_line( \trim( $line ) );
				foreach ( $found as $arg_name => $type_and_name ) {
					$violations[] = \sprintf(
						'%s:%d  %s omits %s',
						\basename( $file ),
						$i + 1,
						$type_and_name,
						$arg_name
					);
				}
			}
		}
		return $violations;
	}

	/**
	 * @param string $line One trimmed `.tsl` line.
	 * @return array<string, string> arg_name => "name (Type)", for each omitted arg.
	 */
	private static function audit_line( string $line ): array {
		if ( ! \preg_match( '/^make_node\s+(\S+)\s+(\S+)\s*(.*)$/', $line, $m ) ) {
			return [];
		}
		[ , $type, $name, $rest ] = $m;
		$fqcn                     = Command_Interpreter_Node::resolve_class( $type );
		if ( null === $fqcn || ! \method_exists( $fqcn, 'node_schema' ) ) {
			return [];
		}
		$schema = $fqcn::node_schema();
		$args   = $schema['arguments'] ?? [];
		$tokens = '' === $rest ? [] : \preg_split( '/\s+/', $rest );

		$missing = [];
		foreach ( $args as $position => $arg ) {
			$arg_name = $arg['name'] ?? '';
			if ( ! \in_array( $arg_name, self::REQUIRED_ARGS, true ) ) {
				continue;
			}
			if ( ! isset( $tokens[ $position ] ) || '' === $tokens[ $position ] ) {
				$missing[ $arg_name ] = "{$name} ({$type})";
			}
		}
		return $missing;
	}
}
