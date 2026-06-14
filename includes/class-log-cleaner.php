<?php
/**
 * Log_Cleaner: GC for orphan partition dirs left behind when `num_partitions` shrinks.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Log_Cleaner {

	/** Set by Supervisor on fleet shrink; cleared once a sweep finishes without deferrals. */
	public const LOGS_DIRTY_OPTION = 'newspack_nodes_logs_dirty';

	/** Prior tick's `{type}.p{N}` descriptor set, persisted to survive supervisor respawns. */
	public const FLEET_DESCRIPTORS_OPTION = 'newspack_nodes_fleet_descriptors';

	/**
	 * Remove `p{N}` dirs where N >= $num_partitions AND no matching lock dir exists.
	 *
	 * @param string $base_dir       Base data directory.
	 * @param int    $num_partitions Current configured partition count.
	 * @return array<int,string>     Absolute paths of the directories removed.
	 */
	public static function cleanup_orphan_partitions( string $base_dir, int $num_partitions ): array {
		// Steady-state short-circuit; Supervisor arms LOGS_DIRTY_OPTION on shrink.
		if ( empty( \get_option( self::LOGS_DIRTY_OPTION, false ) ) ) {
			return [];
		}

		$base_dir = \rtrim( $base_dir, '/' );
		$deleted  = [];
		$blocked  = false;
		// Per-N lock-dir presence; one glob serves both the logs/ and offsets/ sweeps.
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
			Supervisor_Base::delete_directory_recursive( $dir, $base_dir );
			if ( \is_dir( $dir ) ) {
				$blocked = true;
				continue;
			}
			$deleted[] = $dir;
		}

		// Topology-shrink sweep of unexpected `*.log/` dirs; skipped when empty so a not-yet-loaded app doesn't wipe every log dir.
		$expected = self::expected_basenames( $base_dir );
		if ( ! empty( $expected ) ) {
			$expected_set = \array_flip( $expected );
			foreach ( @\glob( "{$base_dir}/logs/*.log", \GLOB_ONLYDIR ) ?: [] as $log_dir ) {
				if ( ! \preg_match( '#/([^/]+)\.log$#', $log_dir, $m ) ) {
					continue;
				}
				if ( isset( $expected_set[ $m[1] ] ) ) {
					continue;
				}
				Supervisor_Base::delete_directory_recursive( $log_dir, $base_dir );
				if ( \is_dir( $log_dir ) ) {
					$blocked = true;
					continue;
				}
				$deleted[] = $log_dir;
			}
		}

		$active_descriptors = self::active_descriptors( $base_dir );

		// Topology-shrink sweep of orphaned offsetlog dirs (a source dropped from
		// a topology). Active set = each active descriptor's declared offset basenames.
		$active_offsets = [];
		foreach ( $active_descriptors as $descriptor ) {
			if ( ! \preg_match( '/^(.*)\.p(\d+)$/', $descriptor, $dm ) ) {
				continue;
			}
			foreach ( Topology_Registry::offset_basenames_for( $dm[1], (int) $dm[2] ) as $basename ) {
				$active_offsets[ $basename ] = true;
			}
		}
		// Skip when no active topology declares any Consumer offsetlog (fail-closed: never wipes when the active set is unknown), mirroring the logs sweep's guard.
		if ( ! empty( $active_offsets ) ) {
			foreach ( @\glob( "{$base_dir}/offsets/*.p*", \GLOB_ONLYDIR ) ?: [] as $odir ) {
				$base = \basename( $odir );
				if ( isset( $active_offsets[ $base ] ) || ! \preg_match( '/\.p(\d+)$/', $base ) ) {
					continue;
				}
				if ( self::has_lock_for( $base_dir, $base ) ) {
					$blocked = true;
					continue;
				}
				Supervisor_Base::delete_directory_recursive( $odir, $base_dir );
				if ( \is_dir( $odir ) ) {
					$blocked = true;
					continue;
				}
				$deleted[] = $odir;
			}
		}

		// Sweep IPC dirs for topologies/partitions no longer active.
		$active_ipc = \array_flip( $active_descriptors );
		if ( ! empty( $active_ipc ) ) {
			foreach ( @\glob( "{$base_dir}/ipc/*.p*", \GLOB_ONLYDIR ) ?: [] as $idir ) {
				$base = \basename( $idir );
				if ( isset( $active_ipc[ $base ] ) || ! \preg_match( '/\.p(\d+)$/', $base ) ) {
					continue;
				}
				if ( self::has_lock_for( $base_dir, $base ) ) {
					$blocked = true;
					continue;
				}
				Supervisor_Base::delete_directory_recursive( $idir, $base_dir );
				if ( \is_dir( $idir ) ) {
					$blocked = true;
					continue;
				}
				$deleted[] = $idir;
			}
		}

		// Clear the flag only when nothing deferred us (a pre-shrink worker holds it until its lock clears).
		if ( ! $blocked ) {
			\delete_option( self::LOGS_DIRTY_OPTION );
		}
		return $deleted;
	}

	/**
	 * Yield every `p{N}` dir under logs/ and offsets/ where `$is_orphan( N )` is true.
	 *
	 * @return iterable<string>
	 */
	private static function orphan_dirs( string $base_dir, callable $is_orphan ): iterable {
		foreach ( @\glob( "{$base_dir}/logs/*.log", \GLOB_ONLYDIR ) ?: [] as $log_dir ) {
			foreach ( @\glob( "{$log_dir}/p*", \GLOB_ONLYDIR ) ?: [] as $pdir ) {
				if ( \preg_match( '#/p(\d+)$#', $pdir, $m ) && $is_orphan( (int) $m[1] ) ) {
					yield $pdir;
				}
			}
		}
		foreach ( @\glob( "{$base_dir}/offsets/*.p*", \GLOB_ONLYDIR ) ?: [] as $odir ) {
			if ( \preg_match( '#\.p(\d+)$#', $odir, $m ) && $is_orphan( (int) $m[1] ) ) {
				yield $odir;
			}
		}
	}

	/**
	 * Expected-log-basenames set the cleanup gates on (active + non-stale topologies, plus the `newspack_nodes/expected_log_basenames` filter).
	 *
	 * @return array<int,string>
	 */
	public static function expected_basenames( string $base_dir ): array {
		$topology_names = [];
		if ( \class_exists( '\\Newspack_Nodes\\Bootstrap' ) ) {
			try {
				foreach ( \array_keys( Bootstrap::get_topologies() ) as $name ) {
					$topology_names[ $name ] = true;
				}
			} catch ( \Throwable $e ) { // phpcs:ignore Generic.CodeAnalysis.EmptyStatement.DetectedCatch
				// Bootstrap is request-scope; tolerate worker contexts.
			}
		}
		try {
			foreach ( ( new CLI( $base_dir ) )->ls_workers() as $worker ) {
				if ( empty( $worker['stale'] ) ) {
					$topology_names[ $worker['type'] ] = true;
				}
			}
		} catch ( \Throwable $e ) { // phpcs:ignore Generic.CodeAnalysis.EmptyStatement.DetectedCatch
			// Cli reads $base_dir; tolerate missing dir.
		}
		unset( $topology_names[''] );

		$basenames = [];
		foreach ( \array_keys( $topology_names ) as $name ) {
			foreach ( Topology_Registry::basenames_for( $name ) as $basename ) {
				$basenames[] = $basename;
			}
		}
		$base = \array_values( \array_unique( $basenames ) );

		$filtered = \apply_filters( 'newspack_nodes/expected_log_basenames', $base );
		if ( ! \is_array( $filtered ) ) {
			return $base;
		}
		return \array_values( \array_unique( \array_map( '\strval', $filtered ) ) );
	}

	/**
	 * Active `{name}.p{N}` descriptors: every active topology expanded over its
	 * num_partitions, unioned with every non-stale live worker's `{type}.p{partition}`.
	 *
	 * @return array<int,string>
	 */
	private static function active_descriptors( string $base_dir ): array {
		$seen = [];
		if ( \class_exists( '\\Newspack_Nodes\\Bootstrap' ) ) {
			try {
				foreach ( Bootstrap::expand_workers() as $worker ) {
					$seen[ "{$worker['type']}.p{$worker['partition']}" ] = true;
				}
			} catch ( \Throwable $e ) { // phpcs:ignore Generic.CodeAnalysis.EmptyStatement.DetectedCatch
				// Bootstrap is request-scope; tolerate worker contexts.
			}
		}
		try {
			foreach ( ( new CLI( $base_dir ) )->ls_workers() as $worker ) {
				if ( empty( $worker['stale'] ) ) {
					$seen[ "{$worker['type']}.p{$worker['partition']}" ] = true;
				}
			}
		} catch ( \Throwable $e ) { // phpcs:ignore Generic.CodeAnalysis.EmptyStatement.DetectedCatch
			// CLI reads $base_dir; tolerate missing dir.
		}
		return \array_keys( $seen );
	}

	/** True if a worker lock dir exists for descriptor `$descriptor` (`{base}/locks/{descriptor}.lock.d`). */
	private static function has_lock_for( string $base_dir, string $descriptor ): bool {
		return \is_dir( "{$base_dir}/locks/{$descriptor}.lock.d" );
	}
}
