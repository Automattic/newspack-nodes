<?php
/**
 * WorkerBase: zombie-process worker lifecycle.
 *
 * Lift-adapted from event-logger's class-worker-base.php. Adaptations:
 *  - $base_dir injected (no Config dependency).
 *  - Spawn URL injected (deferred to later tasks; no hardcoded REST route).
 *  - Env var: NEWSPACK_NODES_WORKER_TYPE.
 *
 * Provides acquire/release/should_continue lifecycle so workers exit cleanly
 * before OOM, before max_runtime, or when their lock is taken from them.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class WorkerBase {
	public const DEFAULT_MAX_RUNTIME    = 595;
	public const MEMORY_WATERMARK_PCT   = 0.80;
	public const HEARTBEAT_INTERVAL_S   = 10;
	public const DB_CHECK_INTERVAL_S    = 30;
	public const DB_CHECK_MAX_FAILURES  = 3;
	public const LOCK_CHECK_GRACE_S     = 0.25;

	protected string $base_dir;
	protected string $worker_type;
	protected int $partition;
	protected int $max_runtime;
	protected int $stale_timeout;
	protected ?Lock $lock = null;
	protected float $start_time = 0.0;
	protected float $last_heartbeat = 0.0;
	protected float $last_db_check = 0.0;
	protected int $db_failures = 0;
	protected bool $shutdown_handled = false;

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

	protected function lock_path(): string {
		return "{$this->base_dir}/locks/{$this->worker_type}.p{$this->partition}.lock.d";
	}

	public function acquire(): bool {
		if ( ! \is_dir( "{$this->base_dir}/locks" ) ) {
			@\mkdir( "{$this->base_dir}/locks", 0755, true );
		}
		$this->lock = new Lock( $this->lock_path(), $this->stale_timeout );
		if ( ! $this->lock->acquire() ) {
			return false;
		}
		$this->start_time     = \microtime( true );
		$this->last_heartbeat = $this->start_time;
		$this->last_db_check  = $this->start_time;
		return true;
	}

	public function release(): void {
		if ( $this->lock !== null ) {
			$this->lock->release();
			$this->lock = null;
		}
	}

	public function should_continue(): bool {
		$now = \microtime( true );

		if ( $this->lock === null || ! $this->lock->is_held() ) {
			return false;
		}
		if ( ! \is_dir( $this->lock_path() ) ) {
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
		if ( $ini === '-1' || $ini === false ) {
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
	 * Build the standard scaffolding nodes every worker process needs:
	 *   _router, _command_interpreter (sinks into _router),
	 *   _responder (sinks into _router), _repl (output Partition).
	 *
	 * Returns the CommandInterpreter so topology closures can drive graph construction.
	 */
	public function build_scaffolding(): CommandInterpreter {
		$ipc_dir = "{$this->base_dir}/ipc/{$this->worker_type}.p{$this->partition}";

		$router = new Router();
		$router->name( '_router' );

		$interpreter = new CommandInterpreter();
		$interpreter->name( '_command_interpreter' );
		$interpreter->sink( $router );

		$responder = new Responder();
		$responder->name( '_responder' );
		$responder->sink( $router );

		// _repl: output IPC partition. Addressable by name; replies route here via TO=_repl.
		if ( ! \is_dir( "{$ipc_dir}/output" ) ) {
			@\mkdir( "{$ipc_dir}/output", 0755, true );
		}
		$repl_out = new Partition( "{$ipc_dir}/output", 0 );
		$repl_out->allow_large_writes(); // dump output frequently exceeds PIPE_BUF
		$repl_out->name( '_repl' );

		return $interpreter;
	}
}
