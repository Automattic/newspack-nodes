<?php
/**
 * Cooperative_Stop: THE stop policy for every long-running process.
 *
 * `should_continue()` owns every cooperative-stop trigger — lock lost, lock dir
 * gone, lock flagged or stolen, max-runtime, memory watermark, DB liveness — and the
 * heartbeat rides along, so a process that asks whether to keep running also
 * proves it is alive. No node implements its own restart.
 *
 * A consumer supplies the two things that genuinely differ — where its lock dir
 * lives, and what to call itself in a stop message — and inherits the policy.
 * Re-implementing any subset of it is how a process ends up with no memory
 * watermark: a leak then bounded only by the FPM child's OOM, which skips the
 * `finally` and therefore the respawn.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

trait Cooperative_Stop {

	/** True while the SIGALRM heartbeat is armed; pcntl may be absent. */
	private bool $alarm_armed = false;

	/** Async-signal dispatch as found, restored on disarm. */
	private bool $async_signals_was = false;

	/** Seconds a process runs before yielding to its successor. */
	public const DEFAULT_MAX_RUNTIME = 595;

	/** Seconds between lock heartbeats. */
	public const HEARTBEAT_INTERVAL_S = 10;

	/** Seconds between DB liveness probes. */
	public const DB_CHECK_INTERVAL_S = 30;

	/** Seconds between idle scans; `idle_since()` stats the disk, `should_continue()` is per-tick. */
	public const IDLE_CHECK_INTERVAL_S = 1;

	/** Consecutive DB-probe failures that stop the process. */
	public const DB_CHECK_MAX_FAILURES = 3;

	/** Fraction of the memory limit at which a process yields. */
	public const MEMORY_WATERMARK_PCT = 0.80;

	/**
	 * DB-liveness seam. Lazily-defaulted to `$wpdb->check_connection( false )`
	 * (duck-typed; passes when no $wpdb is loaded). Tests reassign to drive
	 * consecutive failures without a real dead connection.
	 * Signature: `function (): bool`.
	 *
	 * @var \Closure|null
	 */
	public static ?\Closure $db_probe = null;

	/** Consecutive DB-probe failures; N in a row stops the process. */
	protected int $db_failures = 0;

	/** Last DB liveness probe (epoch seconds). */
	protected float $last_db_check = 0.0;

	/** Last lock heartbeat (epoch seconds). */
	protected float $last_heartbeat = 0.0;

	/** Last idle scan (epoch seconds). */
	protected float $last_idle_check = 0.0;

	/** A reporter the registry cannot see — the anonymous IPC-input Consumer. */
	protected ?Idle_Reporter $ipc_reporter = null;

	/** Seconds every reporter must stay idle before this process exits; 0 = resident. */
	protected int $on_demand_idle = 0;

	/** The held lock, or null before acquire / after release. */
	protected ?Lock_Node $lock = null;

	/** Seconds this process may run before yielding to its successor. */
	protected int $max_runtime = self::DEFAULT_MAX_RUNTIME;

	/** When this process started (epoch seconds). */
	protected float $start_time = 0.0;

	/** Cooperative-stop category for the shutdown handoff; '' is operational. */
	protected string $stop_reason = '';

	/**
	 * The `.lock.d` directory THIS process holds. Named apart from
	 * `Spawn_Coordinator::lock_path( $type, $partition )`, which answers a
	 * different question — where some OTHER worker's lock lives.
	 */
	abstract protected function held_lock_path(): string;

	/** How this process names itself in a stop message. */
	abstract protected function stop_label(): string;

	/**
	 * Beat the lock from a SIGALRM, so work that yields nothing keeps its lock.
	 *
	 * The preferred beat, and while armed the only one. `should_continue()`
	 * beats only between messages, and a job that writes nothing — one long
	 * query, a `proc_open` — starves that: `Event_Framework::pump()` is reached
	 * solely from the Partition write path. Silence past `stale_timeout` costs
	 * the lock to a peer and the job dies mid-flight, replayed to die again.
	 * Where pcntl is missing (it is CLI-only on some builds, and workers run in
	 * the web SAPI) that fallback is what keeps the lock alive, quietly.
	 *
	 * The handler does the MINIMUM: touch the heartbeat, re-arm, return. It
	 * must NOT call should_continue() — that scans the disk and can raise
	 * `Worker_Should_Stop`, and unwinding from a signal at an arbitrary
	 * instruction is not something the drain path survives. Stopping belongs to
	 * the drain loop and pump().
	 *
	 * `pcntl_alarm()` is one-shot; the handler re-arming itself IS the
	 * mechanism. Without pcntl there is no beat at all, so say so loudly.
	 *
	 * @param int $seconds Alarm period; defaults to the ordinary beat interval.
	 */
	protected function arm_heartbeat_alarm( int $seconds = self::HEARTBEAT_INTERVAL_S ): void {
		if ( ! \function_exists( 'pcntl_async_signals' ) || ! \function_exists( 'pcntl_alarm' ) ) {
			return; // should_continue() falls back; see beat().
		}
		// Returns the prior setting; disarm puts it back.
		$this->async_signals_was = \pcntl_async_signals( true );
		\pcntl_signal(
			\SIGALRM,
			function () use ( $seconds ): void {
				// microtime: a signal must not move the cached clock.
				$this->beat( \microtime( true ) );
				\pcntl_alarm( $seconds );
			}
		);
		\pcntl_alarm( $seconds );
		$this->alarm_armed = true;
	}

	/**
	 * Stop the SIGALRM heartbeat and put the process back as it was.
	 *
	 * Idempotent, and called from the shutdown handler as well as the `finally`:
	 * a fatal skips the `finally`, and an alarm landing inside `Lock_Node::
	 * release()` — after `verify_ownership()` reads the heartbeat, before the
	 * unlink completes — recreates the file, so the rmdir fails on a non-empty
	 * dir and the leftover looks fresh enough that nothing will steal it. That
	 * partition then sits dark for a whole `stale_timeout`.
	 */
	protected function disarm_heartbeat_alarm(): void {
		if ( ! $this->alarm_armed ) {
			return;
		}
		$this->alarm_armed = false;
		\pcntl_alarm( 0 );
		// SIG_IGN: SIGALRM's default action terminates the process.
		\pcntl_signal( \SIGALRM, \SIG_IGN );
		\pcntl_async_signals( $this->async_signals_was );
	}

	/**
	 * Touch the lock and stamp the beat. The one implementation, shared by the
	 * alarm and by `should_continue()`'s fallback, so the two cannot drift.
	 *
	 * @param float $now The instant to stamp; the caller owns which clock.
	 */
	private function beat( float $now ): void {
		$this->lock?->heartbeat();
		$this->last_heartbeat = $now;
	}

	/**
	 * Whether to keep running. Every cooperative-stop trigger lives here;
	 * proving the process alive belongs to `arm_heartbeat_alarm()`.
	 *
	 * @param bool $mid_work True when asked from INSIDE a unit of work, which is
	 *   what `Event_Framework::pump()` does so a long job still heartbeats and
	 *   still honors the real stops. The idle branch is skipped there: work is
	 *   in flight by construction, so "has everything been quiet for the whole
	 *   window?" can only answer wrongly — and it is the expensive question,
	 *   since `Consumer_Node::idle_since()` lists segments and stats the newest.
	 *   Idleness is a between-messages question, and the drain loop asks it.
	 * @return bool False once any trigger fires.
	 */
	public function should_continue( bool $mid_work = false ): bool {
		// Under pump(), Core::$now is frozen mid-job: one fresh read, reused.
		$now = Core::right_now();

		if ( null === $this->lock || ! $this->lock->is_held() ) {
			return $this->stop( 'lock lost' );
		}
		if ( ! \is_dir( $this->held_lock_path() ) ) {
			return $this->stop( 'lock dir gone' );
		}

		// Before restart: a stop leaves the slot empty, a restart refills it.
		if ( $this->lock->stop_requested() ) {
			return $this->stop( 'stop requested', 'stop' );
		}

		// A flag, a gone heartbeat, or a stolen lock — each names itself.
		$restart_reason = $this->lock->restart_reason();
		if ( '' !== $restart_reason ) {
			return $this->stop( $restart_reason );
		}

		if ( ( $now - $this->start_time ) >= $this->max_runtime ) {
			return $this->stop( '', 'timeout' );
		}

		if ( $this->memory_over_watermark() ) {
			$used  = \memory_get_usage( true );
			$limit = $this->memory_limit_bytes();
			return $this->stop(
				\sprintf(
					'memory watermark (%dMB / %dMB, %d%%)',
					(int) ( $used / 1048576 ),
					(int) ( $limit / 1048576 ),
					$limit > 0 ? (int) ( $used / $limit * 100 ) : 0
				),
				'memory'
			);
		}

		// Fallback while no alarm is armed; see arm_heartbeat_alarm().
		if ( ! $this->alarm_armed && ( $now - $this->last_heartbeat ) >= self::HEARTBEAT_INTERVAL_S ) {
			$this->beat( $now );
		}

		if ( ( $now - $this->last_db_check ) >= self::DB_CHECK_INTERVAL_S ) {
			$this->last_db_check = $now;
			if ( ! $this->db_check_passes() ) {
				++$this->db_failures;
				if ( $this->db_failures >= self::DB_CHECK_MAX_FAILURES ) {
					return $this->stop( \sprintf( 'db check failed %d times', $this->db_failures ) );
				}
			} else {
				$this->db_failures = 0;
			}
		}

		// Silent like the routine recycle: `wp nodes status` says `idle`.
		if ( ! $mid_work && $this->on_demand_idle > 0 && $this->idle_window_elapsed( $now ) ) {
			return $this->stop( '', 'idle' );
		}

		return true;
	}

	/**
	 * Whether EVERY `Idle_Reporter` in the graph has been idle for the whole
	 * `on_demand_idle` window. One busy reporter forbids the exit, so a builder
	 * holding an open envelope keeps the process alive even while its consumer
	 * sits at EOF — the quiet case that would otherwise abandon a started span
	 * mid-request.
	 *
	 * The window runs from the LATEST reporter's idle timestamp, which is the
	 * same fold `SSE_Out_Node::opened_at_eof_since()` applies to its consumers.
	 * A graph with no reporter has nothing to measure and never exits.
	 *
	 * @longform Throttled to once a second because `Consumer_Node::idle_since()`
	 * lists segments and stats the newest one, while `should_continue()` runs on
	 * every drain tick — per-tick disk I/O would spend more than the residency
	 * this is meant to give back. A skipped scan reads as "keep running", so the
	 * exit lands at most a second past the window, which is measured in seconds.
	 *
	 * @param float $now Current time, shared with the rest of should_continue().
	 */
	private function idle_window_elapsed( float $now ): bool {
		if ( ( $now - $this->last_idle_check ) < self::IDLE_CHECK_INTERVAL_S ) {
			return false;
		}
		$this->last_idle_check = $now;
		$newest                = null;
		// @longform The IPC-input Consumer is ANONYMOUS on purpose (a pure
		// source, never a routed TO), so it is absent from the registry below
		// and the scan could not see it — an attached REPL is someone using
		// this worker, and it would exit under them mid-session.
		$reporters = \array_merge(
			null === $this->ipc_reporter ? [] : [ $this->ipc_reporter ],
			\array_values( Core::$nodes_by_name )
		);
		foreach ( $reporters as $node ) {
			if ( ! $node instanceof Idle_Reporter ) {
				continue;
			}
			$since = $node->idle_since();
			if ( null === $since ) {
				return false;
			}
			$newest = null === $newest ? $since : \max( $newest, $since );
		}
		return null !== $newest && ( $now - $newest ) >= $this->on_demand_idle;
	}

	/**
	 * Record why we are stopping and say so.
	 *
	 * @param string $reason   Human-readable stop reason + metrics.
	 * @param string $category Cooperative-stop category for the shutdown handoff:
	 *                         'timeout' | 'memory' trigger the fair-shot rule; '' is operational.
	 * @return false Always — callers `return $this->stop( ... )`.
	 */
	private function stop( string $reason, string $category = '' ): bool {
		$this->stop_reason = $category;
		if ( '' !== $reason ) {
			Core::stderr( $this->stop_label() . ": stopping — {$reason}" );
		}
		return false;
	}

	protected function memory_limit_bytes(): int {
		$ini = \ini_get( 'memory_limit' );
		if ( '-1' === $ini ) {
			return -1;
		}
		$num = (int) $ini;
		switch ( \strtolower( \substr( $ini, -1 ) ) ) {
			case 'g': $num *= 1024 * 1024 * 1024; break;
			case 'm': $num *= 1024 * 1024;        break;
			case 'k': $num *= 1024;               break;
		}
		return $num;
	}

	protected function memory_over_watermark(): bool {
		$limit = $this->memory_limit_bytes();
		if ( $limit <= 0 ) {
			return false;
		}
		return \memory_get_usage( true ) >= ( $limit * self::MEMORY_WATERMARK_PCT );
	}

	/** DB liveness probe (via the $db_probe seam); N consecutive failures trigger shutdown. */
	protected function db_check_passes(): bool {
		$probe = self::$db_probe ?? static function (): bool {
			global $wpdb;
			if ( ! \is_object( $wpdb ) || ! \method_exists( $wpdb, 'check_connection' ) ) {
				return true;
			}
			// allow_bail=false: report, don't wp_die inside the drain.
			return (bool) $wpdb->check_connection( false );
		};
		return (bool) $probe();
	}
}
