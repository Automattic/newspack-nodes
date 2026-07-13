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

		// Prune dead bare-name targets; inline array not Core::arr (phpstan).
		$targets = \is_array( $this->target ) ? $this->target : [];
		$alive   = [];
		foreach ( $targets as $t ) {
			[ $head ] = Message::split_first( $t );
			if ( Core::node( $head ) !== null ) {
				$alive[] = $t;
			}
		}
		$this->target = $alive;

		$to = Core::as_string( $message[ Message::TO ] );
		foreach ( $alive as $t ) {
			$message[ Message::TO ] = $t;
			try {
				$this->sink?->fill( $message );
			} catch ( Worker_Should_Stop $e ) {
				throw $e; // cooperative stop is control flow
			} catch ( \Throwable $e ) {
				$this->print_less_often( "target $t threw: ", $e->getMessage() );  // tap error stays non-fatal
			}
		}
		$message[ Message::TO ] = $to;
		$this->sink?->fill( $message );
	}
}
