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

class Router_Node extends Timer_Node {
	public const DEFAULT_TICK_MS = 5000;

	public function __construct() {
		parent::__construct();
		$this->registrations['TIMER'] = [];
	}

	protected function fire(): void {
		$this->notify( 'TIMER', Core::$now );
		Core::prune_logs();
	}

	/**
	 * The Router has no sink: it routes by peeling TO and drops what it cannot
	 * peel (an empty or unknown head → NOT_AVAILABLE). Reject any attempt to set
	 * one; the getter always returns null.
	 *
	 * @param Node|null $node Unused; passing any argument is a misuse and throws.
	 * @throws \InvalidArgumentException When called with an argument (a set attempt).
	 */
	public function sink( ?Node $node = null ): ?Node {
		if ( \func_num_args() > 0 ) {
			throw new \InvalidArgumentException(
				\esc_html( 'Router must not have a sink; it routes by TO and drops what it cannot peel.' )
			);
		}
		return null;
	}

	public function fill( array &$message ): void {
		++$this->counter;

		[ $node_name, $remaining ] = Message::split_first( $message[ Message::TO ] );
		$message[ Message::TO ]    = $remaining;

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
			'commands'       => [],
		];
	}
}
