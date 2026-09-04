<?php
/**
 * Timer: the time-driven node base, and the Router hitchhike that buys periodic
 * work without a slot of its own in the drain loop.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Fires on a cadence, in one of two scheduling modes.
 *
 * An interval below the Router's tick takes an own `Event_Framework` slot. No
 * interval, or one at least as long as that tick, registers the node on
 * `_router`'s TIMER channel instead and rides the tick the graph already pays
 * for, `fire_cb()` throttling down to the cadence the node asked for.
 * `set_timer()` picks between the two, `timer_mode()` reports which is live,
 * and `list_timers` shows it in the MODE column.
 *
 * `fire_cb()` is the framework-side hook and `fire()` the subclass override
 * point. The default `fire()` emits a TM_BYTESTREAM carrying the current
 * timestamp at `target` and notifies FIRE listeners.
 *
 * The hitchhike dispatches by NAME, never by closure, and the distinction is
 * load-bearing: `Router_Node::notify_timer()` never calls `notify()`. It walks
 * `registrations['TIMER']` as a name list, resolves each name to its node and
 * calls `fire_cb()` on it, so a closure registered there would carry no node to
 * fire and would never run.
 *
 * Both modes pace from the node's own last fire. The shared wall-clock grid of
 * ADR-17 belongs to the JS mirror, `src/runtime/timer-node.js`, where converging
 * cadences batch into one POST; a worker pays no per-tick cost that alignment
 * would save.
 */
class Timer_Node extends Node {
	use Schema_Reflection;

	/**
	 * Floor, in seconds, under which `cadence_ms()` clamps an operator-supplied
	 * cadence. It keeps a sub-second declaration on the Router hitchhike rather
	 * than in an own slot spinning the drain loop.
	 */
	protected const MIN_INTERVAL_S = 1;

	/**
	 * Cadence in milliseconds, 0 while disarmed. Public because
	 * `Event_Framework` re-seeds `next_fire` from it on every recurring fire and
	 * `list_timers` tabulates it.
	 */
	public int $interval_ms = 0;

	/**
	 * Wall-clock second (`Core::$now` scale) an own slot is next due, 0.0 for a
	 * hitchhiker, which has no slot of its own. `Event_Framework` owns the value
	 * — it seeds it on arming and advances it on each fire — and `list_timers`
	 * prints `-` wherever it is 0.0.
	 */
	public float $next_fire = 0.0;

	/**
	 * Disarm after the first fire. One-time wakeups only: a self-pacing node
	 * holds a recurring timer instead, for the reason `set_timer()` gives.
	 */
	public bool $oneshot = false;

	/**
	 * Dispatches, not emissions. `fire_cb()` counts a tick that cleared the sink
	 * and throttle guards and reached `fire()`, while `Node::$counter` counts
	 * messages actually sent. `list_timers` shows it as FIRES, where a climb
	 * beside a NEXT of 0 or less is how a spinning timer announces itself.
	 */
	protected int $fire_count = 0;

	/**
	 * Tag stamped onto each emitted message's KEY, empty for none. Tachikoma
	 * marks a timer's messages with STREAM and the port has no STREAM field, so
	 * KEY carries it: `Lock_Node::fill()` tests `KEY === 'heartbeat'` to tell a
	 * lock refresh from traffic it should forward.
	 */
	protected string $key = '';

	/**
	 * Wall-clock second (`Core::$now` scale) of the last dispatch, throttling a
	 * hitchhiker whose interval exceeds the Router's tick: `fire_cb()` returns
	 * until `interval_ms` has elapsed since this. An own slot paces itself
	 * through `next_fire` and leaves this at 0.0.
	 */
	protected float $last_fire_time = 0.0;

	/**
	 * Which scheduling mode is live: `inactive`, `event_framework` for an own
	 * slot, or `router` for the hitchhike. `set_timer()` and `stop_timer()` are
	 * the only writers, and `_stop_timer()` reads it to know which registration
	 * to release.
	 */
	protected string $mode = 'inactive';

