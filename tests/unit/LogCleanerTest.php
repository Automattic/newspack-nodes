<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
use Newspack_Nodes\Log_Cleaner;
use Newspack_Nodes\Topology_Registry;
use Newspack_Nodes\Config;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * Flat-layout, declared-set, liveness-free Log GC. The cleaner sweeps
 * `logs/*.p*` and `offsets/*.p*` against a set derived purely from config
 * (topology .tsl declarations × declared num_partitions, unioned with
 * PHP-registered producers × config num_partitions). No dirty flag, no
 * worker locks, no num_partitions param.
 */
#[CoversClass( Log_Cleaner::class )]
class LogCleanerTest extends TestCase {
	private string $tmp;
	private string $stock;

	protected function setUp(): void {
		parent::setUp();
		// Filter callbacks + active overlay leak through the parent's option-only
		// reset; wipe so each test sees a clean declared-set chain.
		$GLOBALS['_wp_actions'] = [];
		Topology_Registry::reset();
		Config::reset();
		Topology_Registry::reset_basename_cache();

		$this->tmp = $this->make_temp_dir();
		\mkdir( "{$this->tmp}/logs", 0755, true );
		\mkdir( "{$this->tmp}/offsets", 0755, true );
		\mkdir( "{$this->tmp}/locks", 0755, true );

		// The resolver-driven declared set resolves <config:logs_dir> /
		// <config:offsets_dir> against the base directory, so pin it to $this->tmp
		// (= the dir the GC sweeps) and register the token namespace.
		$this->use_base_dir( $this->tmp );
		Config::register_token_namespace();

		$this->stock = "{$this->tmp}/topologies";
		\mkdir( $this->stock, 0755, true );
		Topology_Registry::register_stock_dir( $this->stock );
	}

