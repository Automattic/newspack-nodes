<?php
/**
 * Restart_Planner — resolves a Field's restart classification to the ACTIVE
 * topology names a settings save must recycle, and signals their workers.
 *
 * Classification is by CONSUMER NODE TYPE, never by topology name: topology
 * names are deployment config (renamable, user-dir-shadowable) and any
 * name-keyed classification drifts silently — a signal lands on a nonexistent
 * lock dir and no-ops. A node CLASS is a stable code-level identifier. A
 * topology consumes a field iff its parsed graph instantiates a node whose
 * class matches (by ancestry) one of the field's declared consumer types, so
 * `Log` matches a `Partition` declaration and `Tap` matches `Tee`.
 *
 * Substrate-coupled on purpose: the hermetic `Config_System` subset a sibling
 * loads without the runtime excludes this file, so reaching Bootstrap, Config
 * and Lock_Node here is legitimate.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Config_System;

use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Config;
use Newspack_Nodes\Core;
use Newspack_Nodes\Lock_Node;
use Newspack_Nodes\Topology_Analyzer;
use Newspack_Nodes\Topology_Registry;
use Newspack_Nodes\Worker_Should_Stop;

\defined( 'ABSPATH' ) || exit;

class Restart_Planner {

	/**
	 * The whole settings-save recipe, for every door a setting comes through:
	 * recycle the workers the classification names, then tell every live worker
	 * to re-read the config cache it froze at boot.
	 *
	 * Best-effort by contract. Resolving the locks directory and reading the
	 * active set both go through config loading, which throws on an unusable
	 * base directory or an unreadable topology file; a save must not fatal on
	 * that, and the next worker generation boots on the new config whatever
	 * happens here.
	 *
	 * @param array<int,string>|string $restart Restart classification (see topologies_for()).
	 * @return array<int,string> Topology names a restart was requested of; empty off the fleet site and on failure.
	 * @throws Worker_Should_Stop When a cooperative stop reaches the planner from inside a worker (ADR-14).
	 */
	public static function plan( array|string $restart ): array {
		try {
			$locks_dir = Config::get_locks_directory();
			$restarted = self::request_restarts( $restart, $locks_dir );
			self::request_reloads( $locks_dir );
			return $restarted;
		} catch ( Worker_Should_Stop $e ) {
			throw $e; // ADR-14: a cooperative stop is not a planning failure.
		} catch ( \Throwable $e ) {
			Core::print_less_often( 'settings: restart planning failed: ', $e->getMessage() );
			return [];
		}
	}

	/**
	 * Write the reload watermark into every partition lock dir of every ACTIVE
	 * topology; return the topology names addressed.
	 *
	 * Unclassified by design, and the counterpart to `request_restarts()`: a
	 * restart classification says which workers must RECYCLE, while every worker
	 * alive holds a Config cache frozen at boot and so must re-read whatever
	 * changed. Without this, a field classified `[]` waits out a whole ~595s
	 * worker lifetime instead of landing on the next 15s `_fleet` scan. A reload
	 * costs no process recycle, so the broad fan-out is cheap.
	 *
	 * @param string $locks_dir Locks directory holding the per-partition lock dirs.
	 * @return array<int,string> Topology names addressed; empty off the fleet site.
	 */
	public static function request_reloads( string $locks_dir ): array {
		return self::fan_out(
			self::topologies_for( 'all' ),
			$locks_dir,
			Lock_Node::request_reload_at( ... )
		);
	}

	/**
	 * Write the restart flag into every partition lock dir of each topology a
	 * save of $restart must recycle; return the topology names addressed.
	 *
	 * @param array<int,string>|string $restart   Restart classification (see topologies_for()).
	 * @param string                   $locks_dir Locks directory holding the per-partition lock dirs.
	 * @return array<int,string> Topology names addressed; empty off the fleet site.
	 */
	public static function request_restarts( array|string $restart, string $locks_dir ): array {
		return self::fan_out(
			self::topologies_for( $restart ),
			$locks_dir,
			Lock_Node::request_restart_at( ... )
		);
	}

	/**
	 * Active topology names a save of a field with this classification restarts.
	 *
	 * Three inputs: `[]` restarts nothing, `'all'` restarts every active
	 * topology, and a list of node-type tokens restarts the active topologies
	 * whose graph instantiates a matching node. Anything else resolves to
	 * nothing. Every answer is drawn from the ACTIVE set, so an inactive
	 * topology is never signalled.
	 *
	 * @param array<int,string>|string $restart [] | 'all' | node-type tokens.
	 * @return array<int,string> Active topology names.
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
	 * True when the parsed graph of $name instantiates a node of one of $want.
	 *
	 * The match is ancestry-DIRECTIONAL: a graph node matches when it IS-A a
	 * declared type (so a declared `Partition` catches a `Log` node), NOT the
	 * reverse — declaring a subclass will not catch a parent node.
	 *
	 * @param string            $name Topology name.
	 * @param array<int,string> $want FQCNs.
	 * @return bool
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
	 * Resolve node-type tokens to concrete Node FQCNs, dropping every token no
	 * registered namespace yields. An unknown token contributes nothing rather
	 * than matching everything, so a typo in a classification recycles no
	 * topology instead of the whole fleet.
	 *
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
	 * Signal every partition lock dir of $topologies; return the names
	 * addressed. A lock dir that does not exist takes no flag and the per-dir
	 * result is discarded, so the return names what was ADDRESSED, never what a
	 * running worker received.
	 *
	 * Off the fleet site nothing is touched — the fleet is network-global, so a
	 * subsite must never reach the main site's lock dirs.
	 *
	 * @param array<int,string>     $topologies Topology names.
	 * @param string                $locks_dir  Locks directory.
	 * @param callable(string):bool $signal     Per-lock-dir signal.
	 * @return array<int,string>
	 */
	private static function fan_out( array $topologies, string $locks_dir, callable $signal ): array {
		if ( ! Bootstrap::fleet_site() ) {
			return [];
		}
		foreach ( $topologies as $name ) {
			$count = Bootstrap::num_partitions_for( $name );
			for ( $p = 0; $p < $count; $p++ ) {
				$signal( "{$locks_dir}/{$name}.p{$p}.lock.d" );
			}
		}
		return $topologies;
	}
}