	/**
	 * Start disarmed: no slot, no Router registration, `interval_ms` 0.
	 *
	 * Arming belongs to `set_timer()`, never to a constructor. Topic and
	 * Partition build in request scope, where no drain loop runs (ADR-5), so a
	 * constructor-armed timer registers a slot that never fires and nothing says
	 * so.
	 */
	public function __construct() {
		parent::__construct();
	}

	/**
	 * Read the argument tokens, or take token 0 as the interval and arm.
	 *
	 * Only the stock `Timer_Node` reads token 0 as an interval and arms itself.
	 * A subclass returns through `Node::arguments()`, the plain setter, because
	 * its token 0 is its own — `Log_Node`'s is a filename — and because a
	 * subclass declaring no cadence would come back out of `parse_schema_args()`
	 * with `interval_ms` still 0, arming an own slot that fires every 0 ms and
	 * spins the drain loop. A subclass that does want a cadence parses it and
	 * calls `set_timer()` from its own override, as `Probe_Node::arguments()`
	 * does.
	 *
	 * @param list<string>|null $args New argument tokens (null = pure getter).
	 * @return list<string> Last-set argument tokens.
	 * @throws \InvalidArgumentException When token 0 is not a whole number.
	 * @throws \RuntimeException When the hitchhike finds no `_router`.
	 */
	public function arguments( ?array $args = null ): array {
		$ref = new \ReflectionObject( $this );
		if ( 'Timer_Node' !== $ref->getShortName() ) {
			return parent::arguments( $args );
		}
		if ( null === $args ) {
			return $this->arguments;
		}
		// Blank means "no interval": ride the Router heartbeat at its cadence.
		if ( '' === ( $args[0] ?? '' ) ) {
			$this->arguments = $args;
			$this->set_timer();
			return $this->arguments;
		}
		$this->parse_schema_args( $args );
		$this->set_timer( $this->interval_ms );
		return $this->arguments;
	}

