<?php
/**
 * Router: `_router`, where a TO path becomes a delivery.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Dispatches messages by path and drives the TIMER channel.
 *
 * `fill()` peels the head segment off TO, hands the message to the node bound to
 * that name, and answers a miss with NOT_AVAILABLE back along FROM. Addressing
 * is by name and path, never by socket, so no node has to know where its peers
 * live: `a/b/c` means "find `a`, give it `b/c`".
 *
 * The second job is why it extends `Timer_Node`. Its `fire_cb()` calls each
 * TIMER registrant's own `fire_cb()` directly — the Router-hitchhike pattern,
 * which buys a node periodic work without an Event_Framework slot of its own,
 * ported from Tachikoma's `Router::fire_cb` and `notify_timer`. Overriding is
 * what makes the pattern possible at all: `Timer_Node::fire_cb()` returns early
 * on a node with no sink, and the Router has none.
 *
 * Dispatch profiling stays off until the `profile on` verb sets `$profiles`,
 * and while it is null `fill()` takes a branch that costs nothing.
 */
class Router_Node extends Timer_Node {

	/**
	 * Tick cadence in milliseconds, armed by `Worker_Base::build_scaffolding()`.
	 * `Timer_Node` also reads it as the assumed cadence when no Router is mounted,
	 * so a timer arming in a graph without one still resolves a mode.
	 */
	public const DEFAULT_TICK_MS = 1000;

	/** Seconds of idleness after which `trim_profiles()` drops an entry (Tachikoma: 900). */
	public const PROFILE_TTL_S = 900;

	/**
	 * Clock seam replacing the two bare `microtime( true )` reads that bracket a
	 * profiled dispatch. Tests assign a closure returning a scripted sequence, so
	 * elapsed times are exact; production leaves it null.
	 *
	 * Signature: `function (): float`.
	 *
	 * @var (\Closure(): float)|null
	 */
	public static ?\Closure $clock = null;

	/**
	 * Per-node self-time profiles, keyed by node name; null = profiling off.
	 * Static like Router.pm's package-global $PROFILES: the table belongs to the
	 * process rather than to any one Router instance.
	 *
	 * `time` is self-time in seconds, a nested dispatch having been subtracted
	 * back out of its parent. `oldest` and `timestamp` are the first and last
	 * dispatch recorded, which is the window `list_profiles` reports a rate over
	 * and the idleness `trim_profiles()` measures.
	 *
	 * @var array<string,array{time: float,count: int,avg: float,oldest: float,timestamp: float}>|null
	 */
	private static ?array $profiles = null;

	/**
	 * Open dispatch frames, innermost last (Router.pm's @STACK). `pop_profile()`
	 * reads the entry beneath the one it pops to find the parent the child's
	 * elapsed time comes out of.
	 *
	 * @var list<string>
	 */
	private static array $profile_stack = [];

	/**
	 * True while `send_error()` builds a bounce, so an error about that error is
	 * dropped instead of recursing.
	 */
	private bool $handling_error = false;

	/**
	 * Seed the base registrations. The tick is NOT armed here: whoever owns the
	 * event loop calls `set_timer( self::DEFAULT_TICK_MS )`, which is why a
	 * request-scope or REPL graph builds a Router and never fires one (ADR-5).
	 */
	public function __construct() {
		parent::__construct();
	}

