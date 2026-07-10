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

	public function fill( array $message ): void {
		++$this->counter;

		// Drop unaddressed (empty TO), then FROM > MAX_FROM_SIZE (cycle).
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

	// Dispatch TIMER via notify_timer (Router has no sink) + prune logs.
	public function fire_cb(): void {
		$this->notify_timer();
		Core::prune_logs();
	}

	/** @param array<int, mixed> $message Message that failed to route. */
	public function send_error( array $message, string $error ): void {
		if ( $this->handling_error ) {
			$this->drop_message( $message, 'breaking recursion' );
			return;
		}
		$this->handling_error = true;
		// Unreachable node = head segment of TO (peeled in fill()).
		[ $node_name ] = Message::split_first( Core::as_string( $message[ Message::TO ] ) );
		$this->set_state(
			'NOT_AVAILABLE',
			\implode( ' ', [
				'NODE', $node_name,
				'TYPE', Core::as_string( $message[ Message::TYPE ] ),
				'FROM', Core::as_string( $message[ Message::FROM ] ),
				'TO',   Core::as_string( $message[ Message::TO ] ),
				'ID',   Core::as_string( $message[ Message::ID ] ),
				'KEY',  Core::as_string( $message[ Message::KEY ] ),
			] )
		);
		$type = $message[ Message::TYPE ];
		if ( Core::int( $type ) & Message::TM_ERROR ) {
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
	}

	// Call each TIMER node's fire_cb; array_keys snapshot = safe unset.
	public function notify_timer(): void {
		foreach ( array_keys( $this->registrations['TIMER'] ) as $name ) {
			$node = Core::node( $name );
			if ( null === $node ) {
				$this->stderr( "WARNING: $name forgot to unregister" );
				unset( $this->registrations['TIMER'][ $name ] );
				continue;
			}
			// Non-Timer node = misregistration; skip rather than fatal.
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
			// FIRE (Timer tick) + TIMER (hitchhike) + NOT_AVAILABLE.
			'registrations' => [ 'FIRE', 'TIMER', 'NOT_AVAILABLE' ],
		];
	}
}
