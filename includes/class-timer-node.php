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
	public float $next_fire = 0.0;
	public bool $oneshot    = false;

	protected int $fire_count = 0;

	/** Tag stamped onto each emitted message's KEY (Tachikoma uses STREAM; we have no STREAM slot). Empty = unset. */
	protected string $key = '';

	/** Throttle clock (Core::$now seconds) for ROUTER-mode timers with interval_ms > 1000: fire_cb() only fires once interval_ms has elapsed since this. An own slot paces itself. */
	protected float $last_fire_time = 0.0;

	/** @var string Tracks scheduling mode: 'inactive' | 'event_framework' | 'router'. */
	protected string $mode = 'inactive';

	public function __construct() {
		parent::__construct();
	}

	public function arguments( ?array $args = null ): array {
		$ref = new \ReflectionObject( $this );
		if ( 'Timer_Node' !== $ref->getShortName() ) {
			return parent::arguments( $args );
		}
		if ( null === $args ) {
			return $this->arguments;
		}
		$this->arguments = $args;
		$first           = $args[0] ?? '';
		if ( '' === $first ) {
			$this->set_timer();
		} elseif ( preg_match( '/^[0-9]+$/', $first ) ) {
			$this->set_timer( (int) $first );
		} else {
			throw new \InvalidArgumentException( 'Bad arguments for Timer' );
		}
		return $this->arguments;
	}

	public function fire_cb(): void {
		// Driven ticks, not emits (counter's job); silent climber = spinner.
		if ( $this->oneshot ) {
			$this->stop_timer();
		}
		if ( null === $this->sink ) {
			return;
		}
		if ( 'router' === $this->mode && $this->interval_ms > self::router_interval_ms() ) {
			if ( Core::$now - $this->last_fire_time < $this->interval_ms / 1000.0 ) {
				return;
			}
			$this->last_fire_time = Core::$now;
		}
		$this->fire_count++;
		$this->fire();
	}

	// Emit heartbeat unless target-less & sink is CI (spam guard); notify FIRE.
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

	public function set_timer( ?int $ms = null, bool $oneshot = false ): void {
		$router = Core::node( Node_Names::ROUTER );
		// Unnamed takes an own slot: the hitchhike is name-keyed.
		if ( ( null === $ms || $ms >= self::router_interval_ms() ) && '' !== $this->name && $router !== $this ) {
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
			// clear a stale own-slot next_fire (list_timers reads it)
			$this->next_fire      = 0.0;
			$this->oneshot        = $oneshot;
			return;
		}
		if ( 'router' === $this->mode ) {
			$this->_stop_timer();
		}
		if ( null === $ms ) {
			// Own-slot needs an interval; only router reaches here null $ms.
			throw new \RuntimeException( 'Own-slot timer requires an interval (ms)' );
		}
		$this->mode        = 'event_framework';
		$this->interval_ms = $ms;
		$this->oneshot     = $oneshot;
		Event_Framework::instance()->set_timer( $this );
	}

	/**
	 * The router's own tick cadence, or the documented default when no router
	 * is mounted (an unnamed timer arms in registries that have none).
	 *
	 * The hitchhike threshold and the fire throttle both compare against THIS,
	 * not a hardcoded 1000: a timer at exactly the router's cadence must arm at
	 * its own interval rather than inherit the router's, and must not be
	 * throttled, because every tick already is its interval.
	 *
	 * @return int Cadence in milliseconds.
	 */
	private static function router_interval_ms(): int {
		$router = Core::node( Node_Names::ROUTER );
		return $router instanceof self && $router->interval_ms > 0
			? $router->interval_ms
			: Router_Node::DEFAULT_TICK_MS;
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

	/** @api Timer introspection (list_timers): whether the timer is currently armed. */
	public function timer_is_active(): bool {
		return 'inactive' !== $this->mode;
	}

	/** @return string 'inactive' | 'event_framework' | 'router'. */
	public function timer_mode(): string {
		return $this->mode;
	}

	public function get_fire_count(): int {
		return $this->fire_count;
	}

	public function key( ?string $key = null ): string {
		if ( \func_num_args() > 0 ) {
			$this->key = (string) $key;
		}
		return $this->key;
	}

	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'      => 'Control',
			'description'   => 'Periodic firing — emits a heartbeat message every N ms.',
			'arguments'     => [
				[ 'name' => 'interval_ms', 'type' => 'int', 'required' => false, 'description' => 'Fire interval in milliseconds; empty or >=1000 rides the router heartbeat, <1000 gets its own timer slot.' ],
			],
			'registrations' => [ 'FIRE' ],
		] );
	}
}