	protected function tearDown(): void {
		Topology_Registry::reset();
		Config::reset();
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	/** Write a topology .tsl into the registered stock dir and re-resolve caches. */
	private function declare_topology( string $name, string $contents ): void {
		\file_put_contents( "{$this->stock}/{$name}.tsl", $contents );
		Topology_Registry::reset_basename_cache();
	}

	/** Seed a flat log partition dir `logs/{name}.p{N}/0.log`; returns the dir path. */
	private function seed_log_partition( string $name, int $partition ): string {
		$dir = "{$this->tmp}/logs/{$name}.p{$partition}";
		\mkdir( $dir, 0755, true );
		\file_put_contents( "{$dir}/0.log", 'X' );
		return $dir;
	}

	/** Seed a flat offset dir `offsets/{name}.p{N}/`; returns the dir path. */
	private function seed_offset_dir( string $name, int $partition ): string {
		$dir = "{$this->tmp}/offsets/{$name}.p{$partition}";
		\mkdir( $dir, 0755, true );
		\file_put_contents( "{$dir}/0.log", 'offset' );
		return $dir;
	}

	private function partition_tsl( string $basename, int $num_partitions = 1 ): string {
		return "var num_partitions = {$num_partitions}\n"
			. "make_node Partition {$basename}:partition <config:logs_dir>/{$basename}.p<partition> <config:segment_size> <config:num_segments> <config:max_lifespan>\n";
	}

	// ── log-dir sweep ──────────────────────────────────────────────────────

	public function test_deletes_undeclared_flat_log_dir(): void {
		$this->declare_topology( 'requests-workers', $this->partition_tsl( 'requests' ) );

		$ghost = $this->seed_log_partition( 'ghost', 0 );
		$kept  = $this->seed_log_partition( 'requests', 0 );

		Log_Cleaner::cleanup_orphan_partitions( $this->tmp );

		$this->assertDirectoryDoesNotExist( $ghost );
		$this->assertDirectoryExists( $kept );
	}

	public function test_keeps_the_substrate_topicprobe_log(): void {
		// topicprobe.p0 is auto-mounted by every worker (Worker_Base), not declared
		// in any .tsl — the GC must spare it as a substrate-reserved log, else the
		// sweep wipes it between probe writes (appear → delete → recreate churn).
		$this->declare_topology( 'requests-workers', $this->partition_tsl( 'requests' ) );
		$probe = $this->seed_log_partition( 'topicprobe', 0 );

		Log_Cleaner::cleanup_orphan_partitions( $this->tmp );

		$this->assertDirectoryExists( $probe );
	}

	public function test_keeps_declared_log_dirs_all_partitions(): void {
		$this->declare_topology( 'requests-workers', $this->partition_tsl( 'requests', 2 ) );

		$p0 = $this->seed_log_partition( 'requests', 0 );
		$p1 = $this->seed_log_partition( 'requests', 1 );

		Log_Cleaner::cleanup_orphan_partitions( $this->tmp );

		$this->assertDirectoryExists( $p0 );
		$this->assertDirectoryExists( $p1 );
	}

	public function test_deletes_partition_beyond_declared_count(): void {
		$this->declare_topology( 'requests-workers', $this->partition_tsl( 'requests', 2 ) );

		$kept    = $this->seed_log_partition( 'requests', 1 );
		$orphan  = $this->seed_log_partition( 'requests', 2 );

		Log_Cleaner::cleanup_orphan_partitions( $this->tmp );

		$this->assertDirectoryExists( $kept );
		$this->assertDirectoryDoesNotExist( $orphan );
	}

	public function test_registered_producer_protects_its_partition_dirs(): void {
		// No topology declares 'firehose' — a PHP-registered producer protects it.
		\add_filter(
			'newspack_nodes/registered_log_producers',
			static fn (): array => [ 'firehose' ]
		);
		$GLOBALS['_wp_options']['newspack_nodes_num_partitions'] = 2;
		Config::reset();

		$p0 = $this->seed_log_partition( 'firehose', 0 );
		$p1 = $this->seed_log_partition( 'firehose', 1 );
		$p2 = $this->seed_log_partition( 'firehose', 2 );

		Log_Cleaner::cleanup_orphan_partitions( $this->tmp );

		$this->assertDirectoryExists( $p0 );
		$this->assertDirectoryExists( $p1 );
		$this->assertDirectoryDoesNotExist( $p2 );
	}

	public function test_empty_declared_set_skips_log_sweep(): void {
		// No topologies, no producers → declared set empty → fail-closed skip.
		$anything = $this->seed_log_partition( 'anything', 0 );

		Log_Cleaner::cleanup_orphan_partitions( $this->tmp );

		$this->assertDirectoryExists( $anything );
	}

	public function test_unresolvable_logs_root_skips_log_sweep_despite_producers(): void {
		// DATA-LOSS guard: a registered producer keeps declared_log_dirs() NON-empty,
		// but if the `<config:logs_dir>` root can't resolve ('') the topology dirs are
		// absent from the set — so the sweep would delete every topology dir while only
		// producer names are protected. Fail closed: skip the whole log sweep.
		\add_filter(
			'newspack_nodes/registered_log_producers',
			static fn (): array => [ 'firehose' ]
		);
		$this->declare_topology( 'requests-workers', $this->partition_tsl( 'requests' ) );

		$firehose = $this->seed_log_partition( 'firehose', 0 );
		$requests = $this->seed_log_partition( 'requests', 0 );

		// Drop the `config` namespace so logs_dir/offsets_dir resolve to ''.
		Core::$config_resolvers = [];

		Log_Cleaner::cleanup_orphan_partitions( $this->tmp );

		$this->assertDirectoryExists( $firehose );
		$this->assertDirectoryExists( $requests );
	}

	public function test_unresolvable_offsets_root_skips_offset_sweep(): void {
		// Offset-side fail-closed: unresolvable offsets_dir root → skip the offset sweep.
		$this->declare_topology(
			'digest',
			"make_node Consumer scored:consumer <config:logs_dir>/scored.p<partition> <config:offsets_dir>/scored.p<partition>\n"
		);
		$cursor = $this->seed_offset_dir( 'scored', 0 );

		Core::$config_resolvers = [];

		Log_Cleaner::cleanup_orphan_partitions( $this->tmp );

		$this->assertDirectoryExists( $cursor );
	}

	public function test_sweeps_undeclared_non_partition_dir(): void {
		// Layout-agnostic: keep ONLY declared first-level dirs. An undeclared dir
		// whose name has no `.p{N}` suffix is now an orphan and IS swept.
		$this->declare_topology( 'requests-workers', $this->partition_tsl( 'requests' ) );

		\mkdir( "{$this->tmp}/logs/notapartition", 0755, true );
		\file_put_contents( "{$this->tmp}/logs/notapartition/info.json", '{}' );

		Log_Cleaner::cleanup_orphan_partitions( $this->tmp );

		$this->assertDirectoryDoesNotExist( "{$this->tmp}/logs/notapartition" );
	}

	public function test_keeps_arbitrary_partition_placement_sweeps_ghost(): void {
		// A topology declaring `<config:logs_dir>/<partition>-req` (token in PREFIX
		// position) must keep `0-req`/`1-req` and sweep an undeclared `ghost.p9`.
		$this->declare_topology(
			'req-workers',
			"var num_partitions = 2\n"
			. "make_node Partition req:p <config:logs_dir>/<partition>-req 1 2 0\n"
		);

		\mkdir( "{$this->tmp}/logs/0-req", 0755, true );
		\file_put_contents( "{$this->tmp}/logs/0-req/0.log", 'X' );
		\mkdir( "{$this->tmp}/logs/1-req", 0755, true );
		\file_put_contents( "{$this->tmp}/logs/1-req/0.log", 'X' );
		$ghost = $this->seed_log_partition( 'ghost', 9 );

		Log_Cleaner::cleanup_orphan_partitions( $this->tmp );

		$this->assertDirectoryExists( "{$this->tmp}/logs/0-req" );
		$this->assertDirectoryExists( "{$this->tmp}/logs/1-req" );
		$this->assertDirectoryDoesNotExist( $ghost );
	}

	public function test_deletes_recursively_with_nested_subdirs(): void {
		$this->declare_topology( 'requests-workers', $this->partition_tsl( 'requests' ) );

		$ghost = "{$this->tmp}/logs/ghost.p0";
		\mkdir( "{$ghost}/sub/inner", 0755, true );
		\file_put_contents( "{$ghost}/0.log", 'top' );
		\file_put_contents( "{$ghost}/sub/inner/y.log", 'deep' );

		Log_Cleaner::cleanup_orphan_partitions( $this->tmp );

		$this->assertDirectoryDoesNotExist( $ghost );
	}

	public function test_returns_list_of_deleted_paths(): void {
		$this->declare_topology( 'requests-workers', $this->partition_tsl( 'requests' ) );
		$ghost = $this->seed_log_partition( 'ghost', 0 );

		$deleted = Log_Cleaner::cleanup_orphan_partitions( $this->tmp );

		$this->assertContains( $ghost, $deleted );
	}

	public function test_handles_missing_subtrees_gracefully(): void {
		$this->declare_topology( 'requests-workers', $this->partition_tsl( 'requests' ) );
		$bare = $this->make_temp_dir();

		$deleted = Log_Cleaner::cleanup_orphan_partitions( $bare );

		$this->assertSame( [], $deleted );
		$this->rmdir_recursive( $bare );
	}

	// ── offset-dir sweep ───────────────────────────────────────────────────

	public function test_deletes_undeclared_offset_dir(): void {
		$this->declare_topology(
			'digest',
			"make_node Consumer scored:consumer <config:logs_dir>/scored.p<partition> <config:offsets_dir>/scored.p<partition>\n"
		);

		$kept   = $this->seed_offset_dir( 'scored', 0 );
		$orphan = $this->seed_offset_dir( 'summarized', 0 );

		Log_Cleaner::cleanup_orphan_partitions( $this->tmp );

		$this->assertDirectoryExists( $kept );
		$this->assertDirectoryDoesNotExist( $orphan );
	}

	public function test_keeps_declared_offset_dir(): void {
		$this->declare_topology(
			'digest',
			"make_node Consumer scored:consumer <config:logs_dir>/scored.p<partition> <config:offsets_dir>/scored.p<partition>\n"
		);

		$kept = $this->seed_offset_dir( 'scored', 0 );

		Log_Cleaner::cleanup_orphan_partitions( $this->tmp );

		$this->assertDirectoryExists( $kept );
	}

	public function test_empty_offset_set_skips_offset_sweep(): void {
		// A topology declares a Partition (so the log sweep runs) but NO
		// Consumer offsetlog → offset declared set empty → fail-closed skip.
		$this->declare_topology( 'requests-workers', $this->partition_tsl( 'requests' ) );

		$orphan = $this->seed_offset_dir( 'anything', 0 );

		Log_Cleaner::cleanup_orphan_partitions( $this->tmp );

		$this->assertDirectoryExists( $orphan );
	}

	public function test_sweeps_undeclared_non_partition_offset_dir(): void {
		// Layout-agnostic: an undeclared offset dir is an orphan and IS swept.
		$this->declare_topology(
			'digest',
			"make_node Consumer scored:consumer <config:logs_dir>/scored.p<partition> <config:offsets_dir>/scored.p<partition>\n"
		);

		\mkdir( "{$this->tmp}/offsets/notapartition", 0755, true );

		Log_Cleaner::cleanup_orphan_partitions( $this->tmp );

		$this->assertDirectoryDoesNotExist( "{$this->tmp}/offsets/notapartition" );
	}

	// ── liveness-free: locks are no longer consulted ───────────────────────

	public function test_no_longer_reads_lock_dirs(): void {
		// An undeclared log dir WITH a matching lock dir is STILL deleted —
		// the GC ignores locks now (the orange is gone).
		$this->declare_topology( 'requests-workers', $this->partition_tsl( 'requests' ) );

		$ghost = $this->seed_log_partition( 'ghost', 0 );
		\mkdir( "{$this->tmp}/locks/ghost.p0.lock.d", 0755, true );
		\file_put_contents( "{$this->tmp}/locks/ghost.p0.lock.d/heartbeat", (string) \getmypid() );

		Log_Cleaner::cleanup_orphan_partitions( $this->tmp );

		$this->assertDirectoryDoesNotExist( $ghost );
	}

	// ── declared_log_dirs ───────────────────────────

	public function test_declared_log_dirs_unions_topology_and_producers(): void {
		$this->declare_topology( 'requests-workers', $this->partition_tsl( 'requests', 2 ) );
		\add_filter(
			'newspack_nodes/registered_log_producers',
			static fn (): array => [ 'firehose' ]
		);
		$GLOBALS['_wp_options']['newspack_nodes_num_partitions'] = 1;
		Config::reset();

		$result = Log_Cleaner::declared_log_dirs();
		\sort( $result );

		// topicprobe.p0 + settings.p0 ride along once a real declared set exists
		// (substrate probe log + settings-sync log, both written outside any .tsl).
		$this->assertSame( [ 'firehose.p0', 'requests.p0', 'requests.p1', 'settings.p0', 'topicprobe.p0' ], $result );
	}

	public function test_declared_log_dirs_skips_non_string_producers(): void {
		$this->declare_topology( 'requests-workers', $this->partition_tsl( 'requests' ) );
		\add_filter(
			'newspack_nodes/registered_log_producers',
			static fn (): array => [ 'firehose', '', 42, [ 'x' ] ]
		);
		$GLOBALS['_wp_options']['newspack_nodes_num_partitions'] = 1;
		Config::reset();

		$result = Log_Cleaner::declared_log_dirs();
		\sort( $result );

		$this->assertSame( [ 'firehose.p0', 'requests.p0', 'settings.p0', 'topicprobe.p0' ], $result );
	}

	// ── frontmatter-less, multi-partition: SPAWN-aligned partition count ─────

	/**
	 * A topology with NO `var num_partitions` spawns at the global config count,
	 * not 1. The declared set must protect ALL spawned partitions, else the live
	 * X.p1 log + offset cursor get swept (cursor loss → full-log reprocessing).
	 */
	public function test_frontmatterless_topology_protects_config_partitions(): void {
		$GLOBALS['_wp_options']['newspack_nodes_num_partitions'] = 2;
		Config::reset();

		$this->declare_topology(
			'widget-workers',
			"make_node Partition widget:partition <config:logs_dir>/widget.p<partition> <config:segment_size> <config:num_segments> <config:max_lifespan>\n"
			. "make_node Consumer widget:consumer <config:logs_dir>/widget.p<partition> <config:offsets_dir>/widget-consumer.p<partition>\n"
		);

		$log_p0 = $this->seed_log_partition( 'widget', 0 );
		$log_p1 = $this->seed_log_partition( 'widget', 1 );
		$log_p2 = $this->seed_log_partition( 'widget', 2 );

		$off_p0 = $this->seed_offset_dir( 'widget-consumer', 0 );
		$off_p1 = $this->seed_offset_dir( 'widget-consumer', 1 );
		$off_p2 = $this->seed_offset_dir( 'widget-consumer', 2 );

		Log_Cleaner::cleanup_orphan_partitions( $this->tmp );

		$this->assertDirectoryExists( $log_p0 );
		$this->assertDirectoryExists( $log_p1 );
		$this->assertDirectoryDoesNotExist( $log_p2 );

		$this->assertDirectoryExists( $off_p0 );
		$this->assertDirectoryExists( $off_p1 );
		$this->assertDirectoryDoesNotExist( $off_p2 );
	}
}
