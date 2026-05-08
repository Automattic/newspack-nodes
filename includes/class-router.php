<?php
/**
 * Router: path-based message dispatch.
 *
 * Splits TO on '/', looks up the first segment as a registered node name,
 * updates TO to the remainder, and forwards. Empty TO passes to sink. Unknown
 * targets generate NOT_AVAILABLE TM_ERROR responses (unless the inbound was
 * already a TM_ERROR — don't bounce errors-on-errors).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Router extends Node {
	public function fill( array &$message ): void {
		++$this->counter;

		$to = $message[ Message::TO ];
		if ( $to === '' ) {
			$this->sink?->fill( $message );
			return;
		}

		$parts                  = \explode( '/', $to, 2 );
		$node_name              = $parts[0];
		$remaining              = $parts[1] ?? '';
		$message[ Message::TO ] = $remaining;

		// Path-explosion guard.
		if ( \strlen( $message[ Message::FROM ] ?? '' ) > self::MAX_FROM_SIZE ) {
			$this->drop_message( $message, 'path exceeded ' . self::MAX_FROM_SIZE . ' bytes' );
			return;
		}

		$target = Core::node( $node_name );
		if ( $target === null ) {
			if ( $message[ Message::TYPE ] & Message::TM_ERROR ) {
				return; // Silently drop bouncing errors.
			}
			$err                       = Message::new_message();
			$err[ Message::TYPE ]      = Message::TM_ERROR;
			$err[ Message::TIMESTAMP ] = Core::$right_now;
			$err[ Message::FROM ]      = $this->name;
			$err[ Message::TO ]        = $message[ Message::FROM ];
			$err[ Message::ID ]        = $message[ Message::ID ];
			$err[ Message::VALUE ]     = "NOT_AVAILABLE\n";
			$this->sink?->fill( $err );
			return;
		}

		$target->fill( $message );
	}
}
