<?php
/**
 * Spawn Coordinator: lock paths, staleness, the shared spawn throttle, the HMAC
 * spawn token, the POST that carries it, and the reconcile of lock/ipc dirs the
 * active fleet no longer accounts for.
 *
 * Request-scope only. Nothing here takes a lock or runs a loop, which is what
 * lets the cold-start cron pass, the peer scan inside every worker, and the
 * topology-activation verbs all share one coordinator.
 *
 * Some members answer to the name only obliquely, and stay by measure. The
 * spawn/stop pair is one unit: `kill_readers()` is `spawn_fleet()`'s inverse,
 * called from the same request scope over the same `base_dir` lock tree, and
 * splitting it would put half a lifecycle in each of two classes. The janitorial
 * pair (`reconcile_lock_dirs()`, `cleanup_orphan_ipc()`) is the same tree read
 * the other way — which dirs the active fleet no longer accounts for — and both
 * consume the staleness rules and the contained delete right here. The directory
 * utilities (`remove_stale_directory`, `delete_directory_recursive`, `is_within`)
 * are generic and shared with `Log_Cleaner` and uninstall — a home of their own
 * is defensible, but they are the jail guard uninstall loads by `require_once`
 * without an autoloader, so moving them buys a new file and a new dependency for
 * the same code.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

if ( ! \defined( 'ABSPATH' ) ) {
	exit;
}

class Spawn_Coordinator {

	/** Symlink-loop defense. */
	public const MAX_DEPTH = 5;

	/** Upper bound on partitions per topology; expand_workers clamps the spawn count to it. */
	public const MAX_PARTITIONS = 16;

	/** Min interval between spawning the same worker; updated after every attempt (success or fail). */
	public const MIN_SPAWN_INTERVAL_S = 15;

	public const SPAWN_TS_CACHE_KEY = 'newspack_nodes:last_spawn:';

	protected string $base_dir;
	/** @var array<string,float> Key: "{type}|{partition}", value: timestamp. */
	protected array $last_spawn_time = [];

	/** HMAC key for the spawn token. Never a node argument — `dump_config` serializes those. */
	private string $nonce_salt;

	/**
	 * @param string      $base_dir   Runtime state root holding locks/ and ipc/.
	 * @param string|null $nonce_salt Spawn-HMAC key; omitted resolves the one production key.
	 */
	public function __construct( string $base_dir, ?string $nonce_salt = null ) {
		$this->base_dir   = \rtrim( $base_dir, '/' );
		$this->nonce_salt = $nonce_salt ?? \wp_salt( 'nonce' );
	}

	/**
	 * Reconcile every on-disk `*.lock.d` against the active fleet: a partition
	 * past its topology's count is removed if stale, then flagged to retire.
	 *
	 * Order matters — remove_stale_directory must run BEFORE request_restart_at,
	 * or the flag's fresh mtime blocks the removal. Nothing here is urgent: a
	 * surplus worker retires within one lifetime on its own, through
	 * `Spawn_Controller::validate_partition()`.
	 */
	public function reconcile_lock_dirs(): void {
		$active = [];
		foreach ( Bootstrap::expand_workers() as $worker ) {
			$active[ $worker['type'] ] = \max( $active[ $worker['type'] ] ?? 0, $worker['partition'] + 1 );
		}
		if ( empty( $active ) ) {
			return; // No known fleet: every dir would read as an orphan.
		}
		$locks_dir = "{$this->base_dir}/locks";
		$this->reap_steal_scratch_dirs( $locks_dir );
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_glob -- Operator storage, never WP-managed.
		foreach ( \glob( "{$locks_dir}/*.lock.d" ) ?: [] as $path ) {
			if ( ! \preg_match( '/^(.+)\.p(\d+)$/', \basename( $path, '.lock.d' ), $m ) ) {
				continue; // Non-partitioned dir — not a worker.
			}
			if ( (int) $m[2] < ( $active[ $m[1] ] ?? 0 ) ) {
				continue; // In fleet.
			}
			$this->remove_stale_directory( $path, Lock_Node::STALE_TIMEOUT );
			if ( \is_dir( $path ) && ! \file_exists( $path . '/' . Lock_Node::RESTART_FLAG ) ) {
				Lock_Node::request_restart_at( $path );
			}
		}
	}

	/**
	 * Reap leaked `*.lock.d.stealing.*` scratch dirs from Lock_Node's atomic
	 * steal. A normal steal removes its scratch in two syscalls; a process killed
	 * in that window leaks one and nothing else reaps it. Only sweep dirs older
	 * than STALE_TIMEOUT — far beyond any in-flight steal — so a live takeover is
	 * never reaped out from under itself.
	 *
	 * @param string $locks_dir Absolute path to locks/.
	 */
	private function reap_steal_scratch_dirs( string $locks_dir ): void {
		$cutoff = \time() - Lock_Node::STALE_TIMEOUT;
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_glob -- Operator storage, never WP-managed.
		foreach ( \glob( "{$locks_dir}/*.lock.d.stealing.*", \GLOB_ONLYDIR ) ?: [] as $path ) {
			\clearstatcache( true, $path );
			$mtime = @\filemtime( $path );
			if ( false === $mtime || $mtime > $cutoff ) {
				continue; // Unreadable or an in-flight steal — leave it.
			}
			self::delete_directory_recursive( $path, $this->base_dir );
		}
	}

	/**
	 * Recursively delete a directory, depth-bounded and containment-checked under $base_path.
	 *
	 * @param string $path      Directory to delete.
	 * @param string $base_path Containment root (top-level call only).
	 * @param int    $max_depth Optional override of MAX_DEPTH for tests.
	 */
	public static function delete_directory_recursive( string $path, string $base_path, int $max_depth = self::MAX_DEPTH ): void {
		if ( ! self::is_within( $path, $base_path ) ) {
			return;
		}
		// Strict-proper-subpath: refuse equality so `$base/..` can't wipe base.
		$real_path = \realpath( $path );
		$real_base = \realpath( $base_path );
		if ( false === $real_path || false === $real_base
			|| \rtrim( $real_path, '/' ) === \rtrim( $real_base, '/' ) ) {
			return;
		}
		self::delete_directory_recursive_inner( $path, $max_depth, 0 );
	}

	/**
	 * True if $path equals or is under $base_path after realpath; false if either won't resolve.
	 *
	 * @param string $path      Candidate path.
	 * @param string $base_path Containment root.
	 * @return bool True if $path is within $base_path.
	 */
	public static function is_within( string $path, string $base_path ): bool {
		$real_path = \realpath( $path );
		$real_base = \realpath( $base_path );
		if ( false === $real_path || false === $real_base ) {
			return false;
		}
		// Accept equality: containment predicate; callers reject it if needed.
		$real_base_trim = \rtrim( $real_base, '/' );
		if ( $real_path === $real_base_trim ) {
			return true;
		}
		return \strpos( $real_path, $real_base_trim . '/' ) === 0;
	}

	/**
	 * Internal recursion helper: enforces depth bounds + per-node symlink avoidance.
	 */
	private static function delete_directory_recursive_inner( string $path, int $max_depth, int $depth ): void {
		if ( $depth > $max_depth ) {
			return;
		}
		if ( \is_link( $path ) ) {
			return;
		}
		if ( ! \is_dir( $path ) ) {
			return;
		}
		$items = @\scandir( $path ) ?: [];
		foreach ( $items as $item ) {
			if ( '.' === $item || '..' === $item ) {
				continue;
			}
			$child = $path . '/' . $item;
			if ( \is_dir( $child ) && ! \is_link( $child ) ) {
				self::delete_directory_recursive_inner( $child, $max_depth, $depth + 1 );
			} else {
				// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_unlink
				@\unlink( $child );
			}
		}
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_rmdir
		@\rmdir( $path );
	}

	/**
	 * Remove $dir if its newest file mtime exceeds $stale_age_s (symlink-safe, base_dir-contained).
	 *
	 * @param string $dir          Candidate stale directory.
	 * @param int    $stale_age_s  Threshold in seconds.
	 */
	public function remove_stale_directory( string $dir, int $stale_age_s ): void {
		// Symlink: unlink rather than recurse, so we can't escape base_dir.
		if ( \is_link( $dir ) ) {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_unlink -- substrate manages its own base_dir tree (default /tmp/newspack-nodes/); the VIP hosted-filesystem rule doesn't apply to a runtime's reserved directory.
			@\unlink( $dir );
			return;
		}
		if ( ! \is_dir( $dir ) ) {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_unlink -- see above.
			@\unlink( $dir );
			return;
		}

		$newest_mtime = 0;
		$files        = @\scandir( $dir ) ?: [];
		foreach ( $files as $file ) {
			if ( '.' === $file || '..' === $file ) {
				continue;
			}
			$child = $dir . '/' . $file;
			if ( \is_link( $child ) ) {
				continue;
			}
			$mtime = @\filemtime( $child );
			if ( false !== $mtime && $mtime > $newest_mtime ) {
				$newest_mtime = $mtime;
			}
		}

		if ( $newest_mtime > 0 && ( \time() - $newest_mtime ) > $stale_age_s ) {
			self::delete_directory_recursive( $dir, $this->base_dir );
		}
	}

	/**
	 * Spawn every active-fleet worker whose lock is missing or whose heartbeat
	 * has gone stale. The COLD-START pass: `Fleet_Node` runs the same scan from
	 * inside every live worker, so this only ever matters when none is left —
	 * which is exactly why it may not depend on one.
	 *
	 * @param float $now Pass clock.
	 * @return int Spawn POSTs fired.
	 */
	public function spawn_due_workers( float $now ): int {
		$workers = Bootstrap::expand_workers();
		if ( empty( $workers ) ) {
			return 0;
		}
		$conflict = self::conflict_description( \array_values( \array_unique( \array_column( $workers, 'type' ) ) ) );
		if ( '' !== $conflict ) {
			Core::print_less_often( 'refusing to spawn — topology write-conflict: ', $conflict );
			return 0;
		}
		$spawn_url = \rest_url( 'newspack-nodes/v1/workers/spawn' );
		$token     = $this->generate_spawn_token( (int) $now );
		$spawned   = 0;
		foreach ( $workers as $worker ) {
			if ( ! $this->worker_needs_spawn( $worker, $now ) ) {
				continue;
			}
			if ( $this->is_recently_spawned( $worker['type'], $worker['partition'], $now ) ) {
				continue;
			}
			$err = $this->post_spawn( $spawn_url, $worker['type'], $worker['partition'], $token );
			if ( null !== $err ) {
				Core::print_less_often( "spawn failed for {$worker['type']}.p{$worker['partition']}: ", $err );
			}
			++$spawned;
		}
		return $spawned;
	}

	/**
	 * Describe the write-conflicts in a topology set, or '' when it is safe to
	 * spawn. Two topologies writing one partition log corrupt it, so every
	 * spawner refuses the whole set — better no workers than two fleets. Each
	 * caller logs the description in its own voice.
	 *
	 * @param list<string> $types Topology names.
	 * @return string Human-readable conflict list, or '' when there is none.
	 */
	public static function conflict_description( array $types ): string {
		$conflicts = Topology_Analyzer::find_conflicts( $types );
		return empty( $conflicts ) ? '' : Topology_Analyzer::describe_conflicts( $conflicts );
	}

	/** HMAC spawn token for $now's 10s window. Per-site, never logged. */
	public function generate_spawn_token( int $now ): string {
		return Internal_Request_Token::generate( Internal_Request_Token::PURPOSE_SPAWN, $now, $this->nonce_salt );
	}

	/** @param array<string, mixed> $worker Worker descriptor (type, partition, …). */
	public function worker_needs_spawn( array $worker, float $now ): bool {
		$raw_type      = $worker['type'];
		$raw_partition = $worker['partition'];
		$type          = Core::as_string( $raw_type );
		$partition     = Core::as_int( $raw_partition );
		$stale         = Lock_Node::stale_timeout_of( $worker );

		$dir = $this->lock_path( $type, $partition );
		if ( ! \is_dir( $dir ) ) {
			return true;
		}
		return Lock_Node::heartbeat_is_stale( $dir, (int) $now, $stale );
	}

	public function lock_path( string $type, int $partition ): string {
		return "{$this->base_dir}/locks/{$type}.p{$partition}.lock.d";
	}

	public function is_recently_spawned( string $type, int $partition, float $now ): bool {
		$key  = "{$type}|{$partition}";
		// In-memory has priority (current process owns the truth).
		if ( isset( $this->last_spawn_time[ $key ] ) ) {
			return ( $now - $this->last_spawn_time[ $key ] ) < self::MIN_SPAWN_INTERVAL_S;
		}
		// Else consult cross-process state: cron-backstop + self-respawn.
		$persisted = $this->load_spawn_ts( $key );
		if ( null !== $persisted ) {
			$this->last_spawn_time[ $key ] = $persisted;
			return ( $now - $persisted ) < self::MIN_SPAWN_INTERVAL_S;
		}
		return false;
	}

	/**
	 * Load a persisted spawn timestamp; null if absent. Reads the same single
	 * tier persist_spawn_ts wrote — a throttle window must never straddle tiers.
	 */
	protected function load_spawn_ts( string $key ): ?float {
		$cache_key = self::SPAWN_TS_CACHE_KEY . $key;

		$backend = Cache_Backend::shared_first();
		if ( null !== $backend ) {
			$value = $backend->get( $cache_key );
			return \is_scalar( $value ) && false !== $value ? (float) $value : null;
		}
		if ( \function_exists( 'get_transient' ) ) {
			$value = \get_transient( $cache_key );
			if ( false !== $value && \is_scalar( $value ) ) {
				return (float) $value;
			}
		}
		return null;
	}

	/**
	 * Fire-and-forget spawn POST. Returns the transport error so each caller
	 * reports in its own voice — a node through `print_less_often`, a cron pass
	 * through `Core`.
	 *
	 * @param string $spawn_url Fully-qualified spawn endpoint URL.
	 * @param string $type      Worker type.
	 * @param int    $partition Partition number.
	 * @param string $token     Current HMAC spawn token.
	 * @return string|null Error description, or null on success.
	 */
	public function post_spawn( string $spawn_url, string $type, int $partition, string $token ): ?string {
		return Core::fire_and_forget_post( $spawn_url, [
			'type'      => $type,
			'partition' => $partition,
			'nonce'     => $token,
		] );
	}

	/**
	 * Reap ipc dirs for workers no longer in the fleet. A live worker's lock dir
	 * defers its own removal, so a worker mid-recycle keeps its IPC.
	 */
	public function cleanup_orphan_ipc(): void {
		$active = [];
		foreach ( Bootstrap::expand_workers() as $worker ) {
			$active[ "{$worker['type']}.p{$worker['partition']}" ] = true;
		}
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_glob -- Operator storage, never WP-managed.
		foreach ( \glob( "{$this->base_dir}/ipc/*.p*", \GLOB_ONLYDIR ) ?: [] as $dir ) {
			$name = \basename( $dir );
			if ( isset( $active[ $name ] ) || ! \preg_match( '/\.p\d+$/', $name ) ) {
				continue;
			}
			if ( \is_dir( "{$this->base_dir}/locks/{$name}.lock.d" ) ) {
				continue; // A live worker still holds it.
			}
			self::delete_directory_recursive( $dir, $this->base_dir );
		}
	}

	/**
	 * Spawn every partition of one fleet NOW, without waiting for a scan.
	 * Symmetric with kill_readers(); called from request scope on topology
	 * activation. The caller must already have added $name to the active set,
	 * or each worker's self-respawn is refused by Spawn_Controller.
	 *
	 * @param string $name Topology / worker type.
	 * @return int Number of partitions spawned.
	 */
	public function spawn_fleet( string $name ): int {
		$active   = \array_values( \array_unique( \array_merge( \array_keys( Bootstrap::get_topologies() ), [ $name ] ) ) );
		$conflict = self::conflict_description( $active );
		if ( '' !== $conflict ) {
			Core::print_less_often( 'refusing to spawn_fleet — topology write-conflict: ', $conflict );
			return 0;
		}
		$spawn_url = \rest_url( 'newspack-nodes/v1/workers/spawn' );
		$token     = $this->generate_spawn_token( \time() );
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
	 * Record an ACCEPTED spawn (in-memory + persisted). The spawn endpoint calls
	 * this — the one gate every spawn crosses — so self-respawns, peer scans and
	 * the cron pass share a single cross-process throttle window.
	 */
	public function record_spawn( string $type, int $partition, float $when ): void {
		$key                          = "{$type}|{$partition}";
		$this->last_spawn_time[ $key ] = $when;
		$this->persist_spawn_ts( $key, $when );
	}

	/**
	 * Persist a spawn timestamp (Cache_Backend, transient fallback) so a respawn honors the rate limit.
	 */
	protected function persist_spawn_ts( string $key, float $when ): void {
		$cache_key = self::SPAWN_TS_CACHE_KEY . $key;
		$ttl       = self::MIN_SPAWN_INTERVAL_S * 2;

		$backend = Cache_Backend::shared_first();
		if ( null !== $backend ) {
			$backend->set( $cache_key, (int) $when, $ttl );
			return;
		}
		if ( \function_exists( 'set_transient' ) ) {
			\set_transient( $cache_key, (int) $when, $ttl );
		}
	}

	/** Validate against the current AND previous window — don't tighten, that straddle is deliberate. */
	public function validate_spawn_token( string $token, int $now ): bool {
		return Internal_Request_Token::validate( Internal_Request_Token::PURPOSE_SPAWN, $token, $now, $this->nonce_salt );
	}

	/**
	 * Drop restart flags for a list of worker groups (plugins call this on
	 * deactivation). A type no longer in the fleet has no partition count to
	 * consult, so it is swept across the full range.
	 *
	 * @param string[] $groups Group names to kill.
	 */
	public function kill_readers( array $groups ): void {
		$counts = [];
		foreach ( Bootstrap::expand_workers() as $w ) {
			$counts[ $w['type'] ] = \max( $counts[ $w['type'] ] ?? 0, $w['partition'] + 1 );
		}
		foreach ( $groups as $name ) {
			$count = \min( self::MAX_PARTITIONS, \max( 1, $counts[ $name ] ?? self::MAX_PARTITIONS ) );
			for ( $p = 0; $p < $count; $p++ ) {
				$lock_path = "{$this->base_dir}/locks/{$name}.p{$p}.lock.d";
				if ( \is_dir( $lock_path ) ) {
					// Restart channel; force_release reads as a steal.
					Lock_Node::request_restart_at( $lock_path );
				}
			}
		}
	}

	/**
	 * Record a spawn POST in-memory only. The tick loop uses this: persisting
	 * here would make the endpoint (which records on accept) reject the very
	 * POST this record announces.
	 */
	public function record_spawn_local( string $type, int $partition, float $when ): void {
		$this->last_spawn_time[ "{$type}|{$partition}" ] = $when;
	}
}
