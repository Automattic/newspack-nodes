<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Alerts;
use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Core;
use Newspack_Nodes\Job_Intake;
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

	/** Write a topology .tsl into the stock dir AND activate it (operator overlay) — retention follows the active set. */
	private function declare_topology( string $name, string $contents ): void {
		$this->declare_inactive_topology( $name, $contents );
		$active                                              = $GLOBALS['_wp_options']['newspack_nodes_topologies'] ?? [];
		$active[]                                            = $name;
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = \array_values( \array_unique( $active ) );
		Config::reset();
	}

	/** Write a topology .tsl on disk WITHOUT activating it (the operator hasn't enabled it). */
	private function declare_inactive_topology( string $name, string $contents ): void {
		\file_put_contents( "{$this->stock}/{$name}.tsl", $contents );
		Topology_Registry::reset_basename_cache();
	}

	/** A topology that BOTH writes a log (Partition) and tails one (Consumer offsetlog), under `$basename`. */
	private function log_and_offset_tsl( string $basename, int $num_partitions = 1 ): string {
		return "var num_partitions = {$num_partitions}\n"
			. "make_node Partition {$basename}:partition <config:logs_dir>/{$basename}.p<partition> <config:segment_size> <config:min_segments> <config:max_segments> <config:min_lifetime> <config:max_lifetime>\n"
			. "make_node Consumer {$basename}:consumer <config:logs_dir>/src.p<partition> <config:offsets_dir>/{$basename}.p<partition>\n";
	}

	/** Seed a flat log partition dir `logs/{name}.p{N}/0.log`; returns the dir path. */
	private function seed_log_partition( string $name, int $partition ): string {
		$dir = "{$this->tmp}/logs/{$name}.p{$partition}";
		\mkdir( $dir, 0755, true );
		\file_put_contents( "{$dir}/0.log", 'X' );
		$this->age_dir( $dir );
		return $dir;
	}

	/** Seed a flat offset dir `offsets/{name}.p{N}/`; returns the dir path. */
	private function seed_offsetlog_dir( string $name, int $partition ): string {
		$dir = "{$this->tmp}/offsets/{$name}.p{$partition}";
		\mkdir( $dir, 0755, true );
		\file_put_contents( "{$dir}/0.log", 'offset' );
		$this->age_dir( $dir );
		return $dir;
	}

	/** Backdate a dir + its first-level files past the sweep's delete grace. */
	private function age_dir( string $dir ): void {
		$stale = \time() - 7200;
		\touch( $dir, $stale );
		foreach ( (array) \glob( "{$dir}/*" ) as $entry ) {
			\touch( (string) $entry, $stale );
		}
	}

	private function partition_tsl( string $basename, int $num_partitions = 1 ): string {
		return "var num_partitions = {$num_partitions}\n"
			. "make_node Partition {$basename}:partition <config:logs_dir>/{$basename}.p<partition> <config:segment_size> <config:min_segments> <config:max_segments> <config:min_lifetime> <config:max_lifetime>\n";
	}

	// ── log-dir sweep ──────────────────────────────────────────────────────

	public function test_aborts_the_sweep_when_an_active_topology_cannot_resolve(): void {
		// Mid-deploy: the topologies OPTION persists while the owning plugin's
		// stock dir is momentarily unregistered, so the declared set silently
		// loses that plugin's dirs. Sweeping against the degraded set is what
		// deleted errors.p0 (twice) -- an unresolvable ACTIVE name aborts.
		$this->declare_topology( 'requests-workers', $this->partition_tsl( 'requests' ) );
		$active   = $GLOBALS['_wp_options']['newspack_nodes_topologies'];
		$active[] = 'vicuna-unregistered';

		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = $active;
		Config::reset();

		$ghost = $this->seed_log_partition( 'ghost', 0 );

		$this->assertSame( [], Log_Cleaner::cleanup_orphan_partitions( $this->tmp ) );
		$this->assertDirectoryExists( $ghost );
	}

	public function test_deletes_undeclared_flat_log_dir(): void {
		$this->declare_topology( 'requests-workers', $this->partition_tsl( 'requests' ) );

		$ghost = $this->seed_log_partition( 'ghost', 0 );
		$kept  = $this->seed_log_partition( 'requests', 0 );

		Log_Cleaner::cleanup_orphan_partitions( $this->tmp );

		$this->assertDirectoryDoesNotExist( $ghost );
		$this->assertDirectoryExists( $kept );
	}

	public function test_sweeps_topicprobe_when_no_declaring_topology_is_active(): void {
		// topicprobe.p0 is TSL-declared now (the topic-probe include), not
		// whitelisted — undeclared, it GCs like any other retired dir.
		$this->declare_topology( 'requests-workers', $this->partition_tsl( 'requests' ) );
		$probe = $this->seed_log_partition( 'topicprobe', 0 );

		Log_Cleaner::cleanup_orphan_partitions( $this->tmp );

		$this->assertDirectoryDoesNotExist( $probe );
	}

	public function test_keeps_topicprobe_when_the_include_declares_it(): void {
		// A topology pulling `include topic-probe` declares topicprobe.p0
		// through the ordinary declared-set path — no whitelist.
		\file_put_contents(
			"{$this->stock}/topic-probe.tsl",
			"make_node TopicProbe _topicprobe 15\n"
			. "make_node Partition  _topicprobe:log <config:logs_dir>/topicprobe.p0 1048576 2 2 86400 0\n"
			. "connect_node _topicprobe _topicprobe:log\n"
		);
		$this->declare_topology(
			'probing-workers',
			"include topic-probe\n" . $this->partition_tsl( 'requests' )
		);
		$probe = $this->seed_log_partition( 'topicprobe', 0 );

		Log_Cleaner::cleanup_orphan_partitions( $this->tmp );

		$this->assertDirectoryExists( $probe );
	}

	public function test_sweeps_jobstats_when_no_declaring_topology_is_active(): void {
		// jobstats.p0 is now TSL-declared (topologies/job-worker.tsl), not whitelisted.
		// When no active topology declares it, it is an orphan and GCs like any other
		// deactivated topology's log — the correct behavior after revoking the mount.
		$this->declare_topology( 'requests-workers', $this->partition_tsl( 'requests' ) );
		$jobstats = $this->seed_log_partition( 'jobstats', 0 );

		Log_Cleaner::cleanup_orphan_partitions( $this->tmp );

		$this->assertDirectoryDoesNotExist( $jobstats );
	}

	public function test_keeps_jobstats_when_a_declaring_topology_is_active(): void {
		// A topology that declares the jobstats Partition (as job-worker.tsl does)
		// protects jobstats.p0 through the ordinary declared-set path — no whitelist.
		$this->declare_topology(
			'jobs-workers',
			"make_node Partition jobstats:log <config:logs_dir>/jobstats.p0 1048576 2 2 86400 0\n"
		);
		$jobstats = $this->seed_log_partition( 'jobstats', 0 );

		Log_Cleaner::cleanup_orphan_partitions( $this->tmp );

		$this->assertDirectoryExists( $jobstats );
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

	public function test_sweeps_an_inactive_topologys_log_and_offset_alike(): void {
		// Retention follows the operator's ACTIVE set (the supervisor's source), not
		// disk presence — applied UNIFORMLY to logs and offsets. A topology whose .tsl
		// ships on disk but isn't activated has BOTH its log and its offsetlog reclaimed.
		$this->declare_topology( 'keeper-workers', $this->log_and_offset_tsl( 'keeper' ) );            // active
		$this->declare_inactive_topology( 'retired-workers', $this->log_and_offset_tsl( 'retired' ) ); // on disk, NOT active

		$keeper_log  = $this->seed_log_partition( 'keeper', 0 );
		$keeper_off  = $this->seed_offsetlog_dir( 'keeper', 0 );
		$retired_log = $this->seed_log_partition( 'retired', 0 );
		$retired_off = $this->seed_offsetlog_dir( 'retired', 0 );

		Log_Cleaner::cleanup_orphan_partitions( $this->tmp );

		$this->assertDirectoryExists( $keeper_log, 'active topology log kept' );
		$this->assertDirectoryExists( $keeper_off, 'active topology offset kept' );
		$this->assertDirectoryDoesNotExist( $retired_log, 'inactive topology log swept' );
		$this->assertDirectoryDoesNotExist( $retired_off, 'inactive topology offset swept' );
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
		$cursor = $this->seed_offsetlog_dir( 'scored', 0 );

		Core::$config_resolvers = [];

		Log_Cleaner::cleanup_orphan_partitions( $this->tmp );

		$this->assertDirectoryExists( $cursor );
	}

	public function test_a_recently_active_undeclared_dir_is_spared(): void {
		// The delete grace: an undeclared dir with fresh writes is NEVER swept
		// — the declared set can transiently lose entries mid-deploy/restart
		// (this ate a healthy errors.p0 + alerts.p0), and an active dir is
		// never a true orphan. It collects on a later sweep once quiet.
		$this->declare_topology( 'requests-workers', $this->partition_tsl( 'requests' ) );
		$fresh = "{$this->tmp}/logs/undeclared-live.p0";
		\mkdir( $fresh, 0755, true );
		\file_put_contents( "{$fresh}/0.log", 'being written RIGHT NOW' );

		Log_Cleaner::cleanup_orphan_partitions( $this->tmp );

		$this->assertDirectoryExists( $fresh );
	}

	public function test_a_zero_grace_sweeps_a_dir_being_written_right_now(): void {
		// `wp nodes gc --force`: an operator tearing a topology down wants its
		// dirs gone NOW, not after the deploy-safety grace times out.
		$this->declare_topology( 'requests-workers', $this->partition_tsl( 'requests' ) );
		$fresh = "{$this->tmp}/logs/undeclared-live.p0";
		\mkdir( $fresh, 0755, true );
		\file_put_contents( "{$fresh}/0.log", 'being written RIGHT NOW' );

		$deleted = Log_Cleaner::cleanup_orphan_partitions( $this->tmp, 0 );

		$this->assertDirectoryDoesNotExist( $fresh );
		$this->assertSame( [ $fresh ], $deleted );
	}

	public function test_the_spared_dir_is_swept_once_the_grace_expires(): void {
		$this->declare_topology( 'requests-workers', $this->partition_tsl( 'requests' ) );
		$orphan = "{$this->tmp}/logs/undeclared-live.p0";
		\mkdir( $orphan, 0755, true );
		\file_put_contents( "{$orphan}/0.log", 'X' );
		$this->age_dir( $orphan );

		Log_Cleaner::cleanup_orphan_partitions( $this->tmp );

		$this->assertDirectoryDoesNotExist( $orphan );
	}

	public function test_an_old_dir_with_one_fresh_segment_is_spared(): void {
		// Appends touch segment FILES, not the dir: an hour-quiet dir whose
		// newest segment is fresh is still live. The guard reads the newest
		// mtime across the dir and its first-level entries.
		$this->declare_topology( 'requests-workers', $this->partition_tsl( 'requests' ) );
		$busy = "{$this->tmp}/logs/undeclared-busy.p0";
		\mkdir( $busy, 0755, true );
		\file_put_contents( "{$busy}/0.log", 'old' );
		$this->age_dir( $busy );
		\file_put_contents( "{$busy}/1.log", 'fresh append' );
		\touch( $busy, \time() - 7200 ); // dir mtime stays stale; file is fresh.

		Log_Cleaner::cleanup_orphan_partitions( $this->tmp );

		$this->assertDirectoryExists( $busy );
	}

	public function test_sweeps_undeclared_non_partition_dir(): void {
		// Layout-agnostic: keep ONLY declared first-level dirs. An undeclared dir
		// whose name has no `.p{N}` suffix is now an orphan and IS swept.
		$this->declare_topology( 'requests-workers', $this->partition_tsl( 'requests' ) );

		\mkdir( "{$this->tmp}/logs/notapartition", 0755, true );
		\file_put_contents( "{$this->tmp}/logs/notapartition/info.json", '{}' );
		$this->age_dir( "{$this->tmp}/logs/notapartition" );

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
		$this->age_dir( $ghost );

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
		$this->age_dir( $ghost );

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

	public function test_deletes_undeclared_offsetlog_dir(): void {
		$this->declare_topology(
			'digest',
			"make_node Consumer scored:consumer <config:logs_dir>/scored.p<partition> <config:offsets_dir>/scored.p<partition>\n"
		);

		$kept   = $this->seed_offsetlog_dir( 'scored', 0 );
		$orphan = $this->seed_offsetlog_dir( 'summarized', 0 );

		Log_Cleaner::cleanup_orphan_partitions( $this->tmp );

		$this->assertDirectoryExists( $kept );
		$this->assertDirectoryDoesNotExist( $orphan );
	}

	public function test_keeps_declared_offsetlog_dir(): void {
		$this->declare_topology(
			'digest',
			"make_node Consumer scored:consumer <config:logs_dir>/scored.p<partition> <config:offsets_dir>/scored.p<partition>\n"
		);

		$kept = $this->seed_offsetlog_dir( 'scored', 0 );

		Log_Cleaner::cleanup_orphan_partitions( $this->tmp );

		$this->assertDirectoryExists( $kept );
	}

	public function test_empty_offset_set_skips_offset_sweep(): void {
		// A topology declares a Partition (so the log sweep runs) but NO
		// Consumer offsetlog → offset declared set empty → fail-closed skip.
		$this->declare_topology( 'requests-workers', $this->partition_tsl( 'requests' ) );

		$orphan = $this->seed_offsetlog_dir( 'anything', 0 );

		Log_Cleaner::cleanup_orphan_partitions( $this->tmp );

		$this->assertDirectoryExists( $orphan );
	}

	public function test_sweeps_undeclared_non_partition_offsetlog_dir(): void {
		// Layout-agnostic: an undeclared offset dir is an orphan and IS swept.
		$this->declare_topology(
			'digest',
			"make_node Consumer scored:consumer <config:logs_dir>/scored.p<partition> <config:offsets_dir>/scored.p<partition>\n"
		);

		\mkdir( "{$this->tmp}/offsets/notapartition", 0755, true );
		$this->age_dir( "{$this->tmp}/offsets/notapartition" );

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

	public function test_substrate_registers_jobintake_as_a_producer(): void {
		// Job_Intake writes jobintake.p<N> outside any topology's write set; the
		// SUBSTRATE must protect it from the GC sweep (ELN-less installs queue
		// through it via nuclear-gyrobase / pyrobase).
		$this->assertContains( 'jobintake', Bootstrap::register_log_producers( [] ) );
		$producers = Bootstrap::register_log_producers( [ 'firehose', 'jobintake' ] );
		$this->assertContains( 'firehose', $producers );
		$this->assertSame( \array_unique( $producers ), $producers, 'merge dedupes against contributors that already declare it' );
	}

	public function test_substrate_registers_alerts_as_a_producer(): void {
		// The Alerts journal writes alerts.p0 outside any topology's write set
		// too; the substrate must protect it the same way it protects jobintake.
		$this->assertContains( Alerts::LOG_BASENAME, Bootstrap::register_log_producers( [] ) );
		$producers = Bootstrap::register_log_producers( [ 'firehose', Alerts::LOG_BASENAME ] );
		$this->assertContains( 'firehose', $producers );
		$this->assertSame( \array_unique( $producers ), $producers, 'merge dedupes against contributors that already declare it' );
	}

	public function test_registered_jobintake_producer_protects_its_partition_dirs(): void {
		\add_filter(
			'newspack_nodes/registered_log_producers',
			[ Bootstrap::class, 'register_log_producers' ]
		);
		$GLOBALS['_wp_options']['newspack_nodes_num_partitions'] = 1;
		Config::reset();

		$p0 = $this->seed_log_partition( 'jobintake', 0 );
		Log_Cleaner::cleanup_orphan_partitions( $this->tmp );
		$this->assertDirectoryExists( $p0 );
	}

	/**
	 * The GC clamped `num_partitions` to MAX_PARTITIONS while every PRODUCER
	 * clamped it differently — `Job_Intake` and ELN's `Log_Manager` applied no
	 * upper bound at all. Above the cap, producers wrote `jobintake.p16`+ that
	 * the declared set never enumerated, so the sweep deleted them one
	 * DELETE_GRACE_S after their last write: live-data deletion past both of
	 * the GC's fail-closed gates, since the root resolves and the set is
	 * non-empty.
	 *
	 * The invariant is agreement — whatever a producer can write, the GC
	 * declares. 21 is deliberately above MAX_PARTITIONS (16), so a producer
	 * that ignores the cap and one that honours it give different answers.
	 */
	public function test_every_partition_a_producer_writes_is_declared(): void {
		\add_filter(
			'newspack_nodes/registered_log_producers',
			[ Bootstrap::class, 'register_log_producers' ]
		);
		// A real declared set, so the empty-set gate isn't what passes this.
		$this->declare_topology( 'requests-workers', $this->partition_tsl( 'requests', 2 ) );
		$GLOBALS['_wp_options']['newspack_nodes_num_partitions'] = 21;
		Config::reset();

		$declared = Log_Cleaner::declared_log_dirs();
		$intake   = new Job_Intake( $this->tmp );
		// Enough distinct keys to exercise every partition the writer will use.
		for ( $i = 0; $i < 200; $i++ ) {
			$intake->write_job( 'probe_handler', [ 'i' => $i ], "key-{$i}" );
		}
		$intake->close();

		$written = \array_map(
			'basename',
			(array) \glob( $this->tmp . '/logs/jobintake.p*' )
		);
		$this->assertNotEmpty( $written, 'the probe must have written something' );
		$this->assertSame(
			[],
			\array_diff( $written, $declared ),
			'a partition the writer can reach must be in the declared set'
		);
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

		// settings.p0 rides along once a real declared set exists
		// (substrate probe/settings logs, written outside any .tsl). jobstats.p0 does
		// NOT — it's TSL-declared by job-worker, which isn't active here.
		$this->assertSame( [ 'firehose.p0', 'requests.p0', 'requests.p1', 'settings.p0' ], $result );
	}

	public function test_declared_log_partitions_maps_names_to_enumerated_partitions(): void {
		// The map form carries each concrete log dir's enumerated partition index
		// (the dashboard joins logs[] to consumers[] on it). declared_log_dirs()
		// stays byte-for-byte the NAME set (array_keys of the same map).
		$this->declare_topology( 'requests-workers', $this->partition_tsl( 'requests', 2 ) );
		\add_filter(
			'newspack_nodes/registered_log_producers',
			static fn (): array => [ 'firehose' ]
		);
		$GLOBALS['_wp_options']['newspack_nodes_num_partitions'] = 1;
		Config::reset();

		$map = Log_Cleaner::declared_log_partitions();
		\ksort( $map );

		// requests is 2-partition; firehose producer + the whitelisted non-.tsl
		// logs (topicprobe, settings) are partition 0. jobstats is TSL-declared by
		// job-worker (not active here), so it does not ride along.
		$this->assertSame(
			[
				'firehose.p0'  => 0,
				'requests.p0'  => 0,
				'requests.p1'  => 1,
				'settings.p0'  => 0,
			],
			$map
		);

		// declared_log_dirs() is unchanged: the same NAME set the GC sweeps.
		$names = Log_Cleaner::declared_log_dirs();
		\sort( $names );
		$this->assertSame( \array_keys( $map ), $names );
	}

	public function test_declared_log_partitions_null_root_returns_empty_map(): void {
		// Fail-closed: an unresolvable logs_dir root yields an empty map (mirrors
		// declared_log_dirs()'s `?? []`).
		$this->declare_topology( 'requests-workers', $this->partition_tsl( 'requests' ) );
		Core::$config_resolvers = [];

		$this->assertSame( [], Log_Cleaner::declared_log_partitions() );
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

		$this->assertSame( [ 'firehose.p0', 'requests.p0', 'settings.p0' ], $result );
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
			"make_node Partition widget:partition <config:logs_dir>/widget.p<partition> <config:segment_size> <config:min_segments> <config:max_segments> <config:min_lifetime> <config:max_lifetime>\n"
			. "make_node Consumer widget:consumer <config:logs_dir>/widget.p<partition> <config:offsets_dir>/widget-consumer.p<partition>\n"
		);

		$log_p0 = $this->seed_log_partition( 'widget', 0 );
		$log_p1 = $this->seed_log_partition( 'widget', 1 );
		$log_p2 = $this->seed_log_partition( 'widget', 2 );

		$off_p0 = $this->seed_offsetlog_dir( 'widget-consumer', 0 );
		$off_p1 = $this->seed_offsetlog_dir( 'widget-consumer', 1 );
		$off_p2 = $this->seed_offsetlog_dir( 'widget-consumer', 2 );

		Log_Cleaner::cleanup_orphan_partitions( $this->tmp );

		$this->assertDirectoryExists( $log_p0 );
		$this->assertDirectoryExists( $log_p1 );
		$this->assertDirectoryDoesNotExist( $log_p2 );

		$this->assertDirectoryExists( $off_p0 );
		$this->assertDirectoryExists( $off_p1 );
		$this->assertDirectoryDoesNotExist( $off_p2 );
	}

	/**
	 * DATA LOSS: retention drives off Topology_Registry::resolved_resource_dirs(),
	 * which reads write_set(). That scanned the RAW .tsl, so an include-only
	 * topology (ELN's combined.tsl is now two `include` lines) declared NOTHING —
	 * and the GC ATE its live logs and offsetlogs as orphans.
	 *
	 * The second active topology is load-bearing: with an EMPTY declared set the
	 * cleaner skips the sweep entirely (fail-safe), so an include-only topology
	 * alone is never at risk. It takes a neighbour that DOES declare dirs to make
	 * the set non-empty, run the sweep, and delete the borrowed dirs. That is the
	 * live fleet exactly: combined (include-only) beside job-worker + settings-sync.
	 */
	public function test_keeps_the_dirs_an_included_topology_declares(): void {
		$this->declare_topology( 'neighbour', $this->partition_tsl( 'neighbour' ) );
		$this->declare_inactive_topology(
			'zebra-base',
			$this->log_and_offset_tsl( 'zebra' )
		);
		// The active topology is include-ONLY: it declares no node of its own.
		$this->declare_topology( 'zebra-top', "include zebra-base\n" );

		$log    = $this->seed_log_partition( 'zebra', 0 );
		$offset = $this->seed_offsetlog_dir( 'zebra', 0 );

		$deleted = Log_Cleaner::cleanup_orphan_partitions( $this->tmp );

		$this->assertSame( [], $deleted, 'the GC must not orphan what an include declares' );
		$this->assertDirectoryExists( $log );
		$this->assertDirectoryExists( $offset );
	}

	/** Every partition of an included Partition survives, not just p0. */
	public function test_include_only_topology_declares_every_partition(): void {
		$this->declare_topology( 'neighbour', $this->partition_tsl( 'neighbour' ) );
		$this->declare_inactive_topology(
			'zebra-base',
			$this->log_and_offset_tsl( 'zebra', 2 )
		);
		$this->declare_topology(
			'zebra-top',
			"var num_partitions = 2\ninclude zebra-base\n"
		);

		$p0 = $this->seed_log_partition( 'zebra', 0 );
		$p1 = $this->seed_log_partition( 'zebra', 1 );

		Log_Cleaner::cleanup_orphan_partitions( $this->tmp );

		$this->assertDirectoryExists( $p0 );
		$this->assertDirectoryExists( $p1 );
	}
}
