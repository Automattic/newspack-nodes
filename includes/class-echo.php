<?php
/**
 * Echo: routing helper that re-addresses messages on the way through.
 *
 * Mirrors Tachikoma::Nodes::Echo:
 *   - Both `target` and `TO` set → join them: `TO = target/TO` (path-prepend).
 *   - Both empty → bounce: `TO = FROM` (return-to-sender along the trail).
 *   - Otherwise → TO unchanged (forward as-is).
 *   - TM_ERROR with empty TO → drop (would otherwise bounce to a producer
 *     who isn't expecting the error trail).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Echo_Node extends Node {

	public function fill( array &$message ): void {
		$type   = $message[ Message::TYPE ];
		$to     = $message[ Message::TO ];
		$target = $this->target;

		// TM_ERROR with no TO would otherwise bounce — drop instead.
		if ( ( $type & Message::TM_ERROR ) && '' === $to ) {
			$this->set_state(
				'DROPPED_ERROR',
				[ 'from' => $message[ Message::FROM ] ]
			);
			return;
		}

		if ( \is_string( $target ) && '' !== $target && '' !== $to ) {
			$message[ Message::TO ] = $target . '/' . $to;
		} elseif ( ( ! \is_string( $target ) || '' === $target ) && '' === $to ) {
			$message[ Message::TO ] = $message[ Message::FROM ];
		}

		parent::fill( $message );
	}

	public static function node_schema(): array {
		return [
			'category'    => 'Routing',
			'description' => 'Re-addresses messages: target/TO, bounce, or pass-through.',
			'ctor'        => [],
			'verbs'       => [],
		];
	}
}
