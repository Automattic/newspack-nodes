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

	/** Idle profile entries older than this are trimmed each tick (Tachikoma: 900). */
	public const PROFILE_TTL_S = 900;

	/**
	 * Clock seam (tests script a time sequence). Lazily defaults to microtime.
	 *
	 * @var (\Closure(): float)|null
	 */
	public static ?\Closure $clock = null;

	/**
	 * Per-node self-time profiles, keyed by node name; null = profiling off.
	 * Port of Tachikoma Router.pm $PROFILES / @STACK (package globals).
	 *
	 * @var array<string, array{time: float, count: int, avg: float, oldest: float, timestamp: float}>|null
	 */
	private static ?array $profiles = null;

	/** @var list<string> Open dispatch frames (innermost last). */
	private static array $profile_stack = [];

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

		if ( null !== self::$profiles ) {
			$before = $this->push_profile( $node_name );
			try {
				// A throw must still pop, else later parents corrupt.
				$target->fill( $message );
			} finally {
				$this->pop_profile( $before );
			}
			return;
		}
		$target->fill( $message );
	}

	// Dispatch TIMER via notify_timer (Router has no sink) + prune logs.
	public function fire_cb(): void {
		$this->notify_timer();
		Core::prune_logs();
		if ( null !== self::$profiles ) {
			$this->trim_profiles();
		}
		$this->fire_count++;
	}

	/** Open a dispatch frame; returns the start time for pop_profile(). */
	private function push_profile( string $name ): float {
		self::$profile_stack[] = $name;
		return null !== self::$clock ? ( self::$clock )() : \microtime( true );
	}

	/** Close the innermost frame; the elapsed is subtracted from its parent (self-time). */
	private function pop_profile( float $before ): void {
		if ( null === self::$profiles ) {
			return;
		}
		$after = null !== self::$clock ? ( self::$clock )() : \microtime( true );
		$name  = \array_pop( self::$profile_stack );
		if ( null === $name ) {
			return;
		}
		$info               = self::$profiles[ $name ]
			?? [ 'time' => 0.0, 'count' => 0, 'avg' => 0.0, 'oldest' => 0.0, 'timestamp' => 0.0 ];
		$info['time']      += $after - $before;
		++$info['count'];
		$info['avg']        = $info['time'] / $info['count'];
		$info['oldest']     = 0.0 !== $info['oldest'] ? $info['oldest'] : $before;
		$info['timestamp']  = $after;
		self::$profiles[ $name ] = $info;

		if ( [] !== self::$profile_stack ) {
			$parent                = self::$profile_stack[ \count( self::$profile_stack ) - 1 ];
			$parent_info           = self::$profiles[ $parent ]
				?? [ 'time' => 0.0, 'count' => 0, 'avg' => 0.0, 'oldest' => 0.0, 'timestamp' => 0.0 ];
			$parent_info['time']  -= $after - $before;
			self::$profiles[ $parent ] = $parent_info;
		}
	}

	/** Drop entries idle past PROFILE_TTL_S (run from fire_cb while profiling). */
	public function trim_profiles(): void {
		foreach ( self::$profiles ?? [] as $key => $info ) {
			if ( Core::$now - $info['timestamp'] > self::PROFILE_TTL_S ) {
				unset( self::$profiles[ $key ] );
			}
		}
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
	 * Get/set the profile table. Setting (even to null) resets the frame stack.
	 *
	 * @param array<string, array{time: float, count: int, avg: float, oldest: float, timestamp: float}>|null ...$set New table (array to enable, null to disable) when given.
	 * @return array<string, array{time: float, count: int, avg: float, oldest: float, timestamp: float}>|null
	 */
	public static function profiles( ?array ...$set ): ?array {
		if ( \count( $set ) > 0 ) {
			self::$profiles      = $set[0];
			self::$profile_stack = [];
		}
		return self::$profiles;
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
