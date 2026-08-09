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

class Lock_Node extends Node {
	public const HEARTBEAT_FILE = 'heartbeat';

	/** Grace period (s) before stealing an orphan dir (no heartbeat) — holder may be mid-acquire. */
	public const ORPHAN_GRACE_S = 1;
	/**
	 * Config-changed watermark. Read by MTIME and never unlinked by its
	 * consumer — an unlink-after-consume loses a touch that lands mid-reload,
	 * and a comparison survives a lock steal where a removal does not. Distinct
	 * from RESTART_FLAG on purpose: this says "re-read", never "exit".
	 */
	public const RELOAD_FLAG    = 'reload';
	public const RESTART_FLAG   = 'restart';

	/**
	 * Operator stop. Distinct from RESTART_FLAG because the two want opposite
	 * successor behaviour — a restart hands the slot straight to a fresh
	 * process, a stop must leave it empty for the length of a deploy. The flag
	 * only has to outlive the exiting worker; keeping the slot empty afterwards
	 * is the hold option's job, since both acquire paths build a fresh dir.
	 */
	public const STOP_FLAG      = 'stop';

	public const STALE_TIMEOUT  = 60;
	public const STARTED_FILE   = 'started';

	/** Why the last acquire() failed; '' after a success. */
	private string $acquire_failure = '';
	private bool $is_held = false;

	private string $lock_path;
	private int $stale_timeout;

	public function __construct( string $lock_path, int $stale_timeout = self::STALE_TIMEOUT ) {
		parent::__construct();
		$this->lock_path     = \rtrim( $lock_path, '/' );
		$this->stale_timeout = $stale_timeout;
	}

	/**
	 * Node entry point: KEY='heartbeat' refreshes the lock; anything else forwards via sink.
	 *
	 * @param array<int,mixed> $message Unused past the KEY check; never mutated.
	 */
	public function fill( array $message ): void {
		if ( 'heartbeat' === $message[ Message::KEY ] ) {
			++$this->counter;
			if ( $this->is_held ) {
				$this->heartbeat();
			}
			return;
		}
		parent::fill( $message );
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
		$hb_path = $this->unlinked_path( self::HEARTBEAT_FILE );
		if ( null === $hb_path ) {
			return false;
		}
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_touch
		@\touch( $hb_path );
		return true;
	}

	public function acquire( int $max_wait_ms = 0 ): bool {
		$this->acquire_failure = '';
		$deadline   = $max_wait_ms > 0 ? Core::right_now() + ( $max_wait_ms / 1000.0 ) : 0;
		$io_retried = false;
		do {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
			if ( @\mkdir( $this->lock_path, 0755, true ) ) {
				if ( $this->write_acquire_files() ) {
					$this->is_held = true;
					$this->set_state( 'HELD', $this->lock_path );
					return true;
				}
				// Write failed; roll back the dir so we don't orphan it.
				self::force_release_at( $this->lock_path );
				$this->acquire_failure = "lock dir unwritable at {$this->lock_path}";
				return false;
			}

			if ( ! \is_dir( $this->lock_path ) ) {
				if ( ! $io_retried ) {
					// Holder may have released mid-check; one free retry.
					$io_retried = true;
					continue;
				}
				// Nothing holds the path: a real I/O error, NOT contention.
				$err                   = \error_get_last();
				$this->acquire_failure = "mkdir failed at {$this->lock_path}"
					. ( null !== $err ? ": {$err['message']}" : '' );
				return false;
			}

			// The dir exists — contention. Decide whether to steal it.
			if ( $this->try_steal_orphan_or_stale() ) {
				if ( $this->write_acquire_files() ) {
					$this->is_held = true;
					// stolen=true so dashboards can badge the takeover.
					$this->set_state( 'STOLEN', $this->lock_path );
					return true;
				}
				self::force_release_at( $this->lock_path );
				$this->acquire_failure = "lock dir unwritable at {$this->lock_path}";
				return false;
			}

			if ( 0 === $max_wait_ms || Core::right_now() >= $deadline ) {
				$this->acquire_failure = 'lock_held';
				return false;
			}
			\usleep( 100_000 );
		} while ( true );
	}

