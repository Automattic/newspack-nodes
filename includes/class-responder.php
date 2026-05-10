<?php
/**
 * Responder: TM_PERSIST cancel-sink + default forwarder for chainable terminals.
 *
 * Present in every process as `_responder`. Terminal consumers of TM_PERSIST
 * sink to here; Responder replies cancel/answer back along the FROM trail via
 * `_router` (so the reply walks the breadcrumb path, not Responder's own
 * downstream sink). Other messages forward to the sink (typically `_dumper`
 * in the cli, `_router` in workers).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Responder extends Node {
	public function fill( array &$message ): void {
		++$this->counter;
		$type = $message[ Message::TYPE ];

		// Auto-cancel TM_PERSIST. Reply needs path-based routing along the
		// FROM trail, so it goes through `_router` (Core lookup) — NOT through
		// $this->sink. Matches real Tachikoma's pattern where Responder always
		// sinks into Dumper but addresses replies through Router.
		if ( $type & Message::TM_PERSIST ) {
			if ( '' === $message[ Message::FROM ] ) {
				return; // Silent drop, same rule as Node::answer/cancel.
			}
			$ack                       = Message::new_message();
			$ack[ Message::TYPE ]      = Message::TM_PERSIST | Message::TM_RESPONSE;
			$ack[ Message::TIMESTAMP ] = Core::$right_now;
			$ack[ Message::FROM ]      = $this->name;
			$ack[ Message::TO ]        = $message[ Message::FROM ];
			$ack[ Message::ID ]        = $message[ Message::ID ];
			$ack[ Message::KEY ]       = $message[ Message::KEY ];
			$ack[ Message::VALUE ]     = ( $type & Message::TM_ERROR ) ? 'answer' : 'cancel';
			$router                    = Core::node( '_router' );
			if ( null !== $router ) {
				$router->fill( $ack );
			} else {
				$this->sink?->fill( $ack );
			}
			return;
		}

		// Default: forward to sink (Dumper for the cli, _router for workers).
		$this->sink?->fill( $message );
	}
}
