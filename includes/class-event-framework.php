<?php
/**
 * EventFramework: per-process drain-loop singleton.
 *
 * Manages timers, cURL multi handles, and deferred-cleanup integration.
 * Drain order per iteration:
 *   1. Wait: curl_multi_select (when cURL handles are registered) or usleep
 *      (otherwise), capped by the soonest pending timer.
 *   2. Signal dispatch (pcntl_signal_dispatch if available).
 *   3. Run Core::$closing deferred-cleanup queue.
 *   4. Fire any timers whose next_fire has elapsed.
 *   5. Loop check (should_continue callable).
 *
 * Local file descriptors (Tail, Consumer, Cli_Stdin_Reader) are timer-driven
 * via set_timer — there's no FD registration / stream_select path. cli's
 * stdin polls at 0ms when piped data is flowing, 10ms during EOF round-trip,
 * 100ms idle.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class EventFramework {
	private static ?self $instance = null;

	/** @var array<int,array{node:object,interval_ms:int,oneshot:bool,next_fire:float}> */
	private array $timers = [];
	/** @var array<int,array{node:object,multi:\CurlMultiHandle}> */
	private array $curl_handles = [];

	/**
	 * True while inside `drain()`. Lets callers (Partition, etc.) detect
	 * "am I inside a worker event loop?" — false in web-request /
	 * static-helper contexts where there's no drain to fire Timer callbacks.
	 */
	private bool $draining = false;

	public function is_running(): bool {
		return $this->draining;
	}

	private function __construct() {}

	public static function instance(): self {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	public static function reset(): void {
		self::$instance = null;
	}

	public function set_timer( object $node, int $interval_ms, bool $oneshot = false ): void {
		$id = \spl_object_id( $node );
		$this->timers[ $id ] = [
			'node'        => $node,
			'interval_ms' => $interval_ms,
			'oneshot'     => $oneshot,
			'next_fire'   => Core::$now + ( $interval_ms / 1000.0 ),
		];
	}

	public function stop_timer( object $node ): void {
		unset( $this->timers[ \spl_object_id( $node ) ] );
	}

	public function register_curl_handle( object $node, \CurlMultiHandle $multi ): void {
		$this->curl_handles[ \spl_object_id( $node ) ] = [ 'node' => $node, 'multi' => $multi ];
	}

	public function unregister_curl_handle( object $node ): void {
		unset( $this->curl_handles[ \spl_object_id( $node ) ] );
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

	private function drain_curl_multi(): void {
		// Raw cURL is intentional: wp_remote_get is request/response only,
		// no streaming multi handle. SSE pulls need curl_multi_*.
		// phpcs:disable WordPress.WP.AlternativeFunctions.curl_curl_multi_exec, WordPress.WP.AlternativeFunctions.curl_curl_multi_info_read
		foreach ( $this->curl_handles as $entry ) {
			$still_running = 0;
			\curl_multi_exec( $entry['multi'], $still_running );
			while ( $info = \curl_multi_info_read( $entry['multi'] ) ) {
				if ( \method_exists( $entry['node'], 'on_curl_message' ) ) {
					$entry['node']->on_curl_message( $info );
				}
			}
		}
		// phpcs:enable
	}

	/**
	 * Microseconds until the soonest expiring timer (or the idle cap when no
	 * timers are registered). cURL waits use this as the curl_multi_select
	 * timeout so a timer firing wakes us promptly.
	 */
	private const IDLE_TIMEOUT_US = 100_000; // 0.1s when nothing has a timer.

	private function next_timer_timeout_us(): int {
		if ( empty( $this->timers ) ) {
			return self::IDLE_TIMEOUT_US;
		}
		$soonest = PHP_INT_MAX;
		foreach ( $this->timers as $t ) {
			$delta_us = (int) ( ( $t['next_fire'] - Core::$now ) * 1_000_000 );
			if ( $delta_us < $soonest ) {
				$soonest = $delta_us;
			}
		}
		return \max( 0, $soonest );
	}

	public function drain( callable $should_continue ): void {
		$has_pcntl       = \function_exists( 'pcntl_signal_dispatch' );
		$this->draining  = true;
		try {
			$this->drain_inner( $should_continue, $has_pcntl );
		} finally {
			$this->draining = false;
		}
	}

	/**
	 * Hot loop — clock refresh, Core::run_closing, and the expired-timer
	 * scan are inlined for one less call frame per tick. PHP function call
	 * cost is ~100ns each on PHP 8.4; with a busy worker hitting hundreds
	 * of iterations per second, that's measurable. Logic unchanged.
	 */
	private function drain_inner( callable $should_continue, bool $has_pcntl ): void {
		Core::$now = \microtime( true );
		while ( $should_continue() ) {
			if ( Core::$shutting_down ) {
				break;
			}

			$timeout_us = $this->next_timer_timeout_us();

			// Two waiters: cURL handles (block on their internal sockets) or
			// nothing (sleep until the next timer). Local file descriptors
			// are reached via timer-driven polling — every Tail / Consumer /
			// Cli_Stdin_Reader uses set_timer to schedule its next poll.
			// That keeps the loop down to one blocking call per iteration
			// regardless of which I/O sources are active.
			if ( ! empty( $this->curl_handles ) ) {
				foreach ( $this->curl_handles as $entry ) {
					// Raw cURL needed for streaming SSE — wp_remote_get is one-shot.
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

			while ( ! empty( Core::$closing ) ) {
				( \array_shift( Core::$closing ) )();
			}

			Core::$now = \microtime( true );

			foreach ( $this->timers as $id => $entry ) {
				if ( $entry['next_fire'] > Core::$now ) {
					continue;
				}
				if ( $entry['oneshot'] ) {
					unset( $this->timers[ $id ] );
				} else {
					$this->timers[ $id ]['next_fire'] = Core::$now + ( $entry['interval_ms'] / 1000.0 );
				}
				$entry['node']->fire_cb();
			}
		}

		// Post-loop drain so close-handlers scheduled during shutdown actually run.
		while ( ! empty( Core::$closing ) ) {
			( \array_shift( Core::$closing ) )();
		}
	}
}
