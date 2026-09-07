<?php
/**
 * The event loop every long-running substrate process runs inside.
 *
 * One `drain()` call owns the process: it asks its caller whether to go round
 * again, waits for the next thing to fall due, and fires it. Timers are the
 * only scheduling primitive — local file polling (Tail, Consumer, the cli's
 * stdin reader) arms a `Timer_Node` rather than registering a descriptor, so
 * the loop holds exactly one blocking waiter however many sources are active.
 * cURL is the exception it cannot express that way: an easy handle hides its
 * socket behind cURL's API, so registered handles move the wait from `usleep`
 * to `curl_multi_select` over one shared multi handle.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Timer and cURL scheduling for one process, plus the cooperative-stop seam.
 *
 * A singleton because the loop is process state rather than graph state: any
 * node arms a timer through `instance()`, so nothing has to thread a reference
 * down the graph to reach it. `Worker_Base`, `wp nodes cli` and an SSE stream
 * each enter it through `drain()`.
 */
class Event_Framework {

	/**
	 * How long a tick with no timer armed waits, in microseconds.
	 *
	 * The same value serves as the `usleep` duration and the `curl_multi_select`
	 * timeout, so a tick with nothing scheduled to wake it still re-checks the
	 * loop predicate, dispatches signals, and picks up a timer armed by whatever
	 * ran this tick.
	 */
	private const IDLE_TIMEOUT_US = 100_000;

	/**
	 * Minimum seconds between `pump()` liveness checks.
	 *
	 * `Partition_Node` reaches `pump()` on every record it writes, many times a
	 * second on a busy firehose, and each check re-stats the worker's lock
	 * directory. Throttling to a second leaves the writes in between costing one
	 * clock read.
	 */
	private const PUMP_INTERVAL_S = 1.0;

	/** The one instance per process: `instance()` builds it lazily, `reset()` drops it. */
	private static ?self $instance = null;

	/**
	 * cURL-multi poll seam, defaulted lazily to the real `curl_multi_exec` plus a
	 * drain of `curl_multi_info_read`. Tests reassign it to feed synthetic
	 * CURLMSG_DONE infos, so the owner lookup, the completion tally and the
	 * dispatch into `on_curl_message()` all run as production code with no
	 * network transfer.
	 *
	 * Signature: `function ( \CurlMultiHandle $multi ): array<int,array<string,mixed>>`.
	 *
	 * @var \Closure|null
	 */
	public static ?\Closure $curl_poll = null;

	/**
	 * The active drain's continue-predicate, parked where `pump()` can re-run it
	 * from inside a long job. Null unless a cooperative-stop drain is running,
	 * which is what keeps `pump()` from throwing a web request, a cli or an SSE
	 * stream out of its own loop.
	 */
	private ?\Closure $continue_predicate = null;

	/** The one multi handle every registered easy handle attaches to; created on first register. */
	private ?\CurlMultiHandle $curl_multi = null;

	/** @var array<int,Node> Owning node, keyed by `spl_object_id` of its easy handle. */
	private array $curl_owners = [];

	/** @var array<int,int> Completions per node, keyed by the node's `spl_object_id`, for `list_handles`. */
	private array $curl_counts = [];

	/** True while inside `drain()`; how a node asks whether an event loop exists here (false in request scope). */
	private bool $draining = false;

	/** Wall clock of the last `stop_check()`; throttles `pump()` to PUMP_INTERVAL_S. */
	private float $last_pump = 0.0;

	/** @var array<int,Timer_Node> Armed own-slot timers, keyed by the node's `spl_object_id`. */
	private array $timers = [];

	/** Private: the loop is process state, reached through `instance()`. */
	private function __construct() {}

	/**
	 * Run the event loop until $should_continue says stop.
	 *
	 * Every field the loop owns is saved on the way in and restored on the way
	 * out, so a drain entered from inside another one hands the outer loop back
	 * its parked predicate. Nulling those fields instead would leave the outer
	 * worker without a predicate, silently disabling its `pump()` seam for the
	 * rest of the process. Zeroing `last_pump` on entry is the other half: it
	 * lets the first `pump()` of a cooperative-stop drain run its check rather
	 * than inherit an earlier drain's throttle.
	 *
	 * @param callable $should_continue Loop predicate; false ends the loop. Under
	 *   $cooperative_stop it is also called with true from `stop_check()`, meaning
	 *   "asked mid-work" — see `Worker_Base::should_continue()`.
	 * @param bool     $cooperative_stop Park the predicate for `pump()`, which may
	 *   re-run it from inside a long job and raise Worker_Should_Stop. Only
	 *   Worker_Base opts in: a cli or SSE drain passes a generic "this loop is
	 *   done" predicate and must never be thrown out of its own loop.
	 * @throws Worker_Should_Stop Raised by `pump()` or `stop_check()` from inside
	 *   a job and propagated out; `Worker_Base::execute()` catches it around the
	 *   drain as a normal stop.
	 */
	public function drain( callable $should_continue, bool $cooperative_stop = false ): void {
		$has_pcntl      = \function_exists( 'pcntl_signal_dispatch' );
		$prev_draining  = $this->draining;
		$prev_predicate = $this->continue_predicate;
		$prev_last_pump = $this->last_pump;
		$this->draining = true;
		if ( $cooperative_stop ) {
			$this->continue_predicate = \Closure::fromCallable( $should_continue );
			$this->last_pump          = 0.0;
		}
		try {
			$this->drain_inner( $should_continue, $has_pcntl );
		} finally {
			$this->draining           = $prev_draining;
			$this->continue_predicate = $prev_predicate;
			$this->last_pump          = $prev_last_pump;
		}
	}

