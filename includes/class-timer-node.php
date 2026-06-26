<?php
/**
 * Timer: periodic / one-shot fire. Two modes: own EventFramework slot (set_timer($ms)) or Router-hitchhike (set_timer() no args).
 *
 * Hitchhike uses Node-name dispatch, not a closure: a void-returning closure coerces to falsy and self-unregisters after one tick.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Timer_Node extends Node {

	public int $interval_ms = 0;
	public bool $oneshot    = false;
	public float $next_fire = 0.0;

	/** Throttle clock (Core::$now seconds) for hitchhike timers with interval_ms > 1000: fire_cb() only fires once interval_ms has elapsed since this. */
	protected float $last_fire_time = 0.0;

	/** @var string Tracks scheduling mode: 'inactive' | 'event_framework' | 'router'. */
	protected string $mode = 'inactive';

	/** Tag stamped onto each emitted message's KEY (Tachikoma uses STREAM; we have no STREAM slot). Empty = unset. */
	protected string $key = '';

	public function __construct() {
		$this->registrations = [ 'FIRE' => [] ];
		parent::__construct();
	}

	public function arguments( ?string $args = null ): string {
		$ref = new \ReflectionObject( $this );
		if ( 'Timer_Node' !== $ref->getShortName() ) {
			return parent::arguments( $args );
		}
		if ( null === $args ) {
			return $this->arguments;
		}
		$this->arguments = $args;
		if ( '' === $args ) {
			$this->set_timer();
		} elseif ( preg_match( '/^[0-9]+$/', $args ) ) {
			$this->set_timer( (int) $args );
		} else {
			throw new \InvalidArgumentException( 'Bad arguments for Timer' );
		}
		return $this->arguments;
	}

	public function fire_cb(): void {
		if ( $this->oneshot ) {
			$this->mode = 'inactive';
		}
		if ( null === $this->sink ) {
			return;
		}
		// A hitchhike timer with interval_ms > 1000 rides the per-second router tick
		// but only fires once interval_ms has elapsed (Core::$now is in seconds, so
		// convert). interval_ms <= 1000 (own slot already paces it) and interval_ms
		// === 0 (no-ms hitchhike fires every tick) skip the throttle.
		if ( $this->interval_ms > 1000 ) {
			if ( Core::$now - $this->last_fire_time < $this->interval_ms / 1000.0 ) {
				return;
			}
			$this->last_fire_time = Core::$now;
		}
		$this->fire();
	}

	// One tick (Perl Timer::fire). Emit a TM_BYTESTREAM heartbeat carrying the
	// timestamp ONLY when this timer has a target, or its sink isn't the
	// CommandInterpreter (the owner/CI guard — a target-less timer sinking into the
	// interpreter would just spam it); counter++ on emit. Always notify 'FIRE'.
	protected function fire(): void {
		if ( '' !== $this->target || ! ( $this->sink instanceof Command_Interpreter_Node ) ) {
			if ( null === $this->sink ) {
				throw new \RuntimeException( 'Timer::fire requires a wired sink' );
			}
			$message                       = Message::new_message();
			$message[ Message::TYPE ]      = Message::TM_BYTESTREAM;
			$message[ Message::TIMESTAMP ] = Core::$now;
			$message[ Message::FROM ]      = $this->name;
			$message[ Message::TO ]        = $this->target;
			if ( '' !== $this->key ) {
				$message[ Message::KEY ] = $this->key;
			}
			$message[ Message::VALUE ] = (string) Core::$now;
			++$this->counter;
			$this->sink->fill( $message );
		}
		$this->notify( 'FIRE', Core::$now );
	}

	// No ms (or $ms > 1000) => Router-hitchhike: fire_cb() throttles a >1000
	// interval against last_fire_time so the per-second router tick is enough. A
	// $ms <= 1000 timer needs its own event-framework slot (the router tick is ~1s,
	// too coarse to pace a sub-second timer).
	public function set_timer( ?int $ms = null, bool $oneshot = false ): void {
		if ( null === $ms || $ms > 1000 ) {
			if ( '' === $this->name ) {
				throw new \RuntimeException( 'Router-hitchhike requires Timer to have a name' );
			}
			$router = Core::node( Node_Names::ROUTER );
			if ( ! $router instanceof self ) {
				throw new \RuntimeException( 'Router-hitchhike requires _router to be present' );
			}
			if ( 'event_framework' === $this->mode ) {
				$this->_stop_timer();
			}
			$router->register( 'TIMER', $this->name );
			$this->mode           = 'router';
			$this->interval_ms    = null === $ms ? $router->interval_ms : $ms;
			$this->last_fire_time = 0.0;
			$this->oneshot        = false;
			return;
		}
		if ( 'router' === $this->mode ) {
			$this->_stop_timer();
		}
		$this->mode        = 'event_framework';
		$this->interval_ms = $ms;
		$this->oneshot     = $oneshot;
		Event_Framework::instance()->set_timer( $this );
	}

	public function remove_node(): void {
		$this->stop_timer();
		parent::remove_node();
	}

	public function stop_timer(): void {
		$this->_stop_timer();
		$this->mode        = 'inactive';
		$this->interval_ms = 0;
		$this->oneshot     = false;
	}

	private function _stop_timer(): void {
		if ( 'inactive' === $this->mode ) {
			return;
		}
		if ( 'router' === $this->mode ) {
			$router = Core::node( Node_Names::ROUTER );
			if ( null !== $router && '' !== $this->name ) {
				$router->unregister( 'TIMER', $this->name );
			}
			return;
		}
		if ( 'event_framework' === $this->mode ) {
			Event_Framework::instance()->stop_timer( $this );
		}
	}

	public function key( ?string $key = null ): string {
		if ( \func_num_args() > 0 ) {
			$this->key = (string) $key;
		}
		return $this->key;
	}

	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'    => 'Control',
			'description' => 'Periodic firing — emits a heartbeat message every N ms.',
			'arguments'   => [
				[ 'name' => 'interval_ms', 'type' => 'int', 'required' => false ],
			],
		] );
	}
}
