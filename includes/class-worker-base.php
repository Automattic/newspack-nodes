<?php
/**
 * Worker Base: the zombie-process worker lifecycle.
 *
 * A worker is an HTTP request that finishes its response and keeps running
 * (ADR-8). This file owns everything wrapped around the drain loop: taking the
 * lifecycle lock, building the scaffolding every worker graph starts from,
 * handing durable cursors off at shutdown, releasing the lock, and POSTing the
 * successor's spawn. The stop policy itself lives in `Cooperative_Stop`.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

if ( ! \defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * The lifecycle every worker type shares. A topology closure supplies the graph;
 * the lock, the scaffolding, the drain, the cursor handoff and the succession are
 * all here, which is what keeps any one node from implementing its own restart.
 *
 * Succession releases BEFORE it respawns (ADR-8): reversed, the successor's
 * `acquire()` meets a lock this process still holds, skips, and idles the slot
 * until a peer's rescue. That peer scan is the `_fleet` node this class mounts
 * (ADR-9).
 */
class Worker_Base {
	use Cooperative_Stop;

	/**
	 * Fraction of the memory limit at which a fresh post-reset baseline counts as
	 * "near the watermark" itself. A memory stop from such a baseline is a leak or
	 * an undersized limit rather than one poison message, so the fair-shot rule
	 * alerts instead of striking the in-flight message (ADR-12).
	 */
	public const BASELINE_WATERMARK_PCT = 0.50;

	/** IPC scratch geometry: the age rule is off, so a partition is bounded by count. */
	public const IPC_LIFETIME = 0;

	/** IPC scratch geometry: hard cap; segments above it are pruned unconditionally. */
	public const IPC_MAX_SEGMENTS = 4;

	/** IPC scratch geometry: no age floor, so nothing survives the count rule by youth. */
	public const IPC_MIN_LIFETIME = 0;

	/** IPC scratch geometry: floor for the age rule, and Partition's own hard minimum. */
	public const IPC_MIN_SEGMENTS = 2;

	/** IPC scratch geometry: count-rule target the oldest segments are pruned back to. */
	public const IPC_NUM_SEGMENTS = 2;

	/** IPC scratch geometry: 1 MiB segment rotation threshold. */
	public const IPC_SEGMENT_SIZE = 1048576;

	/**
	 * Seconds of one-shot pre-drain pause, so a concurrent spawn reads our lock as
	 * held before it retries. Unlike the heartbeat and DB-probe intervals in
	 * `Cooperative_Stop`, nothing throttles on this — it fires once, before work.
	 */
	public const LOCK_CHECK_GRACE_S = 0.25;

	/**
	 * last-PHP-error seam. Lazily-defaulted to the real `error_get_last()`;
	 * tests reassign to classify fatal shutdowns without raising one.
	 * Signature: `function (): ?array`.
	 *
	 * @var \Closure|null
	 */
	public static ?\Closure $last_error = null;

	/**
	 * Fresh spawn-token minting for self_respawn(). Wired by
	 * `Bootstrap::ensure_runtime_wired()` — the token captured at boot is
	 * ~max_runtime stale by recycle time, far outside the endpoint's 20s HMAC
	 * window. Null (bare tests) falls back to the token execute() was given.
	 * Signature: `function (): string`.
	 *
	 * @var \Closure|null
	 */
	public static ?\Closure $token_provider = null;

	/** Runtime state root; this worker's `locks/` and `ipc/` trees hang off it. */
	protected string $base_dir;

	/** Fresh post-reset memory baseline, captured before the drain — the memory-guard reference point. */
	protected int $baseline_memory = 0;

	/** This worker's IPC-input Consumer — checkpointed at shutdown so a clean recycle doesn't replay consumed commands. */
	protected ?Consumer_Node $ipc_input_consumer = null;

	/** This worker's partition number, handed on to the topology closure. */
	protected int $partition;

	/** Whether the shutdown path has already run; the handler and the `finally` race for it. */
	protected bool $shutdown_handled = false;

	/** Seconds without a heartbeat after which a peer may steal this worker's lock. */
	protected int $stale_timeout;

	/** Worker type; `{type}.p{partition}` names the lock dir, the IPC tree and the stop label. */
	protected string $worker_type;