	/**
	 * Framework-side tick: disarm a oneshot, apply the throttle, dispatch.
	 *
	 * A oneshot disarms BEFORE dispatching, which is what makes a `fire()` that
	 * re-arms a fresh oneshot so fragile — see `set_timer()`.
	 *
	 * A node with no sink returns before reaching `fire()`. That guard is why
	 * `Router_Node` overrides `fire_cb()` outright, having no sink of its own,
	 * and it traps any subclass whose `fire()` emits nothing:
	 * `Connect_Queue_Timer_Node` is mounted with a sink for no other reason.
	 *
	 * The throttle is the price of the hitchhike. The tick arrives at the
	 * Router's cadence, so a registrant that asked for a longer one drops the
	 * ticks in between.
	 */
	public function fire_cb(): void {
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

	/**
	 * Emit one heartbeat at `target` and notify FIRE listeners.
	 *
	 * The message is a TM_BYTESTREAM whose VALUE is the current timestamp,
	 * carrying the KEY tag when `key()` has set one.
	 *
	 * A timer with no target sinking straight into a `Command_Interpreter_Node`
	 * emits nothing: that pairing is a bare `make_node Timer` at the REPL, where
	 * `make_node` sinks the new node into the interpreter, and every tick would
	 * print a line nobody asked for. It still notifies, so a FIRE subscriber
	 * works either way.
	 *
	 * @throws \RuntimeException When the node has to emit and no sink is wired.
	 */
	protected function fire(): void {
		if ( '' !== $this->target || ! ( $this->sink instanceof Command_Interpreter_Node ) ) {
			if ( null === $this->sink ) {
				throw new \RuntimeException( 'Timer::fire requires a wired sink' );
			}
			$message                  = Message::new_message();
			$message[ Message::TYPE ] = Message::TM_BYTESTREAM;
			$message[ Message::FROM ] = $this->name;
			$message[ Message::TO ]   = $this->target;
			if ( '' !== $this->key ) {
				$message[ Message::KEY ] = $this->key;
			}
			$message[ Message::VALUE ] = (string) Core::$now;
			++$this->counter;
			$this->sink->fill( $message );
		}
		$this->notify( 'FIRE', Core::$now );
	}

	/**
	 * Arm the timer, picking the mode.
	 *
	 * A named non-Router node asking for no interval, or for one of at least
	 * `router_interval_ms()`, hitchhikes the Router's TIMER. Everything else
	 * takes its own Event_Framework slot, which requires a concrete interval.
	 *
	 * `$oneshot` is for a ONE-TIME wakeup — a debounce, a deadline, a flush on
	 * the next cycle. A node that PACES ITSELF must never re-arm a fresh oneshot
	 * at the bottom of its own `fire()`: `fire_cb()` disarms a oneshot before
	 * dispatching (`stop_timer()`, which also sets `mode` to inactive and zeroes
	 * `interval_ms`), so the node's continued existence in the event loop then
	 * depends on reaching that last line on every single tick. One early return,
	 * one throw, one refactor that moves the re-arm under a conditional, and the
	 * node leaves the loop for good — no error, no timer, just a node that stops
	 * firing. Hold a RECURRING timer instead and re-arm only when the cadence
	 * CHANGES, which makes a stop explicit:
	 *
	 *     $next_ms = $busy ? self::POLL_INTERVAL_BUSY_MS : self::POLL_INTERVAL_EOF_MS;
	 *     if ( $this->interval_ms !== $next_ms ) {
	 *         $this->set_timer( $next_ms );
	 *     }
	 *
	 * Because `stop_timer()` zeroes `interval_ms`, that guard reads true state
	 * only while every arming site for the node is recurring too: a oneshot boot
	 * arm leaves `interval_ms` at 0, which a busy branch wanting 0 then reads as
	 * "no change" and never re-arms. Live examples are `Durable_Reader::fire()`,
	 * `Remote_Source_Node::fire()` and `Stdin_Node::fire()`; the JS mirror is
	 * `src/runtime/timer-node.js`.
	 *
	 * @param int|null $ms      Interval in milliseconds; null means the Router's own cadence.
	 * @param bool     $oneshot Disarm after the first fire. One-time wakeups only — see above.
	 *
	 * @throws \RuntimeException When the hitchhike finds no `_router`, or an own slot gets no interval.
	 */
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
			// Clear a stale own-slot next_fire; list_timers reads it.
			$this->next_fire      = 0.0;
			$this->oneshot        = $oneshot;
			return;
		}
		if ( 'router' === $this->mode ) {
			$this->_stop_timer();
		}
		if ( null === $ms ) {
			// Null reaches here only from an unnamed node or the Router itself.
			throw new \RuntimeException( 'Own-slot timer requires an interval (ms)' );
		}
		$this->mode        = 'event_framework';
		$this->interval_ms = $ms;
		$this->oneshot     = $oneshot;
		Event_Framework::instance()->set_timer( $this );
	}

	/**
	 * The Router's own tick cadence, or `Router_Node::DEFAULT_TICK_MS` when no
	 * Router is mounted or its tick is not yet armed — a REPL or request-scope
	 * graph still has to resolve a mode.
	 *
	 * The hitchhike threshold and the fire throttle both compare against THIS
	 * rather than a hardcoded 1000. A Router ticking slower than the default
	 * would otherwise hand a 1500 ms timer a hitchhike that fires every 2000 ms,
	 * and would throttle a timer asking for exactly the tick against ticks that
	 * already are its interval.
	 *
	 * @return int Cadence in milliseconds.
	 */
	private static function router_interval_ms(): int {
		$router = Core::node( Node_Names::ROUTER );
		return $router instanceof self && $router->interval_ms > 0
			? $router->interval_ms
			: Router_Node::DEFAULT_TICK_MS;
	}

	/**
	 * Disarm before leaving the registry: a hitchhiker's registration is keyed
	 * by NAME, and one left behind addresses a node that no longer exists.
	 */
	public function remove_node(): void {
		$this->stop_timer();
		parent::remove_node();
	}

	/**
	 * Disarm: release whatever the mode holds, then forget the cadence.
	 *
	 * Zeroing `interval_ms` is what lets `set_timer()`'s "re-arm only when the
	 * cadence changes" guard read true state, and is also why a oneshot arming
	 * site poisons that guard — see `set_timer()`.
	 */
	public function stop_timer(): void {
		$this->_stop_timer();
		$this->mode        = 'inactive';
		$this->interval_ms = 0;
		$this->oneshot     = false;
	}

	/**
	 * Release the slot or the Router registration, leaving `mode` untouched.
	 *
	 * The release and the state reset are separate halves because `set_timer()`
	 * wants only the first: a node moving between modes writes its own new mode,
	 * interval and oneshot straight afterwards. `stop_timer()` is both halves.
	 */
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

	/**
	 * Move the router hitchhike with the name. That registration is keyed by
	 * NAME, so a rename leaving it behind strands an entry addressing nothing:
	 * the router shouts `forgot to unregister` on the next tick, drops it, and
	 * the timer stops firing under either spelling.
	 *
	 * @param string|null $name New name; omit the argument entirely to read.
	 * @return string The name the node answers to.
	 */
	public function name( ?string $name = null ): string {
		if ( 0 === \func_num_args() ) {
			return parent::name();
		}
		$previous = $this->name;
		$result   = parent::name( $name );
		$router   = Core::node( Node_Names::ROUTER );
		if ( 'router' === $this->mode && $previous !== $result && $router instanceof self ) {
			$router->unregister( 'TIMER', $previous );
			$router->register( 'TIMER', $result );
		}
		return $result;
	}

	/**
	 * Milliseconds for an operator-supplied cadence declared in SECONDS — the
	 * one conversion every self-pacing Timer subclass shares.
	 * `parse_schema_args()` has already refused anything that is not the
	 * declared numeric type, so what this adds is the floor, and the floor is
	 * load-bearing: `(int) ( 0.0005 * 1000 )` is a free-spinning 0 ms own slot
	 * rather than a fast timer. Clamping keeps a sub-second cadence on the
	 * Router hitchhike instead of taking the drain loop hostage.
	 *
	 * @param float $seconds Cadence in seconds, already coerced from its token.
	 * @return int Interval in milliseconds, floored at MIN_INTERVAL_S.
	 */
	protected function cadence_ms( float $seconds ): int {
		return (int) \round( \max( (float) self::MIN_INTERVAL_S, $seconds ) * 1000 );
	}

	/**
	 * Whether the timer is armed, in either mode.
	 *
	 * @api Introspection: the ACTIVE column of `list_timers`.
	 */
	public function timer_is_active(): bool {
		return 'inactive' !== $this->mode;
	}

	/**
	 * Which scheduling mode is live — the MODE column of `list_timers`, where it
	 * is what distinguishes an own slot from a Router hitchhike.
	 *
	 * @return string 'inactive', 'event_framework' or 'router'.
	 */
	public function timer_mode(): string {
		return $this->mode;
	}

	/**
	 * Dispatches since construction — the FIRES column of `list_timers`.
	 *
	 * @return int Ticks that reached `fire()`, not messages emitted.
	 */
	public function get_fire_count(): int {
		return $this->fire_count;
	}

	/**
	 * Read the KEY tag stamped onto each emitted message, or set it.
	 *
	 * @param string|null $key New tag, null to clear it; omit the argument to read.
	 * @return string The tag in force, empty for none.
	 */
	public function key( ?string $key = null ): string {
		if ( \func_num_args() > 0 ) {
			$this->key = (string) $key;
		}
		return $this->key;
	}

	/**
	 * Palette entry and configuration form for the topology console.
	 *
	 * @return array<string,mixed>
	 */
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