	/**
	 * The loop. The clock refresh and the expired-timer scan sit here rather
	 * than in helpers, to save a call frame per tick.
	 *
	 * @param callable $should_continue Loop predicate; false ends the loop.
	 * @param bool     $has_pcntl Whether `pcntl_signal_dispatch()` exists, resolved
	 *   once by the caller rather than on every tick.
	 */
	private function drain_inner( callable $should_continue, bool $has_pcntl ): void {
		Core::right_now();
		while ( $should_continue() ) {
			if ( Core::$shutting_down ) {
				break;
			}

			$timeout_us = $this->next_timer_timeout_us();

			// The tick's one blocking wait: the shared multi, or a usleep.
			if ( ! empty( $this->curl_owners ) && null !== $this->curl_multi ) {
				// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_multi_select
				\curl_multi_select( $this->curl_multi, $timeout_us / 1_000_000.0 );
				$this->drain_curl_multi();
			} elseif ( $timeout_us > 0 ) {
				\usleep( $timeout_us );
			}

			if ( $has_pcntl ) {
				\pcntl_signal_dispatch();
			}

			Core::right_now();

			// A snapshot: a timer disarmed mid-scan still fires this tick.
			foreach ( $this->timers as $id => $node ) {
				if ( $node->next_fire > Core::$now ) {
					continue;
				}
				if ( $node->oneshot ) {
					unset( $this->timers[ $id ] );
				} else {
					$node->next_fire = Core::$now + ( $node->interval_ms / 1000.0 );
				}
				$node->fire_cb();
			}
		}
	}

	/**
	 * Service the shared multi handle and route every completion it reports.
	 *
	 * The poll is a replaceable seam, so a reply that is not an array — or a row
	 * inside one that is not — is skipped rather than trusted: a malformed reply
	 * must not take the loop down.
	 */
	private function drain_curl_multi(): void {
		if ( null === $this->curl_multi ) {
			return;
		}
		// Raw cURL: wp_remote_get is one-shot; the loop needs curl_multi_*.
		$poll = self::$curl_poll ?? static function ( \CurlMultiHandle $multi ): array {
			// phpcs:disable WordPress.WP.AlternativeFunctions.curl_curl_multi_exec, WordPress.WP.AlternativeFunctions.curl_curl_multi_info_read
			$still_running = 0;
			\curl_multi_exec( $multi, $still_running );
			$infos = [];
			while ( $info = \curl_multi_info_read( $multi ) ) {
				$infos[] = $info;
			}
			return $infos;
			// phpcs:enable
		};
		$infos = $poll( $this->curl_multi );
		if ( ! \is_array( $infos ) ) {
			return;
		}
		foreach ( $infos as $info ) {
			if ( \is_array( $info ) ) {
				$this->dispatch_curl_info( $info );
			}
		}
	}

	/**
	 * Route one completion to the node owning its easy handle, and tally it.
	 *
	 * Ownership is keyed by the handle's `spl_object_id`, so a node never has to
	 * recognize its own transfer and a handle unregistered mid-tick simply finds
	 * no owner. A node without `on_curl_message()` is skipped rather than fataled:
	 * `Node` does not declare the method, so only the nodes that register handles
	 * implement it.
	 *
	 * @param array<mixed,mixed> $info One `curl_multi_info_read()` row, carrying
	 *   `handle`, `msg` and `result`. The owning node decides what CURLMSG_DONE
	 *   means for it.
	 */
	private function dispatch_curl_info( array $info ): void {
		$handle = $info['handle'] ?? null;
		if ( ! ( $handle instanceof \CurlHandle ) ) {
			return;
		}
		$node = $this->curl_owners[ \spl_object_id( $handle ) ] ?? null;
		if ( null === $node || ! \method_exists( $node, 'on_curl_message' ) ) {
			return;
		}
		++$this->curl_counts[ \spl_object_id( $node ) ]; // on_curl_message may unregister the handle after
		$node->on_curl_message( $info );
	}