	/**
	 * Configure one worker. Nothing here touches the lock, the filesystem or the
	 * graph — `execute()` owns all three, so constructing a worker is free.
	 *
	 * @param string $base_dir       Runtime state root; `locks/` and `ipc/` hang off it.
	 * @param string $worker_type    Worker type, the first half of the `{type}.p{N}` id.
	 * @param int    $partition      Partition number, the second half.
	 * @param int    $max_runtime    Seconds this process runs before yielding to a successor.
	 * @param int    $stale_timeout  Seconds without a heartbeat before a peer may steal the lock.
	 * @param int    $on_demand_idle Seconds every reporter must stay idle before this process exits; 0 stays resident.
	 */
	public function __construct(
		string $base_dir,
		string $worker_type,
		int $partition,
		int $max_runtime = self::DEFAULT_MAX_RUNTIME,
		int $stale_timeout = 60,
		int $on_demand_idle = 0
	) {
		$this->base_dir       = \rtrim( $base_dir, '/' );
		$this->worker_type    = $worker_type;
		$this->partition      = $partition;
		$this->max_runtime    = $max_runtime;
		$this->stale_timeout  = $stale_timeout;
		$this->on_demand_idle = $on_demand_idle;
	}

	/**
	 * Run one worker lifetime: take the lock, build the graph, drain until a stop
	 * trigger fires, then hand the slot to a successor.
	 *
	 * Two paths reach the shutdown, and both claim `$shutdown_handled` first: the
	 * registered handler catches an `exit()` that skips the `finally`, the
	 * `finally` catches everything else, and whichever runs first wins. Without
	 * that flag a clean exit would hand cursors off, tear the graph down, release
	 * and respawn twice over.
	 *
	 * @param callable $topology  Topology closure, called as `( $interpreter, $partition )`.
	 * @param string   $spawn_url Spawn endpoint URL the successor's POST goes to.
	 * @param string   $token     HMAC spawn token, used when `$token_provider` is unwired.
	 * @return array{status: string, reason?: string, error?: string} `skipped` plus the
	 *   acquire failure, `load_failed` plus the topology error, or `ok`.
	 */
	public function execute( callable $topology, string $spawn_url, string $token ): array {
		if ( ! $this->acquire() ) {
			$reason = null !== $this->lock ? ( $this->lock->acquire_failure() ?: 'lock_held' ) : 'lock_held';
			if ( 'lock_held' !== $reason ) {
				Core::print_less_often( "{$this->worker_type}.p{$this->partition}: spawn skipped: ", $reason );
			}
			return [ 'status' => 'skipped', 'reason' => $reason ];
		}

		\register_shutdown_function( function () use ( $spawn_url, $token ): void {
			if ( ! $this->shutdown_handled ) {
				$this->shutdown_handled = true;
				// Handoff durable cursors; skipped on fatal (crashes climb).
				$this->shutdown_handoff();
				// Tear down nodes first so Partitions unlock before respawn.
				Core::cleanup_all_nodes();
				$this->release();
				if ( $this->should_self_respawn() ) {
					$this->self_respawn( $spawn_url, $token );
				}
			}
		} );

		// Brief grace so a concurrent spawn sees we hold the lock before retry.
		\usleep( (int) ( self::LOCK_CHECK_GRACE_S * 1_000_000 ) );

		try {
			$interpreter = $this->build_scaffolding();
			try {
				$this->run_topology( $topology, $interpreter );
			} catch ( Worker_Should_Stop $e ) {
				// A stop IS a RuntimeException; never a load failure.
				throw $e;
			} catch ( \RuntimeException $e ) {
				// @longform A malformed .tsl fails loud but CLEAN: one line,
				// lock freed, NO self-respawn (a hot loop on the same bad
				// file); a peer's scan retries on its own throttled tick.
				Core::stderr( "{$this->worker_type}.p{$this->partition}: topology load failed: " . $e->getMessage() );
				$this->shutdown_handled = true;
				Core::cleanup_all_nodes();
				$this->release();
				return [
					'status' => 'load_failed',
					'error'  => $e->getMessage(),
				];
			}

			// Memory-guard reference: after the graph, before any work.
			$this->baseline_memory = \memory_get_usage( true );

			$ef = Event_Framework::instance();
			$ef->install_signal_handlers();
			// pump() calls this same closure with true from inside a job.
			$ef->drain( fn( bool $mid_work = false ) => $this->should_continue( $mid_work ), cooperative_stop: true );
		} catch ( Worker_Should_Stop $e ) {
			// pump() stopped mid-job; normal exit, finally releases/respawns.
			Core::stderr( "{$this->worker_type}.p{$this->partition}: stopped mid-job (pump)" );
		} finally {
			if ( ! $this->shutdown_handled ) {
				$this->shutdown_handled = true;
				$this->shutdown_handoff();
				Core::cleanup_all_nodes();
				$this->release();
				if ( $this->should_self_respawn() ) {
					$this->self_respawn( $spawn_url, $token );
				}
			}
		}

		return [ 'status' => 'ok' ];
	}

