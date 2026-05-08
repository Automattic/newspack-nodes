<?php
/**
 * Lock: mkdir-based exclusive lock with heartbeat + force_release.
 *
 * Lift from class-lock.php (event-logger). Adaptations:
 *  - No Config dependency.
 *  - No should_restart / request_restart (deferred to A5).
 *  - Added with_lock( callable ) helper for batch-mode auto-acquire.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Lock {
	public const STALE_TIMEOUT = 60;

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
}
