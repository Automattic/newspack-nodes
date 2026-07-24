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
	/**
	 * A fresh post-reset baseline already at/above this fraction of the memory limit is
	 * "near the watermark" — a leak / undersized limit, not a single poison message. A
	 * memory stop on such a baseline alerts instead of striking the message ([42]).
	 */
	public const BASELINE_WATERMARK_PCT = 0.50;
	public const DB_CHECK_INTERVAL_S    = 30;
	public const DB_CHECK_MAX_FAILURES  = 3;

	public const DEFAULT_MAX_RUNTIME    = 595;
	public const HEARTBEAT_INTERVAL_S   = 10;
	public const IPC_LIFETIME           = 0;
	public const IPC_MAX_SEGMENTS       = 4;
	public const IPC_MIN_LIFETIME       = 0;
	public const IPC_MIN_SEGMENTS       = 2;
	public const IPC_NUM_SEGMENTS       = 2;
	public const IPC_SEGMENT_SIZE       = 1048576;
	public const LOCK_CHECK_GRACE_S     = 0.25;
	public const MEMORY_WATERMARK_PCT   = 0.80;

	/**
	 * DB-liveness seam. Lazily-defaulted to `$wpdb->check_connection( false )`
	 * (duck-typed; passes when no $wpdb is loaded). Tests reassign to drive
	 * consecutive failures without a real dead connection.
	 * Signature: `function (): bool`.
	 *
	 * @var \Closure|null
	 */
	public static ?\Closure $db_probe = null;

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

	protected string $base_dir;

	/** Fresh post-reset memory baseline, captured before the drain — the memory-guard reference point. */
	protected int $baseline_memory = 0;
	protected int $db_failures = 0;
	/** This worker's IPC-input Consumer — checkpointed at shutdown so a clean recycle doesn't replay consumed commands. */
	protected ?Consumer_Node $ipc_input_consumer = null;
	protected float $last_db_check = 0.0;
	protected float $last_heartbeat = 0.0;
	protected ?Lock_Node $lock = null;
	protected int $max_runtime;
	protected int $partition;
	protected bool $shutdown_handled = false;
	protected int $stale_timeout;
	protected float $start_time = 0.0;

	/**
	 * Why the worker stopped, categorized for the shutdown handoff ([42]): 'timeout'
	 * or 'memory' is a cooperative stop that triggers the fair-shot rule on durable
	 * consumers; '' is operational (lock loss / restart / db) — a clean graceful handoff.
	 */
	protected string $stop_reason = '';
	protected string $worker_type;

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
	 * @return array{status: string, reason?: string, error?: string}
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
				$this->self_respawn( $spawn_url, $token );
			}
		} );

		// Brief grace so a concurrent spawn sees we hold the lock before retry.
		\usleep( (int) ( self::LOCK_CHECK_GRACE_S * 1_000_000 ) );

		try {
			$interpreter = $this->build_scaffolding();
			try {
				$this->run_topology( $topology, $interpreter );
			} catch ( Worker_Should_Stop $e ) {
				throw $e;
			} catch ( \RuntimeException $e ) {
				// @longform A malformed .tsl fails loud but CLEAN: one line,
				// lock freed, NO self-respawn (a hot loop on the same bad
				// file); the supervisor retries on its own throttled tick.
				Core::stderr( "{$this->worker_type}.p{$this->partition}: topology load failed: " . $e->getMessage() );
				$this->shutdown_handled = true;
				Core::cleanup_all_nodes();
				$this->release();
				return [
					'status' => 'load_failed',
					'error'  => $e->getMessage(),
				];
			}

			// Fresh baseline pre-processing — memory-guard for fair-shot.
			$this->baseline_memory = \memory_get_usage( true );

			$ef = Event_Framework::instance();
			$ef->install_signal_handlers();
			$ef->drain( fn() => $this->should_continue(), cooperative_stop: true );
		} catch ( Worker_Should_Stop $e ) {
			// pump() stopped mid-job; normal exit, finally releases/respawns.
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
		// Lifecycle lock, acquired pre-graph: bare new, no interpreter yet.
		$this->lock = new Lock_Node( $this->lock_path(), $this->stale_timeout );
		if ( ! $this->lock->acquire() ) {
			return false;
		}
		$this->start_time     = Core::right_now();
		$this->last_heartbeat = $this->start_time;
		$this->last_db_check  = $this->start_time;
		return true;
	}

	protected function lock_path(): string {
		return "{$this->base_dir}/locks/{$this->worker_type}.p{$this->partition}.lock.d";
	}

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
		$probe = self::$last_error ?? static fn (): ?array => \error_get_last();
		$error = $probe();
		if ( ! \is_array( $error ) || ! isset( $error['type'] ) ) {
			return false;
		}
		return \in_array( $error['type'], [ \E_ERROR, \E_PARSE, \E_CORE_ERROR, \E_COMPILE_ERROR, \E_USER_ERROR ], true );
	}

	/**
	 * Graceful clean-shutdown handoff for every durable consumer this process owns:
	 * the registered work consumers (Core::$nodes_by_name) plus the anonymous IPC
	 * consumer. A graceful checkpoint stamps attempts=0 at the current cursor, so the
	 * respawn resumes at the virgin baseline rather than counting the clean recycle as
	 * a crash (dead-letter [42]). Only a hard crash skips this path, so only crashes
	 * climb the attempt counter.
	 */
	public function checkpoint_durable_consumers(): void {
		foreach ( Core::$nodes_by_name as $node ) {
			if ( $node instanceof Consumer_Node ) {
				$this->handoff_consumer( $node );
			} elseif ( $node instanceof Remote_Source_Node ) {
				// Durable cursor: coop stop → fair-shot, else graceful.
				$this->handoff_remote_source( $node );
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
	 * Shutdown handoff for one Remote_Source. Mirrors handoff_consumer: a cooperative stop
	 * (timeout/memory) routes through the fair-shot rule; an operational stop is a clean
	 * graceful checkpoint. For memory, pass whether the fresh baseline was already near the
	 * watermark so a leak isn't blamed on the in-flight message ([42]).
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
	 * Build the standard scaffolding (_router, _command_interpreter, _repl, input Consumer).
	 *
	 * @return Command_Interpreter_Node So topology closures can drive graph construction.
	 */
	public function build_scaffolding(): Command_Interpreter_Node {
		// Worker = command VERIFIER: set the process-wide HMAC authorize once.
		Command_Interpreter_Node::$default_authorize = Command_Auth::verifier();

		$ipc_dir = "{$this->base_dir}/ipc/{$this->worker_type}.p{$this->partition}";

		$router = new Router_Node();
		$router->name( Node_Names::ROUTER );
		// Active timer so the Router fires TIMER for the hitchhike pattern.
		$router->set_timer( Router_Node::DEFAULT_TICK_MS );

		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( Node_Names::COMMAND_INTERPRETER );
		$interpreter->sink( $router );

		// _repl output Partition: allow_large_writes (dumps exceed PIPE_BUF).
		if ( ! \is_dir( "{$ipc_dir}/output" ) ) {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
			@\mkdir( "{$ipc_dir}/output", 0755, true );
		}
		// Graph via make_node (name -> arguments -> sink=interpreter).
		$repl = $interpreter->make_node( 'Partition', Node_Names::REPL, ...self::ipc_partition_args( "{$ipc_dir}/output" ) );
		// allow_large_writes keys Lock/heartbeat off name+sink from make_node.
		if ( $repl instanceof Partition_Node ) {
			$repl->void_warranty();
		}

		$repl_in = $this->build_ipc_input_consumer( $ipc_dir );
		$repl_in->sink( $interpreter );

		return $interpreter;
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
			self::IPC_MIN_LIFETIME,
			self::IPC_LIFETIME,
			self::IPC_MAX_SEGMENTS,
		] );
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
		// Anonymous pure source (never a routed TO); off Core's registry.
		$consumer = new Consumer_Node();
		$consumer->arguments( [ $input_dir, "{$ipc_dir}/input.offsets" ] );
		// Tail-seek skips stale history; a respawn's checkpoint overrides it.
		$consumer->next_offset( 'end' );
		$consumer->set_stamp_as( Node_Names::REPL );
		$this->ipc_input_consumer = $consumer;
		return $consumer;
	}

	/** Invoke the topology closure (receives the interpreter + this worker's partition number). */
	public function run_topology( callable $topology, Command_Interpreter_Node $interpreter ): void {
		$topology( $interpreter, $this->partition );
	}

	public function should_continue(): bool {
		// Under pump(), Core::$now is frozen mid-job: one fresh read, reused.
		$now = Core::right_now();

		if ( null === $this->lock || ! $this->lock->is_held() ) {
			return $this->stop( 'lock lost' );
		}
		if ( ! \is_dir( $this->lock_path() ) ) {
			return $this->stop( 'lock dir gone' );
		}

		// request_restart() flags our lock dir; exit so supervisor respawns.
		if ( $this->lock->should_restart() ) {
			return $this->stop( 'restart requested' );
		}

		if ( ( $now - $this->start_time ) >= $this->max_runtime ) {
			return $this->stop( '', 'timeout' );
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
		if ( '' !== $reason ) {
			Core::stderr( "{$this->worker_type}.p{$this->partition}: stopping — {$reason}" );
		}
		return false;
	}

	protected function memory_over_watermark(): bool {
		$limit = $this->memory_limit_bytes();
		if ( $limit <= 0 ) {
			return false;
		}
		return \memory_get_usage( true ) >= ( $limit * self::MEMORY_WATERMARK_PCT );
	}

	/** DB liveness probe (via the $db_probe seam); N consecutive failures trigger shutdown. */
	protected function db_check_passes(): bool {
		$probe = self::$db_probe ?? static function (): bool {
			global $wpdb;
			if ( ! \is_object( $wpdb ) || ! \method_exists( $wpdb, 'check_connection' ) ) {
				return true;
			}
			// allow_bail=false: report, don't wp_die inside the drain.
			return (bool) $wpdb->check_connection( false );
		};
		return (bool) $probe();
	}
}
