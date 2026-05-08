<?php
/**
 * Lock: mkdir-based exclusive lock with heartbeat + force_release + restart channel.
 *
 * Lift from class-lock.php (event-logger). Adaptations:
 *  - No Config dependency.
 *  - Added with_lock( callable ) helper for batch-mode auto-acquire.
 *  - Single-channel restart signaling via a `restart` flag file inside the lock dir
 *    (spec line 832): an external requester writes the flag with request_restart();
 *    workers/supervisors poll should_restart() inside their drain loops; the lock
 *    holder calls clear_restart() once it has handled the signal so a subsequent
 *    relock starts clean.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Lock {
	public const STALE_TIMEOUT = 60;

	/** Filename for the restart-flag file inside the lock dir. */
	public const RESTART_FLAG = 'restart';

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
			if ( @\mkdir( $this->lock_path, 0755, true ) ) {
				\file_put_contents( "{$this->lock_path}/heartbeat", (string) \getmypid() );
				$this->is_held = true;
				return true;
			}
			if ( $max_wait_ms === 0 || \microtime( true ) >= $deadline ) {
				return false;
			}
			\usleep( 100_000 );
		} while ( true );
	}

	public function release(): void {
		if ( ! $this->is_held ) {
			return;
		}
		@\unlink( "{$this->lock_path}/heartbeat" );
		// rmdir requires an empty dir; sweep any in-flight restart flag too so
		// the directory is reusable after release. Cheap and idempotent.
		@\unlink( "{$this->lock_path}/" . self::RESTART_FLAG );
		@\rmdir( $this->lock_path );
		$this->is_held = false;
	}

	public function heartbeat(): void {
		if ( ! $this->is_held ) {
			return;
		}
		@\touch( "{$this->lock_path}/heartbeat" );
	}

	public function is_held(): bool {
		return $this->is_held;
	}

	public function force_release(): bool {
		$hb = "{$this->lock_path}/heartbeat";
		if ( ! \is_dir( $this->lock_path ) ) {
			return false;
		}
		$mtime = @\filemtime( $hb );
		if ( $mtime === false || ( \time() - $mtime ) >= $this->stale_timeout ) {
			@\unlink( $hb );
			@\unlink( "{$this->lock_path}/" . self::RESTART_FLAG );
			@\rmdir( $this->lock_path );
			return true;
		}
		return false;
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
	 */
	public function request_restart(): bool {
		if ( ! \is_dir( $this->lock_path ) ) {
			return false;
		}
		return false !== @\file_put_contents( "{$this->lock_path}/" . self::RESTART_FLAG, '1' );
	}

	/**
	 * Poll for a pending restart request. Callers (WorkerBase::should_continue,
	 * SupervisorBase periodic tick) consult this every 250ms.
	 */
	public function should_restart(): bool {
		return \is_file( "{$this->lock_path}/" . self::RESTART_FLAG );
	}

	/**
	 * Remove a pending restart flag. Called by the holder once it has acted on
	 * the signal (right before exiting), or by a supervisor after relocking,
	 * so the next holder doesn't immediately exit on inherited state.
	 */
	public function clear_restart(): void {
		@\unlink( "{$this->lock_path}/" . self::RESTART_FLAG );
	}
}
