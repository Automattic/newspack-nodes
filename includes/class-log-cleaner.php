<?php
/**
 * Log_Cleaner: log-only GC for orphan flat-layout data dirs.
 *
 * Sweeps `logs/{name}.p{N}/` and `offsets/{name}.p{N}/` against a config-declared
 * set (topology .tsl declarations + PHP-registered producers). Liveness-free: it
 * does NOT read worker locks, lock dirs, ipc dirs, or live-worker descriptors —
 * worker/topology lifecycle (the "orange") lives in Supervisor.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Log_Cleaner {

	/**
	 * Remove flat `logs/*.p*` + `offsets/*.p*` dirs not in the config-declared set.
	 *
	 * Each sweep is independently fail-closed: an empty declared set means the app
	 * isn't loaded, so the sweep is skipped rather than wiping live data.
	 *
	 * @param string $base_dir Base data directory.
	 * @return array<int,string> Absolute paths of the directories removed.
	 */
	public static function cleanup_orphan_partitions( string $base_dir ): array {
		$base_dir = \rtrim( $base_dir, '/' );
		$deleted  = [];

		$log_set = self::declared_log_dirs();
		if ( ! empty( $log_set ) ) {
			self::sweep( "{$base_dir}/logs", \array_flip( $log_set ), $base_dir, $deleted );
		}

		$offset_set = self::declared_offset_dirs();
		if ( ! empty( $offset_set ) ) {
			self::sweep( "{$base_dir}/offsets", \array_flip( $offset_set ), $base_dir, $deleted );
		}

		return $deleted;
	}

	/**
	 * Delete every `*.p<n>` dir under `$dir` whose basename is not in `$declared`.
	 *
	 * @param string             $dir      Directory to sweep (e.g. `{base}/logs`).
	 * @param array<string,int>  $declared Declared basenames flipped to a set.
	 * @param string             $base_dir Jail root for delete_directory_recursive.
	 * @param array<int,string>  $deleted  Accumulator, appended in place when a dir is gone.
	 */
	private static function sweep( string $dir, array $declared, string $base_dir, array &$deleted ): void {
		foreach ( @\glob( "{$dir}/*.p*", \GLOB_ONLYDIR ) ?: [] as $path ) {
			$name = \basename( $path );
			if ( ! \preg_match( '/\.p\d+$/', $name ) || isset( $declared[ $name ] ) ) {
				continue;
			}
			Supervisor_Base::delete_directory_recursive( $path, $base_dir );
			if ( ! \is_dir( $path ) ) {
				$deleted[] = $path;
			}
		}
	}

	/**
	 * Declared LOG dir basenames (`{basename}.p{N}`): every on-disk topology's
	 * Partition basenames expanded over its SPAWN-aligned partition count
	 * (`Bootstrap::num_partitions_for`), unioned with each PHP-registered producer
	 * (`newspack_nodes/registered_log_producers`) expanded over the global config
	 * num_partitions.
	 *
	 * @return array<int,string>
	 */
	public static function declared_log_dirs(): array {
		$out = [];
		foreach ( self::declared_partition_counts() as $name => $np ) {
			foreach ( Topology_Registry::basenames_for( $name ) as $basename ) {
				for ( $p = 0; $p < $np; $p++ ) {
					$out[ "{$basename}.p{$p}" ] = true;
				}
			}
		}

		$cfg_np = self::config_num_partitions();
		foreach ( self::registered_producers() as $producer ) {
			for ( $p = 0; $p < $cfg_np; $p++ ) {
				$out[ "{$producer}.p{$p}" ] = true;
			}
		}

		return \array_keys( $out );
	}

	/**
	 * Declared OFFSET dir basenames (`{basename}.p{N}`): every on-disk topology's
	 * Consumer offsetlogs, already `.p<n>`-substituted by `offset_basenames_for`.
	 *
	 * Known limitation: `offset_basenames_for()`/`write_set()` only recognize
	 * `make_node Consumer` offsetlogs, not `make_node Tail`. No production or
	 * example .tsl uses Tail (only a substrate test fixture), so a Tail offsetlog
	 * under `offsets/*.p*` is not in the declared set and would be swept. Extend
	 * the registry parser if a Tail-with-offsetlog topology ever ships.
	 *
	 * @return array<int,string>
	 */
	public static function declared_offset_dirs(): array {
		$out = [];
		foreach ( self::declared_partition_counts() as $name => $np ) {
			for ( $p = 0; $p < $np; $p++ ) {
				foreach ( Topology_Registry::offset_basenames_for( $name, $p ) as $basename ) {
					$out[ $basename ] = true;
				}
			}
		}
		return \array_keys( $out );
	}

	/**
	 * Per-topology partition count for every on-disk topology, keyed by name.
	 * The count is the SPAWN-aligned `Bootstrap::num_partitions_for()` derivation
	 * (catalog → frontmatter → config default, clamped [1, MAX_PARTITIONS]) — NOT
	 * a bare `synthesize_entry`, which would default a frontmatter-less topology
	 * to 1 while the supervisor spawns it at the global config count.
	 *
	 * @return array<string,int> `{topology name => partition count}`.
	 */
	private static function declared_partition_counts(): array {
		$counts = [];
		foreach ( Topology_Registry::list() as $name ) {
			$counts[ $name ] = Bootstrap::num_partitions_for( $name );
		}
		return $counts;
	}

	/** Global config num_partitions, clamped [1, MAX_PARTITIONS] (mirrors Bootstrap::num_partitions_for). */
	private static function config_num_partitions(): int {
		$cfg = Config::load_config();
		$raw = $cfg['num_partitions'] ?? 1;
		return \max( 1, \min( Supervisor_Base::MAX_PARTITIONS, (int) ( \is_scalar( $raw ) ? $raw : 1 ) ) );
	}

	/**
	 * Non-empty string producer basenames from the registration filter.
	 *
	 * @return array<int,string>
	 */
	private static function registered_producers(): array {
		$producers = \apply_filters( 'newspack_nodes/registered_log_producers', [] );
		if ( ! \is_array( $producers ) ) {
			return [];
		}
		$out = [];
		foreach ( $producers as $producer ) {
			if ( \is_string( $producer ) && '' !== $producer ) {
				$out[ $producer ] = true;
			}
		}
		return \array_keys( $out );
	}
}
