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
use Newspack_Nodes\Node;
use Newspack_Nodes\Spawn_Coordinator;
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
	 * Every caller runs this after the option row is written, so a failure
	 * here — an unusable base directory or lock tree, an unreadable topology
	 * file, a flag that would not land — propagates to the writer: the save
	 * stands, and the error says the live fleet never heard of it.
	 *
	 * @param array<int,string>|string $restart Restart classification (see topologies_for()).
	 * @return array<int,string> Topology names a restart was requested of; empty off the fleet site.
	 * @throws \Throwable When the base directory, its lock tree, the active set or a flag write fails.
	 */
	public static function plan( array|string $restart ): array {
		$base_dir  = Config::get_base_directory_with_locks();
		$restarted = self::request_restarts( $restart, $base_dir );
		self::request_reloads( $base_dir );
		return $restarted;
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
	 * costs no process recycle, so the broad fan-out is cheap. A Vault write
	 * narrows it to the topologies running a credential consumer, through the
	 * same classification a restart takes.
	 *
	 * @param string                   $base_dir  Runtime state root holding the per-partition lock dirs.
	 * @param array<int,string>|string $consumers Classification of who re-reads (see topologies_for()).
	 * @return array<int,string> Topology names addressed; empty off the fleet site.
	 * @throws \Throwable Every unreadable topology and failed flag write, after every dir was offered its flag.
	 */
	public static function request_reloads( string $base_dir, array|string $consumers = 'all' ): array {
		return self::fan_out( $consumers, $base_dir, Lock_Node::request_reload_at( ... ) );
	}

	/**
	 * Write the restart flag into every partition lock dir of each topology a
	 * save of $restart must recycle; return the topology names addressed.
	 *
	 * @param array<int,string>|string $restart  Restart classification (see topologies_for()).
	 * @param string                   $base_dir Runtime state root holding the per-partition lock dirs.
	 * @return array<int,string> Topology names addressed; empty off the fleet site.
	 * @throws \Throwable Every unreadable topology and failed flag write, after every dir was offered its flag.
	 */
	public static function request_restarts( array|string $restart, string $base_dir ): array {
		return self::fan_out( $restart, $base_dir, Lock_Node::request_restart_at( ... ) );
	}

	/**
	 * Signal every partition lock dir of the topologies $restart classifies;
	 * return the names addressed. A lock dir that does not exist holds no
	 * worker and takes no flag, so the return names what was ADDRESSED, never
	 * what a running worker received. Every readable topology's every dir is
	 * offered its flag before anything escapes, so neither an unreadable
	 * topology nor a dir that refuses the write costs the others their signal.
	 *
	 * Off the fleet site nothing is touched — the fleet is network-global, so a
	 * subsite must never reach the main site's lock dirs.
	 *
	 * @param array<int,string>|string $restart  Classification (see topologies_for()).
	 * @param string                   $base_dir Runtime state root.
	 * @param callable(string):bool    $signal   Per-lock-dir signal.
	 * @return array<int,string>
	 * @throws \Throwable Every unreadable topology and failed signal, combined.
	 */
	private static function fan_out( array|string $restart, string $base_dir, callable $signal ): array {
		if ( ! Bootstrap::fleet_site() ) {
			return [];
		}
		[ $topologies, $unreadable ] = self::classify( $restart );
		$workers                     = [];
		foreach ( $topologies as $name => $entry ) {
			$count = Bootstrap::partitions_of( Core::arr( $entry ) );
			for ( $p = 0; $p < $count; $p++ ) {
				$workers[] = [ $name, $p ];
			}
		}
		Worker_Should_Stop::raise( [
			...$unreadable,
			...Worker_Should_Stop::attempt( static fn () => Spawn_Coordinator::signal_workers( $base_dir, $workers, $signal ) ),
		] );
		return \array_map( 'strval', \array_keys( $topologies ) );
	}

	/**
	 * Active topologies a save of a field with this classification restarts,
	 * keyed by name, each carrying the entry `Bootstrap::get_topologies()`
	 * resolved so a caller counts its partitions without rebuilding the catalog.
	 *
	 * Three inputs: `[]` restarts nothing, `'all'` restarts every active
	 * topology, and a list of node-type tokens restarts the active topologies
	 * whose graph instantiates a matching node. Anything else resolves to
	 * nothing. Every answer is drawn from the ACTIVE set, so an inactive
	 * topology is never signalled.
	 *
	 * @param array<int,string>|string $restart [] | 'all' | node-type tokens.
	 * @return array<string,mixed> Active topology name => entry.
	 * @throws \Throwable Every active topology whose graph would not read.
	 */
	public static function topologies_for( array|string $restart ): array {
		[ $readable, $unreadable ] = self::classify( $restart );
		Worker_Should_Stop::raise( $unreadable );
		return $readable;
	}

	/**
	 * `topologies_for()`'s answer, and what each active topology that will not
	 * read threw instead, by name — `Bootstrap::active_topologies()`'s answer,
	 * so one broken `.tsl` leaves the rest classified. `'all'` reads no graph,
	 * so it signals every configured topology and raises nothing.
	 *
	 * @param array<int,string>|string $restart [] | 'all' | node-type tokens.
	 * @return array{0: array<string,mixed>, 1: array<string,\Throwable>} Classified name => entry, then the failures.
	 */
	private static function classify( array|string $restart ): array {
		if ( [] === $restart ) {
			return [ [], [] ];
		}
		if ( 'all' === $restart ) {
			return [ Bootstrap::get_topologies(), [] ];
		}
		if ( ! \is_array( $restart ) ) {
			return [ [], [] ];
		}
		$want = self::resolve_types( $restart );
		if ( [] === $want ) {
			return [ [], [] ];
		}
		[ $readable, $unreadable ] = Bootstrap::active_topologies();
		$consumers                 = \array_filter(
			$readable,
			static fn ( string $name ): bool => self::topology_has_consumer( $name, $want ),
			\ARRAY_FILTER_USE_KEY
		);
		return [ $consumers, $unreadable ];
	}

	/**
	 * True when the parsed graph of $name instantiates a node of one of $want.
	 *
	 * The match is ancestry-DIRECTIONAL: a graph node matches when it IS-A a
	 * declared type (so a declared `Partition` catches a `Log` node), NOT the
	 * reverse — declaring a subclass will not catch a parent node.
	 *
	 * @param string                   $name Topology name.
	 * @param list<class-string<Node>> $want FQCNs.
	 * @return bool
	 */
	private static function topology_has_consumer( string $name, array $want ): bool {
		return [] !== Topology_Analyzer::nodes_of_type( $name, ...$want );
	}

	/**
	 * Resolve node-type tokens to concrete Node FQCNs, dropping every token no
	 * registered namespace yields. An unknown token contributes nothing rather
	 * than matching everything, so a typo in a classification recycles no
	 * topology instead of the whole fleet.
	 *
	 * @param array<int,string> $types Node-type tokens to resolve.
	 * @return list<class-string<Node>> FQCNs (unknowns dropped).
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
}
