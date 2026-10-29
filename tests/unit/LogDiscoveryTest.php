<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Config;
use Newspack_Nodes\Log_Discovery;
use Newspack_Nodes\Tests\TestCase;

/**
 * Disk-discovery primitive — readdir the first-level dirs under `{base}/logs`
 * and return the concrete dir basename list verbatim (flat partition-in-name
 * layout: `firehose.p0`), so no application hardcodes a log catalog.
 */
#[CoversClass( Log_Discovery::class )]
class LogDiscoveryTest extends TestCase {

	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		$this->tmp = $this->make_temp_dir( 'log-discovery-' );
		$this->use_base_dir( $this->tmp );
		Log_Discovery::reset();
		// Other tests in the suite wipe `$GLOBALS['_wp_actions']` to isolate,
		// which drops the boot-time `add_action(Config::RESET_ACTION, ...)`
		// registration from `newspack-nodes.php`. Re-register here so the
		// behavior under test (Log_Discovery responds to config-reset) stays
		// observable regardless of test order. The boot-time registration
		// itself is a one-liner; if it disappears from production we'll catch
		// it via browser smoke / integration coverage, not here.
		\add_action( Config::RESET_ACTION, [ Log_Discovery::class, 'reset' ] );
	}

	protected function tearDown(): void {
		Log_Discovery::reset();
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	/** A subscription is a glob when a `*` stands anywhere in it, group or name. */
	public function test_is_glob_reads_a_star_anywhere_in_a_subscription(): void {
		$this->assertTrue( Log_Discovery::is_glob( 'jobstats.p*' ) );
		$this->assertTrue( Log_Discovery::is_glob( 'offsets:fire*.p3' ) );
		$this->assertFalse( Log_Discovery::is_glob( 'firehose.p0' ) );
		$this->assertFalse( Log_Discovery::is_glob( 'sources:php' ) );
	}

	public function test_root_joins_a_group_onto_the_base(): void {
		$this->assertSame( '/srv/runtime-6612/offsets', Log_Discovery::root( '/srv/runtime-6612', 'offsets' ) );
	}

	public function test_root_refuses_a_name_outside_the_groups(): void {
		$this->expectException( \InvalidArgumentException::class );
		Log_Discovery::root( '/srv/runtime-6612', 'locks' );
	}

	public function test_returns_empty_when_logs_dir_missing(): void {
		// No `{base}/logs/` directory at all — discovery returns empty, not error.
		$this->assertSame( [], Log_Discovery::on_disk() );
	}

	public function test_returns_empty_when_glob_errors(): void {
		// glob() returns false on an I/O error (not [] as for no-match). The seam forces
		// that branch without a real filesystem fault: discovery yields [], never false.
		Log_Discovery::$glob = static fn ( string $pattern, int $flags ) => false;
		try {
			$this->assertSame( [], Log_Discovery::on_disk() );
		} finally {
			Log_Discovery::$glob = null;
		}
	}

	public function test_returns_concrete_dir_basenames_verbatim(): void {
		\mkdir( "{$this->tmp}/logs/firehose.p0", 0755, true );
		\mkdir( "{$this->tmp}/logs/errors.p0", 0755, true );

		$this->assertSame( [ 'errors.p0', 'firehose.p0' ], Log_Discovery::on_disk() );
	}

	public function test_results_are_sorted_alphabetically(): void {
		\mkdir( "{$this->tmp}/logs/zeta.p0", 0755, true );
		\mkdir( "{$this->tmp}/logs/alpha.p0", 0755, true );
		\mkdir( "{$this->tmp}/logs/middle.p0", 0755, true );

		$this->assertSame( [ 'alpha.p0', 'middle.p0', 'zeta.p0' ], Log_Discovery::on_disk() );
	}

	public function test_groups_lists_logs_offsets_and_deadletter_basenames(): void {
		\mkdir( "{$this->tmp}/logs/firehose.p0", 0755, true );
		\mkdir( "{$this->tmp}/offsets/combined.firehose.p0", 0755, true );
		\mkdir( "{$this->tmp}/deadletter/job-worker.jobs.p0", 0755, true );

		$groups = Log_Discovery::groups();

		$this->assertSame( [ 'firehose.p0' ], $groups['logs'] );
		$this->assertSame( [ 'combined.firehose.p0' ], $groups['offsets'] );
		$this->assertSame( [ 'job-worker.jobs.p0' ], $groups['deadletter'] );
	}

	/** A `logs` dir stamps bare; every other root keeps its prefix. */
	public function test_stamp_for_writes_logs_bare_and_other_roots_grouped(): void {
		$this->assertSame( 'ledger.p6', Log_Discovery::stamp_for( 'logs', 'ledger.p6' ) );
		$this->assertSame( 'offsets:ledger.p6', Log_Discovery::stamp_for( 'offsets', 'ledger.p6' ) );
		$this->assertSame( 'deadletter:ledger.p6', Log_Discovery::stamp_for( 'deadletter', 'ledger.p6' ) );
	}

	/** A broker reader's dir stamps as one segment: group, root and kind, joined by `:`. */
	public function test_stamp_for_writes_a_broker_readers_dir_as_one_colon_joined_segment(): void {
		$this->assertSame( 'offsets:hub.tucson-41:firehose.p3', Log_Discovery::stamp_for( 'offsets', 'hub.tucson-41/firehose.p3' ) );
		$this->assertSame( 'deadletter:hub.coast-73:sources:php', Log_Discovery::stamp_for( 'deadletter', 'hub.coast-73/sources:php' ) );
	}

	/** A root holding `:` would read back as another root and kind, so it is refused by name. */
	public function test_stamp_for_refuses_a_broker_root_holding_a_colon(): void {
		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( 'log dir hub:tw0/firehose.p3 holds a colon, which a stamp reads as a separator; rename it' );
		Log_Discovery::stamp_for( 'offsets', 'hub:tw0/firehose.p3' );
	}

	/** A flat dir holding `:` would read back as a broker's reader. */
	public function test_stamp_for_refuses_a_flat_dir_holding_a_colon(): void {
		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( 'log dir hub:firehose.p3 holds a colon, which a stamp reads as a separator; rename it' );
		Log_Discovery::stamp_for( 'deadletter', 'hub:firehose.p3' );
	}

	/** A broker reader's sidecar names itself as the catalog does. */
	public function test_source_for_stamps_a_broker_readers_sidecar_dirs(): void {
		$this->assertSame( 'offsets:hub.tucson-41:sources:php', Log_Discovery::source_for( 'offsets/hub.tucson-41/sources:php' ) );
		$this->assertSame( 'deadletter:hub.TucsonWeekly:firehose.p3', Log_Discovery::source_for( 'deadletter/hub.TucsonWeekly/firehose.p3' ) );
	}

	/** A sidecar no stamp names keeps its path, and throws nothing. */
	public function test_source_for_keeps_the_path_of_a_reader_no_stamp_names(): void {
		$this->assertSame( 'offsets/hub:tw0/firehose.p3', Log_Discovery::source_for( 'offsets/hub:tw0/firehose.p3' ) );
		$this->assertSame( 'offsets/hub tw0/firehose.p3', Log_Discovery::source_for( 'offsets/hub tw0/firehose.p3' ), 'a root ROOT_PATTERN refuses' );
		$this->assertSame( 'deadletter/hub.tw0/Firehose.p3', Log_Discovery::source_for( 'deadletter/hub.tw0/Firehose.p3' ), 'a kind that is not a stamp' );
		$this->assertSame( 'logs/gate/offsets/x', Log_Discovery::source_for( 'logs/gate/offsets/x' ) );
	}

	/** A dir holding a segment belongs to a Partition, whatever else sits in it. */
	public function test_groups_lists_a_dir_holding_a_segment_as_itself(): void {
		$this->seed_segment( 'offsets/job-spoke.jobs.p6/stray-71', 5 );
		$this->seed_segment( 'offsets/job-spoke.jobs.p6', 12 );
		$this->seed_segment( 'deadletter/hub.coast-73/firehose.p3', 3 );
		\file_put_contents( "{$this->tmp}/deadletter/hub.coast-73/notes.txt", '' );

		$groups = Log_Discovery::groups();

		$this->assertSame( [ 'job-spoke.jobs.p6' ], $groups['offsets'] );
		$this->assertSame( [ 'hub.coast-73/firehose.p3' ], $groups['deadletter'], 'a stray file is not a segment' );
	}

	/**
	 * A broker's root holds one reader dir per kind and no segments, so the
	 * readers list in its place; a plain Consumer's offsetlog lists as itself.
	 */
	public function test_groups_lists_each_broker_reader_in_place_of_its_root(): void {
		$this->seed_segment( 'offsets/hub.tucson-41/firehose.p3', 8 );
		$this->seed_segment( 'offsets/hub.tucson-41/sources:php', 9 );
		\mkdir( "{$this->tmp}/offsets/hub.tucson-41/fresh.p1", 0755, true );
		$this->seed_segment( 'offsets/performance.requests.p2', 4 );
		$this->seed_segment( 'deadletter/hub.coast-73/sources:php', 2 );
		$this->seed_segment( 'logs/jobintake.p2/write.lock.d', 6 );

		$groups = Log_Discovery::groups();

		$this->assertSame( [ 'jobintake.p2' ], $groups['logs'], 'a lock dir inside a log is not a reader' );
		$this->assertSame(
			[ 'hub.tucson-41/firehose.p3', 'hub.tucson-41/sources:php', 'performance.requests.p2' ],
			$groups['offsets']
		);
		$this->assertSame( [ 'hub.coast-73/sources:php' ], $groups['deadletter'] );
	}

	/** A root nested a level deeper lists as one dir, never as a broker's root. */
	public function test_groups_lists_a_root_nested_deeper_as_one_dir(): void {
		$this->seed_segment( 'offsets/fleet-58/hub.tucson-41/firehose.p3', 4 );

		$this->assertSame( [ 'fleet-58' ], Log_Discovery::groups()['offsets'] );
	}

	/** A dir the catalog cannot read is named apart, and costs no other dir its place. */
	public function test_groups_names_a_dir_it_cannot_read_and_lists_the_rest(): void {
		$this->seed_segment( 'deadletter/hub.coast-73/firehose.p3', 3 );
		$this->seed_segment( 'deadletter/hub.tucson-41/firehose.p3', 5 );
		$this->seed_segment( 'deadletter/job-spoke.jobs.p6', 2 );
		\chmod( "{$this->tmp}/deadletter/hub.coast-73", 0 );
		try {
			$groups     = Log_Discovery::groups();
			$unreadable = Log_Discovery::unreadable();
		} finally {
			\chmod( "{$this->tmp}/deadletter/hub.coast-73", 0755 );
		}

		$this->assertSame( [ 'hub.tucson-41/firehose.p3', 'job-spoke.jobs.p6' ], $groups['deadletter'] );
		$this->assertSame( [ 'logs' => [], 'offsets' => [], 'deadletter' => [ 'hub.coast-73' ] ], $unreadable );
	}

	/** Seed one empty segment file, `<id>.log`, in a dir under the base. */
	private function seed_segment( string $relative, int $id ): void {
		if ( ! \is_dir( "{$this->tmp}/{$relative}" ) ) {
			\mkdir( "{$this->tmp}/{$relative}", 0755, true );
		}
		\file_put_contents( "{$this->tmp}/{$relative}/{$id}.log", '' );
	}

	/** A one-segment stamp never reads as a prefix, so a log may take a group's name. */
	public function test_stamp_for_writes_a_log_dir_named_like_a_group_bare(): void {
		$this->assertSame( 'deadletter', Log_Discovery::stamp_for( 'logs', 'deadletter' ) );
		$this->assertSame( 'logs', Log_Discovery::source_for( 'logs/logs' ) );
	}

	/** A record's name is the stamp under a group root and the path elsewhere. */
	public function test_source_for_stamps_group_dirs_and_keeps_other_paths(): void {
		$this->assertSame( 'ledger.p6', Log_Discovery::source_for( 'logs/ledger.p6' ) );
		$this->assertSame( 'offsets:ledger.p6', Log_Discovery::source_for( 'offsets/ledger.p6' ) );
		$this->assertSame( 'ipc/web.p2/output', Log_Discovery::source_for( 'ipc/web.p2/output' ) );
		$this->assertSame( 'logs/gate/offsets', Log_Discovery::source_for( 'logs/gate/offsets' ) );
	}

	/** A dir holding a `:` has no stamp, so its records name its path; nothing throws. */
	public function test_source_for_keeps_the_path_of_a_dir_holding_a_colon(): void {
		$this->assertSame( 'logs/sources:php', Log_Discovery::source_for( 'logs/sources:php' ) );
		$this->assertSame( 'deadletter/offsets.aggregator.tw7.sources:php', Log_Discovery::source_for( 'deadletter/offsets.aggregator.tw7.sources:php' ) );
	}

	public function test_groups_returns_empty_lists_for_missing_roots(): void {
		\mkdir( "{$this->tmp}/logs/solo.p0", 0755, true );

		$groups = Log_Discovery::groups();

		$this->assertSame( [ 'solo.p0' ], $groups['logs'] );
		$this->assertSame( [], $groups['offsets'] );
		$this->assertSame( [], $groups['deadletter'] );
	}

	public function test_groups_yields_empty_lists_when_glob_errors(): void {
		// The seam forces glob()'s false (I/O error) return for every root.
		Log_Discovery::$glob = static fn ( string $pattern, int $flags ) => false;
		try {
			$this->assertSame(
				[
					'logs'       => [],
					'offsets'    => [],
					'deadletter' => [],
				],
				Log_Discovery::groups()
			);
		} finally {
			Log_Discovery::$glob = null;
		}
	}

	public function test_groups_memoize_within_process(): void {
		\mkdir( "{$this->tmp}/logs/firehose.p0", 0755, true );
		$first = Log_Discovery::groups();

		// A dir added after the first call must NOT appear (cached wins).
		\mkdir( "{$this->tmp}/deadletter/late.jobs.p3", 0755, true );
		$second = Log_Discovery::groups();

		$this->assertSame( $first, $second );
		$this->assertSame( [], $second['deadletter'] );
	}

	public function test_ignores_non_dir_entries(): void {
		\mkdir( "{$this->tmp}/logs", 0755, true );
		// Stray Log file-sink segment FILE — GLOB_ONLYDIR skips it.
		\file_put_contents( "{$this->tmp}/logs/digest.md.0", '' );
		\mkdir( "{$this->tmp}/logs/real.p0", 0755, true );

		$this->assertSame( [ 'real.p0' ], Log_Discovery::on_disk() );
	}

	public function test_memoizes_within_process(): void {
		\mkdir( "{$this->tmp}/logs/firehose.p0", 0755, true );
		$first = Log_Discovery::on_disk();

		// Add a new log dir AFTER first call. Without memoization the second
		// call would pick it up; with memoization, the cached result wins.
		\mkdir( "{$this->tmp}/logs/late.p0", 0755, true );
		$second = Log_Discovery::on_disk();

		$this->assertSame( $first, $second );
		$this->assertSame( [ 'firehose.p0' ], $second );
	}

	public function test_reset_clears_cache(): void {
		\mkdir( "{$this->tmp}/logs/firehose.p0", 0755, true );
		$this->assertSame( [ 'firehose.p0' ], Log_Discovery::on_disk() );

		\mkdir( "{$this->tmp}/logs/late.p0", 0755, true );
		Log_Discovery::reset();

		$this->assertSame( [ 'firehose.p0', 'late.p0' ], Log_Discovery::on_disk() );
	}

	public function test_config_reset_action_clears_cache(): void {
		// Workers that survive a `Config::reset()` need their on-disk view to
		// invalidate so newly-added logs become visible. setUp() re-registers
		// the callback (bootstrap-time registration is wiped by sibling tests);
		// this test pins the behavior the wiring enables.
		\mkdir( "{$this->tmp}/logs/firehose.p0", 0755, true );
		$this->assertSame( [ 'firehose.p0' ], Log_Discovery::on_disk() );

		\mkdir( "{$this->tmp}/logs/late.p0", 0755, true );
		\do_action( Config::RESET_ACTION );

		$this->assertSame( [ 'firehose.p0', 'late.p0' ], Log_Discovery::on_disk() );
	}

	public function test_on_disk_propagates_throw_when_base_directory_unconfigured(): void {
		// No silent `/tmp/newspack-nodes` fallback: when base_directory is
		// unconfigured, on_disk() must propagate Config::get_base_directory()'s
		// RuntimeException rather than globbing a phantom default tree.
		$conf = "{$this->tmp}/empty-base.php";
		\file_put_contents( $conf, "<?php\nreturn [ 'base_directory' => '' ];\n" );
		\putenv( 'LOCAL_NEWSPACK_NODES_CONF=' . $conf );
		\update_option( 'newspack_nodes_base_directory', '' );
		Config::reset();
		Log_Discovery::reset();

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessageMatches( '/base_directory not configured/' );
		Log_Discovery::on_disk();
	}

	/** A Log whose file ends in digits keeps its own marker, read before a stripped base's. */
	public function test_a_log_whose_file_ends_in_digits_is_gated_by_its_own_marker(): void {
		\mkdir( "{$this->tmp}/logs", 0700, true );
		\file_put_contents( "{$this->tmp}/logs/.intel-notes.0.read-capability", "harbor_ledger_reader\n" );

		$this->assertSame( 'harbor_ledger_reader', Log_Discovery::gate_of_file( "{$this->tmp}/logs/intel-notes.0" ) );
		$this->assertSame( 'harbor_ledger_reader', Log_Discovery::gate_of_file( "{$this->tmp}/logs/intel-notes.0.7" ) );
		$this->assertNull( Log_Discovery::gate_of_file( "{$this->tmp}/logs/intel-notes" ) );
	}
}
