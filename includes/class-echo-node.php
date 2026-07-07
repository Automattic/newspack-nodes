<?php
/**
 * Echo: re-addresses messages. target+TO → `target/TO`; both empty → bounce (TO=FROM); else pass-through. TM_ERROR with empty TO drops.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Echo_Node extends Node {

	public function fill( array $message ): void {
		$raw_type = $message[ Message::TYPE ];
		$type     = \is_int( $raw_type ) ? $raw_type : 0;
		$to       = Core::as_string( $message[ Message::TO ] );
		$target   = $this->target;
		if ( ( $type & Message::TM_ERROR ) && '' === $to ) {
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
			'arguments'   => [],
			'commands'    => [],
		];
	}
}
