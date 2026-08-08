<?php
/**
 * Restart_Planner — resolves a Field's restart classification to the set of
 * ACTIVE topology names a settings-save must restart.
 *
 * Classification is by CONSUMER NODE TYPE, never by topology name: topology
 * names are deployment config (renamable, user-dir-shadowable) and any
 * name-keyed classification drifts silently — a touch lands on a nonexistent
 * lock dir and no-ops. A node CLASS is a stable code-level identifier. A
 * topology consumes a field iff its parsed graph instantiates a node whose
 * class matches (by ancestry) one of the field's declared consumer types, so
 * `Log` matches a `Partition` declaration and `Tap` matches `Tee`.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Config_System;

use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Lock_Node;
use Newspack_Nodes\Topology_Analyzer;
use Newspack_Nodes\Topology_Registry;

\defined( 'ABSPATH' ) || exit;

class Restart_Planner {

	/**
	 * Touch the restart flag in every partition lock dir of each topology a save
	 * of $restart must restart; return the topology names touched.
	 *
	 * @param array<int,string>|string $restart   Restart classification (see topologies_for()).
	 * @param string                   $locks_dir Locks directory holding the per-partition lock dirs.
	 * @return array<int,string>
	 */
	public static function request_restarts( array|string $restart, string $locks_dir ): array {
		if ( ! Bootstrap::fleet_site() ) {
			return [];
		}
		$topologies = self::topologies_for( $restart );
		foreach ( $topologies as $name ) {
			$count = Bootstrap::num_partitions_for( $name );
			for ( $p = 0; $p < $count; $p++ ) {
				Lock_Node::request_restart_at( "{$locks_dir}/{$name}.p{$p}.lock.d" );
			}
		}
		return $topologies;
	}

	/**
	 * Active topology names a save of a field with this classification restarts.
	 *
	 * @param array<int,string>|string $restart [] | 'all' | node-type tokens.
	 * @return array<int,string>
	 */
	public static function topologies_for( array|string $restart ): array {
		if ( [] === $restart ) {
			return [];
		}
		$active = \array_map( 'strval', \array_keys( Bootstrap::get_topologies() ) );
		if ( 'all' === $restart ) {
			return $active;
		}
		if ( ! \is_array( $restart ) ) {
			return [];
		}
		$want = self::resolve_types( $restart );
		if ( [] === $want ) {
			return [];
		}
		return \array_values(
			\array_filter( $active, static fn( string $name ): bool => self::topology_has_consumer( $name, $want ) )
		);
	}

	/**
	 * The match is ancestry-DIRECTIONAL: a graph node matches when it IS-A a
	 * declared type (so a declared `Partition` catches a `Log` node), NOT the
	 * reverse — declaring a subclass will not catch a parent node.
	 *
	 * @param string            $name Topology name.
	 * @param array<int,string> $want FQCNs.
	 */
	private static function topology_has_consumer( string $name, array $want ): bool {
		foreach ( Topology_Analyzer::graph_for( $name )['nodes'] as $node ) {
			$type = $node['type'] ?? '';
			if ( ! \is_string( $type ) || '' === $type ) {
				continue;
			}
			$fqcn = Command_Interpreter_Node::resolve_class( $type );
			if ( null === $fqcn ) {
				continue;
			}
			foreach ( $want as $want_fqcn ) {
				if ( \is_a( $fqcn, $want_fqcn, true ) ) {
					return true;
				}
			}
		}
		return false;
	}

	/**
	 * @param array<int,string> $types Node-type tokens to resolve.
	 * @return array<int,string> FQCNs (unknowns dropped).
	 */
	private static function resolve_types( array $types ): array {
		$out = [];
		foreach ( $types as $type ) {
			$fqcn = Command_Interpreter_Node::resolve_class( $type );
			if ( null !== $fqcn ) {
				$out[] = $fqcn;
			}
		}
		return $out;
	}

	/**
	 * Touch the reload flag in every partition lock dir of every ACTIVE topology;
	 * return the topology names touched.
	 *
	 * Unclassified by design, and the counterpart to `request_restarts()`: a
	 * restart classification says which workers must RECYCLE, while every worker
	 * alive holds a Config cache frozen at boot and so must re-read whatever
	 * changed. Without this, a field classified `[]` waits
	 * out a whole ~595s worker lifetime instead of landing on the next 15s
	 * window. Reload costs no process recycle, so the broad fan-out is cheap.
	 *
	 * @param string $locks_dir Locks directory holding the per-partition lock dirs.
	 * @return array<int,string>
	 */
	public static function request_reloads( string $locks_dir ): array {
		if ( ! Bootstrap::fleet_site() ) {
			return [];
		}
		$topologies = \array_map( 'strval', \array_keys( Bootstrap::get_topologies() ) );
		foreach ( $topologies as $name ) {
			$count = Bootstrap::num_partitions_for( $name );
			for ( $p = 0; $p < $count; $p++ ) {
				Lock_Node::request_reload_at( "{$locks_dir}/{$name}.p{$p}.lock.d" );
			}
		}
		return $topologies;
	}
}
