<?php
/**
 * Tap: Tee with hard targets and passthrough
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Tap_Node extends Tee_Node {

	public function fill( array $message ): void {
		if ( null === $this->sink ) {
			throw new \RuntimeException( 'fill requires a wired sink' );
		}
		++$this->counter;

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

		foreach ( $alive as $t ) {
			try {
				$copy                = $message;
				$copy[ Message::TO ] = $t;
				$this->sink?->fill( $copy );
			} catch ( \Throwable $e ) {
				// log_midfix prepends the node name; keep only the class label here.
				$this->print_less_often( "target $t threw: " . $e->getMessage() );
			}
		}
		$this->sink?->fill( $message );
	}
}