	/**
	 * Microseconds to wait before the soonest armed timer is due.
	 *
	 * Yields IDLE_TIMEOUT_US when no timer is armed, and 0 when one is already
	 * overdue, which drops the tick's wait to nothing so the timer fires at once.
	 *
	 * @return int Microseconds, never negative.
	 */
	private function next_timer_timeout_us(): int {
		if ( empty( $this->timers ) ) {
			return self::IDLE_TIMEOUT_US;
		}
		$soonest = PHP_INT_MAX;
		foreach ( $this->timers as $t ) {
			$delta_us = (int) ( ( $t->next_fire - Core::$now ) * 1_000_000 );
			if ( $delta_us < $soonest ) {
				$soonest = $delta_us;
			}
		}
		return \max( 0, $soonest );
	}

	/**
	 * Attach an easy handle to the shared multi and record its owner. The next
	 * tick services it and routes its completion to `$node->on_curl_message()`.
	 *
	 * Registering also seeds the node's completion counter at zero, so the first
	 * completion increments an existing key instead of warning on a missing one.
	 *
	 * @param Node        $node The node completions belong to.
	 * @param \CurlHandle $easy The easy handle it owns.
	 *
	 * @api Support for SSE streams + outbound HTTP.
	 */
	public function register_curl_easy( Node $node, \CurlHandle $easy ): void {
		// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_multi_add_handle
		\curl_multi_add_handle( $this->ensure_curl_multi(), $easy );
		$this->curl_owners[ \spl_object_id( $easy ) ] = $node;
		$this->curl_counts[ \spl_object_id( $node ) ] ??= 0;
	}

	/**
	 * The one shared multi handle, created on first use.
	 *
	 * One multi means one `curl_multi_select` per tick however many transfers are
	 * in flight, which is what keeps the loop at a single blocking waiter.
	 *
	 * @return \CurlMultiHandle The process's multi handle.
	 */
	private function ensure_curl_multi(): \CurlMultiHandle {
		if ( null === $this->curl_multi ) {
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_multi_init
			$this->curl_multi = \curl_multi_init();
		}
		return $this->curl_multi;
	}

	/**
	 * Re-run the parked continue-predicate from inside a long in-process job.
	 *
	 * A job that never yields starves the drain loop, so the worker's lock stops
	 * beating and its max_runtime, restart and memory stops go unnoticed until
	 * the job ends. `Partition_Node` reaches this on every record it writes, and
	 * an importer walking pages of a blocking API reaches it at each fetch, so
	 * the throttle is what keeps a per-line firehose write from re-running the
	 * check every time. It no-ops unless a cooperative-stop drain is active, so a
	 * web request, a cli or an SSE stream is never thrown out of its own loop.
	 *
	 * The throttle reads the live clock through `Core::right_now()` rather than
	 * the cached `Core::$now`, which nothing refreshes while a blocking job runs
	 * — a frozen read could not gate anything. Going through `right_now()` also
	 * un-freezes that cached clock on every pump a worker makes, throttled or
	 * not, which is what keeps mid-job message TIMESTAMPs advancing.
	 *
	 * The decision itself is `stop_check()`; this is its throttled form.
	 *
	 * @throws Worker_Should_Stop When the throttle allows a check and the parked
	 *   predicate says stop.
	 */
	public function pump(): void {
		// Deliberate duplicate: spares non-workers a right_now() per write.
		if ( null === $this->continue_predicate ) {
			return;
		}
		if ( Core::right_now() - $this->last_pump < self::PUMP_INTERVAL_S ) {
			return;
		}
		$this->stop_check();
	}

	/**
	 * Decide now whether the worker should keep going, and raise if not.
	 *
	 * What `pump()` does once its throttle allows it, for a caller that has just
	 * finished a unit of work and needs the answer at that point rather than up
	 * to PUMP_INTERVAL_S later — a subprocess render that may have outlived the
	 * lease, where the parent logged nothing for the whole render. A short render
	 * would otherwise slip past the throttle and record a clean finish.
	 *
	 * Asking directly beats riding the next write, because a write can be
	 * declined — `Log_Manager::message()` returns false when the request is not
	 * being logged — and whether the worker should stop has nothing to do with
	 * whether this request is logged.
	 *
	 * The Worker_Should_Stop raised here unwinds the whole `fill()` stack: broad
	 * drain-path catches re-throw it before handling (ADR-14), so a mid-job stop
	 * reaches Worker_Base on every path, not only the direct firehose write.
	 *
	 * @throws Worker_Should_Stop When the parked predicate says stop.
	 */
	public function stop_check(): void {
		if ( null === $this->continue_predicate ) {
			return;
		}
		// A stderr write is not a stop boundary; logging it would self-throw.
		if ( Core::in_stderr() ) {
			return;
		}
		$this->last_pump = Core::right_now();
		// mid_work: the idle question is meaningless with a job in flight.
		if ( ! ( $this->continue_predicate )( true ) ) {
			throw new Worker_Should_Stop();
		}
	}

