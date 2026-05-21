<?php
/**
 * Router: path-based message dispatch + TIMER event hub.
 *
 * Extends Timer; each fire_cb tick (5s) notifies TIMER registrants — the Router-hitchhike pattern.
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
		$this->notify( 'TIMER', Core::$now );
		Core::prune_logs();
	}

	public function fill( array &$message ): void {
		++$this->counter;

		$to = $message[ Message::TO ];
		$parts                  = \explode( '/', $to, 2 );
		$node_name              = $parts[0];
		$remaining              = $parts[1] ?? '';
		$message[ Message::TO ] = $remaining;

		if ( \strlen( $message[ Message::FROM ] ?? '' ) > self::MAX_FROM_SIZE ) {
			$this->drop_message( $message, 'path exceeded ' . self::MAX_FROM_SIZE . ' bytes' );
			return;
		}

		$target = Core::node( $node_name );
		if ( null === $target ) {
			// `debug_state _router 1` turns this into a per-failure trace.
			$this->set_state(
				'NOT_AVAILABLE',
				[ 'node' => $node_name, 'from' => $message[ Message::FROM ] ]
			);
			if ( $message[ Message::TYPE ] & Message::TM_ERROR ) {
				return;
			}
			$err                       = Message::new_message();
			$err[ Message::TYPE ]      = Message::TM_ERROR;
			$err[ Message::TIMESTAMP ] = Core::$now;
			$err[ Message::FROM ]      = $this->name;
			$err[ Message::TO ]        = $message[ Message::FROM ];
			$err[ Message::ID ]        = $message[ Message::ID ];
			$err[ Message::VALUE ]     = "NOT_AVAILABLE\n";
			// Re-fill so the error walks the FROM trail; a re-failure drops on the TM_ERROR branch above, not bouncing forever.
			$this->fill( $err );
			return;
		}

		$target->fill( $message );
	}

	public static function node_schema(): array {
		return [
			'category'    => 'Hidden',
			'description' => 'Path-based message routing — placed automatically as `_router`.',
			'ctor'        => [],
			'verbs'       => [],
		];
	}
}
