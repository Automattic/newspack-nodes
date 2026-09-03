<?php
/**
 * Single-holder claim on a slot, and the signal channel to whoever holds it.
 *
 * One worker per `{type}.p{N}` slot and one writer per large-write Partition:
 * a lock directory says the slot is taken, a PID-stamped heartbeat file inside
 * it says the holder is still alive, and three flag files carry restart, stop
 * and reload requests in from processes holding no instance. Acquisition is
 * `mkdir`, POSIX's atomic primitive, so the claim holds on the NFS, tmpfs and
 * Docker bind mounts where `flock` does not, and needs no daemon, no database
 * row and no cleanup pass to be correct after a crash.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

if ( ! \defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Advisory lock over a directory, held for as long as its owner heartbeats.
 *
 * Cooperative, not enforced: nothing stops a process that never asks. A holder
 * that stops refreshing its heartbeat for `stale_timeout` seconds is stolen
 * from, and that is the entire recovery story for a worker lost to an OOM
 * kill, a container restart or a SIGKILL — no reaper runs, the next acquirer
 * cleans up. Every acquire path builds a fresh directory rather than adopting
 * the one it displaces, so no flag or heartbeat survives a handover.
 *
 * A Node so a Timer can sink `KEY='heartbeat'` messages into it inside a drain
 * loop, keeping a held lock fresh without the holder polling.
 */
class Lock_Node extends Node {
	/** Holds the owner's PID; its mtime is the liveness signal every reader stats. */
	public const HEARTBEAT_FILE = 'heartbeat';

	/** Grace period (s) before stealing an orphan dir (no heartbeat) — holder may be mid-acquire. */
	public const ORPHAN_GRACE_S = 1;

	/**
	 * Config-changed watermark: a token its CONTENT carries, compared rather
	 * than consumed (see request_reload_at()). Distinct from RESTART_FLAG on
	 * purpose — this says "re-read", never "exit".
	 */
	public const RELOAD_FLAG    = 'reload';

	/** Recycle request: the holder exits and its successor takes the slot. */
	public const RESTART_FLAG   = 'restart';

	/**
	 * Operator stop. Distinct from RESTART_FLAG because the two want opposite
	 * successor behaviour — a restart hands the slot straight to a fresh
	 * process, a stop must leave it empty for the length of a deploy. The flag
	 * only has to outlive the exiting worker; keeping the slot empty afterwards
	 * is the hold option's job, since both acquire paths build a fresh dir.
	 */
	public const STOP_FLAG      = 'stop';

	/** Default seconds without a heartbeat before a holder becomes stealable. */
	public const STALE_TIMEOUT  = 60;

	/** Acquisition time in Unix seconds; `wp nodes status` reads it as uptime. */
	public const STARTED_FILE   = 'started';

	/** Why the last acquire() failed; '' after a success. */
	private string $acquire_failure = '';

	/**
	 * Whether THIS process believes it holds the lock — a belief, never the
	 * truth. Only the heartbeat PID on disk settles ownership, which is why
	 * release() and heartbeat() verify instead of trusting the flag.
	 */
	private bool $is_held = false;

	/** The lock directory, trailing slash stripped so the file paths compose. */
	private string $lock_path;

	/** Seconds without a heartbeat before this instance steals someone's dir. */
	private int $stale_timeout;

	/**
	 * @param string $lock_path     Directory to claim. acquire() creates it; the caller must not.
	 * @param int    $stale_timeout Seconds without a heartbeat before the holder is stealable.
	 */
	public function __construct( string $lock_path, int $stale_timeout = self::STALE_TIMEOUT ) {
		parent::__construct();
		$this->lock_path     = \rtrim( $lock_path, '/' );
		$this->stale_timeout = $stale_timeout;
	}

