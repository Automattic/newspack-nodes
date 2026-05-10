<?php
/**
 * Supervisor
 *
 * Long-running tick loop with HMAC spawn token + spawn rate limit.
 * Singleton via supervisor.lock.d so concurrent ticks don't double-spawn.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

if ( ! \defined( 'ABSPATH' ) ) {
	exit;
}

class Supervisor extends SupervisorBase {
	/**
	 * HMAC spawn-token rotation window (seconds). Spawn endpoint accepts the
	 * current and previous window for race tolerance. Spec line 848.
	 */
	public const TOKEN_WINDOW_S = 10;

	/**
	 * Maximum supervisor runtime (seconds). 10 minutes minus 5s margin.
	 * Sized for Atomic's ~15-minute cap. Self-respawn at the end keeps the
	 * chain alive; cron is the cold-start backstop. Spec line 605, 92 in event-logger.
	 */
	public const MAX_SUPERVISOR_RUNTIME_S = 595;

	/**
	 * Re-check config (rebuild worker_locks, cleanup_stale_partitions) every
	 * N seconds. Plugin (de)activation latency = this value (spec line 843).
	 */
	public const CONFIG_CHECK_INTERVAL = 15;

	/**
	 * Stale timeout for the supervisor's own lock. Conservative — supervisor
	 * pings heartbeat well within Lock::STALE_TIMEOUT (60s) on every 1s tick.
	 */
	public const SUPERVISOR_STALE_TIMEOUT = 60;

	/** @var string */
	private string $nonce_salt;

	/** @var Lock|null Supervisor's own lock; singleton-globally per host. */
	private ?Lock $own_lock = null;

	/** @var float Start of run(); for max-runtime checks. */
	private float $start_time = 0.0;

	/** @var float Timestamp of last heartbeat touch. */
	private float $last_heartbeat = 0.0;

	/** @var float Timestamp of last config check. */
	private float $last_config_check = 0.0;

	/** @var int|null Cached num_partitions clamped to MAX_PARTITIONS. */
	private ?int $num_partitions = null;

	/** @var array<int,array> Worker descriptors built from expand_workers(). */
	private array $worker_locks = [];

	public function __construct( string $base_dir, string $nonce_salt ) {
		parent::__construct( $base_dir );
		$this->nonce_salt = $nonce_salt;
	}

	/**
	 * HMAC spawn-token, rotates every 10s. Sha256 over
	 * 'newspack_nodes_spawn:{$window}' keyed by NONCE_SALT. Per-site, never
	 * logged. Spec line 848.
	 */
	public function generate_spawn_token( int $now ): string {
		$window = (int) \floor( $now / self::TOKEN_WINDOW_S );
		return \hash_hmac( 'sha256', "newspack_nodes_spawn:{$window}", $this->nonce_salt );
	}

	/**
	 * Validate token: accepts current and previous 10s window. Race tolerance
	 * for tokens generated near a window boundary. Don't tighten to a single
	 * window — supervisor and worker may straddle a tick. Spec line 848.
	 */
	public function validate_spawn_token( string $token, int $now ): bool {
		$window   = (int) \floor( $now / self::TOKEN_WINDOW_S );
		$current  = \hash_hmac( 'sha256', "newspack_nodes_spawn:{$window}", $this->nonce_salt );
		$previous = \hash_hmac( 'sha256', "newspack_nodes_spawn:" . ( $window - 1 ), $this->nonce_salt );
		return \hash_equals( $current, $token ) || \hash_equals( $previous, $token );
	}

	/**
	 * Long-running tick loop. ~595s; ticks every 1s; check_config every 15s;
	 * self-respawns via spawn endpoint at the end.
	 *
	 * Two exit reasons:
	 *   - max_runtime exceeded (normal): self-respawn via spawn endpoint.
	 *   - check_config returned false (logging disabled, or another supervisor
	 *     stole our lock): release + return without respawn.
	 */
	public function run(): void {
		$this->start_time = \microtime( true );

		// Tag this process as a supervisor worker for stats exclusion / log
		// correlation. Mirrors event-logger line 402.
		$_SERVER['NEWSPACK_NODES_WORKER_TYPE']      = 'supervisor';
		$_SERVER['NEWSPACK_NODES_WORKER_PARTITION'] = '0';

		// First config check — exit early if logging disabled or another
		// supervisor is mid-tick.
		if ( ! $this->check_config( $this->start_time ) ) {
			return;
		}

		// Acquire our own lock — singleton globally. If another supervisor
		// is already running this host, defer to it.
		$lock_dir = "{$this->base_dir}/locks/supervisor.lock.d";
		if ( ! \is_dir( "{$this->base_dir}/locks" ) ) {
			@\mkdir( "{$this->base_dir}/locks", 0755, true );
		}
		$this->own_lock = new Lock( $lock_dir, self::SUPERVISOR_STALE_TIMEOUT );
		if ( ! $this->own_lock->acquire() ) {
			return;
		}
		$this->last_heartbeat = $this->start_time;

		// Disable execution timeout post-lock-acquire so a slow PHP-FPM
		// timeout doesn't kill the supervisor mid-tick.
		@\set_time_limit( 0 );

		try {
			$this->tick_loop();
		} finally {
			$this->own_lock->release();
			$this->own_lock = null;
			$this->spawn_next_supervisor();
		}
	}

	/**
	 * The actual 595s tick loop. Extracted for testability and cleaner
	 * try/finally semantics.
	 */
	private function tick_loop(): void {
		$last_token_window = -1;
		$token             = '';
		$spawn_url         = \rest_url( 'newspack-nodes/v1/workers/spawn' );

		while ( true ) {
			$now = \microtime( true );

			// Exit if max runtime reached.
			if ( ( $now - $this->start_time ) >= self::MAX_SUPERVISOR_RUNTIME_S ) {
				break;
			}

			// Heartbeat every 10s.
			if ( ( $now - $this->last_heartbeat ) >= self::SUPERVISOR_STALE_TIMEOUT / 6 ) {
				$this->own_lock->heartbeat();
				$this->last_heartbeat = $now;
			}

			// Bail if our lock was taken from us (PID-content theft) or restart requested.
			if ( $this->own_lock->should_restart() ) {
				break;
			}

			// Refresh HMAC token every 10s window boundary.
			$current_window = (int) \floor( $now / self::TOKEN_WINDOW_S );
			if ( $current_window !== $last_token_window ) {
				$token             = $this->generate_spawn_token( (int) $now );
				$last_token_window = $current_window;
			}

			// Re-check config every 15s; if false, exit (logging disabled).
			if ( ( $now - $this->last_config_check ) >= self::CONFIG_CHECK_INTERVAL ) {
				if ( ! $this->check_config( $now ) ) {
					break;
				}
				// Lightweight periodic hook for plugins.
				if ( \function_exists( 'do_action' ) ) {
					\do_action( 'newspack_nodes/supervisor_periodic' );
				}
			}

			// Iterate registered workers; spawn any that need it.
			foreach ( $this->worker_locks as $worker ) {
				if ( ! $this->worker_needs_spawn( $worker, $now ) ) {
					continue;
				}
				if ( $this->is_recently_spawned( $worker['type'], $worker['partition'], $now ) ) {
					continue;
				}
				$this->post_spawn( $spawn_url, $worker['type'], $worker['partition'], $token );
				$this->record_spawn( $worker['type'], $worker['partition'], $now );
			}

			\sleep( 1 );
		}
	}

	/**
	 * Reload config + rebuild worker_locks from current filter values.
	 *
	 * Returns false if the supervisor should exit (e.g., logging disabled).
	 * Otherwise returns true and updates internal state.
	 */
	public function check_config( float $now ): bool {
		$this->last_config_check = $now;

		// Honor the enable_logging gate. Bootstrap is the source of truth.
		if ( ! Bootstrap::is_logging_enabled() ) {
			return false;
		}

		// Rebuild worker_locks from current topology + standalone-worker filters.
		// Filter iteration is cheap; no marker file or restart dance needed.
		// Spec line 590.
		$workers = Bootstrap::expand_workers();

		// Determine effective num_partitions (max across topologies, clamped).
		$max_partitions = 1;
		foreach ( $workers as $w ) {
			if ( $w['partition'] + 1 > $max_partitions ) {
				$max_partitions = $w['partition'] + 1;
			}
		}
		$this->num_partitions = \min( self::MAX_PARTITIONS, \max( 1, $max_partitions ) );

		$this->worker_locks = $workers;

		// Clean up stale partition directories beyond the current num_partitions.
		$this->cleanup_stale_partitions();

		return true;
	}

	/**
	 * Walk [num_partitions, MAX_PARTITIONS) partition lock dirs; remove any
	 * whose newest mtime is older than STALE_PARTITION_AGE_S (1h). Bounded
	 * loop — MAX_PARTITIONS=16, so worst case 16-num_partitions iterations
	 * per topology type.
	 *
	 * Spec line 844: "cleanup_stale_partitions walks num_partitions..MAX_PARTITIONS
	 * to GC retired partition dirs."
	 */
	public function cleanup_stale_partitions(): void {
		if ( null === $this->num_partitions ) {
			return;
		}

		// Collect distinct types from worker_locks for cleanup scope.
		$types = [];
		foreach ( $this->worker_locks as $w ) {
			$types[ $w['type'] ] = true;
		}

		$locks_dir = "{$this->base_dir}/locks";
		foreach ( \array_keys( $types ) as $type ) {
			for ( $p = $this->num_partitions; $p < self::MAX_PARTITIONS; $p++ ) {
				$lock_dir = "{$locks_dir}/{$type}.p{$p}.lock.d";
				$this->remove_stale_directory( $lock_dir, self::STALE_PARTITION_AGE_S );
			}
		}
	}

	/**
	 * Force-release locks for a list of reader/worker groups. Plugins call
	 * this on deactivation to stop their workers immediately. Supervisor's
	 * next check_config() tick rebuilds worker_locks from filters and the
	 * forced-released locks naturally drop off the spawn list.
	 *
	 * Reading num_partitions from the current topology filter (clamped to
	 * MAX_PARTITIONS) so we cover all currently-known partitions.
	 *
	 * @param string[] $groups Group names to kill.
	 */
	public function kill_readers( array $groups ): void {
		$workers = Bootstrap::expand_workers();
		// Build a per-type partition count from current topology.
		$counts = [];
		foreach ( $workers as $w ) {
			$counts[ $w['type'] ] = \max( $counts[ $w['type'] ] ?? 0, $w['partition'] + 1 );
		}

		$locks_dir = "{$this->base_dir}/locks";
		foreach ( $groups as $name ) {
			// If the type is no longer in topology, fall back to MAX_PARTITIONS
			// to be sure we clear any orphaned locks.
			$count = $counts[ $name ] ?? self::MAX_PARTITIONS;
			$count = \min( self::MAX_PARTITIONS, \max( 1, $count ) );
			for ( $p = 0; $p < $count; $p++ ) {
				$lock_path = "{$locks_dir}/{$name}.p{$p}.lock.d";
				if ( \is_dir( $lock_path ) ) {
					// Use the unified restart channel: drops a `restart` file
					// inside the lock dir; the worker exits on its next 250ms
					// poll. Cleaner than force_release (which the worker reads
					// as a stolen lock and may double-respawn). Spec line 832.
					Lock::request_restart_at( $lock_path );
				}
			}
		}
	}

	/**
	 * Fire-and-forget spawn POST. Errors are logged but not retried; the
	 * 1s-tick + 15s rate limit + cron backstop together guarantee eventual
	 * spawn even if individual POSTs fail.
	 */
	private function post_spawn( string $spawn_url, string $type, int $partition, string $token ): void {
		if ( ! \function_exists( 'wp_remote_post' ) ) {
			return;
		}
		$args = [
			'method'    => 'POST',
			'timeout'   => 0.01,
			'blocking'  => false,
			'sslverify' => false,
			'body'      => [
				'type'      => $type,
				'partition' => $partition,
				'nonce'     => $token,
			],
		];
		$response = \wp_remote_post( $spawn_url, $args );
		if ( \function_exists( 'is_wp_error' ) && \is_wp_error( $response ) ) {
			// phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
			\error_log( 'Newspack_Nodes\\Supervisor: spawn failed for ' . $type . '|' . $partition . ': ' . $response->get_error_message() );
		}
	}

	/**
	 * Spawn the next supervisor instance via the spawn endpoint. Fire-and-
	 * forget; WP-Cron is the backstop if this fails.
	 */
	private function spawn_next_supervisor(): void {
		if ( ! \function_exists( 'wp_remote_post' ) ) {
			return;
		}
		$args = [
			'method'    => 'POST',
			'timeout'   => 0.01,
			'blocking'  => false,
			'sslverify' => false,
			'body'      => [
				'type'      => 'supervisor',
				'partition' => 0,
				'nonce'     => $this->generate_spawn_token( \time() ),
			],
		];
		$response = \wp_remote_post( \rest_url( 'newspack-nodes/v1/workers/spawn' ), $args );
		if ( \function_exists( 'is_wp_error' ) && \is_wp_error( $response ) ) {
			// phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
			\error_log( 'Newspack_Nodes\\Supervisor: spawn_next_supervisor failed: ' . $response->get_error_message() );
		}
	}

	/**
	 * Test hook: drive a single tick without entering the sleep loop. Used
	 * by SupervisorTest to verify per-tick behavior (config rebuild, spawn
	 * iteration, rate-limit) without a real subprocess. Not part of the
	 * production path.
	 *
	 * @param float $now Simulated clock for this tick.
	 * @return bool True if the loop would continue, false if it would exit.
	 */
	public function tick_for_test( float $now, string $token ): bool {
		// Refresh config if window elapsed.
		if ( ( $now - $this->last_config_check ) >= self::CONFIG_CHECK_INTERVAL ) {
			if ( ! $this->check_config( $now ) ) {
				return false;
			}
		}

		$spawn_url = \rest_url( 'newspack-nodes/v1/workers/spawn' );
		foreach ( $this->worker_locks as $worker ) {
			if ( ! $this->worker_needs_spawn( $worker, $now ) ) {
				continue;
			}
			if ( $this->is_recently_spawned( $worker['type'], $worker['partition'], $now ) ) {
				continue;
			}
			$this->post_spawn( $spawn_url, $worker['type'], $worker['partition'], $token );
			$this->record_spawn( $worker['type'], $worker['partition'], $now );
		}

		// Bail-on-stolen-lock check, mirroring run loop.
		if ( null !== $this->own_lock && $this->own_lock->should_restart() ) {
			return false;
		}
		return true;
	}

	/**
	 * Test hook: install the supervisor's own lock without entering the run
	 * loop. Lets contention tests verify "another supervisor is running" without
	 * forking.
	 */
	public function init_lock_for_test(): bool {
		if ( ! \is_dir( "{$this->base_dir}/locks" ) ) {
			@\mkdir( "{$this->base_dir}/locks", 0755, true );
		}
		$this->own_lock = new Lock( "{$this->base_dir}/locks/supervisor.lock.d", self::SUPERVISOR_STALE_TIMEOUT );
		return $this->own_lock->acquire();
	}

	/** Test hook: release the lock from init_lock_for_test. */
	public function release_lock_for_test(): void {
		if ( null !== $this->own_lock ) {
			$this->own_lock->release();
			$this->own_lock = null;
		}
	}

	/** Test hook: expose worker_locks for assertions after check_config(). */
	public function worker_locks_for_test(): array {
		return $this->worker_locks;
	}

	/** Test hook: return the cached, clamped num_partitions value. */
	public function num_partitions_for_test(): ?int {
		return $this->num_partitions;
	}
}
