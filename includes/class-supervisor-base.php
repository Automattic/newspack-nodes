<?php
/**
 * Supervisor Base: pure-data spawn coordination so tests can drive it without forking.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

if ( ! \defined( 'ABSPATH' ) ) {
	exit;
}

class Supervisor_Base {

	/** Symlink-loop defense. */
	public const MAX_DEPTH = 5;

	/** Upper bound on partitions per topology; expand_workers clamps the spawn count to it. */
	public const MAX_PARTITIONS = 16;

	/** Min interval between spawning the same worker; updated after every attempt (success or fail). */
	public const MIN_SPAWN_INTERVAL_S = 15;

	public const SPAWN_TS_CACHE_KEY = 'newspack_nodes:last_spawn:';

	protected string $base_dir;
	/** @var array<string,float> Key: "{type}|{partition}", value: timestamp. */
	protected array $last_spawn_time = [];

	public function __construct( string $base_dir ) {
		$this->base_dir = \rtrim( $base_dir, '/' );
	}

	/**
	 * Remove $dir if its newest file mtime exceeds $stale_age_s (symlink-safe, base_dir-contained).
	 *
	 * @param string $dir          Candidate stale directory.
	 * @param int    $stale_age_s  Threshold in seconds.
	 */
	public function remove_stale_directory( string $dir, int $stale_age_s ): void {
		// Symlink: unlink rather than recurse, so we can't escape base_dir.
		if ( \is_link( $dir ) ) {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_unlink -- substrate manages its own base_dir tree (default /tmp/newspack-nodes/); the VIP hosted-filesystem rule doesn't apply to a runtime's reserved directory.
			@\unlink( $dir );
			return;
		}
		if ( ! \is_dir( $dir ) ) {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_unlink -- see above.
			@\unlink( $dir );
			return;
		}

		$newest_mtime = 0;
		$files        = @\scandir( $dir ) ?: [];
		foreach ( $files as $file ) {
			if ( '.' === $file || '..' === $file ) {
				continue;
			}
			$child = $dir . '/' . $file;
			if ( \is_link( $child ) ) {
				continue;
			}
			$mtime = @\filemtime( $child );
			if ( false !== $mtime && $mtime > $newest_mtime ) {
				$newest_mtime = $mtime;
			}
		}

		if ( $newest_mtime > 0 && ( \time() - $newest_mtime ) > $stale_age_s ) {
			self::delete_directory_recursive( $dir, $this->base_dir );
		}
	}

	/**
	 * Recursively delete a directory, depth-bounded and containment-checked under $base_path.
	 *
	 * @param string $path      Directory to delete.
	 * @param string $base_path Containment root (top-level call only).
	 * @param int    $max_depth Optional override of MAX_DEPTH for tests.
	 */
	public static function delete_directory_recursive( string $path, string $base_path, int $max_depth = self::MAX_DEPTH ): void {
		if ( ! self::is_within( $path, $base_path ) ) {
			return;
		}
		// Strict-proper-subpath: refuse equality so `$base/..` can't wipe base.
		$real_path = \realpath( $path );
		$real_base = \realpath( $base_path );
		if ( false === $real_path || false === $real_base
			|| \rtrim( $real_path, '/' ) === \rtrim( $real_base, '/' ) ) {
			return;
		}
		self::delete_directory_recursive_inner( $path, $max_depth, 0 );
	}

	/**
	 * True if $path equals or is under $base_path after realpath; false if either won't resolve.
	 *
	 * @param string $path      Candidate path.
	 * @param string $base_path Containment root.
	 * @return bool True if $path is within $base_path.
	 */
	public static function is_within( string $path, string $base_path ): bool {
		$real_path = \realpath( $path );
		$real_base = \realpath( $base_path );
		if ( false === $real_path || false === $real_base ) {
			return false;
		}
		// Accept equality: containment predicate; callers reject it if needed.
		$real_base_trim = \rtrim( $real_base, '/' );
		if ( $real_path === $real_base_trim ) {
			return true;
		}
		return \strpos( $real_path, $real_base_trim . '/' ) === 0;
	}

	/**
	 * Internal recursion helper: enforces depth bounds + per-node symlink avoidance.
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
			if ( '.' === $item || '..' === $item ) {
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

	/** @param array<string, mixed> $worker Worker descriptor (type, partition, …). */
	public function worker_needs_spawn( array $worker, float $now ): bool {
		$raw_type      = $worker['type'];
		$raw_partition = $worker['partition'];
		$type          = Core::as_string( $raw_type );
		$partition     = Core::as_int( $raw_partition );
		$stale         = Lock_Node::stale_timeout_of( $worker );

		$dir = $this->lock_path( $type, $partition );
		if ( ! \is_dir( $dir ) ) {
			return true;
		}
		return Lock_Node::heartbeat_is_stale( $dir, (int) $now, $stale );
	}

	public function lock_path( string $type, int $partition ): string {
		return "{$this->base_dir}/locks/{$type}.p{$partition}.lock.d";
	}

	/**
	 * Record an ACCEPTED spawn (in-memory + persisted). The spawn endpoint calls
	 * this — the one gate every spawn crosses — so self-respawns and supervisor
	 * posts share a single cross-process throttle window.
	 */
	public function record_spawn( string $type, int $partition, float $when ): void {
		$key                          = "{$type}|{$partition}";
		$this->last_spawn_time[ $key ] = $when;
		$this->persist_spawn_ts( $key, $when );
	}

	/**
	 * Persist a spawn timestamp (Cache_Backend, transient fallback) so a respawn honors the rate limit.
	 */
	protected function persist_spawn_ts( string $key, float $when ): void {
		$cache_key = self::SPAWN_TS_CACHE_KEY . $key;
		$ttl       = self::MIN_SPAWN_INTERVAL_S * 2;

		$backend = Cache_Backend::shared_first();
		if ( null !== $backend ) {
			$backend->set( $cache_key, (int) $when, $ttl );
			return;
		}
		if ( \function_exists( 'set_transient' ) ) {
			\set_transient( $cache_key, (int) $when, $ttl );
		}
	}

	public function is_recently_spawned( string $type, int $partition, float $now ): bool {
		$key  = "{$type}|{$partition}";
		// In-memory has priority (current process owns the truth).
		if ( isset( $this->last_spawn_time[ $key ] ) ) {
			return ( $now - $this->last_spawn_time[ $key ] ) < self::MIN_SPAWN_INTERVAL_S;
		}
		// Else consult cross-process state: cron-backstop + self-respawn.
		$persisted = $this->load_spawn_ts( $key );
		if ( null !== $persisted ) {
			$this->last_spawn_time[ $key ] = $persisted;
			return ( $now - $persisted ) < self::MIN_SPAWN_INTERVAL_S;
		}
		return false;
	}

	/**
	 * Load a persisted spawn timestamp; null if absent. Reads the same single
	 * tier persist_spawn_ts wrote — a throttle window must never straddle tiers.
	 */
	protected function load_spawn_ts( string $key ): ?float {
		$cache_key = self::SPAWN_TS_CACHE_KEY . $key;

		$backend = Cache_Backend::shared_first();
		if ( null !== $backend ) {
			$value = $backend->get( $cache_key );
			return \is_scalar( $value ) && false !== $value ? (float) $value : null;
		}
		if ( \function_exists( 'get_transient' ) ) {
			$value = \get_transient( $cache_key );
			if ( false !== $value && \is_scalar( $value ) ) {
				return (float) $value;
			}
		}
		return null;
	}

	/**
	 * Record a spawn POST in-memory only. The tick loop uses this: persisting
	 * here would make the endpoint (which records on accept) reject the very
	 * POST this record announces.
	 */
	public function record_spawn_local( string $type, int $partition, float $when ): void {
		$this->last_spawn_time[ "{$type}|{$partition}" ] = $when;
	}
}
