<?php
/**
 * EventFramework: per-process drain-loop singleton (timers + cURL multi handles).
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

	/**
	 * curl-multi poll seam. Lazily-defaulted to the real curl_multi_exec + drain of
	 * curl_multi_info_read. Tests reassign to feed synthetic CURLMSG_DONE infos so the
	 * owner-routing runs as production code without a network transfer.
	 *
	 * Signature: `function ( \CurlMultiHandle $multi ): array<int,array<string,mixed>>`.
	 *
	 * @var \Closure|null
	 */
	public static ?\Closure $curl_poll = null;

	/** The drain's continue-predicate, parked for pump() to re-run from inside a long job. Null outside a drain. */
	private ?\Closure $continue_predicate = null;

	/** One shared multi handle for every registered easy handle; lazily created on first register. */
	private ?\CurlMultiHandle $curl_multi = null;

	/** @var array<int,Node> Owning node keyed by spl_object_id of the easy handle. */
	private array $curl_owners = [];

	/** @var array<int,int> Per-node completion counter keyed by spl_object_id of the node (list_handles introspection). */
	private array $curl_counts = [];

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
		Core::right_now();
		while ( $should_continue() ) {
			if ( Core::$shutting_down ) {
				break;
			}

			$timeout_us = $this->next_timer_timeout_us();

			// 1 blocking call/iteration: the shared multi, or usleep to timer.
			if ( ! empty( $this->curl_owners ) && null !== $this->curl_multi ) {
				// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_multi_select
				\curl_multi_select( $this->curl_multi, $timeout_us / 1_000_000.0 );
				$this->drain_curl_multi();
			} elseif ( $timeout_us > 0 ) {
				\usleep( $timeout_us );
			}

			if ( $has_pcntl ) {
				\pcntl_signal_dispatch();
			}

			Core::right_now();

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
		if ( null === $this->curl_multi ) {
			return;
		}
		// Raw cURL: wp_remote_get is one-shot; SSE pulls need curl_multi_*.
		$poll = self::$curl_poll ?? static function ( \CurlMultiHandle $multi ): array {
			// phpcs:disable WordPress.WP.AlternativeFunctions.curl_curl_multi_exec, WordPress.WP.AlternativeFunctions.curl_curl_multi_info_read
			$still_running = 0;
			\curl_multi_exec( $multi, $still_running );
			$infos = [];
			while ( $info = \curl_multi_info_read( $multi ) ) {
				$infos[] = $info;
			}
			return $infos;
			// phpcs:enable
		};
		$infos = $poll( $this->curl_multi );
		if ( ! \is_array( $infos ) ) {
			return;
		}
		foreach ( $infos as $info ) {
			if ( \is_array( $info ) ) {
				$this->dispatch_curl_info( $info );
			}
		}
	}

	/**
	 * Route one completion to its owning node (looked up by the easy handle) and tally it.
	 *
	 * @param array<mixed,mixed> $info
	 */
	private function dispatch_curl_info( array $info ): void {
		$handle = $info['handle'] ?? null;
		if ( ! ( $handle instanceof \CurlHandle ) ) {
			return;
		}
		$node = $this->curl_owners[ \spl_object_id( $handle ) ] ?? null;
		if ( null === $node || ! \method_exists( $node, 'on_curl_message' ) ) {
			return;
		}
		++$this->curl_counts[ \spl_object_id( $node ) ]; // on_curl_message may unregister the handle after
		$node->on_curl_message( $info );
	}

	/**
	 * Add an easy handle to the shared multi and record its owner. The next drain
	 * tick services it and routes its completion back to $node->on_curl_message().
	 *
	 * @api Support for SSE streams + outbound HTTP.
	 */
	public function register_curl_easy( Node $node, \CurlHandle $easy ): void {
		// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_multi_add_handle
		\curl_multi_add_handle( $this->ensure_curl_multi(), $easy );
		$this->curl_owners[ \spl_object_id( $easy ) ] = $node;
		$this->curl_counts[ \spl_object_id( $node ) ] ??= 0;
	}

	/** Lazily create the one shared multi handle every easy handle attaches to. */
	private function ensure_curl_multi(): \CurlMultiHandle {
		if ( null === $this->curl_multi ) {
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_multi_init
			$this->curl_multi = \curl_multi_init();
		}
		return $this->curl_multi;
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
	 * Throttle reads the live wall clock via Core::right_now(): Core::$now is
	 * otherwise frozen for the whole blocking job (nothing refreshes it), so a
	 * stale read couldn't gate this. Routing through right_now() also un-freezes
	 * the cached clock at pump cadence, so mid-job message TIMESTAMPs advance.
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
		$now = Core::right_now();
		if ( $now - $this->last_pump < self::PUMP_INTERVAL_S ) {
			return;
		}
		$this->last_pump = $now;
		// mid_work: the idle question is meaningless with a job in flight.
		if ( ! ( $this->continue_predicate )( true ) ) {
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

	/**
	 * Remove an easy handle from the shared multi and drop its owner. Idempotent.
	 * Clears the per-node counter once that node has no more registered handles.
	 *
	 * @api Support for SSE streams + outbound HTTP.
	 */
	public function unregister_curl_easy( \CurlHandle $easy ): void {
		$id   = \spl_object_id( $easy );
		$node = $this->curl_owners[ $id ] ?? null;
		if ( null === $node ) {
			return;
		}
		if ( null !== $this->curl_multi ) {
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_multi_remove_handle
			\curl_multi_remove_handle( $this->curl_multi, $easy );
		}
		unset( $this->curl_owners[ $id ] );
		if ( ! \in_array( $node, $this->curl_owners, true ) ) {
			unset( $this->curl_counts[ \spl_object_id( $node ) ] );
		}
	}

	/**
	 * Per-node cURL summary keyed by node spl_object_id. Introspection for `list_handles`
	 * — one row per node with a registered easy handle, carrying its completion counter.
	 *
	 * @return array<int, array{node: Node, counter: int}>
	 */
	public function curl_handles(): array {
		$rows = [];
		foreach ( $this->curl_owners as $node ) {
			$nid = \spl_object_id( $node );
			$rows[ $nid ] ??= [ 'node' => $node, 'counter' => $this->curl_counts[ $nid ] ?? 0 ];
		}
		return $rows;
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
