<?php
/**
 * Router: path-based message dispatch + TIMER event hub.
 *
 * Extends Timer; its fire_cb runs notify_timer — calling each TIMER registrant's
 * fire_cb DIRECTLY (Tachikoma Router::fire_cb → notify_timer, the Router-hitchhike
 * pattern). The worker arms the tick; the request-scope ctor stays event-loop-free.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Router_Node extends Timer_Node {

	public const DEFAULT_TICK_MS = 1000;

	private bool $handling_error = false;

	public function __construct() {
		parent::__construct();
	}

	public function fill( array &$message ): void {
		++$this->counter;

		// Perl Router::fill drops before routing, in this order: an unaddressed
		// message (empty TO), then one whose FROM trail exceeded MAX_FROM_SIZE
		// (path explosion on a routing cycle).
		if ( '' === $message[ Message::TO ] ) {
			$this->drop_message( $message, 'message not addressed' );
			return;
		}
		$from = Core::as_string( $message[ Message::FROM ] ?? '' );
		if ( \strlen( $from ) > self::MAX_FROM_SIZE ) {
			$this->drop_message( $message, 'path exceeded ' . self::MAX_FROM_SIZE . ' bytes' );
			return;
		}

		[ $node_name, $remaining ] = Message::split_first( Core::as_string( $message[ Message::TO ] ) );
		$target = Core::node( $node_name );
		if ( null === $target ) {
			$this->send_error( $message, 'NOT_AVAILABLE' );
			return;
		}
		$message[ Message::TO ] = $remaining;

		$target->fill( $message );
	}

	// fire_cb (Perl Router::fire_cb): dispatch the TIMER tick via notify_timer (the
	// Router has no sink, so it can't fall through Timer_Node::fire_cb's no-sink
	// guard), then prune expired logs (Perl Router::update_logs). Overrides
	// Timer_Node::fire_cb — the Router dispatches TIMER instead of emitting.
	public function fire_cb(): void {
		$this->notify_timer();
		Core::prune_logs();
	}

	/** @param array<int, mixed> $message Message that failed to route. */
	public function send_error( array &$message, string $error ): void {
		if ( $this->handling_error ) {
			$this->drop_message( $message, 'breaking recursion' );
			return;
		}
		$this->handling_error = true;
		// The unreachable destination is the head segment of TO (Router peels it
		// in fill() before the lookup that landed here).
		[ $node_name ] = Message::split_first( Core::as_string( $message[ Message::TO ] ) );
		$this->set_state(
			'NOT_AVAILABLE',
			\implode( ' ', [
				'NODE', $node_name,
				'TYPE', \is_scalar( $message[ Message::TYPE ] ) ? $message[ Message::TYPE ] : '',
				'FROM', \is_scalar( $message[ Message::FROM ] ) ? $message[ Message::FROM ] : '',
				'TO',   \is_scalar( $message[ Message::TO   ] ) ? $message[ Message::TO   ] : '',
				'ID',   \is_scalar( $message[ Message::ID   ] ) ? $message[ Message::ID   ] : '',
				'KEY',  \is_scalar( $message[ Message::KEY  ] ) ? $message[ Message::KEY  ] : '',
			] )
		);
		$type = $message[ Message::TYPE ];
		if ( ( \is_int( $type ) ? $type : 0 ) & Message::TM_ERROR ) {
			$this->handling_error = false;
			return;
		}
		if ( Core::has_value( Core::as_string( $message[ Message::FROM ] ) ) ) {
			$err                       = Message::new_message();
			$err[ Message::TYPE ]      = Message::TM_ERROR;
			$err[ Message::TIMESTAMP ] = Core::$now;
			$err[ Message::FROM ]      = $message[ Message::TO ];
			$err[ Message::TO ]        = $message[ Message::FROM ];
			$err[ Message::ID ]        = $message[ Message::ID ];
			$err[ Message::VALUE ]     = "{$error}\n";
			$this->fill( $err );
		}
		$this->handling_error = false;
		return;
	}

	// notify_timer (Perl Router::notify_timer): call each TIMER-registered node's
	// fire_cb DIRECTLY; a name with no live node is warned + dropped (forgot to
	// unregister). No message, no fill(). array_keys() snapshots the keys so a
	// mid-loop unset() (self-stop or this cleanup) is safe.
	public function notify_timer(): void {
		foreach ( array_keys( $this->registrations['TIMER'] ) as $name ) {
			$node = Core::node( $name );
			if ( null === $node ) {
				$this->stderr( "WARNING: $name forgot to unregister" );
				unset( $this->registrations['TIMER'][ $name ] );
				continue;
			}
			// Only Timer_Node (and its Router_Node subclass) defines fire_cb;
			// Timer_Node::set_timer is the sole TIMER registrar, so a non-Timer
			// node here is a misregistration — skip it rather than fatal.
			if ( $node instanceof Timer_Node ) {
				$node->fire_cb();
			}
		}
	}

	/**
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

	public static function node_schema(): array {
		return [
			'category'      => 'Hidden',
			'description'   => 'Path-based message routing — placed automatically as `_router`.',
			'arguments'     => [],
			'commands'      => [],
			// FIRE (inherited Timer tick) + TIMER (hitchhike event peers register for)
			// + NOT_AVAILABLE (routing-failure state set_state publishes for observers,
			// matching the JS Router). Fresh array (no parent merge), so list all three.
			'registrations' => [ 'FIRE', 'TIMER', 'NOT_AVAILABLE' ],
		];
	}
}
