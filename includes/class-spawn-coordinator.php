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
 * consume the staleness rules and the contained delete right here. Of the
 * directory utilities only `delete_directory_recursive` has callers outside this
 * class (`Log_Cleaner`, uninstall); `remove_stale_directory` and `is_within` are
 * its neighbours. A home of their own is defensible, but they are the jail guard
 * `uninstall-cleanup.php` pulls in by an explicit `require_once`, so moving them
 * buys a new file and a new dependency for the same code.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

if ( ! \defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * An instance is scoped to one `base_dir`, and its only state is the in-memory
 * record of the POSTs this process fired — which is why
 * `Bootstrap::spawn_coordinator()` can hand out a fresh one per call.
 *
 * The static half needs neither instance nor base_dir: the deploy hold, the
 * spawn-token key, the conflict description, and the contained delete.
 */
class Spawn_Coordinator {

	/**
	 * Recursion cap on the contained delete, so a pathological tree cannot
	 * exhaust the stack. Symlinks are a separate refusal, made at every node.
	 */
	public const MAX_DEPTH = 5;

	/** Upper bound on partitions per topology; expand_workers clamps the spawn count to it. */
	public const MAX_PARTITIONS = 16;

	/** Min interval between spawning the same worker; updated after every attempt (success or fail). */
	public const MIN_SPAWN_INTERVAL_S = 15;

	/** Logical name for the spawn-throttle window; Cache_Backend scopes it. */
	public const SPAWN_TS_CACHE_KEY = 'last_spawn:';

	/**
	 * Deploy hold: while set, every spawn path is refused so a plugin update can
	 * swap `includes/` with no worker running against the half-old directory.
	 * `Spawn_Controller::spawn()` is where the refusal lands, because it is the
	 * one gate every spawn crosses — a worker's own respawn included, and that
	 * one never consults this class.
	 *
	 * An OPTION, not a file under base_dir: the point of the hold is to survive
	 * deactivate/remove/reinstall, and base_dir is operator storage a reinstall
	 * may well wipe (`/tmp/newspack-nodes` by default). A hold that evaporates
	 * halfway through the thing it protects is worse than no hold.
	 */
	public const HOLD_OPTION = 'newspack_nodes_hold';

	/** Runtime state root holding locks/ and ipc/, trailing slash trimmed. */
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
		$this->nonce_salt = $nonce_salt ?? self::spawn_key();
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
		$this->reap_steal_scratch_dirs( "{$this->base_dir}/locks" );
		foreach ( $this->worker_lock_dirs() as $path => $lock ) {
			if ( $lock['partition'] < ( $active[ $lock['type'] ] ?? 0 ) ) {
				continue; // In fleet.
			}
			$this->remove_stale_directory( $path, Lock_Node::STALE_TIMEOUT );
			if ( \is_dir( $path ) && ! \file_exists( $path . '/' . Lock_Node::RESTART_FLAG ) ) {
				Lock_Node::request_restart_at( $path );
			}
		}
	}

	/**
	 * Remove `$dir` when its newest child is older than `$stale_age_s`, symlink-safe
	 * and contained under base_dir.
	 *
	 * A directory yielding no readable child mtime survives, because nothing dates
	 * it — an empty lock dir is a mid-acquire one. A symlink or a plain file at
	 * `$dir` is unlinked outright rather than walked, so the recursion can never
	 * follow a link out of base_dir.
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
	 * Every worker lock dir under `locks/`, as `path => {type, partition}`.
	 *
	 * The `{type}.p{N}.lock.d` layout, read ONCE here beside the `lock_path()`
	 * that writes it. A second hand-written walk drifts to a narrower glob or a
	 * weaker regex, and then one pass retires a dir another pass never sees.
	 *
	 * @return array<string,array{type:string,partition:int}>
	 */
	public function worker_lock_dirs(): array {
		$out = [];
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_glob -- Operator storage, never WP-managed.
		foreach ( \glob( "{$this->base_dir}/locks/*.lock.d" ) ?: [] as $path ) {
			if ( ! \preg_match( '/^(.+)\.p(\d+)$/', \basename( $path, '.lock.d' ), $m ) ) {
				continue; // Non-partitioned dir — not a worker.
			}
			$out[ $path ] = [ 'type' => $m[1], 'partition' => (int) $m[2] ];
		}
		return $out;
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
		$due     = \array_filter( $workers, fn ( array $worker ): bool => $this->worker_needs_spawn( $worker, $now ) );
		return $this->spawn_each( $due, 'spawn failed', $now );
	}

	/**
	 * True when `$worker` is due a spawn: no lock dir at all, or a lock whose
	 * heartbeat has aged past the descriptor's own stale timeout.
	 *
	 * The one exception is a cleanly ABSENT on-demand worker, which is asleep by
	 * design and reads as not due; the wake paths own its revival. A STALE lock
	 * spawns whatever the worker's kind, because a worker that died holding one
	 * crashed, and crash recovery is this scan's job.
	 *
	 * @param array<string,mixed> $worker Worker descriptor (type, partition, …).
	 * @param float               $now    Pass clock.
	 * @return bool True when this worker warrants a spawn POST.
	 */
	public function worker_needs_spawn( array $worker, float $now ): bool {
		$type      = Core::as_string( $worker['type'] );
		$partition = Core::as_int( $worker['partition'] );
		$stale     = Lock_Node::stale_timeout_of( $worker );

		$dir = $this->lock_path( $type, $partition );
		if ( ! \is_dir( $dir ) ) {
			// Clean absence is normal on-demand; a producer wakes it, not us.
			return 0 === Bootstrap::on_demand_idle_of( $worker );
		}
		// A stale lock is a worker that died holding it — a crash either way.
		return Lock_Node::heartbeat_is_stale( $dir, (int) $now, $stale );
	}

	/**
	 * Wake every absent on-demand reader whose partition holds unread bytes.
	 *
	 * `wake_on_demand()` is driven by a write this process performed, so it only
	 * ever sees producers that went through `Partition_Node::fill()`. A producer
	 * outside the substrate — gyrobase appending to a segment in Perl — marks
	 * nothing, and `worker_needs_spawn()` deliberately declines to resurrect a
	 * cleanly-absent on-demand worker, so without this pass nothing brings that
	 * reader back at all. This is the fallback tier `wake_on_demand()` names.
	 *
	 * Backlog, not presence: a partition that exists but is drained must not wake
	 * anyone, or the minute pass quietly restores the resident fleet on-demand
	 * replaced. A live reader is skipped before its partition is ever read, and
	 * so is a reader whose cursor is unknown — an ephemeral one keeps none, and
	 * one that has not checkpointed yet reports the whole partition by default.
	 * Reading either as "all of it is behind" respawns it on every pass forever,
	 * which is the same resident fleet by another route.
	 *
	 * Spawns the SPECIFIC backlogged worker rather than delegating to
	 * `wake_on_demand()`, which wakes every absent reader of the directory: two
	 * ELN topologies tail the firehose, so a behind job-router would otherwise
	 * drag a drained request-builder up with it, every minute.
	 *
	 * @param float $now Clock, so one pass judges every worker alike.
	 * @return int Spawns posted.
	 */
	public function wake_readers_with_backlog( float $now ): int {
		$behind = [];
		foreach ( Bootstrap::on_demand_wake_map() as $dir => $readers ) {
			foreach ( $readers as $worker ) {
				if ( ! $this->is_absent( $worker ) ) {
					continue;
				}
				// No durable cursor is no opinion, not "all of it is behind".
				$cursor = Core::as_string( $worker['offsetlog_dir'] ?? '' );
				if ( '' === $cursor ) {
					continue;
				}
				$lag = Consumer_Node::lag_from_disk( $dir, $cursor );
				if ( ! $lag['cursor_known'] || 0 === $lag['bytes_behind'] ) {
					continue;
				}
				$behind[] = $worker;
			}
		}
		return $this->spawn_each( $behind, 'backlog wake failed', $now );
	}

	/**
	 * True when no lock dir stands for `$worker` — absent, not merely stale. A
	 * STALE lock is a crash, and the ordinary spawn scan owns crash recovery.
	 *
	 * @param array<array-key,mixed> $worker Worker descriptor.
	 * @return bool True when the worker holds no lock dir.
	 */
	private function is_absent( array $worker ): bool {
		return ! \is_dir( $this->lock_path(
			Core::as_string( $worker['type'] ),
			Core::as_int( $worker['partition'] )
		) );
	}

	/**
	 * The lock directory one worker acquires. THE writer of the
	 * `{type}.p{N}.lock.d` layout `worker_lock_dirs()` reads back.
	 *
	 * @param string $type      Worker type.
	 * @param int    $partition Partition number.
	 * @return string Absolute path, which need not exist.
	 */
	public function lock_path( string $type, int $partition ): string {
		return "{$this->base_dir}/locks/{$type}.p{$partition}.lock.d";
	}

	/**
	 * Wake the on-demand worker `$worker_id` names; false when it names none.
	 *
	 * ONE rule, shared by every entry point that meets an absent worker: a
	 * cleanly absent on-demand worker is asleep BY DESIGN and holds no lock dir,
	 * so a caller that refuses on the missing lock alone never wakes one — which
	 * is what an attach, and a request-scope Partition mount, both need. A
	 * resident worker with no lock dir is a typo or a dead fleet, and stays
	 * refused.
	 *
	 * Matches on the id the FLEET spells (`{type}.p{N}`, unpadded), because that
	 * is the ipc/ tree the caller goes on to read; a padded id names no worker
	 * and must refuse rather than wake a different partition.
	 *
	 * @param string $worker_id `{type}.p{N}`.
	 * @param float  $now       Clock, so one pass judges every worker alike.
	 * @return bool True when the id names an on-demand worker; the wake itself is
	 *              fire-and-forget, and the throttle may still swallow it.
	 */
	public function wake_sleeping_worker( string $worker_id, float $now ): bool {
		foreach ( Bootstrap::expand_workers() as $worker ) {
			if ( 0 === Bootstrap::on_demand_idle_of( $worker ) ) {
				continue;
			}
			$id = Core::as_string( $worker['type'] ) . '.p' . Core::as_int( $worker['partition'] );
			if ( $id !== $worker_id ) {
				continue;
			}
			$this->wake_on_demand( "{$this->base_dir}/ipc/{$worker_id}/input", $now );
			return true;
		}
		return false;
	}

	/**
	 * Wake every absent on-demand worker owning $partition. Fire-and-forget.
	 *
	 * The counterpart to `worker_needs_spawn()` refusing to resurrect a cleanly
	 * absent on-demand worker: something has to bring it back, and WP-Cron at
	 * minute cadence is the fallback tier rather than the mechanism. A producer
	 * that just wrote work calls this.
	 *
	 * Only workers that TAIL `$dir` are woken — `Bootstrap::on_demand_wake_map()`
	 * resolves that off the TSL and caches it — so queueing a job cannot boot a
	 * firehose reader. The 15s throttle means a burst costs one spawn.
	 *
	 * A STALE lock is left alone: that worker crashed, and the ordinary spawn
	 * scan already owns crash recovery.
	 *
	 * @param string $dir Resolved partition directory just written to.
	 * @param float  $now Clock, so one enqueue judges every worker alike.
	 * @return int Spawns posted.
	 */
	public function wake_on_demand( string $dir, float $now ): int {
		$dir     = \rtrim( $dir, '/' );
		$readers = $this->ipc_reader_of( $dir ) ?? ( Bootstrap::on_demand_wake_map()[ $dir ] ?? [] );
		if ( [] === $readers ) {
			return 0; // A write path: don't mint a token for nobody.
		}
		return $this->spawn_each(
			\array_filter( $readers, fn ( array $worker ): bool => $this->is_absent( $worker ) ),
			'wake failed',
			$now
		);
	}

	/**
	 * The on-demand worker whose IPC tree `$dir` sits in, or null when it isn't
	 * one — the same rule as any other partition, resolved a shorter way.
	 *
	 * IPC needs no map entry because the PATH names its worker: this layout is
	 * the substrate's own (`Spawn_Coordinator::lock_path()` and
	 * `Cli::attach_to_worker()` already build and read it), not a user-authored
	 * template, so reading an identity out of it assumes nothing about where a
	 * `<partition>` token sits in someone's TSL.
	 *
	 * @param string $dir Resolved partition directory.
	 * @return list<array<array-key,mixed>>|null Null when $dir is not under ipc/.
	 */
	private function ipc_reader_of( string $dir ): ?array {
		$prefix = $this->base_dir . '/ipc/';
		if ( ! \str_starts_with( $dir, $prefix ) ) {
			return null;
		}
		$worker_id = \explode( '/', \substr( $dir, \strlen( $prefix ) ) )[0];
		foreach ( Bootstrap::expand_workers() as $worker ) {
			if ( 0 === Bootstrap::on_demand_idle_of( $worker ) ) {
				continue;
			}
			if ( $worker_id === Core::as_string( $worker['type'] ) . '.p' . Core::as_int( $worker['partition'] ) ) {
				return [ $worker ];
			}
		}
		return [];
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
	 * The recursion itself: depth bound, plus a symlink refusal at every node.
	 * Containment is checked once by the public entry point, so this helper is
	 * private — reached with an already-vetted root and never from outside.
	 *
	 * @param string $path      Directory to walk.
	 * @param int    $max_depth Depth ceiling; a deeper node is left standing.
	 * @param int    $depth     Depth of $path, 0 at the vetted root.
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
	 * Spawn every partition of one fleet NOW, without waiting for a scan.
	 * Symmetric with kill_readers(); called from request scope on topology
	 * activation. The caller must already have added $name to the active set,
	 * or each worker's self-respawn is refused by Spawn_Controller.
	 *
	 * @param string $name Topology / worker type.
	 * @return int Spawn POSTs requested — never a count of workers started.
	 */
	public function spawn_fleet( string $name ): int {
		$fleet = \array_filter(
			Bootstrap::expand_workers(),
			static fn ( array $worker ): bool => $name === $worker['type']
		);
		return $this->spawn_each( $fleet, 'fleet spawn failed', (float) \time() );
	}

	/**
	 * The ONE spawn loop: drop what the shared throttle suppresses, refuse a
	 * write-conflicting active set, resolve the endpoint and mint one token for
	 * the pass, then POST each survivor, report under `$label`, and record the
	 * POST locally.
	 *
	 * Every entry point differs only in the worker list it computes, which is its
	 * actual job. A hand-copied second loop drops the local record and re-posts
	 * what it just spawned, or swallows the transport error and reports a fleet
	 * that never came up.
	 *
	 * The refusal is a property of the SET, so it is judged over the configured
	 * active topologies rather than the workers handed in — a single fleet cannot
	 * see the peer it would collide with. Copied per caller it goes missing from
	 * the wake paths, which are the only ones that revive an on-demand worker at
	 * all.
	 *
	 * The throttle runs FIRST because the refusal parses every configured `.tsl`
	 * and `wake_on_demand()` is driven by a write: judged the other way round,
	 * every request that writes pays a full topology parse for the whole window.
	 *
	 * Counts POSTS REQUESTED, not workers started: `fire_and_forget_post` hangs
	 * up before any outcome, and the endpoint records accepted spawns only after
	 * control has returned here — which is why the local record cannot wait.
	 *
	 * @param array<array-key,array<array-key,mixed>> $workers Descriptors to spawn (fleet or wake-map shape).
	 * @param string                                  $label   Failure-report verb, e.g. 'wake failed'.
	 * @param float                                   $now     Pass clock.
	 * @return int Spawn POSTs fired.
	 */
	public function spawn_each( array $workers, string $label, float $now ): int {
		$due = [];
		foreach ( $workers as $worker ) {
			$type      = Core::as_string( $worker['type'] );
			$partition = Core::as_int( $worker['partition'] );
			if ( ! $this->is_recently_spawned( $type, $partition, $now ) ) {
				$due[] = [ $type, $partition ];
			}
		}
		if ( [] === $due ) {
			return 0; // Nothing to POST: don't pay for the conflict walk.
		}
		// Configured names, not the catalog — asking it re-globs every .tsl.
		$names    = \array_filter( Core::arr( Config::value( 'topologies' ) ), static fn ( mixed $n ): bool => \is_string( $n ) );
		$conflict = self::conflict_description( \array_values( $names ) );
		if ( '' !== $conflict ) {
			Core::print_less_often( 'refusing to spawn — topology write-conflict: ', $conflict );
			return 0;
		}
		$spawn_url = \function_exists( 'rest_url' ) ? \rest_url( 'newspack-nodes/v1/workers/spawn' ) : '';
		if ( '' === $spawn_url ) {
			return 0;
		}
		$token = $this->generate_spawn_token( (int) $now );
		foreach ( $due as [ $type, $partition ] ) {
			$err = $this->post_spawn( $spawn_url, $type, $partition, $token );
			if ( null !== $err ) {
				Core::print_less_often( "{$label} for {$type}.p{$partition}: ", $err );
			}
			$this->record_spawn_local( $type, $partition, $now );
		}
		return \count( $due );
	}

	/**
	 * Record a spawn POST in-memory only. The tick loop uses this: persisting
	 * here would make the endpoint (which records on accept) reject the very
	 * POST this record announces.
	 *
	 * @param string $type      Worker type.
	 * @param int    $partition Partition number.
	 * @param float  $when      Pass clock.
	 */
	private function record_spawn_local( string $type, int $partition, float $when ): void {
		$this->last_spawn_time[ "{$type}|{$partition}" ] = $when;
	}

	/**
	 * Fire-and-forget spawn POST. Returns the transport error rather than
	 * reporting it, so `spawn_each` names the pass the failure belongs to.
	 *
	 * @param string $spawn_url Fully-qualified spawn endpoint URL.
	 * @param string $type      Worker type.
	 * @param int    $partition Partition number.
	 * @param string $token     Current HMAC spawn token.
	 * @return string|null Error description, or null on success.
	 */
	private function post_spawn( string $spawn_url, string $type, int $partition, string $token ): ?string {
		return Core::fire_and_forget_post( $spawn_url, [
			'type'      => $type,
			'partition' => $partition,
			'nonce'     => $token,
		] );
	}

	/**
	 * HMAC spawn token for $now's 10s window. Per-site, never logged.
	 *
	 * @param int $now Unix time selecting the window.
	 * @return string Token the spawn endpoint accepts as its `nonce`.
	 */
	public function generate_spawn_token( int $now ): string {
		return Internal_Request_Token::generate( Internal_Request_Token::PURPOSE_SPAWN, $now, $this->nonce_salt );
	}

	/**
	 * Describe the write-conflicts in a topology set, or '' when it is safe to
	 * spawn. Two topologies writing one partition log corrupt it, so the spawn
	 * loop refuses the whole set — better no workers than two fleets. Activation
	 * consults the same analyzer to refuse persisting one in the first place.
	 *
	 * @param list<string> $types Topology names.
	 * @return string Human-readable conflict list, or '' when there is none.
	 */
	public static function conflict_description( array $types ): string {
		$conflicts = Topology_Analyzer::find_conflicts( $types );
		return empty( $conflicts ) ? '' : Topology_Analyzer::describe_conflicts( $conflicts );
	}

	/**
	 * True while `{type}.p{partition}` sits inside the shared throttle window.
	 *
	 * @param string $type      Worker type.
	 * @param int    $partition Partition number.
	 * @param float  $now       Pass clock.
	 * @return bool True while another spawn is still suppressed.
	 */
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
	 *
	 * @param string $key `{type}|{partition}`.
	 * @return float|null Recorded timestamp, or null when no tier holds one.
	 */
	protected function load_spawn_ts( string $key ): ?float {
		$cache_key = Cache_Backend::site_key( self::SPAWN_TS_CACHE_KEY . $key );

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
	 * Record an ACCEPTED spawn (in-memory + persisted). The spawn endpoint calls
	 * this — the one gate every spawn crosses — so self-respawns, peer scans and
	 * the cron pass share a single cross-process throttle window.
	 *
	 * @param string $type      Worker type.
	 * @param int    $partition Partition number.
	 * @param float  $when      Time the endpoint accepted the spawn.
	 */
	public function record_spawn( string $type, int $partition, float $when ): void {
		$key                          = "{$type}|{$partition}";
		$this->last_spawn_time[ $key ] = $when;
		$this->persist_spawn_ts( $key, $when );
	}

	/**
	 * Persist a spawn timestamp (Cache_Backend, transient fallback) so a respawn
	 * honors the rate limit. The TTL is twice MIN_SPAWN_INTERVAL_S, so the entry
	 * outlives the window it guards and then expires on its own — no sweep.
	 *
	 * @param string $key  `{type}|{partition}`.
	 * @param float  $when Time the spawn was accepted.
	 */
	protected function persist_spawn_ts( string $key, float $when ): void {
		$cache_key = Cache_Backend::site_key( self::SPAWN_TS_CACHE_KEY . $key );
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

	/**
	 * The spawn-token HMAC key: `wp_salt('nonce')` run through one purpose-bound
	 * derivation rather than used raw.
	 *
	 * The raw nonce salt forges every WordPress nonce on the site. This key
	 * forges spawn tokens and nothing else, which is what makes it safe to hand
	 * to a process outside PHP — nuclear-gyrobase exports it to the Perl engine
	 * so a render can ring the doorbell for a job it just queued.
	 *
	 * @return string Purpose-bound HMAC key, stable for the life of the salt.
	 */
	public static function spawn_key(): string {
		return \hash_hmac( 'sha256', 'newspack_nodes_spawn_key', \wp_salt( 'nonce' ) );
	}

	/** Unix time the deploy hold was placed, or 0 when the fleet is free to spawn. */
	public static function hold(): int {
		return \function_exists( 'get_option' ) ? Core::as_int( \get_option( self::HOLD_OPTION, 0 ) ) : 0;
	}

	/**
	 * Place the deploy hold, stamped so `doctor` can report how long it has stood.
	 *
	 * @param int $when Unix time the hold begins.
	 */
	public static function set_hold( int $when ): void {
		\update_option( self::HOLD_OPTION, $when, false );
	}

	/** Lift the deploy hold; `wp nodes start` calls it, then spawns the fleet. */
	public static function clear_hold(): void {
		\delete_option( self::HOLD_OPTION );
	}

	/**
	 * Validate against the current AND previous window — don't tighten, that
	 * straddle is deliberate.
	 *
	 * @param string $token Token carried by the spawn request.
	 * @param int    $now   Unix time selecting the current window.
	 * @return bool True when the token matches either window.
	 */
	public function validate_spawn_token( string $token, int $now ): bool {
		return Internal_Request_Token::validate( Internal_Request_Token::PURPOSE_SPAWN, $token, $now, $this->nonce_salt );
	}

	/**
	 * Raise a restart flag on every live partition of each named group; plugins
	 * call this on deactivation. It spawns nothing and takes no lock — each
	 * worker reads its own flag on the next drain iteration and exits.
	 *
	 * A type no longer in the fleet has no partition count to consult, so it is
	 * swept across the full MAX_PARTITIONS range.
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
}