	/**
	 * Invoke the topology closure, which hangs this worker's own nodes off the
	 * scaffolded interpreter.
	 *
	 * @param callable                 $topology    Called as `( $interpreter, $partition )`.
	 * @param Command_Interpreter_Node $interpreter The scaffolded interpreter.
	 */
	public function run_topology( callable $topology, Command_Interpreter_Node $interpreter ): void {
		$topology( $interpreter, $this->partition );
	}

	/**
	 * Build the scaffolding every worker graph starts from: `_router`,
	 * `_command_interpreter`, `_fleet`, the `_repl` output Partition and the
	 * anonymous IPC-input Consumer.
	 *
	 * The interpreter sinks into the Router and everything else sinks into the
	 * interpreter, so a topology steers flow with `target` alone and never needs a
	 * sink chain of its own.
	 *
	 * @return Command_Interpreter_Node The interpreter topology closures build on.
	 */
	public function build_scaffolding(): Command_Interpreter_Node {
		// A worker VERIFIES commands: set the process-wide authorize once.
		Command_Interpreter_Node::$default_authorize = Command_Auth::verifier();

		$ipc_dir = self::ipc_dir( $this->base_dir, $this->worker_type, $this->partition );

		$router = new Router_Node();
		$router->name( Node_Names::ROUTER );
		// Active timer so the Router fires TIMER for the hitchhike pattern.
		$router->set_timer( Router_Node::DEFAULT_TICK_MS );

		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( Node_Names::COMMAND_INTERPRETER );
		$interpreter->sink( $router );

		// @longform Peer-spawn scan: every worker revives the fleet, so
		// supervision outlives any one process; the throttle dedupes them.
		$interpreter->make_node( 'Fleet', Node_Names::FLEET, $this->base_dir, $this->held_lock_path() );

		// The _repl output Partition, which an attached `wp nodes cli` tails.
		if ( ! \is_dir( "{$ipc_dir}/output" ) ) {
			if ( ! Config::write_denied( 'ipc output dir' ) ) {
				// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
				@\mkdir( "{$ipc_dir}/output", 0755, true );
			}
		}
		// make_node names it, applies the arguments, and sinks it into us.
		$repl = $interpreter->make_node( 'Partition', Node_Names::REPL, ...self::ipc_partition_args( "{$ipc_dir}/output" ) );
		// Dumps exceed PIPE_BUF, and this worker is its only writer: no lock.
		if ( $repl instanceof Partition_Node ) {
			$repl->void_warranty();
		}

		$repl_in = $this->build_ipc_input_consumer( $ipc_dir );
		$repl_in->sink( $interpreter );

		return $interpreter;
	}

