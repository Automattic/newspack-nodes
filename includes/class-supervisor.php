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
	 * Seconds to defer first spawn for a topology type that just appeared in
	 * the active set. Gives any still-exiting predecessor (released by the
	 * same check_config tick) time to flush its offsetlog before a fresh
	 * worker grabs the same source.
	 */
	public const NEW_TYPE_SPAWN_DELAY_S = 5;

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

	/** @var array<string,int> type ⇒ max-partition-count, built fresh each check_config tick. Used by reconcile_lock_dirs to recognize which on-disk lock dirs belong in the active fleet, and by the spawn-delay logic to detect newly-added types. */
	private array $active_types = [];

	/** @var array<string,float> type => earliest unix timestamp at which spawn is allowed. */
	private array $spawn_after = [];

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
			// base_dir is operator-configured under /tmp/ or similar — not WP-managed.
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
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
				Log_Cleaner::cleanup_orphan_partitions( $this->base_dir, (int) ( $this->num_partitions ?? 1 ) );
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
				// Type was just added via check_config; honor the
				// post-detection delay so a released predecessor has time
				// to flush its offsetlog cleanly.
				$deferred_until = $this->spawn_after[ $worker['type'] ] ?? 0;
				if ( $deferred_until > 0 ) {
					if ( $now < $deferred_until ) {
						continue;
					}
					unset( $this->spawn_after[ $worker['type'] ] );
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

		// Refresh per-process option snapshots so operator changes
		// reach the supervisor on its next 15s tick instead of waiting
		// for natural respawn (~595s). Mirrors the legacy event-logger
		// supervisor's check_config preamble — solved the same
		// staleness bug there.
		Config::invalidate_options_cache();
		Config::reset();

		// Honor the enable_logging gate. Bootstrap is the source of truth.
		if ( ! Bootstrap::is_logging_enabled() ) {
			return false;
		}

		// Rebuild worker_locks from current topology.
		// Filter iteration is cheap; no marker file or restart dance needed.
		// Spec line 590.
		$workers = Bootstrap::expand_workers();

		// No topologies → no work. Exit the tick loop and let
		// run_supervisor_tick's empty-check skip the cron until the
		// configuration changes. Mid-run config flips (operator turns
		// enable_jobs / enable_workers / enable_aggregator off) land here
		// on the 15s tick boundary.
		if ( empty( $workers ) ) {
			return false;
		}

		// Determine effective num_partitions (max across topologies, clamped).
		$max_partitions = 1;
		foreach ( $workers as $w ) {
			if ( $w['partition'] + 1 > $max_partitions ) {
				$max_partitions = $w['partition'] + 1;
			}
		}
		$this->num_partitions = \min( self::MAX_PARTITIONS, \max( 1, $max_partitions ) );

		// Build active fleet table: type => max-partition-count. Each
		// topology can declare its own count via TSL frontmatter, so this
		// honors per-type sizing instead of using the global max.
		$new_types = [];
		foreach ( $workers as $w ) {
			$new_types[ $w['type'] ] = \max(
				$new_types[ $w['type'] ] ?? 0,
				$w['partition'] + 1
			);
		}

		// Newly added types: defer first spawn so a released-but-not-yet-
		// exited predecessor (e.g. swapping firehose-workers-and-jobs for
		// firehose-workers-only) has time to flush its offsetlog. Skipped on
		// the very first check_config tick (no prior active_types == cold
		// start, every type is "new" but there's no predecessor to wait for).
		if ( ! empty( $this->active_types ) ) {
			$added = \array_diff_key( $new_types, $this->active_types );
			foreach ( \array_keys( $added ) as $type ) {
				$this->spawn_after[ $type ] = $now + self::NEW_TYPE_SPAWN_DELAY_S;
			}
		}
		$this->active_types = $new_types;
		$this->worker_locks = $workers;

		// Detect a shrunk fleet and arm Log_Cleaner. The prior set is
		// persisted (non-autoloaded) so the comparison survives supervisor
		// respawns without firing a false positive on every cold start.
		$current_set = [];
		foreach ( $workers as $w ) {
			$current_set[] = "{$w['type']}.p{$w['partition']}";
		}
		\sort( $current_set );
		$prior = \get_option( Log_Cleaner::FLEET_DESCRIPTORS_OPTION, null );
		if ( \is_array( $prior ) && ! empty( \array_diff( $prior, $current_set ) ) ) {
			\update_option( Log_Cleaner::LOGS_DIRTY_OPTION, '1', false );
		}
		if ( $current_set !== $prior ) {
			\update_option( Log_Cleaner::FLEET_DESCRIPTORS_OPTION, $current_set, false );
		}

		// Reconcile lock dirs on disk against the active fleet — one
		// state-free pass that handles every "this worker shouldn't be
		// running anymore" case: operator-removed topology, shrunk
		// num_partitions, or stale orphans inherited from a previous
		// supervisor.
		$this->reconcile_lock_dirs();

		return true;
	}

	/**
	 * Walk every `*.lock.d` on disk and reconcile against the active fleet
	 * (`$active_types` = type ⇒ partition-count). One state-free pass
	 * handles every "this worker shouldn't be running anymore" case:
	 *   - Operator removed the topology from the active list.
	 *   - Operator shrunk `num_partitions` (orphans partition slots >= count).
	 *   - Previous supervisor left stale dirs we never spawned ourselves.
	 *
	 * Per dir:
	 *   - Non-partitioned dir (supervisor, etc.) → leave alone.
	 *   - In active fleet (type+partition both still wanted) → leave alone.
	 *   - Otherwise → cold-removal attempt first; if dir survives (live
	 *     worker), drop a restart flag so the worker exits on its next
	 *     250ms drain iteration. Next tick reaps the dir once cold.
	 *
	 * State-free intentionally: derived purely from on-disk lock dirs and
	 * the live `$active_types` table built this tick. Survives supervisor
	 * respawn boundaries and rapid topology / num_partitions flips within
	 * a single check_config interval.
	 *
	 * Order matters: `remove_stale_directory` reads the newest mtime among
	 * files in the dir; running it AFTER `request_restart_at` would always
	 * see a fresh mtime (the restart flag we just wrote) and skip removal.
	 */
	public function reconcile_lock_dirs(): void {
		if ( empty( $this->active_types ) ) {
			// Cold start (check_config hasn't run) — without a known fleet
			// every dir would be tagged "orphan" and reaped. Bail.
			return;
		}
		$locks_dir = "{$this->base_dir}/locks";
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_glob -- Operator storage, never WP-managed.
		$candidates = \glob( $locks_dir . '/*.lock.d' );
		if ( empty( $candidates ) ) {
			return;
		}
		foreach ( $candidates as $path ) {
			$base = \basename( $path, '.lock.d' );
			if ( ! \preg_match( '/^(.+)\.p(\d+)$/', $base, $m ) ) {
				// Non-partitioned dir (e.g. supervisor.lock.d) — leave alone.
				continue;
			}
			$type           = $m[1];
			$partition      = (int) $m[2];
			$max_partitions = $this->active_types[ $type ] ?? 0;
			if ( $partition < $max_partitions ) {
				// In fleet — leave alone.
				continue;
			}
			$this->remove_stale_directory( $path, Lock::STALE_TIMEOUT );
			if ( \is_dir( $path ) && ! \file_exists( $path . '/' . Lock::RESTART_FLAG ) ) {
				// Skip rewriting the restart flag if one's already dropped —
				// otherwise every 15s tick stomps the file (no behavioral
				// impact; just wasted disk churn until the worker exits).
				Lock::request_restart_at( $path );
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
	 * `curl_exec` seam. Lazily-defaulted to a closure that calls real
	 * libcurl (can't default a Closure on a class property — must be a
	 * constant expression). Tests reassign in their bootstrap to
	 * capture without short-circuiting the rest of the curl_init /
	 * curl_setopt_array path; that lets the suite exercise the actual
	 * production setopt + error-classification logic.
	 *
	 * Signature: `function (\CurlHandle $ch, array $body): mixed`.
	 * The default ignores `$body` — POSTFIELDS was already set on the
	 * handle. Tests use `$body` to record what was POSTed, since PHP
	 * curl doesn't expose POSTFIELDS through `curl_getinfo`.
	 *
	 * @var \Closure|null
	 */
	public static ?\Closure $curl_exec = null;

	/**
	 * Fire-and-forget spawn POST. Errors are logged but not retried; the
	 * 1s-tick + 15s rate limit + cron backstop together guarantee eventual
	 * spawn even if individual POSTs fail.
	 */
	private function post_spawn( string $spawn_url, string $type, int $partition, string $token ): void {
		$err = self::fire_and_forget_post( $spawn_url, [
			'type'      => $type,
			'partition' => $partition,
			'nonce'     => $token,
		] );
		if ( null !== $err ) {
			Core::stderr( 'Newspack_Nodes\\Supervisor: spawn failed for ' . $type . '|' . $partition . ': ' . $err );
		}
	}

	/**
	 * Spawn the next supervisor instance via the spawn endpoint. Fire-and-
	 * forget; WP-Cron is the backstop if this fails.
	 */
	private function spawn_next_supervisor(): void {
		$err = self::fire_and_forget_post( \rest_url( 'newspack-nodes/v1/workers/spawn' ), [
			'type'      => 'supervisor',
			'partition' => 0,
			'nonce'     => $this->generate_spawn_token( \time() ),
		] );
		if ( null !== $err ) {
			Core::stderr( 'Newspack_Nodes\\Supervisor: spawn_next_supervisor failed: ' . $err );
		}
	}

	/**
	 * Raw-curl fire-and-forget POST. Bypasses `wp_remote_post` because
	 * WP's Requests library floors the timeout at 1s
	 * (`Requests/src/Transport/Curl.php:427`) — a SIGALRM-resolver guard
	 * that serializes a per-tick sweep of N spawns into N seconds.
	 * `CURLOPT_NOSIGNAL=1` skips the alarm machinery so the requested
	 * `CURLOPT_TIMEOUT_MS=10` is honored verbatim. The expected outcome
	 * IS `CURLE_OPERATION_TIMEDOUT` — we hang up well before the
	 * synchronous spawn handler finishes — so timeout errors are
	 * swallowed and counted as success.
	 *
	 * Test seam: `Supervisor::$curl_exec` (a static closure with the
	 * real libcurl call as its default) is the one swappable line —
	 * everything around it still runs unmocked, so the test suite
	 * covers the actual setopt + error-classification logic.
	 */
	private static function fire_and_forget_post( string $url, array $body ): ?string {
		if ( '' === $url ) {
			return 'empty url';
		}
		if ( ! \function_exists( 'curl_init' ) ) {
			return 'curl extension not available';
		}
		// phpcs:disable WordPress.WP.AlternativeFunctions.curl_curl_init,WordPress.WP.AlternativeFunctions.curl_curl_setopt_array,WordPress.WP.AlternativeFunctions.curl_curl_exec,WordPress.WP.AlternativeFunctions.curl_curl_errno,WordPress.WP.AlternativeFunctions.curl_curl_error,WordPress.WP.AlternativeFunctions.curl_curl_close -- raw curl is intentional. wp_remote_post() routes through Requests, whose Curl transport at src/Transport/Curl.php:427 does `max( (int) $timeout, 1 )` and clamps any sub-second timeout up to 1 full second — defeating this helper's CURLOPT_TIMEOUT_MS=10 fire-and-forget contract. Raw curl is the only path that honors the 10ms timeout.
		$ch = \curl_init();
		if ( false === $ch ) {
			return 'curl_init failed';
		}
		\curl_setopt_array( $ch, [
			\CURLOPT_URL               => $url,
			\CURLOPT_POST              => true,
			\CURLOPT_POSTFIELDS        => \http_build_query( $body ),
			\CURLOPT_NOSIGNAL          => true,
			\CURLOPT_TIMEOUT_MS        => 10,
			\CURLOPT_CONNECTTIMEOUT_MS => 10,
			\CURLOPT_RETURNTRANSFER    => false,
			\CURLOPT_HEADER            => false,
			\CURLOPT_SSL_VERIFYHOST    => 0,
			\CURLOPT_SSL_VERIFYPEER    => false,
		] );
		// Default closure ignores `$body` — it's already set on the
		// handle's POSTFIELDS by the curl_setopt_array above. The arg
		// only matters to test mocks (POSTFIELDS isn't recoverable via
		// curl_getinfo, so this is the narrowest seam that still
		// preserves body-shape assertions in supervisor tests).
		$exec = self::$curl_exec ?? static fn ( $h, $b ) => \curl_exec( $h );
		$exec( $ch, $body );
		$errno = \curl_errno( $ch );
		$err   = ( 0 === $errno || \CURLE_OPERATION_TIMEDOUT === $errno ) ? null : \curl_error( $ch );
		\curl_close( $ch );
		// phpcs:enable WordPress.WP.AlternativeFunctions
		return $err;
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
			$deferred_until = $this->spawn_after[ $worker['type'] ] ?? 0;
			if ( $deferred_until > 0 ) {
				if ( $now < $deferred_until ) {
					continue;
				}
				unset( $this->spawn_after[ $worker['type'] ] );
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
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
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