	/**
	 * Route one message: peel the head segment off TO and fill the node it names.
	 *
	 * The counter counts messages taken in rather than delivered, so a miss that
	 * bounces a TM_ERROR back through this same `fill()` bumps it twice. The JS
	 * Router counts identically.
	 *
	 * FROM is measured here rather than trusted. `stamp_message()` already guards
	 * the path on the way out of each node, but a message arriving off the wire
	 * was stamped in another process; dropping over `MAX_FROM_SIZE` is what keeps
	 * a routing cycle from growing an unbounded path.
	 *
	 * TO becomes the remainder before the target sees it, so each hop reads only
	 * the path below itself and a deeper Router peels its own head in turn.
	 *
	 * @param array<int,mixed> $message The 7-field positional message array.
	 */
	public function fill( array $message ): void {
		++$this->counter;

		if ( '' === $message[ Message::TO ] ) {
			$this->drop_message( $message, 'message not addressed' );
			return;
		}

		$from = $message[ Message::FROM ] ?? '';
		if ( ! \is_string( $from ) ) {
			$from = Core::as_string( $from );
		}
		if ( \strlen( $from ) > self::MAX_FROM_SIZE ) {
			$this->drop_message( $message, 'path exceeded ' . self::MAX_FROM_SIZE . ' bytes' );
			return;
		}

		$to = $message[ Message::TO ];
		if ( ! \is_string( $to ) ) {
			$to = Core::as_string( $to );
		}
		$parts     = \explode( '/', $to, 2 );
		$node_name = $parts[0];
		$remaining = $parts[1] ?? '';
		$target    = Core::$nodes_by_name[ $node_name ] ?? null;
		if ( null === $target ) {
			$this->send_error( $message, 'NOT_AVAILABLE' );
			return;
		}
		$message[ Message::TO ] = $remaining;

		if ( null !== self::$profiles ) {
			$before = $this->push_profile( $node_name );
			try {
				// A throw must still pop, or later frames get the wrong parent.
				$target->fill( $message );
			} finally {
				$this->pop_profile( $before );
			}
			return;
		}
		$target->fill( $message );
	}

	/**
	 * The tick: fire every TIMER registrant, then run the per-tick housekeeping.
	 *
	 * This replaces `Timer_Node::fire_cb()` rather than extending it. That one
	 * returns early on a sinkless node and emits a heartbeat message the Router
	 * would have nowhere to send; this one dispatches `notify_timer()` instead,
	 * which is the whole hitchhike.
	 *
	 * The housekeeping rides here because the tick is the one fixed cadence every
	 * worker already pays for: `Partition_Node::flush_pending_wakes()` wakes
	 * on-demand workers once per process instead of once per partition write,
	 * `Core::prune_logs()` re-windows the rate limiter so a recurring warning
	 * eventually prints again, and `trim_profiles()` drops idle profile entries.
	 */
	public function fire_cb(): void {
		// 0 is armed but undeclared; null is a graph with no command surface.
		if ( 0 === Core::$secure_level ) {
			$this->print_less_often( 'WARNING: no secure level declared' );
		}
		$this->notify_timer();
		// One flush per tick for the whole process, off Partition's lock path.
		Partition_Node::flush_pending_wakes();
		Core::prune_logs();
		if ( null !== self::$profiles ) {
			$this->trim_profiles();
		}
		$this->fire_count++;
	}

	/**
	 * Open a dispatch frame for $name.
	 *
	 * @param string $name Node the message is about to be handed to.
	 * @return float Start time, handed straight back to `pop_profile()`.
	 */
	private function push_profile( string $name ): float {
		self::$profile_stack[] = $name;
		// Bare microtime, NOT right_now(): must not perturb Core::$now.
		return null !== self::$clock ? ( self::$clock )() : \microtime( true );
	}

