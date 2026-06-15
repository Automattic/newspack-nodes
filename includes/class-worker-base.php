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
	public const HEARTBEAT_INTERVAL_S   = 10;
	public const DB_CHECK_INTERVAL_S    = 30;
	public const DB_CHECK_MAX_FAILURES  = 3;
	public const LOCK_CHECK_GRACE_S     = 0.25;
	public const IPC_SEGMENT_SIZE       = 1048576;
	public const IPC_NUM_SEGMENTS       = 2;

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
				// Persist the IPC-input cursor before teardown so a clean recycle doesn't replay consumed commands.
				$this->checkpoint_ipc_input();
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

			$ef = Event_Framework::instance();
			$ef->install_signal_handlers();
			$ef->drain( fn() => $this->should_continue() );
		} finally {
			if ( ! $this->shutdown_handled ) {
				$this->shutdown_handled = true;
				$this->checkpoint_ipc_input();
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
	 * Persist the IPC-input read cursor. Called at worker shutdown so a clean
	 * recycle never replays already-consumed commands (the Consumer otherwise
	 * only checkpoints on a periodic cadence; the final <1s would re-deliver).
	 */
	public function checkpoint_ipc_input(): void {
		$this->ipc_input_consumer?->checkpoint();
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
	 * @param string $spawn_url Fully-qualified spawn URL (rest_url + path).
	 * @param string $token     Current HMAC spawn token.
	 */
	public function self_respawn( string $spawn_url, string $token ): void {
		if ( ! \function_exists( 'wp_remote_post' ) ) {
			return;
		}
		$args = [
			'method'   => 'POST',
			'timeout'  => 1, // fire-and-forget
			'blocking' => false,
			'body'     => [
				'type'      => $this->worker_type,
				'partition' => $this->partition,
				'nonce'     => $token,
			],
		];
		@\wp_remote_post( $spawn_url, $args );
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

	/** Invoke the topology closure (receives the interpreter + this worker's partition number). */
	public function run_topology( callable $topology, Command_Interpreter_Node $interpreter ): void {
		$topology( $interpreter, $this->partition );
	}

	public function should_continue(): bool {
		$now = \microtime( true );

		if ( null === $this->lock || ! $this->lock->is_held() ) {
			return false;
		}
		if ( ! \is_dir( $this->lock_path() ) ) {
			return false;
		}

		// External request_restart() drops a flag into our lock dir; exit so the supervisor respawns.
		if ( $this->lock->should_restart() ) {
			return false;
		}

		if ( ( $now - $this->start_time ) >= $this->max_runtime ) {
			return false;
		}

		if ( $this->memory_over_watermark() ) {
			return false;
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
					return false;
				}
			} else {
				$this->db_failures = 0;
			}
		}

		return true;
	}

	protected function memory_over_watermark(): bool {
		$limit = $this->memory_limit_bytes();
		if ( $limit <= 0 ) {
			return false;
		}
		return \memory_get_usage( true ) >= ( $limit * self::MEMORY_WATERMARK_PCT );
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

	/** Cheap DB liveness probe; default always passes. N consecutive failures trigger shutdown. */
	protected function db_check_passes(): bool {
		return true;
	}
}
