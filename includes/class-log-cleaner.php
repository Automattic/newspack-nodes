<?php
/**
 * Log_Cleaner: GC for orphan partition dirs left behind when `num_partitions`
 * shrinks. Removes `{base}/logs/{name}.log/p{N}/` and `{base}/offsets/{src}.p{N}/`
 * where N >= num_partitions AND no `*.p{N}.lock.d/` exists (the worker has
 * fully exited; Lock::release() rmdirs the lock dir on clean exit).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Log_Cleaner {

	/**
	 * WP option set by `Supervisor::check_config` when it detects a fleet
	 * shrink. Cleared by `cleanup_orphan_partitions` once the sweep finishes
	 * without any deferrals. Single source of truth — Supervisor writes,
	 * Log_Cleaner reads / clears.
	 */
	public const LOGS_DIRTY_OPTION = 'newspack_nodes_logs_dirty';

	/**
	 * WP option holding the prior tick's `{type}.p{N}` descriptor set so
	 * the comparison survives supervisor respawns.
	 */
	public const FLEET_DESCRIPTORS_OPTION = 'newspack_nodes_fleet_descriptors';

	/**
	 * Walk the on-disk log and offsetlog trees under $base_dir and remove any
	 * `p{N}` directory where N >= $num_partitions AND no `*.p{N}.lock.d/`
	 * exists under `{base_dir}/locks/`. Deletes happen via
	 * SupervisorBase::delete_directory_recursive — inherits containment-to-
	 * base_dir + depth-cap + symlink-skip from the substrate primitive.
	 *
	 * @param string $base_dir       Base data directory (e.g. `/tmp/newspack-nodes`).
	 * @param int    $num_partitions Current configured partition count.
	 * @return array<int,string>     Absolute paths of the directories that were removed.
	 */
	public static function cleanup_orphan_partitions( string $base_dir, int $num_partitions ): array {
		// Steady-state short-circuit. Supervisor arms LOGS_DIRTY_OPTION
		// on observed fleet shrink (topology disabled or num_partitions
		// reduced); we no-op otherwise.
		if ( empty( \get_option( self::LOGS_DIRTY_OPTION, false ) ) ) {
			return [];
		}

		$base_dir = \rtrim( $base_dir, '/' );
		$deleted  = [];
		$blocked  = false;
		// Lock-dir presence is gated per partition N, not per directory: same
		// `*.p{N}.lock.d` glob serves both the logs/ and offsets/ sweeps.
		$has_lock = [];
		$is_orphan = static function ( int $n ) use ( &$has_lock, &$blocked, $base_dir, $num_partitions ): bool {
			if ( $n < $num_partitions ) {
				return false;
			}
			if ( ! isset( $has_lock[ $n ] ) ) {
				$has_lock[ $n ] = ! empty(
					@\glob( "{$base_dir}/locks/*.p{$n}.lock.d", \GLOB_ONLYDIR )
				);
			}
			if ( $has_lock[ $n ] ) {
				$blocked = true;
				return false;
			}
			return true;
		};

		foreach ( self::orphan_dirs( $base_dir, $is_orphan ) as $dir ) {
			SupervisorBase::delete_directory_recursive( $dir, $base_dir );
			if ( \is_dir( $dir ) ) {
				$blocked = true;
				continue;
			}
			$deleted[] = $dir;
		}

		// Topology-shrink sweep: entire `*.log/` dirs whose basename isn't
		// in the application's `newspack_nodes/expected_log_basenames`
		// filter result. Substrate trusts the filter — it's the
		// application's job to keep a basename "expected" while any
		// worker that touches it is still running. The substrate has no
		// basename → worker-type map and a blanket lock-dir gate would
		// permanently defer cleanup in any live system (workers are
		// always running for the survivors). Skipped when the
		// application hasn't registered the filter (empty array →
		// back-compat: only partition-slice cleanup runs).
		$expected = \apply_filters( 'newspack_nodes/expected_log_basenames', [] );
		if ( \is_array( $expected ) && ! empty( $expected ) ) {
			$expected_set = \array_flip( $expected );
			foreach ( @\glob( "{$base_dir}/logs/*.log", \GLOB_ONLYDIR ) ?: [] as $log_dir ) {
				if ( ! \preg_match( '#/([^/]+)\.log$#', $log_dir, $m ) ) {
					continue;
				}
				if ( isset( $expected_set[ $m[1] ] ) ) {
					continue;
				}
				SupervisorBase::delete_directory_recursive( $log_dir, $base_dir );
				if ( \is_dir( $log_dir ) ) {
					$blocked = true;
					continue;
				}
				$deleted[] = $log_dir;
			}
		}

		// Clear the flag only when nothing deferred us. A still-running
		// pre-shrink worker keeps it set until its lock dir clears.
		if ( ! $blocked ) {
			\delete_option( self::LOGS_DIRTY_OPTION );
		}
		return $deleted;
	}

	/**
	 * Yield every `p{N}` directory under `{base}/logs/*.log/` and `{base}/offsets/*.p*`
	 * where `$is_orphan( N )` returns true.
	 *
	 * @return iterable<string>
	 */
	private static function orphan_dirs( string $base_dir, callable $is_orphan ): iterable {
		// Data partitions.
		foreach ( @\glob( "{$base_dir}/logs/*.log", \GLOB_ONLYDIR ) ?: [] as $log_dir ) {
			foreach ( @\glob( "{$log_dir}/p*", \GLOB_ONLYDIR ) ?: [] as $pdir ) {
				if ( \preg_match( '#/p(\d+)$#', $pdir, $m ) && $is_orphan( (int) $m[1] ) ) {
					yield $pdir;
				}
			}
		}
		// Per-Consumer offsetlogs.
		foreach ( @\glob( "{$base_dir}/offsets/*.p*", \GLOB_ONLYDIR ) ?: [] as $odir ) {
			if ( \preg_match( '#\.p(\d+)$#', $odir, $m ) && $is_orphan( (int) $m[1] ) ) {
				yield $odir;
			}
		}
	}
}
