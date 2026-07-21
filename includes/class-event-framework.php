<?php
/**
 * EventFramework: per-process drain-loop singleton (timers + cURL multi handles + deferred cleanup).
 *
 * Local file descriptors are timer-driven via set_timer — no FD registration / stream_select path.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Event_Framework {

	/** Idle cap for the wait when no timers are registered; also the curl_multi_select timeout so a timer firing wakes us. */
	private const IDLE_TIMEOUT_US = 100_000;

	/** Monotonic throttle for pump(): per-write callers hit it many times/sec; the liveness check runs at most this often. */
	private const PUMP_INTERVAL_S = 1.0;

	private static ?self $instance = null;

	/** The drain's continue-predicate, parked for pump() to re-run from inside a long job. Null outside a drain. */
	private ?\Closure $continue_predicate = null;

	/** @var array<int,array{node:Node,multi:\CurlMultiHandle,counter:int}> */
	private array $curl_handles = [];

	/** True while inside `drain()`; lets callers detect "am I inside a worker event loop?" (false in web-request contexts). */
	private bool $draining = false;
	private float $last_pump = 0.0;

	/** @var array<int,Timer_Node> Timer slots */
	private array $timers = [];

	private function __construct() {}

	/**
	 * @param callable $should_continue Loop predicate; false ends the loop.
	 * @param bool     $cooperative_stop When true, $should_continue carries
	 *   worker-stop semantics: pump() may re-run it from inside a long job and
	 *   raise Worker_Should_Stop. Only Worker_Base opts in — cli / SSE drains
	 *   pass a generic "this loop is done" predicate and must NOT have it thrown.
	 *   Save/restore (not null) keeps a nested drain from disabling an outer
	 *   worker's pump seam.
	 */
	public function drain( callable $should_continue, bool $cooperative_stop = false ): void {
		$has_pcntl      = \function_exists( 'pcntl_signal_dispatch' );
		$prev_draining  = $this->draining;
		$prev_predicate = $this->continue_predicate;
		$prev_last_pump = $this->last_pump;
		$this->draining = true;
		if ( $cooperative_stop ) {
			$this->continue_predicate = \Closure::fromCallable( $should_continue );
			$this->last_pump          = 0.0;
		}
		try {
			$this->drain_inner( $should_continue, $has_pcntl );
		} finally {
			$this->draining           = $prev_draining;
			$this->continue_predicate = $prev_predicate;
			$this->last_pump          = $prev_last_pump;
		}
	}

	/** Hot loop — clock refresh, and the expired-timer scan are inlined to save a call frame per tick. */
	private function drain_inner( callable $should_continue, bool $has_pcntl ): void {
		Core::$now = \microtime( true );
		while ( $should_continue() ) {
			if ( Core::$shutting_down ) {
				break;
			}

			$timeout_us = $this->next_timer_timeout_us();

			// 1 blocking call/iteration: cURL handles, or usleep to timer.
			if ( ! empty( $this->curl_handles ) ) {
				foreach ( $this->curl_handles as $entry ) {
					// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_multi_select
					\curl_multi_select( $entry['multi'], $timeout_us / 1_000_000.0 );
				}
				$this->drain_curl_multi();
			} elseif ( $timeout_us > 0 ) {
				\usleep( $timeout_us );
			}

			if ( $has_pcntl ) {
				\pcntl_signal_dispatch();
			}

			Core::$now = \microtime( true );

			foreach ( $this->timers as $id => $node ) {
				if ( $node->next_fire > Core::$now ) {
					continue;
				}
				if ( $node->oneshot ) {
					unset( $this->timers[ $id ] );
				} else {
					$node->next_fire = Core::$now + ( $node->interval_ms / 1000.0 );
				}
				$node->fire_cb();
			}
		}
	}

	private function next_timer_timeout_us(): int {
		if ( empty( $this->timers ) ) {
			return self::IDLE_TIMEOUT_US;
		}
		$soonest = PHP_INT_MAX;
		foreach ( $this->timers as $t ) {
			$delta_us = (int) ( ( $t->next_fire - Core::$now ) * 1_000_000 );
			if ( $delta_us < $soonest ) {
				$soonest = $delta_us;
			}
		}
		return \max( 0, $soonest );
	}

	private function drain_curl_multi(): void {
		// Raw cURL: wp_remote_get is one-shot; SSE pulls need curl_multi_*.
		// phpcs:disable WordPress.WP.AlternativeFunctions.curl_curl_multi_exec, WordPress.WP.AlternativeFunctions.curl_curl_multi_info_read
		foreach ( $this->curl_handles as &$entry ) {
			$still_running = 0;
			\curl_multi_exec( $entry['multi'], $still_running );
			while ( $info = \curl_multi_info_read( $entry['multi'] ) ) {
				if ( \method_exists( $entry['node'], 'on_curl_message' ) ) {
					++$entry['counter']; // @longform ref writes the live entry; on_curl_message may unregister it after
					$entry['node']->on_curl_message( $info );
				}
			}
		}
		unset( $entry );
		// phpcs:enable
	}

	public function is_running(): bool {
		return $this->draining;
	}

	/**
	 * Re-run the worker drain's continue-predicate from inside a long in-process
	 * job (called on the firehose write path) so the worker lock keeps beating
	 * and a max_runtime / restart / memory stop is honored even while the job is
	 * starving the drain loop. No-op unless a cooperative-stop drain is active
	 * (so web requests + cli/SSE drains never throw); throttled so per-line
	 * writes don't re-run the check every time.
	 *
	 * Throttle reads the wall clock directly, not Core::$now — that clock is
	 * frozen for the whole blocking job, so it can't gate this.
	 *
	 * A Worker_Should_Stop raised here unwinds the whole fill() stack: broad
	 * drain-path catches re-throw it before handling (ADR-14), so the mid-job
	 * stop reaches Worker_Base on every path, not just the direct firehose write.
	 */
	public function pump(): void {
		if ( null === $this->continue_predicate ) {
			return;
		}
		// A stderr write is not a stop boundary; logging it would self-throw.
		if ( Core::in_stderr() ) {
			return;
		}
		$now = \microtime( true );
		if ( $now - $this->last_pump < self::PUMP_INTERVAL_S ) {
			return;
		}
		$this->last_pump = $now;
		if ( ! ( $this->continue_predicate )() ) {
			throw new Worker_Should_Stop();
		}
	}

	public static function instance(): self {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	/** @api Support for unit tests. */
	public static function reset(): void {
		self::$instance = null;
	}

	public function set_timer( Timer_Node $node ): void {
		$id = \spl_object_id( $node );
		// Seed next_fire; else it stays 0.0 and the timer busy-loops.
		$node->next_fire     = Core::$now + ( $node->interval_ms / 1000.0 );
		$this->timers[ $id ] = $node;
	}

	public function stop_timer( Timer_Node $node ): void {
		unset( $this->timers[ \spl_object_id( $node ) ] );
	}

	/** @api Support for SSE streams. */
	public function register_curl_handle( Node $node, \CurlMultiHandle $multi ): void {
		$this->curl_handles[ \spl_object_id( $node ) ] = [ 'node' => $node, 'multi' => $multi, 'counter' => 0 ];
	}

	/** @api Support for SSE streams. */
	public function unregister_curl_handle( Node $node ): void {
		unset( $this->curl_handles[ \spl_object_id( $node ) ] );
	}

	/**
	 * Registered curl handles, keyed by spl_object_id. Introspection for `list_handles`.
	 *
	 * @return array<int, array{node: Node, multi: \CurlMultiHandle, counter: int}>
	 */
	public function curl_handles(): array {
		return $this->curl_handles;
	}

	public function install_signal_handlers(): void {
		if ( ! \function_exists( 'pcntl_signal' ) ) {
			return;
		}
		$handler = static function ( int $sig ): void {
			Core::$shutting_down = true;
		};
		\pcntl_signal( SIGTERM, $handler );
		\pcntl_signal( SIGINT,  $handler );
	}
}