	/**
	 * Steal an existing lock dir if orphaned (no heartbeat, past grace) or stale (mtime > timeout).
	 *
	 * Non-blocking: the orphan grace is judged by the dir's own mtime, never by
	 * sleeping — acquire() runs in request scope (SSE / CLI) and must not stall.
	 *
	 * @return bool True if the dir is now ours.
	 */
	private function try_steal_orphan_or_stale(): bool {
		$hb = $this->lock_path . '/' . self::HEARTBEAT_FILE;
		\clearstatcache( true, $hb );

		if ( ! \file_exists( $hb ) ) {
			// Orphan steal by dir age; write nothing before heartbeat.
			\clearstatcache( true, $this->lock_path );
			$dir_mtime = @\filemtime( $this->lock_path );
			// `<=` not `<`: int-second clocks; straddle can false-steal.
			if ( false === $dir_mtime || ( \time() - $dir_mtime ) <= self::ORPHAN_GRACE_S ) {
				return false; // Too fresh — assume the owner is mid-acquire.
			}
			// Past grace, still no heartbeat — owner died mid-acquire. Steal.
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

		return $this->steal_atomically();
	}

	/**
	 * Atomically take over the lock dir. rename() of a directory is atomic, so
	 * of two stealers racing the same dir exactly one rename succeeds; the
	 * loser's rename fails (source already gone) and it backs off. This closes
	 * the force_release_at()+mkdir() window where both racers could delete each
	 * other's heartbeat and both believe they hold the lock.
	 *
	 * The single-holder guarantee ultimately rests on mkdir, not rename: between
	 * the rename (line below) and the recreate the canonical path is briefly
	 * absent, so a plain acquire()-top `mkdir` racer can also claim it. That's
	 * still safe — both the racer's mkdir and our recreate mkdir target the same
	 * path and mkdir-on-existing fails, so exactly one becomes the holder and the
	 * other returns false. Keep the recreate an `mkdir` (an unconditional
	 * rename-back or removing the existence check would reopen a double-holder).
	 *
	 * @return bool True if WE won the recreate and now hold the dir.
	 */
	private function steal_atomically(): bool {
		$aside = $this->lock_path . '.stealing.' . \getmypid() . '.' . \uniqid( '', true );
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_rename
		if ( ! @\rename( $this->lock_path, $aside ) ) {
			return false; // Lost the steal — another racer got it first.
		}
		self::force_release_at( $aside ); // Discard the stolen dir + its files.
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
		return @\mkdir( $this->lock_path, 0755, true );
	}

	/**
	 * Write the heartbeat (PID) and started-timestamp files; both must succeed.
	 *
	 * @return bool True if both files written; false on first failure.
	 */
	private function write_acquire_files(): bool {
		$hb_path      = $this->unlinked_path( self::HEARTBEAT_FILE );
		$started_path = $this->unlinked_path( self::STARTED_FILE );
		if ( null === $hb_path || null === $started_path ) {
			return false;
		}
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_file_put_contents
		$hb_ok = false !== @\file_put_contents( $hb_path, (string) \getmypid() );
		if ( ! $hb_ok ) {
			return false;
		}
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_file_put_contents
		$started_ok = false !== @\file_put_contents( $started_path, (string) \time() );
		if ( ! $started_ok ) {
			return false;
		}
		// Clear an inherited restart flag so a new holder doesn't exit.
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_unlink
		@\unlink( $this->lock_path . '/' . self::RESTART_FLAG );
		return true;
	}

	/**
	 * A lock-dir file path, or null when something planted a symlink there —
	 * the write would land at its target. Spawn_Coordinator refuses to follow one
	 * when sweeping; the writer refuses too.
	 */
	private function unlinked_path( string $file ): ?string {
		$path = $this->lock_path . '/' . $file;
		return \is_link( $path ) ? null : $path;
	}

	/**
	 * Give up the lock — but only if we still hold it.
	 *
	 * @longform Verified against the heartbeat PID, never against our own
	 * `is_held` flag. A worker blocked in a long job stops heartbeating, goes
	 * stale, and a peer steals the dir; `restart_reason()` reports the theft but
	 * deliberately leaves `is_held` alone, so a flag-only check here would have
	 * the evicted holder `force_release_at()` the SUCCESSOR's directory. The
	 * successor then dies of "lock dir gone" on its next tick and both respawn,
	 * turning a self-correcting handoff into a restart loop. Failing closed
	 * leaks a dir at worst, and a leaked dir goes stale and is stolen normally.
	 */
	public function release(): void {
		if ( ! $this->verify_ownership() ) {
			$this->is_held = false;
			return;
		}
		self::force_release_at( $this->lock_path );
		$this->is_held = false;
		$this->set_state( 'RELEASED', $this->lock_path );
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
		if ( false === $pid || (int) \trim( $pid ) !== \getmypid() ) {
			$this->is_held = false;
			return false;
		}
		return true;
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
		// The dir goes with it, so the stop survives in the hold option alone.
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_unlink
		@\unlink( $lock_dir . '/' . self::STOP_FLAG );
		// @longform The reload watermark is never unlinked by its CONSUMER, but
		// it must go here: rmdir() only removes an empty dir, so a survivor
		// turns every clean release into an orphan peers steal through the
		// grace window. Losing it costs nothing: the successor boots on
		// fresh config, so it has nothing stale to reload.
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_unlink
		@\unlink( $lock_dir . '/' . self::RELOAD_FLAG );
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_rmdir
		@\rmdir( $lock_dir );
	}

	/** Why the last acquire() failed ('' after success): 'lock_held' = contention; anything else is an I/O diagnosis. */
	public function acquire_failure(): string {
		return $this->acquire_failure;
	}

	public function is_held(): bool {
		return $this->is_held;
	}

	/**
	 * Static politely request restart: create a file inside the lock dir.
	 *
	 * @param string $lock_dir The lock directory path.
	 * @return bool True if the flag file was created.
	 */
	public static function request_restart_at( string $lock_dir ): bool {
		$lock_dir = \rtrim( $lock_dir, '/' );
		if ( ! \is_dir( $lock_dir ) || Config::write_denied( 'restart flag' ) ) {
			return false;
		}
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_file_put_contents
		return false !== @\file_put_contents( $lock_dir . '/' . self::RESTART_FLAG, (string) \time() );
	}

	/**
	 * Static politely request STOP: exit and leave the slot empty.
	 *
	 * @param string $lock_dir The lock directory path.
	 * @return bool True if the flag file was created.
	 */
	public static function request_stop_at( string $lock_dir ): bool {
		$lock_dir = \rtrim( $lock_dir, '/' );
		if ( ! \is_dir( $lock_dir ) || Config::write_denied( 'stop flag' ) ) {
			return false;
		}
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_file_put_contents
		return false !== @\file_put_contents( $lock_dir . '/' . self::STOP_FLAG, (string) \time() );
	}

	/**
	 * Clear a stop flag without disturbing the lock. `wp nodes start` calls this
	 * for every dir before spawning: a straggler that outlasted `stop`'s wait
	 * still carries the flag, and would read it whenever its handler returns,
	 * exit, and — being a stop — decline to respawn, emptying the slot long
	 * after the operator was told the fleet was back.
	 *
	 * @param string $lock_dir The lock directory path.
	 */
	public static function clear_stop_at( string $lock_dir ): void {
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_unlink
		@\unlink( \rtrim( $lock_dir, '/' ) . '/' . self::STOP_FLAG );
	}

	/** Whether an operator asked this worker to stop rather than recycle. */
	public function stop_requested(): bool {
		\clearstatcache( true, $this->lock_path . '/' . self::STOP_FLAG );
		return \is_file( $this->lock_path . '/' . self::STOP_FLAG );
	}

	/**
	 * Signal the lock's holder that its config is stale — re-read, do not exit.
	 *
	 * The file's CONTENT is the whole signal: a fresh watermark per request, which
	 * the holder acts on whenever it differs from the one it last acted on.
	 * MTIME cannot carry it — the filesystem resolves to a second and a settings
	 * save writes several options in one request, so a second request inside that
	 * second would be lost rather than merely late. Rewriting an existing flag is
	 * the intended repeat path, so this never checks for absence first.
	 *
	 * @param string $lock_dir The lock directory path.
	 * @return bool True if the watermark was written.
	 */
	public static function request_reload_at( string $lock_dir ): bool {
		$lock_dir = \rtrim( $lock_dir, '/' );
		if ( ! \is_dir( $lock_dir ) || Config::write_denied( 'reload flag' ) ) {
			return false;
		}
		$watermark = \time() . '.' . \bin2hex( \random_bytes( 6 ) );
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_file_put_contents
		return false !== @\file_put_contents( $lock_dir . '/' . self::RELOAD_FLAG, $watermark );
	}

	/**
	 * Why this lock's holder should exit, or '' to keep running.
	 *
	 * Three unrelated situations end a worker through this one channel, and an
	 * operator reading `restart requested` off a worker that nobody restarted
	 * has no way to tell which — so each says what actually happened.
	 *
	 * Heavy clearstatcache is intentional — long-running workers won't see external changes otherwise.
	 */
	public function restart_reason(): string {
		\clearstatcache( true, $this->lock_path . '/' . self::RESTART_FLAG );
		if ( \is_file( $this->lock_path . '/' . self::RESTART_FLAG ) ) {
			return 'restart requested';
		}

		// PID-content theft check: only meaningful if we believe we hold it.
		if ( $this->is_held ) {
			\clearstatcache( true, $this->lock_path . '/' . self::HEARTBEAT_FILE );
			// phpcs:ignore WordPressVIPMinimum.Performance.FetchingRemoteData.FileGetContentsUnknown
			$content = @\file_get_contents( $this->lock_path . '/' . self::HEARTBEAT_FILE );
			if ( false === $content ) {
				return 'lock heartbeat gone';
			}
			$holder = (int) $content;
			if ( $holder !== \getmypid() ) {
				return "lock stolen by pid {$holder}";
			}
		}
		return '';
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
	 * THE staleness rule for a worker heartbeat: no heartbeat file, or one
	 * older than the threshold this worker declares.
	 *
	 * Four readers of this one mtime once had four policies — the respawn
	 * decision and the Workers dashboard honoured a topology's declared
	 * `stale_timeout`, `wp nodes status` used a flat 60, and two dashboards
	 * hardcoded 30. So a job-worker mid-job (`job-worker.tsl` lifts the
	 * threshold to 600 precisely because job handlers run slow user code) read
	 * DOWN in the CLI and the UI while the peer scan correctly left it alone.
	 *
	 * @param string $lock_dir      The `.lock.d` directory.
	 * @param int    $now           Clock, so one scan judges every worker alike.
	 * @param int    $stale_timeout Seconds without a heartbeat before stale.
	 * @return bool True when the worker reads as down.
	 */
	public static function heartbeat_is_stale( string $lock_dir, int $now, int $stale_timeout ): bool {
		$mtime = @\filemtime( "{$lock_dir}/heartbeat" );
		return false === $mtime || ( $now - $mtime ) > $stale_timeout;
	}

	/**
	 * The stale threshold a worker descriptor declares, defaulting to
	 * STALE_TIMEOUT. The one place that `?? STALE_TIMEOUT` fallback lives.
	 *
	 * @param array<array-key,mixed> $descriptor A worker descriptor or topology entry.
	 * @return int Seconds.
	 */
	public static function stale_timeout_of( array $descriptor ): int {
		return Core::as_int(
			$descriptor['stale_timeout'] ?? self::STALE_TIMEOUT,
			self::STALE_TIMEOUT
		);
	}

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

	public static function node_schema(): array {
		// Hidden: internal primitive, not a standalone graph node.
		return [
			'category'    => 'Hidden',
			'description' => 'Advisory cooperative file lock with heartbeat; blocks until acquired.',
			'arguments'   => [],
			'commands'    => [],
		];
	}
}