	/**
	 * Build this worker's IPC-input Consumer with a DURABLE offsetlog so a
	 * respawned worker resumes from its last read offset — commands queued while
	 * it was down (fleets recycle ~10 min) aren't dropped, so a live console
	 * reconnecting through a restart keeps getting replies. First spawn (no
	 * checkpoint) tail-seeks to end so it doesn't replay the input partition's
	 * retained command history. Anonymous (a pure source — never a routed TO).
	 *
	 * It stamps FROM as `_repl`, which is the whole reply path: a command read out
	 * of `input/` carries that FROM, the interpreter answers TO=FROM, and the
	 * Router hands the answer to the `_repl` Partition writing `output/`, where
	 * the cli is reading. Addressing IS the correlation (ADR-7) — nothing else
	 * pairs a reply with its command.
	 *
	 * @param string $ipc_dir This worker's IPC dir (`{base}/ipc/{type}.p{N}`).
	 * @return Consumer_Node The consumer, unsunk; the caller wires it.
	 */
	public function build_ipc_input_consumer( string $ipc_dir ): Consumer_Node {
		$input_dir = "{$ipc_dir}/input";
		if ( ! \is_dir( $input_dir ) ) {
			if ( ! Config::write_denied( 'ipc input dir' ) ) {
				// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
				@\mkdir( $input_dir, 0755, true );
			}
		}
		$consumer = new Consumer_Node();
		$consumer->arguments( [ $input_dir, "{$ipc_dir}/input.offsets" ] );
		// Tail-seek skips stale history; a respawn's checkpoint overrides it.
		$consumer->next_offset( 'end' );
		$consumer->set_stamp_as( Node_Names::REPL );
		$this->ipc_input_consumer = $consumer;
		$this->ipc_reporter       = $consumer;
		return $consumer;
	}

	/**
	 * Full seven-slot geometry for an IPC scratch partition: bounded by COUNT, never
	 * age-pruned. Declaring all five retention axes is the point — an omitted one
	 * inherits `<config:*>`, where a min_lifetime of an hour protects every segment
	 * from the count rule and the scratch grows without bound.
	 *
	 * @param string $dir Segment directory.
	 * @return list<string>
	 */
	public static function ipc_partition_args( string $dir ): array {
		return \array_map( '\strval', [
			$dir,
			self::IPC_SEGMENT_SIZE,
			self::IPC_MIN_SEGMENTS,
			self::IPC_NUM_SEGMENTS,
			self::IPC_MAX_SEGMENTS,
			self::IPC_MIN_LIFETIME,
			self::IPC_LIFETIME,
		] );
	}

	/**
	 * Where a worker's IPC tree lives: `{base}/ipc/{type}.p{N}`. One definition,
	 * because the fleet's own scaffolding and anything asking about another worker
	 * must agree — this layout is the SUBSTRATE's, unlike a TSL path template, so
	 * constructing it here is not the layout assumption a `.p<N>` parse would be.
	 *
	 * @param string $base_dir  Runtime state root.
	 * @param string $type      Worker type.
	 * @param int    $partition Partition number.
	 */
	public static function ipc_dir( string $base_dir, string $type, int $partition ): string {
		return \rtrim( $base_dir, '/' ) . "/ipc/{$type}.p{$partition}";
	}

	/**
	 * Fire-and-forget spawn POST so another process takes over after we exit.
	 *
	 * Routes through Core::fire_and_forget_post — the same raw-curl path the
	 * Fleet_Node uses (wp_remote_post's Requests transport floors the timeout at
	 * 1s, defeating the sub-second fire-and-forget contract; the helper guards on the
	 * curl extension itself). Body stays byte-compatible with the spawn endpoint's
	 * {type, partition, nonce} contract so HMAC/nonce validation still passes.
	 *
	 * @param string $spawn_url Fully-qualified spawn URL (rest_url + path).
	 * @param string $token     Current HMAC spawn token.
	 */
	public function self_respawn( string $spawn_url, string $token ): void {
		// Boot-time tokens are stale here; mint at POST time when wired.
		$provider = self::$token_provider;
		if ( null !== $provider ) {
			$token = Core::as_string( $provider() );
		}
		$err = Core::fire_and_forget_post( $spawn_url, [
			'type'      => $this->worker_type,
			'partition' => $this->partition,
			'nonce'     => $token,
		] );
		if ( null !== $err ) {
			Core::stderr( "{$this->worker_type}.p{$this->partition}: self_respawn failed: {$err}" );
		}
	}

