<?php
/**
 * Router: path-based message dispatch + TIMER event hub.
 *
 * Extends Timer (matches real Tachikoma Router.pm). On each fire_cb tick
 * (5s default), notifies all TIMER registrants — the Router-hitchhike pattern
 * for cheap periodic work without per-node EventFramework slots.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Router extends Timer {
	public const DEFAULT_TICK_MS = 5000;

	public function __construct() {
		parent::__construct();
		$this->registrations['TIMER'] = [];
	}

	protected function fire(): void {
		$this->notify( 'TIMER', Core::$right_now );
	}

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

		if ( \strlen( $message[ Message::FROM ] ?? '' ) > self::MAX_FROM_SIZE ) {
			$this->drop_message( $message, 'path exceeded ' . self::MAX_FROM_SIZE . ' bytes' );
			return;
		}

		$target = Core::node( $node_name );
		if ( $target === null ) {
			if ( $message[ Message::TYPE ] & Message::TM_ERROR ) {
				return;
			}
			$err                       = Message::new_message();
			$err[ Message::TYPE ]      = Message::TM_ERROR;
			$err[ Message::TIMESTAMP ] = Core::$right_now;
			$err[ Message::FROM ]      = $this->name;
			$err[ Message::TO ]        = $message[ Message::FROM ];
			$err[ Message::ID ]        = $message[ Message::ID ];
			$err[ Message::VALUE ]     = "NOT_AVAILABLE\n";
			// Re-fill via this Router so the error walks the FROM trail. If the FROM head
			// resolves, the error reaches the originator; if not, the (recursive) call
			// drops on the TM_ERROR-on-error branch above instead of bouncing forever.
			$this->fill( $err );
			return;
		}

		$target->fill( $message );
	}
}
