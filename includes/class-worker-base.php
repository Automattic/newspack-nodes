<?php
/**
 * Worker Base
 *
 * Zombie-process worker lifecycle. Provides acquire/release/should_continue
 * so workers exit cleanly before OOM, before max_runtime, or when their lock
 * is taken from them.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

if ( ! \defined( 'ABSPATH' ) ) {
	exit;
}

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
			// base_dir is operator-configured worker storage, not WP-managed.
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
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
		if ( null !== $this->lock ) {
			$this->lock->release();
			$this->lock = null;
		}
	}

	public function should_continue(): bool {
		$now = \microtime( true );

		if ( null === $this->lock || ! $this->lock->is_held() ) {
			return false;
		}
		if ( ! \is_dir( $this->lock_path() ) ) {
			return false;
		}

		// Single restart channel: external request_restart() drops a flag into our
		// lock dir; we exit cleanly so the supervisor respawns a fresh process.
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

	/**
	 * Cheap liveness probe for the WordPress / DB substrate.
	 *
	 * Default returns true (always passes); subclasses or test doubles override.
	 * After DB_CHECK_MAX_FAILURES consecutive false returns at DB_CHECK_INTERVAL_S
	 * cadence, should_continue() returns false to trigger an orderly shutdown.
	 */
	protected function db_check_passes(): bool {
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
		if ( '-1' === $ini || false === $ini ) {
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
	 *   _repl (output Partition).
	 *
	 * Returns the CommandInterpreter so topology closures can drive graph construction.
	 */
	public function build_scaffolding(): CommandInterpreter {
		$ipc_dir = "{$this->base_dir}/ipc/{$this->worker_type}.p{$this->partition}";

		$router = new Router();
		$router->name( '_router' );
		// Router extends Timer and serves as the TIMER event hub for the
		// Router-hitchhike pattern (see Timer::set_timer() with no args).
		// Without an active timer the Router never fires `notify('TIMER',...)`
		// and any node registered via `$router->register('TIMER', $name)`
		// silently stops ticking. DEFAULT_TICK_MS is 5s — fine grain for
		// keepalives like StreamMerger's /firehose/heartbeat POSTs.
		$router->set_timer( Router::DEFAULT_TICK_MS );

		$interpreter = new CommandInterpreter();
		$interpreter->name( '_command_interpreter' );
		$interpreter->sink( $router );

		// _repl: output IPC Partition. Partition::fill auto-packs any non-control
		// message (Message::packed → bytes → segment), so anything routed to
		// TO=_repl lands on disk in the cli's read-side wire format. No wrapper
		// needed. allow_large_writes because dump output regularly exceeds
		// PIPE_BUF.
		if ( ! \is_dir( "{$ipc_dir}/output" ) ) {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
			@\mkdir( "{$ipc_dir}/output", 0755, true );
		}
		$repl = new Partition( "{$ipc_dir}/output", 0 );
		$repl->name( '_repl' );
		$repl->sink( $interpreter );
		// allow_large_writes constructs Lock + heartbeat Timer keyed off
		// `$repl->name` and routed through `$repl->sink`, so name() and
		// sink() must be set first.
		$repl->allow_large_writes();

		// IPC input Consumer (unnamed — spec line 636). Reads packed messages
		// from the cli's command Partition, auto-unpacks, stamps `_repl` onto
		// FROM (path-prepend, preserving the cli's $pid trail), forwards to
		// _command_interpreter. Replies route via TO=_repl/_output/$pid
		// → worker's _router peels `_repl` → `_repl` Partition (above) writes
		// to disk → cli reads.
		//
		// Cli commands are ephemeral — running them on worker (re)start would
		// replay every historical command (e.g. one `ping` triggers a fresh
		// reply on every worker respawn). Skip the offsetlog and tail-seek so
		// each fresh worker process starts handling commands from now-forward.
		$input_dir = "{$ipc_dir}/input";
		if ( ! \is_dir( $input_dir ) ) {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
			@\mkdir( $input_dir, 0755, true );
		}
		$repl_in = new Consumer( $input_dir, 0, '' );
		$repl_in->next_offset( 'end' );
		$repl_in->set_stamp_as( '_repl' );
		$repl_in->sink( $interpreter );

		return $interpreter;
	}

	/**
	 * Invoke the topology closure to wire up worker-specific nodes.
	 *
	 * Closure receives the CommandInterpreter (drives `make_node`/`connect_node`
	 * via shell vocabulary) and this worker's partition number.
	 */
	public function run_topology( callable $topology, CommandInterpreter $ci ): void {
		$topology( $ci, $this->partition );
	}

	/**
	 * Fire-and-forget POST to the spawn endpoint to ask another zombie process
	 * to take over the worker after we exit. Non-blocking; ignore failures.
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
	 * Full lifecycle wrapper: acquire → grace sleep → register shutdown handler
	 * → run topology in drain loop → release lock + self_respawn.
	 *
	 * Idempotent shutdown: both the registered shutdown handler and the finally
	 * block flip $shutdown_handled, so release+respawn happens exactly once
	 * regardless of normal exit, exception, or fatal error.
	 *
	 * @param callable $topology  Topology closure (signature: ($ci, $partition)).
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
				// Tear down nodes first so each Partition releases its
				// write_lock + heartbeat. Otherwise the next spawn races
				// the stale-timeout window (60s) waiting for our heartbeat
				// to age out — manifests as RuntimeException on
				// allow_large_writes() in the new worker's build_scaffolding.
				Core::cleanup_all_nodes();
				$this->release();
				$this->self_respawn( $spawn_url, $token );
			}
		} );

		// Brief grace so any concurrent spawn racing for the same lock can see we
		// own it before they retry — matches event-logger WorkerBase pattern.
		\usleep( (int) ( self::LOCK_CHECK_GRACE_S * 1_000_000 ) );

		try {
			$ci = $this->build_scaffolding();
			$this->run_topology( $topology, $ci );

			$ef = EventFramework::instance();
			$ef->install_signal_handlers();
			$ef->drain( fn() => $this->should_continue() );
		} finally {
			if ( ! $this->shutdown_handled ) {
				$this->shutdown_handled = true;
				Core::cleanup_all_nodes();
				$this->release();
				$this->self_respawn( $spawn_url, $token );
			}
		}

		return [ 'status' => 'ok' ];
	}
}
