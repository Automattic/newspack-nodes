<?php
/**
 * EventFramework: per-process drain-loop singleton.
 *
 * Manages reader/writer file descriptors, timers, cURL multi handles, and
 * deferred-cleanup integration. Drain order per iteration:
 *   1. Handle ready FDs (read + write)
 *   2. Handle cURL info-read events
 *   3. Handle signals
 *   4. Run Core::run_closing() deferred cleanup
 *   5. Fire expired timers
 *   6. Loop check (should_continue)
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class EventFramework {
	private static ?self $instance = null;

	/** @var array<int,object> */
	private array $readers = [];
	/** @var array<int,object> */
	private array $writers = [];
	/** @var array<int,array{node:object,interval_ms:int,oneshot:bool,next_fire:float}> */
	private array $timers = [];
	/** @var array<int,array{node:object,multi:\CurlMultiHandle}> */
	private array $curl_handles = [];

	private function __construct() {}

	public static function instance(): self {
		if ( self::$instance === null ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	public static function reset(): void {
		self::$instance = null;
	}

	public function register_reader_node( object $node ): void {
		if ( ! isset( $node->stream ) || ! \is_resource( $node->stream ) ) {
			throw new \InvalidArgumentException( 'register_reader_node: node must have a resource $stream' );
		}
		$fd                   = \intval( $node->stream );
		$this->readers[ $fd ] = $node;
	}

	public function unregister_reader_node( object $node ): void {
		if ( isset( $node->stream ) && \is_resource( $node->stream ) ) {
			unset( $this->readers[ \intval( $node->stream ) ] );
		}
	}

	public function register_writer_node( object $node ): void {
		if ( ! isset( $node->stream ) || ! \is_resource( $node->stream ) ) {
			throw new \InvalidArgumentException( 'register_writer_node: node must have a resource $stream' );
		}
		$fd                   = \intval( $node->stream );
		$this->writers[ $fd ] = $node;
	}

	public function unregister_writer_node( object $node ): void {
		if ( isset( $node->stream ) && \is_resource( $node->stream ) ) {
			unset( $this->writers[ \intval( $node->stream ) ] );
		}
	}

	public function reader_for_fd( int $fd ): ?object {
		return $this->readers[ $fd ] ?? null;
	}

	public function writer_for_fd( int $fd ): ?object {
		return $this->writers[ $fd ] ?? null;
	}

	public function set_timer( object $node, int $interval_ms, bool $oneshot = false ): void {
		$id = \spl_object_id( $node );
		$this->timers[ $id ] = [
			'node'        => $node,
			'interval_ms' => $interval_ms,
			'oneshot'     => $oneshot,
			'next_fire'   => Core::$right_now + ( $interval_ms / 1000.0 ),
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
		foreach ( $this->curl_handles as $entry ) {
			$still_running = 0;
			\curl_multi_exec( $entry['multi'], $still_running );
			while ( $info = \curl_multi_info_read( $entry['multi'] ) ) {
				if ( \method_exists( $entry['node'], 'on_curl_message' ) ) {
					$entry['node']->on_curl_message( $info );
				}
			}
		}
	}

	private function next_timer_timeout_us(): int {
		if ( empty( $this->timers ) ) {
			return 1_000_000;
		}
		$soonest = PHP_INT_MAX;
		foreach ( $this->timers as $t ) {
			$delta_us = (int) ( ( $t['next_fire'] - Core::$right_now ) * 1_000_000 );
			if ( $delta_us < $soonest ) {
				$soonest = $delta_us;
			}
		}
		return \max( 0, $soonest );
	}

	private function fire_expired_timers(): void {
		foreach ( $this->timers as $id => $t ) {
			if ( $t['next_fire'] <= Core::$right_now ) {
				$t['node']->fire_cb();
				if ( $t['oneshot'] ) {
					unset( $this->timers[ $id ] );
				} else {
					$this->timers[ $id ]['next_fire'] = Core::$right_now + ( $t['interval_ms'] / 1000.0 );
				}
			}
		}
	}

	public function drain( callable $should_continue ): void {
		$has_pcntl = \function_exists( 'pcntl_signal_dispatch' );
		while ( $should_continue() ) {
			if ( Core::$shutting_down ) {
				break;
			}
			Core::update_time();

			$reads  = [];
			$writes = [];
			foreach ( $this->readers as $node ) { $reads[]  = $node->stream; }
			foreach ( $this->writers as $node ) { $writes[] = $node->stream; }
			$except     = null;
			$timeout_us = $this->next_timer_timeout_us();

			if ( ! empty( $reads ) || ! empty( $writes ) ) {
				$ready = @\stream_select(
					$reads, $writes, $except,
					(int) ( $timeout_us / 1_000_000 ),
					$timeout_us % 1_000_000
				);
				if ( $ready !== false && $ready > 0 ) {
					foreach ( $reads as $r ) {
						$node = $this->readers[ \intval( $r ) ] ?? null;
						if ( $node !== null ) { $node->drain_fh(); }
					}
					foreach ( $writes as $w ) {
						$node = $this->writers[ \intval( $w ) ] ?? null;
						if ( $node !== null ) { $node->fill_fh(); }
					}
				}
			} elseif ( $timeout_us > 0 ) {
				\usleep( $timeout_us );
			}

			// Step 2: cURL multi.
			if ( ! empty( $this->curl_handles ) ) {
				foreach ( $this->curl_handles as $entry ) {
					\curl_multi_select( $entry['multi'], $timeout_us / 1_000_000.0 );
				}
				$this->drain_curl_multi();
			}

			// Step 3: signals.
			if ( $has_pcntl ) {
				\pcntl_signal_dispatch();
			}

			Core::run_closing();
			Core::update_time();
			$this->fire_expired_timers();
		}
		Core::run_closing();
	}
}
