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
	private static ?self $instance = null;

	/** @var array<int,Timer_Node> Timer slots */
	private array $timers = [];

	/** @var array<int,array{node:object,multi:\CurlMultiHandle}> */
	private array $curl_handles = [];

	/** True while inside `drain()`; lets callers detect "am I inside a worker event loop?" (false in web-request contexts). */
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

	/** @api Support for unit tests. */
	public static function reset(): void {
		self::$instance = null;
	}

	public function set_timer( Timer_Node $node ): void {
		$id = \spl_object_id( $node );
		// Schedule the first fire from the node's interval (set by Timer_Node::set_timer
		// before it hands us the node). Without this, next_fire stays 0.0 → the timer
		// fires immediately on the first drain pass and next_timer_timeout_us() computes
		// a negative wait, busy-looping instead of sleeping the interval.
		$node->next_fire     = Core::$now + ( $node->interval_ms / 1000.0 );
		$this->timers[ $id ] = $node;
	}

	public function stop_timer( Timer_Node $node ): void {
		unset( $this->timers[ \spl_object_id( $node ) ] );
	}

	/** @api Support for SSE streams. */
	public function register_curl_handle( object $node, \CurlMultiHandle $multi ): void {
		$this->curl_handles[ \spl_object_id( $node ) ] = [ 'node' => $node, 'multi' => $multi ];
	}

	/** @api Support for SSE streams. */
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
		// Raw cURL is intentional: wp_remote_get is one-shot; SSE pulls need curl_multi_*.
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

	/** Idle cap for the wait when no timers are registered; also the curl_multi_select timeout so a timer firing wakes us. */
	private const IDLE_TIMEOUT_US = 100_000;

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

	public function drain( callable $should_continue ): void {
		$has_pcntl       = \function_exists( 'pcntl_signal_dispatch' );
		$this->draining  = true;
		try {
			$this->drain_inner( $should_continue, $has_pcntl );
		} finally {
			$this->draining = false;
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

			// One blocking call per iteration: cURL handles, or usleep until the next timer.
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
}
