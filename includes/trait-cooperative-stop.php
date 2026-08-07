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

	/** Seconds a process runs before yielding to its successor. */
	public const DEFAULT_MAX_RUNTIME = 595;

	/** Seconds between lock heartbeats. */
	public const HEARTBEAT_INTERVAL_S = 10;

	/** Seconds between DB liveness probes. */
	public const DB_CHECK_INTERVAL_S = 30;

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
	 * Whether to keep running. Every cooperative-stop trigger lives here, and
	 * the heartbeat rides along so a process that asks the question also proves
	 * it is alive.
	 *
	 * @return bool False once any trigger fires.
	 */
	public function should_continue(): bool {
		// Under pump(), Core::$now is frozen mid-job: one fresh read, reused.
		$now = Core::right_now();

		if ( null === $this->lock || ! $this->lock->is_held() ) {
			return $this->stop( 'lock lost' );
		}
		if ( ! \is_dir( $this->held_lock_path() ) ) {
			return $this->stop( 'lock dir gone' );
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

		if ( ( $now - $this->last_heartbeat ) >= self::HEARTBEAT_INTERVAL_S ) {
			$this->lock->heartbeat();
			$this->last_heartbeat = $now;
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

		return true;
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
