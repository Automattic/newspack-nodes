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
		++$this->counter;

		$raw_type = $message[ Message::TYPE ];
		$type     = \is_int( $raw_type ) ? $raw_type : 0;
		$to       = Core::as_string( $message[ Message::TO ] );

		// Prune dead bare-name targets; pass path-shaped targets (with a slash) through as-is for the sink to route.
		$targets = \is_array( $this->target ) ? $this->target : [];
		$alive   = [];
		foreach ( $targets as $t ) {
			if ( false !== \strpos( $t, '/' ) || Core::node( $t ) !== null ) {
				$alive[] = $t;
			}
		}
		$this->target = $alive;

		foreach ( $alive as $t ) {
			if ( null === $this->sink ) {
				throw new \RuntimeException( 'Tee::fill requires a wired sink' );
			}
			try {
				$copy                = $message;
				$copy[ Message::TO ] = '' === $to ? $t : ( $t . '/' . $to );
				$this->sink->fill( $copy );
			} catch ( \Throwable $e ) {
				// log_midfix prepends the node name; keep only the class label here.
				$this->print_less_often( "Tee: target $t threw: " . $e->getMessage() );
			}
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
