<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Log_Cleaner;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Log_Cleaner::class )]
class LogCleanerTest extends TestCase {
	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		// Filter callbacks added by a previous test in this class leak
		// through the parent's option-only reset; wipe them so each test
		// sees a clean expected_log_basenames chain.
		$GLOBALS['_wp_actions'] = [];
		$this->tmp = $this->make_temp_dir();
		\mkdir( "{$this->tmp}/logs", 0755, true );
		\mkdir( "{$this->tmp}/offsets", 0755, true );
		\mkdir( "{$this->tmp}/locks", 0755, true );
		// Default: arm the dirty flag so the existing tests (which
		// exercise the cleanup behavior itself) run the sweep. Tests
		// that exercise the gate explicitly clear the flag.
		\update_option( Log_Cleaner::LOGS_DIRTY_OPTION, '1' );
	}

	protected function tearDown(): void {
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	private function seed_log_partition( string $log_name, int $partition, int $bytes = 100 ): string {
		$dir = "{$this->tmp}/logs/{$log_name}.log/p{$partition}";
		\mkdir( $dir, 0755, true );
		\file_put_contents( "{$dir}/0.log", \str_repeat( 'X', $bytes ) );
		return $dir;
	}

	private function seed_offsetlog_partition( string $source, int $partition ): string {
		$dir = "{$this->tmp}/offsets/{$source}.p{$partition}/p0";
		\mkdir( $dir, 0755, true );
		\file_put_contents( "{$dir}/0.log", 'offsetlog data' );
		return "{$this->tmp}/offsets/{$source}.p{$partition}";
	}

	private function seed_lock_dir( string $type, int $partition ): string {
		$dir = "{$this->tmp}/locks/{$type}.p{$partition}.lock.d";
		\mkdir( $dir, 0755, true );
		\file_put_contents( "{$dir}/heartbeat", (string) \getmypid() );
		return $dir;
	}

	public function test_deletes_log_partition_dir_when_n_above_num_partitions_and_no_lock(): void {
		$p1 = $this->seed_log_partition( 'firehose', 1 );
		$this->assertDirectoryExists( $p1 );

		Log_Cleaner::cleanup_orphan_partitions( $this->tmp, 1 );

		$this->assertDirectoryDoesNotExist( $p1 );
	}

	public function test_skips_log_partition_dir_when_lock_dir_exists(): void {
		$p1 = $this->seed_log_partition( 'firehose', 1 );
		$this->seed_lock_dir( 'firehose-workers', 1 );

		Log_Cleaner::cleanup_orphan_partitions( $this->tmp, 1 );

		$this->assertDirectoryExists( $p1 );
	}

	public function test_skips_log_partition_dir_when_some_other_workers_lock_exists(): void {
		$p1 = $this->seed_log_partition( 'firehose', 1 );
		// Any worker type holding partition 1 means we can't clean.
		$this->seed_lock_dir( 'request-workers', 1 );

		Log_Cleaner::cleanup_orphan_partitions( $this->tmp, 1 );

		$this->assertDirectoryExists( $p1 );
	}

	public function test_skips_log_partition_dir_when_n_below_num_partitions(): void {
		$p0 = $this->seed_log_partition( 'firehose', 0 );

		Log_Cleaner::cleanup_orphan_partitions( $this->tmp, 1 );

		$this->assertDirectoryExists( $p0 );
	}

	public function test_deletes_offsetlog_dir_when_n_above_num_partitions_and_no_lock(): void {
		$dir = $this->seed_offsetlog_partition( 'firehose', 1 );
		$this->assertDirectoryExists( $dir );

		Log_Cleaner::cleanup_orphan_partitions( $this->tmp, 1 );

		$this->assertDirectoryDoesNotExist( $dir );
	}

	public function test_skips_offsetlog_dir_when_lock_dir_exists(): void {
		$dir = $this->seed_offsetlog_partition( 'firehose', 1 );
		$this->seed_lock_dir( 'firehose-workers', 1 );

		Log_Cleaner::cleanup_orphan_partitions( $this->tmp, 1 );

		$this->assertDirectoryExists( $dir );
	}

	public function test_skips_offsetlog_dir_when_n_below_num_partitions(): void {
		$dir = $this->seed_offsetlog_partition( 'firehose', 0 );

		Log_Cleaner::cleanup_orphan_partitions( $this->tmp, 1 );

		$this->assertDirectoryExists( $dir );
	}

	public function test_deletes_recursively_with_nested_subdirs_and_files(): void {
		$p2 = "{$this->tmp}/logs/firehose.log/p2";
		\mkdir( "{$p2}/sub/inner", 0755, true );
		\file_put_contents( "{$p2}/0.log", 'top' );
		\file_put_contents( "{$p2}/0.idx", 'idx' );
		\file_put_contents( "{$p2}/sub/x.log", 'mid' );
		\file_put_contents( "{$p2}/sub/inner/y.log", 'deep' );

		Log_Cleaner::cleanup_orphan_partitions( $this->tmp, 1 );

		$this->assertDirectoryDoesNotExist( $p2 );
	}

	public function test_cleans_multiple_logs_in_one_pass(): void {
		$a = $this->seed_log_partition( 'firehose', 1 );
		$b = $this->seed_log_partition( 'requests', 1 );
		$c = $this->seed_log_partition( 'errors', 2 );

		Log_Cleaner::cleanup_orphan_partitions( $this->tmp, 1 );

		$this->assertDirectoryDoesNotExist( $a );
		$this->assertDirectoryDoesNotExist( $b );
		$this->assertDirectoryDoesNotExist( $c );
	}

	public function test_returns_list_of_deleted_paths(): void {
		$p1 = $this->seed_log_partition( 'firehose', 1 );
		$off = $this->seed_offsetlog_partition( 'firehose', 1 );

		$deleted = Log_Cleaner::cleanup_orphan_partitions( $this->tmp, 1 );

		$this->assertContains( $p1, $deleted );
		$this->assertContains( $off, $deleted );
	}

	public function test_handles_missing_subtrees_gracefully(): void {
		$bare = $this->make_temp_dir();
		// no logs/ or offsets/ subdir
		$deleted = Log_Cleaner::cleanup_orphan_partitions( $bare, 1 );
		$this->assertSame( [], $deleted );
		$this->rmdir_recursive( $bare );
	}

	// ── Orphan log-dir cleanup ────────────────────────────────────────────

	public function test_deletes_log_dir_not_in_expected_basenames(): void {
		// `flames.log` is orphan — filter doesn't include 'flames'. With no
		// `*.lock.d` blocking, the whole dir (every partition) is removed.
		$log_dir = "{$this->tmp}/logs/flames.log";
		\mkdir( "{$log_dir}/p0", 0755, true );
		\file_put_contents( "{$log_dir}/p0/0.log", 'stale' );

		\add_filter(
			'newspack_nodes/expected_log_basenames',
			static fn() => [ 'firehose', 'requests', 'errors' ]
		);

		Log_Cleaner::cleanup_orphan_partitions( $this->tmp, 1 );

		$this->assertDirectoryDoesNotExist( $log_dir );
	}

	public function test_skips_log_dir_when_basename_is_in_expected_set(): void {
		$log_dir = "{$this->tmp}/logs/firehose.log";
		\mkdir( "{$log_dir}/p0", 0755, true );
		\file_put_contents( "{$log_dir}/p0/0.log", 'live' );

		\add_filter(
			'newspack_nodes/expected_log_basenames',
			static fn() => [ 'firehose', 'requests' ]
		);

		Log_Cleaner::cleanup_orphan_partitions( $this->tmp, 1 );

		$this->assertDirectoryExists( $log_dir );
	}

	public function test_log_dir_lock_safety_is_delegated_to_the_filter(): void {
		// Substrate trusts the filter. A blanket "defer if any lock dir
		// exists" gate would permanently block cleanup in any live
		// system (workers are always running for the survivors), so
		// safety lives in the application's filter implementation — its
		// job is to keep a basename "expected" until the workers for it
		// are gone. A test for the application's runtime-aware logic
		// lives in ExpectedLogBasenamesTest in event-logger-nodes.
		$log_dir = "{$this->tmp}/logs/flames.log";
		\mkdir( "{$log_dir}/p0", 0755, true );
		\file_put_contents( "{$log_dir}/p0/0.log", 'whatever' );
		\mkdir( "{$this->tmp}/locks/request-workers.p0.lock.d", 0755, true );
		\file_put_contents(
			"{$this->tmp}/locks/request-workers.p0.lock.d/heartbeat",
			(string) \getmypid()
		);
		\add_filter(
			'newspack_nodes/expected_log_basenames',
			static fn() => [ 'firehose' ]
		);

		Log_Cleaner::cleanup_orphan_partitions( $this->tmp, 1 );

		// Filter excluded 'flames' → substrate deletes regardless of locks.
		$this->assertDirectoryDoesNotExist( $log_dir );
	}

	public function test_empty_expected_basenames_filter_disables_log_dir_cleanup(): void {
		// Back-compat: when no application registers the filter (or it
		// returns an empty list), only partition-slice cleanup runs.
		// Otherwise a misconfigured / not-yet-loaded app would auto-
		// delete every log dir on the spot.
		$log_dir = "{$this->tmp}/logs/firehose.log";
		\mkdir( "{$log_dir}/p0", 0755, true );
		\file_put_contents( "{$log_dir}/p0/0.log", 'live' );

		Log_Cleaner::cleanup_orphan_partitions( $this->tmp, 1 );

		$this->assertDirectoryExists( $log_dir );
	}

	// ── expected_basenames: substrate computes the topology-derived set ─────

	public function test_expected_basenames_unions_active_topology_basenames(): void {
		// Substrate computes the base expected set itself — apps just register
		// a filter to append runtime basenames they manage outside the topology
		// graph. The base set is the union of every active topology's TSL
		// Partition basenames, ignoring the filter input.
		$stock = "{$this->tmp}/topologies";
		\mkdir( $stock, 0755, true );
		\file_put_contents(
			"{$stock}/firehose-workers-only.tsl",
			"make_node Partition completed:partition <config:logs_dir>/completed.log <partition> 1048576 <config:num_segments> <config:max_lifespan>\n"
			. "make_node Partition errors:partition <config:logs_dir>/errors.log <partition> <config:segment_size> <config:num_segments> <config:max_lifespan>\n"
		);
		\Newspack_Nodes\Topology_Registry::register_stock_dir( $stock );

		// Operator-overlay names this topology.
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'firehose-workers-only' ];

		$result = Log_Cleaner::expected_basenames( $this->tmp );

		\sort( $result );
		$this->assertSame( [ 'completed', 'errors' ], $result );

		\Newspack_Nodes\Topology_Registry::reset();
	}

	public function test_expected_basenames_runs_filter_after_topology_derivation(): void {
		// App callback appends runtime-pinned basenames; the substrate seeds
		// the filter input with the topology-derived set so the callback
		// stays a pure "I add X" — never has to recompute substrate state.
		$stock = "{$this->tmp}/topologies";
		\mkdir( $stock, 0755, true );
		\file_put_contents(
			"{$stock}/job-workers.tsl",
			"make_node Partition jobs:partition <config:logs_dir>/jobs.log <partition> <config:segment_size> <config:num_segments> <config:max_lifespan>\n"
		);
		\Newspack_Nodes\Topology_Registry::register_stock_dir( $stock );
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'job-workers' ];

		\add_filter(
			'newspack_nodes/expected_log_basenames',
			static fn ( array $basenames ): array => \array_merge( $basenames, [ 'firehose', 'jobintake' ] )
		);

		$result = Log_Cleaner::expected_basenames( $this->tmp );

		\sort( $result );
		$this->assertSame( [ 'firehose', 'jobintake', 'jobs' ], $result );

		\Newspack_Nodes\Topology_Registry::reset();
	}

	public function test_expected_basenames_includes_running_workers_topology_basenames(): void {
		// A lock dir on disk for a topology that's no longer in the active
		// set still counts — the worker may still be writing to its logs as
		// the operator-side change settles. Once the worker exits and its
		// lock dir clears, the basenames drop out on the next call.
		$stock = "{$this->tmp}/topologies";
		\mkdir( $stock, 0755, true );
		\file_put_contents(
			"{$stock}/request-workers.tsl",
			"make_node Partition flames:partition <config:logs_dir>/flames.log <partition> <config:segment_size> <config:num_segments> <config:max_lifespan>\n"
		);
		\Newspack_Nodes\Topology_Registry::register_stock_dir( $stock );

		// Operator overlay deactivated request-workers — but its worker
		// is still on disk.
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [];
		$this->seed_lock_dir( 'request-workers', 0 );

		$result = Log_Cleaner::expected_basenames( $this->tmp );

		$this->assertContains( 'flames', $result );

		\Newspack_Nodes\Topology_Registry::reset();
	}

	// ── Dirty-flag gate ───────────────────────────────────────────────────

	public function test_cleanup_is_noop_when_dirty_flag_not_set(): void {
		// Flag absent → no work, no scans, returns empty.
		\delete_option( Log_Cleaner::LOGS_DIRTY_OPTION );
		$p1 = $this->seed_log_partition( 'firehose', 1 );

		$deleted = Log_Cleaner::cleanup_orphan_partitions( $this->tmp, 1 );

		$this->assertSame( [], $deleted );
		$this->assertDirectoryExists( $p1 );
	}

	public function test_cleanup_clears_dirty_flag_after_successful_sweep(): void {
		// Flag set + an orphan we can actually delete → flag is cleared.
		$this->seed_log_partition( 'firehose', 1 );

		Log_Cleaner::cleanup_orphan_partitions( $this->tmp, 1 );

		$this->assertSame(
			false,
			\get_option( Log_Cleaner::LOGS_DIRTY_OPTION, false )
		);
	}

	public function test_cleanup_clears_dirty_flag_when_already_clean(): void {
		// Flag set but nothing to delete (no orphans on disk) — still
		// clear the flag so we don't keep scanning forever.
		Log_Cleaner::cleanup_orphan_partitions( $this->tmp, 1 );

		$this->assertSame(
			false,
			\get_option( Log_Cleaner::LOGS_DIRTY_OPTION, false )
		);
	}

	public function test_cleanup_leaves_dirty_flag_set_when_lock_blocks(): void {
		// Flag set + orphan exists + lock dir present → cleanup defers,
		// flag stays so the next supervisor tick retries.
		$this->seed_log_partition( 'firehose', 1 );
		$this->seed_lock_dir( 'firehose-workers', 1 );

		Log_Cleaner::cleanup_orphan_partitions( $this->tmp, 1 );

		$this->assertSame( '1', \get_option( Log_Cleaner::LOGS_DIRTY_OPTION ) );
	}

	public function test_leaves_non_partition_subdirs_alone(): void {
		// A log dir with a non-p\d+ sibling (e.g., a future "meta" dir). Must NOT touch.
		\mkdir( "{$this->tmp}/logs/firehose.log/meta", 0755, true );
		\file_put_contents( "{$this->tmp}/logs/firehose.log/meta/info.json", '{}' );
		$this->seed_log_partition( 'firehose', 1 );

		Log_Cleaner::cleanup_orphan_partitions( $this->tmp, 1 );

		$this->assertDirectoryExists( "{$this->tmp}/logs/firehose.log/meta" );
		$this->assertFileExists( "{$this->tmp}/logs/firehose.log/meta/info.json" );
	}
}
