<?php
/**
 * Tee: fan-out to multiple targets via Router.
 *
 * Overrides Node's single-target connect_node to append to an array.
 * Dispatch sets TO per target and forwards through sink (typically _router).
 * Per-target try/catch isolates failures.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Tee extends Node {
	public function __construct() {
		$this->target = [];
	}

	public function connect_node( string $target ): void {
		if ( ! \is_array( $this->target ) ) {
			$this->target = $this->target !== '' ? [ $this->target ] : [];
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

	public function fill( array &$message ): void {
		++$this->counter;
		$targets = \is_array( $this->target ) ? $this->target : [];
		$alive = [];
		foreach ( $targets as $t ) {
			if ( Core::node( $t ) !== null ) {
				$alive[] = $t;
			}
		}
		$this->target = $alive;

		foreach ( $alive as $t ) {
			try {
				$copy                = $message;
				$copy[ Message::TO ] = $t;
				$this->sink?->fill( $copy );
			} catch ( \Throwable $e ) {
				Core::print_less_often( "Tee {$this->name}: target $t threw: " . $e->getMessage() );
			}
		}
	}
}