	/**
	 * Whether this stop hands the slot straight back to a successor.
	 *
	 * Two reasons say no. An idle stop means there was no work, so respawning
	 * would undo the exit that just happened — a producer wakes the slot instead.
	 * An operator stop must leave the slot empty for the length of a deploy. Every
	 * other reason means the work outlived one process, so the slot is handed on.
	 *
	 * @return bool True when `execute()` should POST the successor's spawn.
	 */
	public function should_self_respawn(): bool {
		return ! \in_array( $this->stop_reason, [ 'idle', 'stop' ], true );
	}

	/**
	 * Drop the lifecycle lock, flushing pending on-demand wakes first — while the
	 * lock still reads HELD. Flush them after, and a wake for a partition this
	 * worker itself tails finds the slot free and spawns a duplicate of us.
	 */
	public function release(): void {
		Partition_Node::flush_pending_wakes();
		if ( null !== $this->lock ) {
			$this->lock->release();
			$this->lock = null;
		}
	}

	/**
	 * Shutdown handoff: the `Shutdown_Sweeper` flush, then the cursors. On a clean stop
	 * (cooperative or operational) every durable reader is graceful/fair-shot checkpointed.
	 * On a FATAL (OOM / uncaught error that aborted the run before the finally) the handoff
	 * is SKIPPED: leaving the boot frame's climbing attempt count intact is what lets a
	 * deterministic fatal-poison reach the crash-crawl threshold (ADR-12) instead of
	 * resetting to the baseline every lifetime.
	 */
	public function shutdown_handoff(): void {
		if ( $this->is_fatal_shutdown() ) {
			return;
		}
		$this->sweep_shutdown_sweepers();
		$this->checkpoint_durable_consumers();
	}

	/**
	 * Clean-shutdown handoff for every durable reader this process owns: the registered
	 * Consumers and Remote_Sources (`Core::$nodes_by_name`) plus the anonymous IPC
	 * consumer, which no registry can see. A graceful checkpoint stamps attempts=0 at
	 * the current cursor, so the respawn resumes at the virgin baseline rather than
	 * counting the clean recycle as a crash. That stamp is half the crash detector:
	 * every boot climbs attempts unconditionally, so without it an idle cursor would
	 * cross the threshold and quarantine an innocent message (ADR-12).
	 */
	public function checkpoint_durable_consumers(): void {
		foreach ( Core::$nodes_by_name as $node ) {
			if ( $node instanceof Consumer_Node ) {
				$this->handoff_consumer( $node );
			} elseif ( $node instanceof Remote_Source_Node ) {
				// Also a durable cursor, but not a Consumer_Node.
				$this->handoff_remote_source( $node );
			}
		}
		$this->checkpoint_ipc_input();
	}

	/**
	 * Persist the IPC-input read cursor. Called at worker shutdown so a clean
	 * recycle never replays already-consumed commands (the Consumer otherwise
	 * only checkpoints on a periodic cadence; the final <1s would re-deliver).
	 */
	public function checkpoint_ipc_input(): void {
		if ( null !== $this->ipc_input_consumer ) {
			$this->handoff_consumer( $this->ipc_input_consumer );
		}
	}

	/**
	 * Shutdown handoff for one durable consumer. A cooperative stop (timeout/memory)
	 * routes through the fair-shot rule — which strikes/quarantines an in-flight poison
	 * message and clears an innocent one; an operational stop is a clean graceful
	 * checkpoint (attempts=0). For memory, pass whether the fresh baseline was already
	 * near the watermark so a leak isn't blamed on the in-flight message.
	 *
	 * @param Consumer_Node $node The consumer to hand off.
	 */
	private function handoff_consumer( Consumer_Node $node ): void {
		$is_memory = 'memory' === $this->stop_reason;
		if ( 'timeout' === $this->stop_reason || $is_memory ) {
			$node->cooperative_stop( $this->stop_reason, $is_memory && $this->baseline_near_watermark() );
			return;
		}
		$node->checkpoint( true );
	}

