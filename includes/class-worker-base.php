<?php
/**
 * Worker Base: zombie-process worker lifecycle.
 *
 * acquire/release/should_continue so workers exit cleanly before OOM, max_runtime, or lock loss.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

if ( ! \defined( 'ABSPATH' ) ) {
	exit;
}

class Worker_Base {

	public const DEFAULT_MAX_RUNTIME    = 595;
	public const MEMORY_WATERMARK_PCT   = 0.80;
	// A fresh post-reset baseline already at/above this fraction of the memory limit is
	// "near the watermark" — a leak / undersized limit, not a single poison message. A
	// memory stop on such a baseline alerts instead of striking the message ([42]).
	public const BASELINE_WATERMARK_PCT = 0.50;
	public const HEARTBEAT_INTERVAL_S   = 10;
	public const DB_CHECK_INTERVAL_S    = 30;
	public const DB_CHECK_MAX_FAILURES  = 3;
	public const LOCK_CHECK_GRACE_S     = 0.25;
	public const IPC_SEGMENT_SIZE       = 1048576;
	public const IPC_NUM_SEGMENTS       = 2;

	// Shared topicprobe log: 1 MiB segments × 2, aged out at 24h — a day of
	// consumer-stats snapshots for the dashboards' rate + backlog graphs. Single
	// fixed partition (.p0); every worker process appends to this one dir, so
	// Log_Cleaner must whitelist it (it's declared by no .tsl).
	public const TOPICPROBE_LOG_DIR      = 'topicprobe.p0';
	public const TOPICPROBE_SEGMENT_SIZE = 1048576;
	public const TOPICPROBE_NUM_SEGMENTS = 2;
	public const TOPICPROBE_MAX_LIFESPAN = 86400;
	public const TOPICPROBE_INTERVAL_S   = 15;

	protected string $base_dir;
	protected string $worker_type;
	protected int $partition;
	protected int $max_runtime;
	protected int $stale_timeout;
	protected ?Lock_Node $lock = null;
	protected float $start_time = 0.0;
	protected float $last_heartbeat = 0.0;
	protected float $last_db_check = 0.0;
	protected int $db_failures = 0;
	protected bool $shutdown_handled = false;
	/** This worker's IPC-input Consumer — checkpointed at shutdown so a clean recycle doesn't replay consumed commands. */
	protected ?Consumer_Node $ipc_input_consumer = null;

	/**
	 * Why the worker stopped, categorized for the shutdown handoff ([42]): 'timeout'
	 * or 'memory' is a cooperative stop that triggers the fair-shot rule on durable
	 * consumers; '' is operational (lock loss / restart / db) — a clean graceful handoff.
	 */
	protected string $stop_reason = '';

	/** Fresh post-reset memory baseline, captured before the drain — the memory-guard reference point. */
	protected int $baseline_memory = 0;

	public function __construct(
		string $base_dir,
		string $worker_type,
		int $partition,
		int $max_runtime = self::DEFAULT_MAX_RUNTIME,
		int $stale_timeout = 60
	) {
		$this->base_dir      = \rtrim( $base_dir, '/' );
		$this->worker_type   = $worker_type;
		$this->partition     = $partition;
		$this->max_runtime   = $max_runtime;
		$this->stale_timeout = $stale_timeout;
	}

	/**
	 * Full lifecycle: acquire → grace → shutdown handler → drain → release + self_respawn.
	 *
	 * Idempotent shutdown via $shutdown_handled (handler + finally) so release+respawn happens once.
	 *
	 * @param callable $topology  Topology closure (signature: ($interpreter, $partition)).
	 * @param string   $spawn_url Spawn endpoint URL for self-respawn.
	 * @param string   $token     Current HMAC spawn token.
	 * @return array{status: string, reason?: string}
	 */
	public function execute( callable $topology, string $spawn_url, string $token ): array {
		if ( ! $this->acquire() ) {
			return [ 'status' => 'skipped', 'reason' => 'lock_held' ];
		}

		\register_shutdown_function( function () use ( $spawn_url, $token ): void {
			if ( ! $this->shutdown_handled ) {
				$this->shutdown_handled = true;
				// Handoff every durable cursor before teardown — graceful on a clean exit, but
				// SKIPPED on a fatal so the crash counter climbs (see shutdown_handoff).
				$this->shutdown_handoff();
				// Tear down nodes first so Partitions release their locks before the next spawn.
				Core::cleanup_all_nodes();
				$this->release();
				$this->self_respawn( $spawn_url, $token );
			}
		} );

		// Brief grace so a concurrent spawn sees we own the lock before retrying.
		\usleep( (int) ( self::LOCK_CHECK_GRACE_S * 1_000_000 ) );

		try {
			$interpreter = $this->build_scaffolding();
			$this->run_topology( $topology, $interpreter );

			// Capture the fresh baseline (Core::initialize reset already ran this execution)
			// before any message processing — the memory-guard reference for the fair-shot rule.
			$this->baseline_memory = \memory_get_usage( true );

			$ef = Event_Framework::instance();
			$ef->install_signal_handlers();
			$ef->drain( fn() => $this->should_continue(), cooperative_stop: true );
		} catch ( Worker_Should_Stop $e ) {
			// pump() said stop from inside a job; normal exit — finally releases + respawns.
			Core::stderr( "{$this->worker_type}.p{$this->partition}: stopped mid-job (pump)" );
		} finally {
			if ( ! $this->shutdown_handled ) {
				$this->shutdown_handled = true;
				$this->shutdown_handoff();
				Core::cleanup_all_nodes();
				$this->release();
				$this->self_respawn( $spawn_url, $token );
			}
		}

		return [ 'status' => 'ok' ];
	}

	public function acquire(): bool {
		if ( ! \is_dir( "{$this->base_dir}/locks" ) ) {
			// base_dir is operator-configured worker storage, not WP-managed.
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
			@\mkdir( "{$this->base_dir}/locks", 0755, true );
		}
		// Process lifecycle lock acquired before the graph exists: bare new (no interpreter in scope).
		$this->lock = new Lock_Node( $this->lock_path(), $this->stale_timeout );
		if ( ! $this->lock->acquire() ) {
			return false;
		}
		$this->start_time     = \microtime( true );
		$this->last_heartbeat = $this->start_time;
		$this->last_db_check  = $this->start_time;
		return true;
	}

	protected function lock_path(): string {
		return "{$this->base_dir}/locks/{$this->worker_type}.p{$this->partition}.lock.d";
	}

	/**
	 * Graceful clean-shutdown handoff for every durable consumer this process owns:
	 * the registered work consumers (Core::$nodes_by_name) plus the anonymous IPC
	 * consumer. A graceful checkpoint stamps attempts=0 at the current cursor, so the
	 * respawn resumes at the virgin baseline rather than counting the clean recycle as
	 * a crash (dead-letter [42]). Only a hard crash skips this path, so only crashes
	 * climb the attempt counter.
	 */
	/**
	 * Shutdown cursor handoff. On a clean stop (cooperative or operational) every durable
	 * consumer is graceful/fair-shot checkpointed. On a FATAL (OOM / uncaught error that
	 * aborted the run before the finally), the handoff is SKIPPED: leaving the boot frame's
	 * climbing attempt count intact is what lets a deterministic fatal-poison reach the
	 * crash-crawl threshold ([42]) instead of resetting to the baseline every lifetime.
	 */
	public function shutdown_handoff(): void {
		if ( $this->is_fatal_shutdown() ) {
			return;
		}
		$this->checkpoint_durable_consumers();
	}

	/** A catchable PHP fatal (OOM, uncaught error) is shutting us down — not a clean stop. */
	protected function is_fatal_shutdown(): bool {
		$error = $this->last_error();
		return null !== $error
			&& \in_array( $error['type'], [ \E_ERROR, \E_PARSE, \E_CORE_ERROR, \E_COMPILE_ERROR, \E_USER_ERROR ], true );
	}

	/**
	 * Seam (tests override): the last PHP error, used to classify a fatal shutdown.
	 *
	 * @return array{type: int, message: string, file: string, line: int}|null
	 */
	protected function last_error(): ?array {
		return \error_get_last();
	}

	public function checkpoint_durable_consumers(): void {
		foreach ( Core::$nodes_by_name as $node ) {
			if ( $node instanceof Consumer_Node ) {
				$this->handoff_consumer( $node );
			}
		}
		$this->checkpoint_ipc_input();
	}

	/**
	 * Shutdown handoff for one durable consumer. A cooperative stop (timeout/memory)
	 * routes through the fair-shot rule — which strikes/quarantines an in-flight poison
	 * message and clears an innocent one; an operational stop is a clean graceful
	 * checkpoint (attempts=0). For memory, pass whether the fresh baseline was already
	 * near the watermark so a leak isn't blamed on the in-flight message ([42]).
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
	 * Memory baseline guard ([42]): was the fresh post-reset baseline already near the
	 * watermark? If so a memory stop is a leak / undersized memory_limit, not a single
	 * poison message — the fair-shot rule alerts instead of striking the in-flight message.
	 */
	protected function baseline_near_watermark(): bool {
		$limit = $this->memory_limit_bytes();
		if ( $limit <= 0 ) {
			return false;
		}
		return $this->baseline_memory >= (int) ( $limit * self::BASELINE_WATERMARK_PCT );
	}

	protected function memory_limit_bytes(): int {
		$ini = \ini_get( 'memory_limit' );
		if ( '-1' === $ini ) {
			return -1;
		}
		$num = (int) $ini;
		switch ( \strtolower( \substr( $ini, -1 ) ) ) {
			case 'g': $num *= 1024 * 1024 * 1024; break;
			case 'm': $num *= 1024 * 1024;        break;
			case 'k': $num *= 1024;               break;
		}
		return $num;
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

	public function release(): void {
		if ( null !== $this->lock ) {
			$this->lock->release();
			$this->lock = null;
		}
	}

	/**
	 * Fire-and-forget spawn POST so another process takes over after we exit.
	 *
	 * Routes through Core::fire_and_forget_post — the same raw-curl path the
	 * Supervisor uses (wp_remote_post's Requests transport floors the timeout at
	 * 1s, defeating the 10ms fire-and-forget contract; the helper guards on the
	 * curl extension itself). Body stays byte-compatible with the spawn endpoint's
	 * {type, partition, nonce} contract so HMAC/nonce validation still passes.
	 *
	 * @param string $spawn_url Fully-qualified spawn URL (rest_url + path).
	 * @param string $token     Current HMAC spawn token.
	 */
	public function self_respawn( string $spawn_url, string $token ): void {
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
	 * Build the standard scaffolding (_router, _command_interpreter, _repl, input Consumer).
	 *
	 * @return Command_Interpreter_Node So topology closures can drive graph construction.
	 */
	public function build_scaffolding(): Command_Interpreter_Node {
		// This worker process is a command VERIFIER: every interpreter it builds — the main
		// _command_interpreter plus the patron interpreters embedded in Partitions — must
		// HMAC-check commands arriving over IPC (which strips the LOCAL taint). Set
		// the process-wide authorization policy once, before any interpreter is constructed.
		Command_Interpreter_Node::$default_authorize = Command_Auth::verifier();

		$ipc_dir = "{$this->base_dir}/ipc/{$this->worker_type}.p{$this->partition}";

		$router = new Router_Node();
		$router->name( Node_Names::ROUTER );
		// Active timer so the Router fires TIMER for the hitchhike pattern (keepalives etc.).
		$router->set_timer( Router_Node::DEFAULT_TICK_MS );

		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( Node_Names::COMMAND_INTERPRETER );
		$interpreter->sink( $router );

		// _repl output Partition: TO=_repl lands on disk; allow_large_writes since dumps exceed PIPE_BUF.
		if ( ! \is_dir( "{$ipc_dir}/output" ) ) {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
			@\mkdir( "{$ipc_dir}/output", 0755, true );
		}
		// Graph assembly with the interpreter in scope: go through make_node (name -> arguments -> sink=interpreter).
		$repl = $interpreter->make_node( 'Partition', Node_Names::REPL, "{$ipc_dir}/output", self::IPC_SEGMENT_SIZE, self::IPC_NUM_SEGMENTS );
		// allow_large_writes keys its Lock/heartbeat off name + sink, both set by make_node.
		if ( $repl instanceof Partition_Node ) {
			$repl->void_warranty();
		}

		$repl_in = $this->build_ipc_input_consumer( $ipc_dir );
		$repl_in->sink( $interpreter );

		$this->mount_topic_probe( $interpreter );

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
	 * @param string $ipc_dir This worker's IPC dir (`{base}/ipc/{type}.p{N}`).
	 */
	public function build_ipc_input_consumer( string $ipc_dir ): Consumer_Node {
		$input_dir = "{$ipc_dir}/input";
		if ( ! \is_dir( $input_dir ) ) {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
			@\mkdir( $input_dir, 0755, true );
		}
		// Intentionally anonymous (pure source, never a routed TO) — stays out of Core's registry.
		$consumer = new Consumer_Node();
		$consumer->arguments( "{$input_dir} {$ipc_dir}/input.offsets" );
		// Seek the tail to skip any stale command history. On respawn, poll_init's
		// load_offsetlog overrides this with the durable checkpoint (resume wins);
		// on a first spawn there's no checkpoint, so the tail seek stands.
		$consumer->next_offset( 'end' );
		$consumer->set_stamp_as( Node_Names::REPL );
		$this->ipc_input_consumer = $consumer;
		return $consumer;
	}

	/**
	 * Mount this worker's TopicProbe + the shared topicprobe log. The probe sweeps
	 * this process's Consumers every TOPICPROBE_INTERVAL_S and routes one snapshot
	 * per tick to the log via target() (rule #2 — flow steered by TO, not a bespoke
	 * sink). The log is shared across every worker process (multi-writer atomic
	 * appends, the firehose pattern); 1 MiB segments × 2, aged out at 24h.
	 *
	 * @param Command_Interpreter_Node $interpreter The graph's interpreter (make_node host).
	 */
	public function mount_topic_probe( Command_Interpreter_Node $interpreter ): void {
		$probe_dir = "{$this->base_dir}/logs/" . self::TOPICPROBE_LOG_DIR;
		if ( ! \is_dir( $probe_dir ) ) {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
			@\mkdir( $probe_dir, 0755, true );
		}
		$interpreter->make_node(
			'Partition',
			Node_Names::TOPICPROBE_LOG,
			"{$probe_dir} " . self::TOPICPROBE_SEGMENT_SIZE
				. ' ' . self::TOPICPROBE_NUM_SEGMENTS
				. ' ' . self::TOPICPROBE_MAX_LIFESPAN
		);
		$probe = $interpreter->make_node( 'TopicProbe', Node_Names::TOPICPROBE, (string) self::TOPICPROBE_INTERVAL_S );
		if ( $probe instanceof TopicProbe_Node ) {
			$probe->target( Node_Names::TOPICPROBE_LOG );
		}
	}

	/** Invoke the topology closure (receives the interpreter + this worker's partition number). */
	public function run_topology( callable $topology, Command_Interpreter_Node $interpreter ): void {
		$topology( $interpreter, $this->partition );
	}

	public function should_continue(): bool {
		$now = \microtime( true );

		if ( null === $this->lock || ! $this->lock->is_held() ) {
			return $this->stop( 'lock lost' );
		}
		if ( ! \is_dir( $this->lock_path() ) ) {
			return $this->stop( 'lock dir gone' );
		}

		// External request_restart() drops a flag into our lock dir; exit so the supervisor respawns.
		if ( $this->lock->should_restart() ) {
			return $this->stop( 'restart requested' );
		}

		if ( ( $now - $this->start_time ) >= $this->max_runtime ) {
			return $this->stop(
				\sprintf( 'max_runtime exceeded (%ds / %ds)', (int) ( $now - $this->start_time ), $this->max_runtime ),
				'timeout'
			);
		}

		if ( $this->memory_over_watermark() ) {
			$used  = \memory_get_usage( true );
			$limit = $this->memory_limit_bytes();
			return $this->stop(
				\sprintf(
					'memory watermark (%dMB / %dMB, %d%%)',
					(int) ( $used / 1048576 ),
					(int) ( $limit / 1048576 ),
					$limit > 0 ? (int) ( $used / $limit * 100 ) : 0
				),
				'memory'
			);
		}

		if ( ( $now - $this->last_heartbeat ) >= self::HEARTBEAT_INTERVAL_S ) {
			$this->lock->heartbeat();
			$this->last_heartbeat = $now;
		}

		if ( ( $now - $this->last_db_check ) >= self::DB_CHECK_INTERVAL_S ) {
			$this->last_db_check = $now;
			if ( ! $this->db_check_passes() ) {
				++$this->db_failures;
				if ( $this->db_failures >= self::DB_CHECK_MAX_FAILURES ) {
					return $this->stop( \sprintf( 'db check failed %d times', $this->db_failures ) );
				}
			} else {
				$this->db_failures = 0;
			}
		}

		return true;
	}

	/**
	 * Log WHY the worker is stopping (the should_continue() branch that tripped),
	 * prefixed with the worker id, then return false. One line per cooperative
	 * stop (should_continue returns true until the first false ends the loop).
	 *
	 * @param string $reason   Human-readable stop reason + metrics.
	 * @param string $category Cooperative-stop category for the shutdown handoff:
	 *                         'timeout' | 'memory' trigger the fair-shot rule; '' is operational.
	 * @return false Always — callers `return $this->stop( ... )`.
	 */
	private function stop( string $reason, string $category = '' ): bool {
		$this->stop_reason = $category;
		Core::stderr( "{$this->worker_type}.p{$this->partition}: stopping — {$reason}" );
		return false;
	}

	protected function memory_over_watermark(): bool {
		$limit = $this->memory_limit_bytes();
		if ( $limit <= 0 ) {
			return false;
		}
		return \memory_get_usage( true ) >= ( $limit * self::MEMORY_WATERMARK_PCT );
	}

	/** Cheap DB liveness probe; default always passes. N consecutive failures trigger shutdown. */
	protected function db_check_passes(): bool {
		return true;
	}
}