	/**
	 * Whether this process is inside `drain()`.
	 *
	 * What a node asks before arming a timer it depends on: nothing fires a timer
	 * in request scope, so `Partition_Node` gives its large-write lock a
	 * heartbeat timer only when a loop is there to drive it.
	 *
	 * @return bool True while a drain is on the stack.
	 */
	public function is_running(): bool {
		return $this->draining;
	}

	/**
	 * The process's event framework, built on first use.
	 *
	 * @return self The singleton.
	 */
	public static function instance(): self {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	/**
	 * Drop the singleton, so the next `instance()` starts with no timers and no
	 * registered handles. `Core::reset()` calls it for that reason: a timer armed
	 * by a node the registry has just dropped would otherwise keep firing into a
	 * graph that no longer exists.
	 *
	 * @api Test teardown.
	 */
	public static function reset(): void {
		self::$instance = null;
	}

	/**
	 * Give a timer node its own slot in this loop.
	 *
	 * Arm timers through `Timer_Node::set_timer()`, never here: that is what picks
	 * between an own slot and the Router hitchhike, and what records the mode
	 * `list_timers` reports.
	 *
	 * @param Timer_Node $node The node to fire; its `interval_ms` sets the cadence.
	 */
	public function set_timer( Timer_Node $node ): void {
		$id = \spl_object_id( $node );
		// Seed next_fire; else it stays 0.0 and the timer busy-loops.
		$node->next_fire     = Core::$now + ( $node->interval_ms / 1000.0 );
		$this->timers[ $id ] = $node;
	}

	/**
	 * Release a node's slot. Idempotent: a node holding none is a no-op.
	 *
	 * @param Timer_Node $node The node to stop firing.
	 */
	public function stop_timer( Timer_Node $node ): void {
		unset( $this->timers[ \spl_object_id( $node ) ] );
	}

	/**
	 * Detach an easy handle from the shared multi and drop its owner. Idempotent.
	 *
	 * The per-node completion counter goes once that node's last handle does, so
	 * `list_handles` lists live handles only and a reconnecting node starts a
	 * fresh tally.
	 *
	 * @param \CurlHandle $easy The handle to release.
	 *
	 * @api Support for SSE streams + outbound HTTP.
	 */
	public function unregister_curl_easy( \CurlHandle $easy ): void {
		$id   = \spl_object_id( $easy );
		$node = $this->curl_owners[ $id ] ?? null;
		if ( null === $node ) {
			return;
		}
		if ( null !== $this->curl_multi ) {
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_multi_remove_handle
			\curl_multi_remove_handle( $this->curl_multi, $easy );
		}
		unset( $this->curl_owners[ $id ] );
		if ( ! \in_array( $node, $this->curl_owners, true ) ) {
			unset( $this->curl_counts[ \spl_object_id( $node ) ] );
		}
	}

	/**
	 * Per-node cURL rows for the `list_handles` verb: one row per node holding a
	 * registered easy handle, carrying that node's completion counter.
	 *
	 * @return array<int,array{node: Node,counter: int}> Keyed by the node's `spl_object_id`.
	 */
	public function curl_handles(): array {
		$rows = [];
		foreach ( $this->curl_owners as $node ) {
			$nid = \spl_object_id( $node );
			$rows[ $nid ] ??= [ 'node' => $node, 'counter' => $this->curl_counts[ $nid ] ?? 0 ];
		}
		return $rows;
	}

	/**
	 * Make SIGTERM and SIGINT set `Core::$shutting_down`, and nothing else.
	 *
	 * The handler flips a flag instead of exiting, so the tick in progress
	 * finishes and teardown runs after `drain()` returns; a handler that exited
	 * would strand a Partition's write lock for the next spawn to wait out. A
	 * build without pcntl gets no handlers and is otherwise unchanged.
	 */
	public function install_signal_handlers(): void {
		if ( ! \function_exists( 'pcntl_signal' ) ) {
			return;
		}
		$handler = static function ( int $sig ): void {
			Core::$shutting_down = true;
		};
		\pcntl_signal( SIGTERM, $handler );
		\pcntl_signal( SIGINT,  $handler );
	}
}
