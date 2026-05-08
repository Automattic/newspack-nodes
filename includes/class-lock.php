<?php
/**
 * Lock: mkdir-based exclusive lock with heartbeat + restart channel + PID-content
 * theft detection.
 *
 * Lift from class-lock.php (event-logger). Adaptations:
 *  - No Config dependency.
 *  - Added with_lock( callable ) helper for batch-mode auto-acquire.
 *  - Single-channel restart signaling via a `restart` flag file inside the lock dir
 *    (spec line 832): an external requester writes the flag with request_restart();
 *    workers/supervisors poll should_restart() inside their drain loops; the lock
 *    holder calls clear_restart() once it has handled the signal so a subsequent
 *    relock starts clean.
 *  - PID-content theft detection: heartbeat file contains the holder's PID;
 *    should_restart() exits if the on-disk PID no longer matches getmypid()
 *    (someone else stole the lock).
 *  - `started` timestamp file: written at acquire(), readable without holding
 *    the lock via static get_started_time(). Supervisors use this to compute
 *    worker uptime without parsing heartbeat mtimes.
 *  - Grace period for orphan dirs: if mkdir fails because the dir exists but
 *    the heartbeat file doesn't, the holder may be mid-acquire (race window
 *    between mkdir and file_put_contents). Sleep 1s and re-check before
 *    deciding to steal.
 *  - Static helpers: force_release_at(string), request_restart_at(string),
 *    is_restart_pending(string), get_started_time(string) callable without
 *    instantiating a Lock object — used by REST endpoints, admin actions, and
 *    supervisor relock-on-config-change flows that need to interact with a
 *    lock dir without first knowing whether anyone currently holds it. The
 *    `_at` suffix marks the path-keyed static parallel of an instance method.
 *    PHP forbids declaring instance + static methods with the same name, so
 *    the instance form keeps the bare name (back-compat) and the static form
 *    gets the `_at` suffix.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Lock {
	public const STALE_TIMEOUT = 60;

	/** Filename for the restart-flag file inside the lock dir. */
	public const RESTART_FLAG = 'restart';

	/** Filename for the heartbeat file (contains holder's PID). */
	public const HEARTBEAT_FILE = 'heartbeat';

	/** Filename for the started-timestamp file. */
	public const STARTED_FILE = 'started';

	/**
	 * Grace period (seconds) for orphan dir detection. If mkdir fails because
	 * the dir exists but no heartbeat file is present, the holder may be
	 * mid-acquire. Sleep this many seconds and re-check before stealing.
	 */
	public const ORPHAN_GRACE_S = 1;

	private string $lock_path;
	private int $stale_timeout;
	private bool $is_held = false;

	public function __construct( string $lock_path, int $stale_timeout = self::STALE_TIMEOUT ) {
		$this->lock_path     = \rtrim( $lock_path, '/' );
		$this->stale_timeout = $stale_timeout;
	}

	public function acquire( int $max_wait_ms = 0 ): bool {
		$deadline = $max_wait_ms > 0 ? \microtime( true ) + ( $max_wait_ms / 1000.0 ) : 0;
		do {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
			if ( @\mkdir( $this->lock_path, 0755, true ) ) {
				if ( $this->write_acquire_files() ) {
					$this->is_held = true;
					return true;
				}
				// Couldn't write required files (disk full / permissions). Roll back
				// the dir so we don't leave an orphan; report acquire failure.
				self::force_release_at( $this->lock_path );
				return false;
			}

			// mkdir failed because the dir exists. Decide whether to steal it.
			if ( $this->try_steal_orphan_or_stale() ) {
				if ( $this->write_acquire_files() ) {
					$this->is_held = true;
					return true;
				}
				self::force_release_at( $this->lock_path );
				return false;
			}

			if ( $max_wait_ms === 0 || \microtime( true ) >= $deadline ) {
				return false;
			}
			\usleep( 100_000 );
		} while ( true );
	}

	/**
	 * Decide whether to steal an existing lock dir.
	 *
	 * Two reasons to steal:
	 *   - Orphan: the dir exists but no heartbeat file is present (crash during
	 *     creation). Honor a grace period so we don't race a holder who's
	 *     between `mkdir()` and `file_put_contents( heartbeat )`.
	 *   - Stale: heartbeat file exists but mtime is older than stale_timeout
	 *     (holder hung or crashed without releasing).
	 *
	 * Steals by force-releasing the dir and re-mkdir'ing. Returns true if the
	 * dir is now ours (mkdir succeeded after force_release).
	 */
	private function try_steal_orphan_or_stale(): bool {
		$hb = $this->lock_path . '/' . self::HEARTBEAT_FILE;
		\clearstatcache( true, $hb );

		if ( ! \file_exists( $hb ) ) {
			// Orphan dir (no heartbeat). Holder may be mid-acquire; honor grace.
			\sleep( self::ORPHAN_GRACE_S );
			\clearstatcache( true, $hb );
			if ( \file_exists( $hb ) ) {
				return false; // Heartbeat appeared during grace — back off.
			}
			// Still no heartbeat — treat as stale and steal.
		} else {
			$mtime = @\filemtime( $hb );
			if ( $mtime === false ) {
				// Can't read mtime (permissions?) — don't steal blindly.
				return false;
			}
			if ( ( \time() - $mtime ) < $this->stale_timeout ) {
				return false; // Holder is alive enough.
			}
		}

		self::force_release_at( $this->lock_path );
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
		return (bool) @\mkdir( $this->lock_path, 0755, true );
	}

	/**
	 * Write the heartbeat (PID) and started-timestamp files. Both must succeed
	 * for the acquire to be considered complete.
	 *
	 * @return bool True if both files written; false on first failure.
	 */
	private function write_acquire_files(): bool {
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_file_put_contents
		$hb_ok = false !== @\file_put_contents( $this->lock_path . '/' . self::HEARTBEAT_FILE, (string) \getmypid() );
		if ( ! $hb_ok ) {
			return false;
		}
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_file_put_contents
		$started_ok = false !== @\file_put_contents( $this->lock_path . '/' . self::STARTED_FILE, (string) \time() );
		if ( ! $started_ok ) {
			return false;
		}
		// Clear any inherited restart flag so a new holder doesn't immediately exit.
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_unlink
		@\unlink( $this->lock_path . '/' . self::RESTART_FLAG );
		return true;
	}

	public function release(): void {
		if ( ! $this->is_held ) {
			return;
		}
		self::force_release_at( $this->lock_path );
		$this->is_held = false;
	}

	public function heartbeat(): void {
		if ( ! $this->is_held ) {
			return;
		}
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_touch
		@\touch( $this->lock_path . '/' . self::HEARTBEAT_FILE );
	}

	public function is_held(): bool {
		return $this->is_held;
	}

	/**
	 * Path used by this Lock instance.
	 */
	public function path(): string {
		return $this->lock_path;
	}

	/**
	 * Instance helper: only release if heartbeat is stale (or missing).
	 *
	 * Returns true if the lock was forcibly released, false if the holder was
	 * still alive within the stale_timeout window. Preserves prior behavior of
	 * the instance API used by acquire-time stale-takeover paths.
	 */
	public function force_release(): bool {
		$hb = $this->lock_path . '/' . self::HEARTBEAT_FILE;
		if ( ! \is_dir( $this->lock_path ) ) {
			return false;
		}
		$mtime = @\filemtime( $hb );
		if ( $mtime === false || ( \time() - $mtime ) >= $this->stale_timeout ) {
			self::force_release_at( $this->lock_path );
			return true;
		}
		return false;
	}

	/**
	 * Static unconditional release: clear a lock dir regardless of staleness.
	 *
	 * Used by REST endpoints, supervisors stealing locks during relock-on-config-
	 * change, and acquire()'s own internal cleanup. Available without an
	 * instance for callers that just have a path and no holder context.
	 *
	 * Spec asked for "static `force_release(string $lock_dir)` in addition to
	 * existing instance method"; PHP forbids same-name instance/static methods,
	 * so the static form is named `force_release_at`.
	 *
	 * @param string $lock_dir The lock directory path.
	 */
	public static function force_release_at( string $lock_dir ): void {
		$lock_dir = \rtrim( $lock_dir, '/' );
		if ( ! \is_dir( $lock_dir ) ) {
			return;
		}
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_unlink
		@\unlink( $lock_dir . '/' . self::HEARTBEAT_FILE );
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_unlink
		@\unlink( $lock_dir . '/' . self::STARTED_FILE );
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_unlink
		@\unlink( $lock_dir . '/' . self::RESTART_FLAG );
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_rmdir
		@\rmdir( $lock_dir );
	}

	public function with_lock( callable $fn, int $max_wait_ms = 5000 ): mixed {
		if ( ! $this->acquire( $max_wait_ms ) ) {
			throw new \RuntimeException( "Lock::with_lock could not acquire {$this->lock_path}" );
		}
		try {
			return $fn();
		} finally {
			$this->release();
		}
	}

	/**
	 * Drop a `restart` flag file inside the lock dir. The current holder polls
	 * should_restart() from its drain loop and exits cleanly when it sees the flag.
	 *
	 * Called by external requesters (REST endpoint, admin action, supervisor
	 * relock-on-config-change). Does NOT require the caller to hold the lock —
	 * a stranger writing into someone else's lock dir is the entire point of the
	 * channel. No-op (returns false) if the lock dir doesn't exist.
	 *
	 * Instance form. Static form: Lock::request_restart_at( $path ).
	 */
	public function request_restart(): bool {
		return self::request_restart_at( $this->lock_path );
	}

	/**
	 * Static variant of request_restart for callers that only have a lock-dir path.
	 *
	 * @param string $lock_dir The lock directory path.
	 * @return bool True if the flag file was created.
	 */
	public static function request_restart_at( string $lock_dir ): bool {
		$lock_dir = \rtrim( $lock_dir, '/' );
		if ( ! \is_dir( $lock_dir ) ) {
			return false;
		}
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_file_put_contents
		return false !== @\file_put_contents( $lock_dir . '/' . self::RESTART_FLAG, (string) \time() );
	}

	/**
	 * Poll for a pending restart request OR PID-content theft.
	 *
	 * Two exit conditions:
	 *   1. restart flag file present (external requester wants us out).
	 *   2. heartbeat file gone OR contains a PID different from ours (someone
	 *      else stole the lock — we exit so they can take over cleanly).
	 *
	 * Both conditions imply "exit clean and let the supervisor respawn." Heavy
	 * stat-cache invalidation is intentional: long-running workers won't see
	 * filesystem changes from external processes without it.
	 */
	public function should_restart(): bool {
		\clearstatcache( true, $this->lock_path . '/' . self::RESTART_FLAG );
		if ( \is_file( $this->lock_path . '/' . self::RESTART_FLAG ) ) {
			return true;
		}

		// PID-content theft check: only meaningful if we believe we hold the lock.
		if ( $this->is_held ) {
			\clearstatcache( true, $this->lock_path . '/' . self::HEARTBEAT_FILE );
			// phpcs:ignore WordPressVIPMinimum.Performance.FetchingRemoteData.FileGetContentsUnknown
			$content = @\file_get_contents( $this->lock_path . '/' . self::HEARTBEAT_FILE );
			if ( false === $content ) {
				// Heartbeat gone — lock dir was deleted out from under us.
				return true;
			}
			if ( (int) $content !== \getmypid() ) {
				// PID mismatch — another process is now the rightful holder.
				return true;
			}
		}
		return false;
	}

	/**
	 * Static restart-pending query (path-only; no PID check). Used by callers
	 * that want to know whether a restart was requested without taking any
	 * action — e.g., admin UI status displays.
	 *
	 * @param string $lock_dir The lock directory path.
	 */
	public static function is_restart_pending( string $lock_dir ): bool {
		$lock_dir = \rtrim( $lock_dir, '/' );
		\clearstatcache( true, $lock_dir . '/' . self::RESTART_FLAG );
		return \is_file( $lock_dir . '/' . self::RESTART_FLAG );
	}

	/**
	 * Read the started-timestamp file for a lock dir. Callable without an
	 * instance — supervisors compute worker uptime via this without knowing
	 * the worker's own Lock object.
	 *
	 * @param string $lock_dir The lock directory path.
	 * @return int|null Unix timestamp when acquire() succeeded, or null if missing.
	 */
	public static function get_started_time( string $lock_dir ): ?int {
		$lock_dir = \rtrim( $lock_dir, '/' );
		$started_file = $lock_dir . '/' . self::STARTED_FILE;
		if ( ! \is_file( $started_file ) ) {
			return null;
		}
		// phpcs:ignore WordPressVIPMinimum.Performance.FetchingRemoteData.FileGetContentsUnknown
		$content = @\file_get_contents( $started_file );
		return false !== $content ? (int) $content : null;
	}

	/**
	 * Remove a pending restart flag. Called by the holder once it has acted on
	 * the signal (right before exiting), or by a supervisor after relocking,
	 * so the next holder doesn't immediately exit on inherited state.
	 */
	public function clear_restart(): void {
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_unlink
		@\unlink( $this->lock_path . '/' . self::RESTART_FLAG );
	}
}
