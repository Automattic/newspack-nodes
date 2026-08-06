<?php
/**
 * Fleet_Sweep: the fleet's housekeeping, as an ordinary job.
 *
 * Revival cannot be a job — a dead fleet has no worker to run one — so the
 * peer-spawn scan stays inline in Fleet_Node. Everything else can, and should:
 * these are destructive sweeps and third-party hooks, which want single
 * execution, retries, quarantine and a memory-managed host. Job_Worker_Node is
 * built for exactly that, and Job_Intake's `unique` claim gives us
 * one-per-window across N scanners with no lock to leak.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Fleet_Sweep {

	/** Job handler name, registered on `newspack_nodes/job_handlers`. */
	public const HANDLER = 'nodes_fleet_sweep';

	/** Sweep cadence; also the width of the unique-claim window. */
	public const INTERVAL_S = 15;

	/** Claim ttl. Wider than the window so a lagging clock can't re-win a window its peers have left. */
	private const CLAIM_TTL_S = 20;

	/**
	 * The sweep. Each step is independent, so one failure must not cost the
	 * others — a third-party `periodic` subscriber that throws would
	 * otherwise stop retention and ipc reaping for the whole fleet, and burn the
	 * job's retries until housekeeping dead-lettered. A `Worker_Should_Stop` is
	 * the exception: it is a lifecycle signal, not a failure, and ADR-14 requires
	 * every broad catch on the drain path to let it through.
	 *
	 * @param array<string, mixed> $parameters Unused; the sweep takes no arguments.
	 */
	public static function run( array $parameters = [] ): void {
		$base_dir = Bootstrap::base_dir();
		self::step( 'reconcile', static fn() => self::reconcile_lock_dirs( $base_dir ) );
		self::step( 'retention', static fn() => Log_Cleaner::cleanup_orphan_partitions( $base_dir ) );
		self::step( 'orphan-ipc', static fn() => self::cleanup_orphan_ipc( $base_dir ) );
		self::step( 'periodic', static function (): void {
			if ( \function_exists( 'do_action' ) ) {
				\do_action( 'newspack_nodes/periodic' );
			}
		} );
	}

	/** Run one sweep step, reporting rather than propagating. */
	private static function step( string $label, callable $work ): void {
		try {
			$work();
		} catch ( Worker_Should_Stop $e ) {
			throw $e; // ADR-14: a cooperative stop is not an error.
		} catch ( \Throwable $e ) {
			Core::print_less_often( "fleet sweep step '{$label}' failed: ", $e->getMessage() );
		}
	}

	/**
	 * Reconcile every on-disk `*.lock.d` against the active fleet: a partition
	 * past its topology's count is removed if stale, then flagged to retire.
	 *
	 * Order matters — remove_stale_directory must run BEFORE request_restart_at,
	 * or the flag's fresh mtime blocks the removal.
	 *
	 * @param string $base_dir Runtime state root.
	 */
	private static function reconcile_lock_dirs( string $base_dir ): void {
		$active = [];
		foreach ( Bootstrap::expand_workers() as $worker ) {
			$active[ $worker['type'] ] = \max( $active[ $worker['type'] ] ?? 0, $worker['partition'] + 1 );
		}
		if ( empty( $active ) ) {
			return; // No known fleet: every dir would read as an orphan.
		}
		$locks_dir  = "{$base_dir}/locks";
		$coordinator = new Spawn_Coordinator( $base_dir );
		self::reap_steal_scratch_dirs( $locks_dir, $base_dir );
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_glob -- Operator storage, never WP-managed.
		foreach ( \glob( "{$locks_dir}/*.lock.d" ) ?: [] as $path ) {
			if ( ! \preg_match( '/^(.+)\.p(\d+)$/', \basename( $path, '.lock.d' ), $m ) ) {
				continue; // Non-partitioned dir — not a worker.
			}
			if ( (int) $m[2] < ( $active[ $m[1] ] ?? 0 ) ) {
				continue; // In fleet.
			}
			$coordinator->remove_stale_directory( $path, Lock_Node::STALE_TIMEOUT );
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
	 * @param string $base_dir  Containment root.
	 */
	private static function reap_steal_scratch_dirs( string $locks_dir, string $base_dir ): void {
		$cutoff = \time() - Lock_Node::STALE_TIMEOUT;
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_glob -- Operator storage, never WP-managed.
		foreach ( \glob( "{$locks_dir}/*.lock.d.stealing.*", \GLOB_ONLYDIR ) ?: [] as $path ) {
			\clearstatcache( true, $path );
			$mtime = @\filemtime( $path );
			if ( false === $mtime || $mtime > $cutoff ) {
				continue; // Unreadable or an in-flight steal — leave it.
			}
			Spawn_Coordinator::delete_directory_recursive( $path, $base_dir );
		}
	}

	/**
	 * Reap ipc dirs for workers no longer in the fleet. A live worker's lock dir
	 * defers its own removal, so a worker mid-recycle keeps its IPC.
	 *
	 * @param string $base_dir Runtime state root.
	 */
	private static function cleanup_orphan_ipc( string $base_dir ): void {
		$active = [];
		foreach ( Bootstrap::expand_workers() as $worker ) {
			$active[ "{$worker['type']}.p{$worker['partition']}" ] = true;
		}
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_glob -- Operator storage, never WP-managed.
		foreach ( \glob( "{$base_dir}/ipc/*.p*", \GLOB_ONLYDIR ) ?: [] as $dir ) {
			$name = \basename( $dir );
			if ( isset( $active[ $name ] ) || ! \preg_match( '/\.p\d+$/', $name ) ) {
				continue;
			}
			if ( \is_dir( "{$base_dir}/locks/{$name}.lock.d" ) ) {
				continue; // A live worker still holds it.
			}
			Spawn_Coordinator::delete_directory_recursive( $dir, $base_dir );
		}
	}

	/**
	 * `newspack_nodes/job_handlers` registration.
	 *
	 * @param array<string, callable> $handlers Handler map.
	 * @return array<string, callable>
	 */
	public static function register( array $handlers ): array {
		$handlers[ self::HANDLER ] = [ self::class, 'run' ];
		return $handlers;
	}

	/**
	 * Enqueue at most one sweep for this window, fleet-wide. Every scanner calls
	 * this every check; the atomic `add()` behind `unique` picks the winner.
	 *
	 * Never scheduled: `Job_Delay::sweep_action()` runs INSIDE the sweep, so a
	 * delayed sweep would depend on the machinery it exists to drive.
	 *
	 * Reports every failure rather than raising it: the claim needs memcached or
	 * APCu, and a host with neither must still revive workers — revival may not
	 * depend on housekeeping. The single exception is `Worker_Should_Stop`, which
	 * the intake write can raise from `pump()` and which ADR-14 forbids eating.
	 *
	 * Never BLOCKS either: every caller is inside a worker's drain loop, where
	 * the default write-lock wait outlasts the lock stale_timeout and would get
	 * the caller's own lock stolen out from under it. A contended window is
	 * simply skipped; the next tick tries again.
	 *
	 * @param float $now Tick clock.
	 * @return bool True when this caller won the window.
	 */
	public static function enqueue( float $now ): bool {
		try {
			return Job_Intake::try_queue( self::HANDLER, [], [
				'unique'     => (string) \intdiv( (int) $now, self::INTERVAL_S ),
				'unique_ttl' => self::CLAIM_TTL_S,
			] );
		} catch ( Worker_Should_Stop $e ) {
			throw $e; // ADR-14: a cooperative stop is not an error.
		} catch ( \Throwable $e ) {
			Core::print_less_often( 'fleet sweep not enqueued: ', $e->getMessage() );
			return false;
		}
	}
}
