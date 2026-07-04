<?php
/**
 * Tee: fan-out to multiple targets via Router. Per-target try/catch isolates failures.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Tee_Node extends Node {

	public function __construct() {
		parent::__construct();
		$this->target = [];
	}

	public function fill( array &$message ): void {
		if ( null === $this->sink ) {
			throw new \RuntimeException( 'fill requires a wired sink' );
		}
		++$this->counter;

		$to = Core::as_string( $message[ Message::TO ] );

		// Prune dead bare-name targets; pass path-shaped targets (with a slash) through as-is for the sink to route.
		$targets = \is_array( $this->target ) ? $this->target : [];
		$alive   = [];
		foreach ( $targets as $t ) {
			[ $head ] = Message::split_first( $t );
			if ( Core::node( $head ) !== null ) {
				$alive[] = $t;
			}
		}
		$this->target = $alive;

		$deferred = null;
		foreach ( $alive as $t ) {
			$message[ Message::TO ] = '' === $to ? $t : ( $t . '/' . $to );
			try {
				$this->sink->fill( $message );
			} catch ( \Throwable $e ) {
				$deferred ??= $e;
			}
		}
		if ( null !== $deferred ) {
			throw $deferred;
		}
	}

	public function connect_node( string $target ): void {
		if ( ! \is_array( $this->target ) ) {
			$this->target = '' !== $this->target ? [ $this->target ] : [];
		}
		if ( ! \in_array( $target, $this->target, true ) ) {
			$this->target[] = $target;
		}
	}

	public function disconnect_node( string $target = '' ): void {
		if ( ! \is_array( $this->target ) ) {
			$this->target = [];
			return;
		}
		$this->target = \array_values( \array_filter( $this->target, fn ( $t ) => $t !== $target ) );
	}

	public static function node_schema(): array {
		return [
			'category'    => 'Routing',
			'description' => 'Fan-out: copies each message to multiple targets via Router.',
			'arguments'   => [],
			'commands'    => [],
			'requests'    => [],
		];
	}
}