	/**
	 * Node entry point: a `KEY='heartbeat'` message refreshes the lock, anything
	 * else forwards via the sink.
	 *
	 * @param array<int,mixed> $message Read for its KEY; handed to parent::fill() otherwise.
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

	/**
	 * Claim the lock, stealing an orphaned or stale dir if one is in the way.
	 *
	 * A failed `mkdir` on a path that is not a directory is an I/O fault rather
	 * than contention, so it earns one free retry — the holder may have released
	 * between the two calls — and then reports the errno through
	 * acquire_failure(). Telling the two apart is what lets a skipped spawn stay
	 * quiet while a broken directory gets logged.
	 *
	 * @param int $max_wait_ms Milliseconds to retry contention at 100ms; 0 gives up on the first refusal.
	 * @return bool True when the lock is ours.
	 */
	public function acquire( int $max_wait_ms = 0 ): bool {
		$this->acquire_failure = '';
		$deadline   = $max_wait_ms > 0 ? Core::right_now() + ( $max_wait_ms / 1000.0 ) : 0;
		$io_retried = false;
		do {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
			if ( @\mkdir( $this->lock_path, 0755, true ) ) {
				return $this->claim( 'HELD' );
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
				// STOLEN so dashboards can badge the takeover.
				return $this->claim( 'STOLEN' );
			}

			if ( 0 === $max_wait_ms || Core::right_now() >= $deadline ) {
				$this->acquire_failure = 'lock_held';
				return false;
			}
			\usleep( 100_000 );
		} while ( true );
	}

