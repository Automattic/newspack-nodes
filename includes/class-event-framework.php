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

	public function drain( callable $should_continue ): void {
		while ( $should_continue() ) {
			Core::update_time();
			// Steps 1-2 (FDs, cURL): added in Tasks 3-4.
			// Step 3 (signals): added in Task 5.
			Core::run_closing();
			// Step 5 (timers): added in Task 3.
		}
		Core::run_closing();
	}
}