	/**
	 * Close the innermost frame and fold its elapsed time into that node's entry.
	 *
	 * The same elapsed comes back out of the enclosing frame, so every entry
	 * reports SELF time: a node whose work is one nested dispatch shows the cost
	 * against the callee, not against itself.
	 *
	 * Profiling can be switched off between the push and the pop, so `$profiles`
	 * is re-read; the frame left open then costs nothing, because `profiles()`
	 * empties the stack on any set.
	 *
	 * @param float $before Start time from `push_profile()`.
	 */
	private function pop_profile( float $before ): void {
		if ( null === self::$profiles ) {
			return;
		}
		// Bare microtime, NOT right_now() — see push_profile().
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

	/**
	 * Drop profile entries idle longer than `PROFILE_TTL_S`, which the tick does
	 * on every pass while profiling is on. Idleness is measured against
	 * `Core::$now`, the cached per-tick clock — the `$clock` seam times
	 * dispatches, not this sweep.
	 */
	public function trim_profiles(): void {
		foreach ( self::$profiles ?? [] as $key => $info ) {
			if ( Core::$now - $info['timestamp'] > self::PROFILE_TTL_S ) {
				unset( self::$profiles[ $key ] );
			}
		}
	}

	/**
	 * Answer an unroutable message: publish NOT_AVAILABLE, then bounce a TM_ERROR
	 * back down the FROM trail.
	 *
	 * `set_state()` fires first, so a NOT_AVAILABLE registrant sees the miss even
	 * when there is no FROM to reply to. Its payload is the flat `KEY VALUE` form
	 * a TM_INFO listener expects, naming the node that was missing and the fields
	 * identifying the message. The bounce then reverses the addresses — FROM
	 * becomes the destination that was missing, TO the sender — and re-enters
	 * this Router, so the error walks back the way the message came.
	 *
	 * A message already carrying TM_ERROR gets the state change and nothing else:
	 * answering an error trail with another error is how two dead paths loop.
	 * `$handling_error` closes the same hole from the other side, because the
	 * bounce's own route can miss too.
	 *
	 * @param array<int,mixed> $message Message that failed to route.
	 * @param string           $error   Text carried as the TM_ERROR VALUE; callers pass `NOT_AVAILABLE`.
	 */
	public function send_error( array $message, string $error ): void {
		if ( $this->handling_error ) {
			$this->drop_message( $message, 'breaking recursion' );
			return;
		}
		$this->handling_error = true;
		// TO is unpeeled here, so its head names the node that was missing.
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

	/**
	 * Call each TIMER registrant's `fire_cb()` directly — no message, no `fill()`.
	 *
	 * The channel holds NAMES, so each is resolved fresh on every tick: a name
	 * whose node is gone costs one warning and loses its registration, and a
	 * registrant that is not a `Timer_Node` is skipped rather than fataled,
	 * because one misregistration must not take the tick — and every other
	 * hitchhiker riding it — down.
	 *
	 * Iterating `array_keys()` walks a snapshot, so a registrant unregistering
	 * itself or a peer from inside its own `fire_cb()` cannot disturb the walk.
	 */
	public function notify_timer(): void {
		foreach ( array_keys( $this->registrations['TIMER'] ) as $name ) {
			$node = Core::node( $name );
			if ( null === $node ) {
				$this->stderr( "WARNING: $name forgot to unregister" );
				unset( $this->registrations['TIMER'][ $name ] );
				continue;
			}
			if ( $node instanceof Timer_Node ) {
				$node->fire_cb();
			}
		}
	}

	/**
	 * Get/set the profile table. Setting (even to null) resets the frame stack.
	 *
	 * Variadic because null is a VALUE here — it turns profiling off — so a
	 * `?array $set = null` parameter could not tell a disable from a read. The
	 * stack is emptied on either kind of set: whatever frames stood open belonged
	 * to a table that is no longer the one being written.
	 *
	 * @param array<string,array{time: float,count: int,avg: float,oldest: float,timestamp: float}>|null ...$set New table (array to enable, null to disable) when given.
	 * @return array<string,array{time: float,count: int,avg: float,oldest: float,timestamp: float}>|null
	 */
	public static function profiles( ?array ...$set ): ?array {
		if ( \count( $set ) > 0 ) {
			self::$profiles      = $set[0];
			self::$profile_stack = [];
		}
		return self::$profiles;
	}

	/**
	 * Always null: the Router has no sink, and refuses to be given one.
	 *
	 * Every other node forwards to its sink; this one routes by TO instead, and
	 * never reads the field. A sink accepted here would therefore sit unused, and
	 * whoever wired it would watch messages never arrive with nothing to blame —
	 * so the setter throws instead. The JS Router refuses the same way.
	 *
	 * @param Node|null $node Unused; passing any argument is a misuse and throws.
	 * @return Node|null Always null.
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

	/**
	 * Console manifest. `Hidden` keeps `_router` out of the palette: a graph has
	 * exactly one, placed by the scaffolding rather than dragged in. The three
	 * declared events are FIRE for the tick, TIMER for the hitchhike channel
	 * and NOT_AVAILABLE for a route miss.
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return [
			'category'      => 'Hidden',
			'description'   => 'Path-based message routing — placed automatically as `_router`.',
			'arguments'     => [],
			'commands'      => [],
			'registrations' => [ 'FIRE', 'TIMER', 'NOT_AVAILABLE' ],
		];
	}
}