	/**
	 * Take ownership of a lock dir this call just created or stole: write the
	 * acquire files, or roll the dir back so a half-written one is not orphaned.
	 *
	 * @param string $state The state event to publish — 'HELD' or 'STOLEN'.
	 * @return bool True when the lock is ours.
	 */
	private function claim( string $state ): bool {
		if ( $this->write_acquire_files() ) {
			$this->is_held = true;
			$this->set_state( $state, $this->lock_path );
			return true;
		}
		self::force_release_at( $this->lock_path );
		$this->acquire_failure = "lock dir unwritable at {$this->lock_path}";
		return false;
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
	 * loser's rename fails (source already gone) and it backs off. Clearing the
	 * dir in place with force_release_at() then mkdir() instead would let both
	 * racers delete each other's heartbeat and both believe they hold the lock.
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
	 * Write the heartbeat (PID) and started-timestamp files, then unlink the
	 * restart flag — the only place that flag is ever cleared, so a holder
	 * starting under a stale one would exit on its first tick.
	 *
	 * @return bool True if both files were written; false on the first failure.
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
	 *
	 * @param string $file Filename to compose inside the lock dir.
	 * @return string|null The path, or null when a symlink occupies it.
	 */
	private function unlinked_path( string $file ): ?string {
		$path = $this->lock_path . '/' . $file;
		return \is_link( $path ) ? null : $path;
	}

	/**
	 * Give up the lock — but only if we still hold it.
	 *
	 * Verified against the heartbeat PID, never against our own `is_held` flag.
	 * A worker blocked in a long job stops heartbeating, goes stale, and a peer
	 * steals the dir; `restart_reason()` reports the theft but deliberately
	 * leaves `is_held` alone, so a flag-only check here would have the evicted
	 * holder `force_release_at()` the SUCCESSOR's directory. The successor then
	 * dies of "lock dir gone" on its next tick and both respawn, turning a
	 * self-correcting handoff into a restart loop. Failing closed leaks a dir
	 * at worst, and a leaked dir goes stale and is stolen normally.
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
	 * Clear a lock dir unconditionally: every file this class writes, then the
	 * directory itself. Neither ownership nor staleness is consulted, so the
	 * caller has to know it is entitled — release() verifies first, and claim()
	 * rolls back a half-written dir of its own.
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

	/**
	 * Static politely request restart: create a file inside the lock dir.
	 *
	 * @param string $lock_dir The lock directory path.
	 * @return bool True if the flag file was created.
	 */
	public static function request_restart_at( string $lock_dir ): bool {
		return self::write_flag_at( $lock_dir, self::RESTART_FLAG, 'restart flag', (string) \time() );
	}

	/**
	 * Static politely request STOP: exit and leave the slot empty.
	 *
	 * @param string $lock_dir The lock directory path.
	 * @return bool True if the flag file was created.
	 */
	public static function request_stop_at( string $lock_dir ): bool {
		return self::write_flag_at( $lock_dir, self::STOP_FLAG, 'stop flag', (string) \time() );
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
		$watermark = \time() . '.' . \bin2hex( \random_bytes( 6 ) );
		return self::write_flag_at( $lock_dir, self::RELOAD_FLAG, 'reload flag', $watermark );
	}

	/**
	 * Write one signal file into a lock dir the caller does not hold. The three
	 * flags differ only in name, diagnostic and contents; the refusal to write
	 * into a missing dir or under a write-denied config is one rule.
	 *
	 * @param string $lock_dir The lock directory path.
	 * @param string $flag     Flag filename constant.
	 * @param string $what     Diagnostic label for Config::write_denied().
	 * @param string $contents The signal itself.
	 * @return bool True if the flag file was written.
	 */
	private static function write_flag_at( string $lock_dir, string $flag, string $what, string $contents ): bool {
		$lock_dir = \rtrim( $lock_dir, '/' );
		if ( ! \is_dir( $lock_dir ) || Config::write_denied( $what ) ) {
			return false;
		}
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_file_put_contents
		return false !== @\file_put_contents( $lock_dir . '/' . $flag, $contents );
	}

	/** Why the last acquire() failed ('' after success): 'lock_held' = contention; anything else is an I/O diagnosis. */
	public function acquire_failure(): string {
		return $this->acquire_failure;
	}

	/** Whether this process last believed it held the lock; verify_ownership() is the check. */
	public function is_held(): bool {
		return $this->is_held;
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
	 * Why this lock's holder should exit, or '' to keep running.
	 *
	 * Three unrelated situations end a worker through this one channel —
	 * `restart requested`, `lock heartbeat gone` and `lock stolen by pid N` —
	 * and an operator reading a bare `restart requested` off a worker nobody
	 * restarted cannot tell which, so each says what happened.
	 *
	 * Every stat clears the cache first: a long-running worker otherwise never
	 * sees a flag another process wrote.
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
	 * Whether a restart is pending on a lock dir this process does not hold —
	 * the flag file alone, since there is no PID here to compare against.
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
	 * Every reader of that mtime comes through here — the respawn decision,
	 * `wp nodes status`, the dashboards — because a threshold each picks for
	 * itself drifts from the rest. A worker mid-job declares a long one
	 * (`job-spoke.tsl` sets 600, since a render is slow user code), and a reader
	 * holding a flat 60 reports it down while the peer scan correctly leaves it
	 * alone.
	 *
	 * @param string $lock_dir      The `.lock.d` directory.
	 * @param int    $now           Clock, so one scan judges every worker alike.
	 * @param int    $stale_timeout Seconds without a heartbeat before stale.
	 * @return bool True when the worker reads as down.
	 */
	public static function heartbeat_is_stale( string $lock_dir, int $now, int $stale_timeout ): bool {
		$beat = \rtrim( $lock_dir, '/' ) . '/' . self::HEARTBEAT_FILE;
		// Per-process stat cache: a long worker freezes every peer's mtime.
		\clearstatcache( true, $beat );
		$mtime = @\filemtime( $beat );
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

	/**
	 * The acquisition time the current holder wrote, or null when the lock dir
	 * or the file is absent — which reads as "no uptime to show", never as an
	 * uptime of zero.
	 *
	 * @param string $lock_dir The lock directory path.
	 * @return int|null Unix seconds, or null when there is no started file.
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
	 * Hidden from the palette: PHP builds this node directly — `Worker_Base` for
	 * a slot, `Partition::allow_large_writes()` for a write lock — and no
	 * topology line names it, so it declares no arguments and no verbs. The
	 * HELD / STOLEN / RELEASED states it publishes are deliberately undeclared
	 * too: they surface through `dump_node` and trace, and nothing subscribes.
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return [
			'category'    => 'Hidden',
			'description' => 'Advisory cooperative directory lock with a PID heartbeat and stale takeover.',
			'arguments'   => [],
			'commands'    => [],
		];
	}
}
