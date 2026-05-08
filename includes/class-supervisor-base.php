<?php
/**
 * SupervisorBase: spawn coordination logic without I/O.
 *
 * Lift-adapted from event-logger's class-supervisor-base.php. Pure-data methods
 * so tests can drive without spawning real subprocesses.
 *
 * Hardening additions (per spec lines 840-851):
 *  - MAX_PARTITIONS = 16 ceiling for partition counts and stale-partition GC.
 *  - delete_directory_recursive() with depth bound + path-containment guard
 *    (defense-in-depth against symlink loops + accidental sibling-tree wipes).
 *  - remove_stale_directory() — purge a dir whose newest mtime is older than
 *    a stale_age threshold; load-bearing for partition-count downgrades that
 *    leave partition dirs orphaned beyond num_partitions.
 *  - is_recently_spawned() persists last_spawn_time to memcache (with a
 *    transient fallback) so the rate limit survives across supervisor
 *    process restarts (cron backstop respawns or self-respawns).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class SupervisorBase {
	/**
	 * Minimum interval between spawning the same worker (rate limiting).
	 *
	 * Prevents thundering-herd respawns when locks flap. Updated after every
	 * spawn attempt — success OR failure — so a failing-to-acquire worker
	 * doesn't get hammered. Spec line 588.
	 */
	public const MIN_SPAWN_INTERVAL_S = 15;

	/**
	 * Hard ceiling on partition counts. min/max-clamped at supervisor +
	 * Bootstrap; cleanup walks num_partitions..MAX_PARTITIONS to GC retired
	 * partition dirs. Bounded loops. Spec line 844.
	 */
	public const MAX_PARTITIONS = 16;

	/**
	 * Grace period (seconds) before purging retired partition directories.
	 * Load-bearing for partition-count downgrades: gives in-flight workers
	 * (still running with the old count) time to finish before their data
	 * dirs disappear under them. Spec line 849.
	 */
	public const STALE_PARTITION_AGE_S = 3600;

	/**
	 * Maximum recursion depth for delete_directory_recursive.
	 * Defense-in-depth against symlink loops. Spec line 850.
	 */
	public const MAX_DEPTH = 5;

	/**
	 * Memcache key prefix for cross-process spawn-rate-limit persistence.
	 *
	 * Without persistence, a supervisor that just respawned (cron backstop
	 * after a crash, or self-respawn) starts with last_spawn_time=[] and
	 * could re-spawn workers that were already spawned <15s ago.
	 */
	public const SPAWN_TS_CACHE_KEY = 'newspack_nodes:last_spawn:';

	protected string $base_dir;
	/** @var array<string,float> Key: "{type}|{partition}", value: timestamp. */
	protected array $last_spawn_time = [];

	public function __construct( string $base_dir ) {
		$this->base_dir = \rtrim( $base_dir, '/' );
	}

	public function lock_path( string $type, int $partition ): string {
		return "{$this->base_dir}/locks/{$type}.p{$partition}.lock.d";
	}

	public function worker_needs_spawn( array $worker, float $now ): bool {
		$type      = $worker['type'];
		$partition = $worker['partition'];
		$stale     = $worker['stale_timeout'] ?? Lock::STALE_TIMEOUT;

		$dir = $this->lock_path( $type, $partition );
		if ( ! \is_dir( $dir ) ) {
			return true;
		}
		$hb    = "{$dir}/heartbeat";
		$mtime = @\filemtime( $hb );
		if ( $mtime === false ) {
			return true;
		}
		if ( ( $now - $mtime ) > $stale ) {
			return true;
		}
		return false;
	}

	public function record_spawn( string $type, int $partition, float $when ): void {
		$key                          = "{$type}|{$partition}";
		$this->last_spawn_time[ $key ] = $when;
		$this->persist_spawn_ts( $key, $when );
	}

	public function is_recently_spawned( string $type, int $partition, float $now ): bool {
		$key  = "{$type}|{$partition}";
		// In-memory has priority (current process owns the truth).
		if ( isset( $this->last_spawn_time[ $key ] ) ) {
			return ( $now - $this->last_spawn_time[ $key ] ) < self::MIN_SPAWN_INTERVAL_S;
		}
		// Otherwise consult cross-process state — covers cron-backstop respawns
		// after a crash and self-respawn handoffs.
		$persisted = $this->load_spawn_ts( $key );
		if ( $persisted !== null ) {
			$this->last_spawn_time[ $key ] = $persisted;
			return ( $now - $persisted ) < self::MIN_SPAWN_INTERVAL_S;
		}
		return false;
	}

	/**
	 * Recursively delete a directory and its contents.
	 *
	 * Depth-bounded (MAX_DEPTH=5) and path-containment-checked: only paths
	 * under $base_path are eligible at depth 0. realpath() resolution at the
	 * top-level call defends against symlink escapes; subsequent depths use
	 * a simple is_link() skip so a symlink inside the tree can't redirect
	 * the recursion outside the original $base_path.
	 *
	 * @param string $path      Directory to delete.
	 * @param string $base_path Containment root; only paths under this are
	 *                          eligible at the top-level call.
	 * @param int    $max_depth Optional override of MAX_DEPTH for tests.
	 */
	public static function delete_directory_recursive( string $path, string $base_path, int $max_depth = self::MAX_DEPTH ): void {
		if ( ! self::is_within( $path, $base_path ) ) {
			return;
		}
		// Strict-proper-subpath: refuse equality so `$base/..` (which realpaths
		// back to $base) can't wipe the base itself.
		$real_path = \realpath( $path );
		$real_base = \realpath( $base_path );
		if ( false === $real_path || false === $real_base
			|| \rtrim( $real_path, '/' ) === \rtrim( $real_base, '/' ) ) {
			return;
		}
		self::delete_directory_recursive_inner( $path, $max_depth, 0 );
	}

	/**
	 * Internal recursion helper. Containment is established at the top-level
	 * call; this only enforces depth bounds + symlink avoidance per node.
	 */
	private static function delete_directory_recursive_inner( string $path, int $max_depth, int $depth ): void {
		if ( $depth > $max_depth ) {
			return;
		}
		if ( \is_link( $path ) ) {
			return;
		}
		if ( ! \is_dir( $path ) ) {
			return;
		}
		$items = @\scandir( $path ) ?: [];
		foreach ( $items as $item ) {
			if ( $item === '.' || $item === '..' ) {
				continue;
			}
			$child = $path . '/' . $item;
			if ( \is_dir( $child ) && ! \is_link( $child ) ) {
				self::delete_directory_recursive_inner( $child, $max_depth, $depth + 1 );
			} else {
				// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_unlink
				@\unlink( $child );
			}
		}
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_rmdir
		@\rmdir( $path );
	}

	/**
	 * Verify $path is the same as or strictly under $base_path after realpath
	 * resolution. Both must exist on disk for realpath to resolve. If either
	 * fails to resolve, return false (refuse the operation rather than guess).
	 *
	 * @param string $path      Candidate path.
	 * @param string $base_path Containment root.
	 * @return bool True if $path is within $base_path.
	 */
	public static function is_within( string $path, string $base_path ): bool {
		$real_path = \realpath( $path );
		$real_base = \realpath( $base_path );
		if ( $real_path === false || $real_base === false ) {
			return false;
		}
		// Normalize trailing slash on base for the prefix check, but accept
		// equality — is_within() is a containment predicate. Callers that need
		// strict-proper-subpath semantics (e.g. delete_directory_recursive)
		// reject equality at their own boundary.
		$real_base_trim = \rtrim( $real_base, '/' );
		if ( $real_path === $real_base_trim ) {
			return true;
		}
		return \strpos( $real_path, $real_base_trim . '/' ) === 0;
	}

	/**
	 * Remove a directory if its newest file mtime is older than $stale_age_s
	 * seconds. Skips symlinks (top-level + when checking mtimes) so a
	 * misconfigured symlink can't redirect the deletion. The directory must
	 * be inside $this->base_dir for the deletion to proceed (containment via
	 * delete_directory_recursive).
	 *
	 * @param string $dir          Candidate stale directory.
	 * @param int    $stale_age_s  Threshold in seconds.
	 */
	public function remove_stale_directory( string $dir, int $stale_age_s ): void {
		// Skip symlinks to prevent escaping the intended directory.
		if ( \is_link( $dir ) ) {
			return;
		}
		if ( ! \is_dir( $dir ) ) {
			return;
		}

		// Find newest mtime among files (skip symlinks).
		$newest_mtime = 0;
		$files        = @\scandir( $dir ) ?: [];
		foreach ( $files as $file ) {
			if ( $file === '.' || $file === '..' ) {
				continue;
			}
			$child = $dir . '/' . $file;
			if ( \is_link( $child ) ) {
				continue;
			}
			$mtime = @\filemtime( $child );
			if ( $mtime !== false && $mtime > $newest_mtime ) {
				$newest_mtime = $mtime;
			}
		}

		// Only remove if we found at least one file and it's older than threshold.
		if ( $newest_mtime > 0 && ( \time() - $newest_mtime ) > $stale_age_s ) {
			self::delete_directory_recursive( $dir, $this->base_dir );
		}
	}

	/**
	 * Persist a {type}|{partition} spawn timestamp so a respawned supervisor
	 * (cron backstop or self-respawn) sees recent activity and honors the
	 * 15s rate limit. Memcache is preferred (low TTL, cluster-safe);
	 * transients are the fallback when memcache is unavailable.
	 *
	 * TTL is bounded by MIN_SPAWN_INTERVAL_S * 2 so stale entries auto-expire
	 * and don't accumulate after retired worker types.
	 */
	protected function persist_spawn_ts( string $key, float $when ): void {
		$cache_key = self::SPAWN_TS_CACHE_KEY . $key;
		$ttl       = self::MIN_SPAWN_INTERVAL_S * 2;

		if ( \function_exists( 'wp_cache_set' ) ) {
			\wp_cache_set( $cache_key, (int) $when, 'newspack_nodes', $ttl );
			return;
		}
		if ( \function_exists( 'set_transient' ) ) {
			\set_transient( $cache_key, (int) $when, $ttl );
		}
	}

	/**
	 * Load a persisted spawn timestamp. Returns null if not present or
	 * unavailable (no memcache + no transient API).
	 */
	protected function load_spawn_ts( string $key ): ?float {
		$cache_key = self::SPAWN_TS_CACHE_KEY . $key;

		if ( \function_exists( 'wp_cache_get' ) ) {
			$found = false;
			$value = \wp_cache_get( $cache_key, 'newspack_nodes', false, $found );
			if ( $found && $value !== false ) {
				return (float) $value;
			}
		}
		if ( \function_exists( 'get_transient' ) ) {
			$value = \get_transient( $cache_key );
			if ( $value !== false ) {
				return (float) $value;
			}
		}
		return null;
	}
}
