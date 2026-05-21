<?php
/**
 * Lock: mkdir+heartbeat locking utility.
 *
 * Works on macOS Docker volumes where flock fails. Atomic mkdir for acquisition,
 * heartbeat file for stale detection.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

if ( ! \defined( 'ABSPATH' ) ) {
	exit;
}

class Lock extends Node {
	public const STALE_TIMEOUT  = 60;
	public const RESTART_FLAG   = 'restart';
	public const HEARTBEAT_FILE = 'heartbeat';
	public const STARTED_FILE   = 'started';

	/** Grace period (s) before stealing an orphan dir (no heartbeat) — holder may be mid-acquire. */
	public const ORPHAN_GRACE_S = 1;

	private string $lock_path;
	private int $stale_timeout;
	private bool $is_held = false;

	public function __construct( string $lock_path, int $stale_timeout = self::STALE_TIMEOUT ) {
		$this->lock_path     = \rtrim( $lock_path, '/' );
		$this->stale_timeout = $stale_timeout;
	}

	/**
	 * Node entry point: KEY='heartbeat' refreshes the lock; anything else forwards via sink.
	 *
	 * @param array $message Reference; not mutated by the heartbeat path.
	 */
	public function fill( array &$message ): void {
		if ( 'heartbeat' === $message[ Message::KEY ] ) {
			++$this->counter;
			if ( $this->is_held ) {
				$this->heartbeat();
			}
			return;
		}
		parent::fill( $message );
	}

	public function acquire( int $max_wait_ms = 0 ): bool {
		$deadline = $max_wait_ms > 0 ? \microtime( true ) + ( $max_wait_ms / 1000.0 ) : 0;
		do {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
			if ( @\mkdir( $this->lock_path, 0755, true ) ) {
				if ( $this->write_acquire_files() ) {
					$this->is_held = true;
					$this->set_state( 'HELD', [ 'path' => $this->lock_path, 'stolen' => false ] );
					return true;
				}
				// Couldn't write required files; roll back the dir so we don't orphan it.
				self::force_release_at( $this->lock_path );
				return false;
			}

			// mkdir failed because the dir exists. Decide whether to steal it.
			if ( $this->try_steal_orphan_or_stale() ) {
				if ( $this->write_acquire_files() ) {
					$this->is_held = true;
					// stolen=true so dashboards can badge the takeover.
					$this->set_state( 'HELD', [ 'path' => $this->lock_path, 'stolen' => true ] );
					return true;
				}
				self::force_release_at( $this->lock_path );
				return false;
			}

			if ( 0 === $max_wait_ms || \microtime( true ) >= $deadline ) {
				return false;
			}
			\usleep( 100_000 );
		} while ( true );
	}

	/**
	 * Steal an existing lock dir if orphaned (no heartbeat, past grace) or stale (mtime > timeout).
	 *
	 * @return bool True if the dir is now ours.
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
			if ( false === $mtime ) {
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
	 * Write the heartbeat (PID) and started-timestamp files; both must succeed.
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
		$this->set_state( 'HELD', [ 'path' => $this->lock_path, 'released' => true ] );
	}

	/**
	 * Refresh the heartbeat file. Verifies ownership first; returns false if stolen (flips is_held).
	 *
	 * @return bool True if heartbeat refreshed; false if not held or lost.
	 */
	public function heartbeat(): bool {
		if ( ! $this->verify_ownership() ) {
			return false;
		}
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_touch
		@\touch( $this->lock_path . '/' . self::HEARTBEAT_FILE );
		return true;
	}

	public function is_held(): bool {
		return $this->is_held;
	}

	/** Verify the heartbeat PID still matches getmypid(); flips is_held=false on loss. */
	public function verify_ownership(): bool {
		if ( ! $this->is_held ) {
			return false;
		}
		$hb = $this->lock_path . '/' . self::HEARTBEAT_FILE;
		\clearstatcache( true, $hb );
		// phpcs:ignore WordPressVIPMinimum.Performance.FetchingRemoteData.FileGetContentsUnknown
		$pid = @\file_get_contents( $hb );
		if ( false === $pid || (int) \trim( (string) $pid ) !== \getmypid() ) {
			$this->is_held = false;
			return false;
		}
		return true;
	}

	/** Path used by this Lock instance. */
	public function path(): string {
		return $this->lock_path;
	}

	/**
	 * Release only if the heartbeat is stale/missing.
	 *
	 * @return bool True if released; false if the holder is still alive.
	 */
	public function force_release(): bool {
		$hb = $this->lock_path . '/' . self::HEARTBEAT_FILE;
		if ( ! \is_dir( $this->lock_path ) ) {
			return false;
		}
		$mtime = @\filemtime( $hb );
		if ( false === $mtime || ( \time() - $mtime ) >= $this->stale_timeout ) {
			self::force_release_at( $this->lock_path );
			return true;
		}
		return false;
	}

	/**
	 * Static unconditional release: clear a lock dir regardless of staleness.
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

	/**
	 * Drop a `restart` flag in the lock dir; the holder exits when it polls should_restart().
	 *
	 * Does NOT require holding the lock (cross-process signal). Static form: request_restart_at().
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
	 * True if a restart flag is present OR the heartbeat is gone / PID-stolen.
	 *
	 * Heavy clearstatcache is intentional — long-running workers won't see external changes otherwise.
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
				return true; // Heartbeat gone — lock dir was deleted out from under us.
			}
			if ( (int) $content !== \getmypid() ) {
				return true; // PID mismatch — another process is now the rightful holder.
			}
		}
		return false;
	}

	/**
	 * Static restart-pending query (path-only; no PID check).
	 *
	 * @param string $lock_dir The lock directory path.
	 */
	public static function is_restart_pending( string $lock_dir ): bool {
		$lock_dir = \rtrim( $lock_dir, '/' );
		\clearstatcache( true, $lock_dir . '/' . self::RESTART_FLAG );
		return \is_file( $lock_dir . '/' . self::RESTART_FLAG );
	}

	/**
	 * Read the started-timestamp file for a lock dir (no instance needed).
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

	/** Remove a pending restart flag so the next holder doesn't exit on inherited state. */
	public function clear_restart(): void {
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_unlink
		@\unlink( $this->lock_path . '/' . self::RESTART_FLAG );
	}

	public static function node_schema(): array {
		// Hidden: internal primitive, not a standalone graph node.
		return [
			'category'    => 'Hidden',
			'description' => 'Advisory cooperative file lock with heartbeat; blocks until acquired.',
			'ctor'        => [],
			'verbs'       => [],
		];
	}
}