	/**
	 * Shutdown handoff for one Remote_Source. Mirrors handoff_consumer: a cooperative stop
	 * (timeout/memory) routes through the fair-shot rule; an operational stop is a clean
	 * graceful checkpoint. For memory, pass whether the fresh baseline was already near the
	 * watermark so a leak isn't blamed on the in-flight message. A Remote_Source is not a
	 * Consumer_Node, which is why it needs a branch rather than the Consumer one.
	 *
	 * @param Remote_Source_Node $node The remote source to hand off.
	 */
	private function handoff_remote_source( Remote_Source_Node $node ): void {
		$is_memory = 'memory' === $this->stop_reason;
		if ( 'timeout' === $this->stop_reason || $is_memory ) {
			$node->cooperative_stop( $this->stop_reason, $is_memory && $this->baseline_near_watermark() );
			return;
		}
		$node->checkpoint_shutdown();
	}

	/**
	 * Memory baseline guard: was the fresh post-reset baseline already near the
	 * watermark? If so a memory stop is a leak / undersized memory_limit, not a single
	 * poison message — the fair-shot rule alerts instead of striking the in-flight
	 * message. An unlimited memory_limit has no watermark to be near, so it answers no.
	 */
	protected function baseline_near_watermark(): bool {
		$limit = $this->memory_limit_bytes();
		if ( $limit <= 0 ) {
			return false;
		}
		return $this->baseline_memory >= (int) ( $limit * self::BASELINE_WATERMARK_PCT );
	}

	/**
	 * Final sweep for every node that opted into Shutdown_Sweeper — the probes'
	 * partial interval since their last tick, which a ~595s recycle would
	 * otherwise drop. Runs before the cursor handoff, while the graph is intact.
	 * One sweeper's failure is logged and skipped: the cursors matter more.
	 */
	private function sweep_shutdown_sweepers(): void {
		foreach ( Core::$nodes_by_name as $node ) {
			if ( ! $node instanceof Shutdown_Sweeper ) {
				continue;
			}
			try {
				$node->shutdown_sweep();
			} catch ( \Throwable $e ) {
				Core::print_less_often( "{$this->worker_type}.p{$this->partition}: shutdown sweep failed: ", $e->getMessage() );
			}
		}
	}

	/**
	 * Whether a PHP fatal (OOM, uncaught error, parse failure) is what is shutting
	 * us down rather than a clean stop. A fatal offers no catch point, so the last
	 * recorded error is the only evidence there is, and reading it here — inside
	 * the shutdown function — is the one moment it still says what happened.
	 *
	 * @return bool True when the run died rather than stopped.
	 */
	protected function is_fatal_shutdown(): bool {
		$probe = self::$last_error ?? static fn (): ?array => \error_get_last();
		$error = $probe();
		if ( ! \is_array( $error ) || ! isset( $error['type'] ) ) {
			return false;
		}
		return \in_array( $error['type'], [ \E_ERROR, \E_PARSE, \E_CORE_ERROR, \E_COMPILE_ERROR, \E_USER_ERROR ], true );
	}

	/**
	 * Take the lifecycle lock and start the runtime, heartbeat and DB-probe clocks.
	 *
	 * A false here is the normal case for a losing spawn, not an error:
	 * `Lock_Node::acquire_failure()` is what separates plain contention from an I/O
	 * refusal, so `execute()` can stay quiet about the first and log the second.
	 *
	 * @return bool True when this process owns the slot.
	 */
	public function acquire(): bool {
		if ( ! \is_dir( "{$this->base_dir}/locks" ) ) {
			// base_dir is operator-configured worker storage, not WP-managed.
			if ( ! Config::write_denied( 'locks dir' ) ) {
				// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
				@\mkdir( "{$this->base_dir}/locks", 0755, true );
			}
		}
		// Lifecycle lock, acquired pre-graph: bare new, no interpreter yet.
		$this->lock = new Lock_Node( $this->held_lock_path(), $this->stale_timeout );
		if ( ! $this->lock->acquire() ) {
			return false;
		}
		$this->start_time     = Core::right_now();
		$this->last_heartbeat = $this->start_time;
		$this->last_db_check  = $this->start_time;
		return true;
	}

	/** The `.lock.d` directory THIS worker holds: `{base}/locks/{type}.p{N}.lock.d`. */
	protected function held_lock_path(): string {
		return "{$this->base_dir}/locks/{$this->worker_type}.p{$this->partition}.lock.d";
	}

	/** How a worker names itself in a stop message. */
	protected function stop_label(): string {
		return "{$this->worker_type}.p{$this->partition}";
	}

}
