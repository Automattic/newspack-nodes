<?php
/**
 * Supervisor: long-running tick loop with HMAC spawn token + spawn rate limit.
 *
 * Singleton via supervisor.lock.d so concurrent ticks don't double-spawn.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

if ( ! \defined( 'ABSPATH' ) ) {
	exit;
}

class Supervisor extends Supervisor_Base {

	/** Endpoint accepts current + previous for race tolerance. */
	public const TOKEN_WINDOW_S = 10;

	/** 10 min minus 5s margin, sized for Atomic's ~15-min cap. */
	public const MAX_SUPERVISOR_RUNTIME_S = 595;

	/** Also the plugin (de)activation latency. */
	public const CONFIG_CHECK_INTERVAL = 15;

	/** Defer first spawn of a newly-appeared type so a still-exiting predecessor can flush. */
	public const NEW_TYPE_SPAWN_DELAY_S = 5;

	public const SUPERVISOR_STALE_TIMEOUT = 60;

	private string $nonce_salt;

	/** @var Lock_Node|null Supervisor's own lock; singleton-globally per host. */
	private ?Lock_Node $own_lock = null;

	private float $start_time = 0.0;

	private float $last_heartbeat = 0.0;

	private float $last_config_check = 0.0;

	/** @var array<int, array{type: string, partition: int, topology: mixed, stale_timeout: mixed}> Worker descriptors built from expand_workers(). */
	private array $worker_locks = [];

	/** @var array<string,int> type ⇒ max-partition-count, rebuilt each check_config tick (active fleet). */
	private array $active_types = [];

	/** @var array<string,float> type => earliest unix timestamp at which spawn is allowed. */
	private array $spawn_after = [];

	public function __construct( string $base_dir, string $nonce_salt ) {
		parent::__construct( $base_dir );
		$this->nonce_salt = $nonce_salt;
	}

	/** HMAC spawn-token, rotating every 10s. Per-site, never logged. */
	public function generate_spawn_token( int $now ): string {
		$window = (int) \floor( $now / self::TOKEN_WINDOW_S );
		return \hash_hmac( 'sha256', "newspack_nodes_spawn:{$window}", $this->nonce_salt );
	}

	/** Validate a token against the current AND previous window (don't tighten — straddle tolerance). */
	public function validate_spawn_token( string $token, int $now ): bool {
		$window   = (int) \floor( $now / self::TOKEN_WINDOW_S );
		$current  = \hash_hmac( 'sha256', "newspack_nodes_spawn:{$window}", $this->nonce_salt );
		$previous = \hash_hmac( 'sha256', "newspack_nodes_spawn:" . ( $window - 1 ), $this->nonce_salt );
		return \hash_equals( $current, $token ) || \hash_equals( $previous, $token );
	}

	/**
	 * Long-running tick loop (~595s, 1s ticks). Exits via max-runtime (self-respawns)
	 * or check_config=false (logging disabled / lock stolen — no respawn).
	 */
	public function run(): void {
		$this->start_time = \microtime( true );

		// Tag this process as a supervisor worker for stats exclusion / log correlation.
		$_SERVER['NEWSPACK_NODES_WORKER_TYPE']      = 'supervisor';
		$_SERVER['NEWSPACK_NODES_WORKER_PARTITION'] = '0';

		if ( ! $this->check_config( $this->start_time ) ) {
			return;
		}

		// Acquire our own lock — singleton globally; defer to any supervisor already running.
		$lock_dir = "{$this->base_dir}/locks/supervisor.lock.d";
		if ( ! \is_dir( "{$this->base_dir}/locks" ) ) {
			// base_dir is operator-configured under /tmp/ — not WP-managed.
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
			@\mkdir( "{$this->base_dir}/locks", 0755, true );
		}
		// Supervisor is not a Node and runs no interpreter: bare new (no-interpreter exception).
		$lock           = new Lock_Node( $lock_dir, self::SUPERVISOR_STALE_TIMEOUT );
		$this->own_lock = $lock;
		if ( ! $lock->acquire() ) {
			return;
		}
		$this->last_heartbeat = $this->start_time;

		// Disable execution timeout so a slow PHP-FPM timeout doesn't kill us mid-tick.
		@\set_time_limit( 0 );

		try {
			$this->tick_loop();
		} finally {
			$lock->release();
			$this->own_lock = null;
			$this->spawn_next_supervisor();
		}
	}

	/** The actual 595s tick loop. Extracted for testability + cleaner try/finally. */
	private function tick_loop(): void {
		// own_lock is set by run()/init_lock_for_test() before this runs; bail loudly otherwise.
		$lock = $this->own_lock;
		if ( null === $lock ) {
			throw new \RuntimeException( 'tick_loop requires an acquired own_lock' );
		}
		$last_token_window = -1;
		$token             = '';
		$spawn_url         = \rest_url( 'newspack-nodes/v1/workers/spawn' );

		while ( true ) {
			$now = \microtime( true );

			if ( ( $now - $this->start_time ) >= self::MAX_SUPERVISOR_RUNTIME_S ) {
				break;
			}

			if ( ( $now - $this->last_heartbeat ) >= self::SUPERVISOR_STALE_TIMEOUT / 6 ) {
				$lock->heartbeat();
				$this->last_heartbeat = $now;
			}

			// Bail if our lock was stolen or restart requested.
			if ( $lock->should_restart() ) {
				break;
			}

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
				Log_Cleaner::cleanup_orphan_partitions( $this->base_dir );
				$this->cleanup_orphan_ipc();
				if ( \function_exists( 'do_action' ) ) {
					\do_action( 'newspack_nodes/supervisor_periodic' );
				}
			}

			foreach ( $this->worker_locks as $worker ) {
				if ( ! $this->worker_needs_spawn( $worker, $now ) ) {
					continue;
				}
				if ( $this->is_recently_spawned( $worker['type'], $worker['partition'], $now ) ) {
					continue;
				}
				// Newly-added type: honor the post-detection delay so a predecessor can flush.
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
	 * @return bool False if the supervisor should exit (logging disabled / no topologies).
	 */
	public function check_config( float $now ): bool {
		$this->last_config_check = $now;

		// Refresh per-process option snapshots so operator changes land on the next 15s tick.
		Config::invalidate_options_cache();
		Config::reset();

		if ( ! Bootstrap::is_supervisor_enabled() ) {
			return false;
		}

		$workers = Bootstrap::expand_workers();

		// No topologies → no work; exit so the cron skips until config changes.
		if ( empty( $workers ) ) {
			// Whole fleet deactivated at once: drain running workers so they exit now (reconcile bails on an empty set); cold start drains nothing.
			if ( ! empty( $this->active_types ) ) {
				$this->drain_all_workers();
			}
			return false;
		}

		// Refuse a write-conflicting active set (two topologies writing the same
		// log/offsetlog). The activate verb rejects conflicts before persisting, but
		// a config-FILE override bypasses that — better no workers than two fleets
		// corrupting one partition. Exit loudly; the cron retries each minute.
		$active    = \array_values( \array_unique( \array_column( $workers, 'type' ) ) );
		$conflicts = Topology_Registry::find_conflicts( $active );
		if ( ! empty( $conflicts ) ) {
			Core::stderr( 'Newspack_Nodes\\Supervisor: refusing to spawn — topology write-conflict: ' . Topology_Registry::describe_conflicts( $conflicts ) );
			return false;
		}

		// Active fleet table: type => max-partition-count (per-type sizing from TSL frontmatter).
		$new_types = [];
		foreach ( $workers as $w ) {
			$new_types[ $w['type'] ] = \max(
				$new_types[ $w['type'] ] ?? 0,
				$w['partition'] + 1
			);
		}

		// Defer first spawn of newly-added types so a predecessor can flush. Skipped on cold start.
		if ( ! empty( $this->active_types ) ) {
			$added = \array_diff_key( $new_types, $this->active_types );
			foreach ( \array_keys( $added ) as $type ) {
				$this->spawn_after[ $type ] = $now + self::NEW_TYPE_SPAWN_DELAY_S;
			}
		}
		$this->active_types = $new_types;
		$this->worker_locks = $workers;

		// Reconcile on-disk lock dirs against the active fleet (removed topology, shrunk count, orphans).
		$this->reconcile_lock_dirs();

		return true;
	}

	/**
	 * Reconcile every on-disk `*.lock.d` against the active fleet (state-free).
	 *
	 * Order matters: remove_stale_directory must run BEFORE request_restart_at or the fresh mtime blocks removal.
	 */
	public function reconcile_lock_dirs(): void {
		if ( empty( $this->active_types ) ) {
			// Cold start: without a known fleet every dir would be reaped as an orphan.
			return;
		}
		$locks_dir = "{$this->base_dir}/locks";
		$this->reap_steal_scratch_dirs( $locks_dir );
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
			$this->remove_stale_directory( $path, Lock_Node::STALE_TIMEOUT );
			if ( \is_dir( $path ) && ! \file_exists( $path . '/' . Lock_Node::RESTART_FLAG ) ) {
				// Skip if a restart flag is already dropped (avoids per-tick disk churn).
				Lock_Node::request_restart_at( $path );
			}
		}
	}

	/**
	 * Flag every worker lock dir for restart when the whole fleet is deactivated.
	 *
	 * reconcile_lock_dirs() bails on an empty active set, so this is the drain path
	 * for "all topologies off". The `.p<N>` shape naturally excludes supervisor.lock.d.
	 */
	private function drain_all_workers(): void {
		$locks_dir = "{$this->base_dir}/locks";
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_glob -- Operator storage, never WP-managed.
		$candidates = \glob( $locks_dir . '/*.p*.lock.d', \GLOB_ONLYDIR );
		if ( empty( $candidates ) ) {
			return;
		}
		foreach ( $candidates as $path ) {
			$base = \basename( $path, '.lock.d' );
			if ( ! \preg_match( '/\.p\d+$/', $base ) ) {
				continue;
			}
			if ( \file_exists( $path . '/' . Lock_Node::RESTART_FLAG ) ) {
				// Skip if a restart flag is already dropped (avoids per-tick disk churn).
				continue;
			}
			Lock_Node::request_restart_at( $path );
		}
	}

	/**
	 * Reap leaked `*.lock.d.stealing.*` scratch dirs from Lock_Node's atomic
	 * steal. A normal steal removes its scratch dir in two syscalls; a process
	 * killed in that window leaks one, and nothing else reaps it. Only sweep
	 * dirs older than STALE_TIMEOUT — far beyond any in-flight steal — so a live
	 * takeover is never reaped out from under itself.
	 *
	 * @param string $locks_dir Absolute path to the locks/ directory.
	 */
	private function reap_steal_scratch_dirs( string $locks_dir ): void {
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_glob -- Operator storage, never WP-managed.
		$scratch = \glob( $locks_dir . '/*.lock.d.stealing.*', \GLOB_ONLYDIR );
		if ( empty( $scratch ) ) {
			return;
		}
		$cutoff = \time() - Lock_Node::STALE_TIMEOUT;
		foreach ( $scratch as $path ) {
			\clearstatcache( true, $path );
			$mtime = @\filemtime( $path );
			if ( false === $mtime || $mtime > $cutoff ) {
				continue; // Unreadable or possibly an in-flight steal — leave it.
			}
			Supervisor_Base::delete_directory_recursive( $path, $locks_dir );
		}
	}

	/** Reap ipc dirs for workers no longer in the fleet (a live worker's lock defers its own). */
	private function cleanup_orphan_ipc(): void {
		$active = [];
		foreach ( $this->worker_locks as $w ) {
			$active[ "{$w['type']}.p{$w['partition']}" ] = true;
		}
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_glob -- Operator storage, never WP-managed.
		foreach ( @\glob( "{$this->base_dir}/ipc/*.p*", \GLOB_ONLYDIR ) ?: [] as $dir ) {
			$name = \basename( $dir );
			if ( isset( $active[ $name ] ) || ! \preg_match( '/\.p\d+$/', $name ) ) {
				continue;
			}
			if ( \is_dir( "{$this->base_dir}/locks/{$name}.lock.d" ) ) {
				continue; // a live worker still holds it
			}
			Supervisor_Base::delete_directory_recursive( $dir, $this->base_dir );
		}
	}

	/**
	 * Drop restart flags for a list of worker groups (plugins call this on deactivation).
	 *
	 * @param string[] $groups Group names to kill.
	 */
	public function kill_readers( array $groups ): void {
		$workers = Bootstrap::expand_workers();
		$counts  = [];
		foreach ( $workers as $w ) {
			$counts[ $w['type'] ] = \max( $counts[ $w['type'] ] ?? 0, $w['partition'] + 1 );
		}

		$locks_dir = "{$this->base_dir}/locks";
		foreach ( $groups as $name ) {
			// Fall back to MAX_PARTITIONS for types no longer in topology, to clear orphans.
			$count = $counts[ $name ] ?? self::MAX_PARTITIONS;
			$count = \min( self::MAX_PARTITIONS, \max( 1, $count ) );
			for ( $p = 0; $p < $count; $p++ ) {
				$lock_path = "{$locks_dir}/{$name}.p{$p}.lock.d";
				if ( \is_dir( $lock_path ) ) {
					// Restart channel, not force_release (which a worker reads as a stolen lock).
					Lock_Node::request_restart_at( $lock_path );
				}
			}
		}
	}

	/**
	 * Spawn every partition of one fleet NOW (don't wait for the reconcile tick).
	 *
	 * Symmetric with kill_readers() (immediate drain). The caller must have
	 * already added $name to the active set so each worker's self_respawn is
	 * accepted by Spawn_Controller. Reuses the tick loop's spawn token + post path.
	 *
	 * @param string $name Topology / worker type.
	 * @return int Number of partitions spawned.
	 */
	public function spawn_fleet( string $name ): int {
		// Defense-in-depth behind the activate verb: refuse to put a second fleet
		// on a log/offsetlog a peer already owns. Phrased like check_config.
		$active    = \array_values( \array_unique( \array_merge( \array_keys( Bootstrap::get_topologies() ), [ $name ] ) ) );
		$conflicts = Topology_Registry::find_conflicts( $active );
		if ( ! empty( $conflicts ) ) {
			Core::stderr( 'Newspack_Nodes\\Supervisor: refusing to spawn_fleet — topology write-conflict: ' . Topology_Registry::describe_conflicts( $conflicts ) );
			return 0;
		}

		$token     = $this->generate_spawn_token( \time() );
		$spawn_url = \rest_url( 'newspack-nodes/v1/workers/spawn' );
		$count     = 0;
		foreach ( Bootstrap::expand_workers() as $worker ) {
			if ( $worker['type'] !== $name ) {
				continue;
			}
			$this->post_spawn( $spawn_url, $worker['type'], $worker['partition'], $token );
			++$count;
		}
		return $count;
	}

	/**
	 * libcurl-call seam. Tests reassign in bootstrap to capture POST bodies without
	 * short-circuiting the setopt + error-classification path.
	 *
	 * Signature: `function (\CurlHandle $ch, array $body): mixed`.
	 *
	 * @var \Closure(\CurlHandle, array<string, mixed>): mixed|null
	 */
	public static ?\Closure $curl_exec = null;

	/**
	 * Fire-and-forget spawn POST. Errors logged, not retried (tick + rate-limit + cron guarantee spawn).
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
	 * Spawn the next supervisor via the spawn endpoint (fire-and-forget; WP-Cron backstops).
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
	 * Raw-curl fire-and-forget POST. Bypasses wp_remote_post (Requests floors timeout at 1s);
	 * CURLOPT_NOSIGNAL + TIMEOUT_MS=10 means CURLE_OPERATION_TIMEDOUT is expected and counted as success.
	 *
	 * @param array<string, mixed> $body POST body.
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
		// Default ignores $body (already in POSTFIELDS); the arg only matters to test mocks.
		$exec = self::$curl_exec ?? static fn ( \CurlHandle $h, array $b ) => \curl_exec( $h );
		$exec( $ch, $body );
		$errno = \curl_errno( $ch );
		$err   = ( 0 === $errno || \CURLE_OPERATION_TIMEDOUT === $errno ) ? null : \curl_error( $ch );
		\curl_close( $ch );
		// phpcs:enable WordPress.WP.AlternativeFunctions
		return $err;
	}

	/**
	 * @api Test hook: drive a single tick without the sleep loop.
	 *
	 * @param float $now Simulated clock for this tick.
	 * @return bool True if the loop would continue, false if it would exit.
	 */
	public function tick_for_test( float $now, string $token ): bool {
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

		if ( null !== $this->own_lock && $this->own_lock->should_restart() ) {
			return false;
		}
		return true;
	}

	/** @api Test hook: install the supervisor's own lock without entering the run loop. */
	public function init_lock_for_test(): bool {
		if ( ! \is_dir( "{$this->base_dir}/locks" ) ) {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
			@\mkdir( "{$this->base_dir}/locks", 0755, true );
		}
		// Lifecycle primitive (see run()): bare new per the no-interpreter exception.
		$this->own_lock = new Lock_Node( "{$this->base_dir}/locks/supervisor.lock.d", self::SUPERVISOR_STALE_TIMEOUT );
		return $this->own_lock->acquire();
	}

	/** @api Test hook: release the lock from init_lock_for_test. */
	public function release_lock_for_test(): void {
		if ( null !== $this->own_lock ) {
			$this->own_lock->release();
			$this->own_lock = null;
		}
	}

	/**
	 * @api Test hook: expose worker_locks for assertions after check_config().
	 *
	 * @return array<int, array<string, mixed>>
	 */
	public function worker_locks_for_test(): array {
		return $this->worker_locks;
	}
}
