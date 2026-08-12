<?php
/**
 * Tap: Tee with hard targets and passthrough.
 *
 * Same failure handling as Tee — attempt every target, defer the throwable that
 * outranks, re-throw after the passthrough. Completing the fan-out is what keeps
 * at-least-once: a target skipped by an early throw never receives the message
 * once the poison path dead-letters it and advances the cursor. Duplicates on
 * replay are the accepted cost of that, and they arise with any fan-out.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Tap_Node extends Tee_Node {

	public function fill( array $message ): void {
		$sink = $this->require_sink();
		++$this->counter;

		$alive = $this->live_targets();
		$to    = Core::as_string( $message[ Message::TO ] );

		// Defer: the passthrough below IS the pipeline, and Clean commits past.
		$deferred = null;
		foreach ( $alive as $t ) {
			$message[ Message::TO ] = $t; // hard target: no remainder to route on
			try {
				$sink->fill( $message );
			} catch ( \Throwable $e ) {
				if ( $this->outranks( $e, $deferred ) ) {
					$deferred = $e;
				}
			}
		}
		$message[ Message::TO ] = $to;
		$sink->fill( $message );
		if ( null !== $deferred ) {
			throw $deferred;
		}
	}
}
