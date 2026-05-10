<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Cli;
use Newspack_Nodes\Lock;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Cli::class )]
class CliTest extends TestCase {
	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		$this->tmp = $this->make_temp_dir();
	}

	protected function tearDown(): void {
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	// ── ls_workers() ───────────────────────────────────────────────────────────

	public function test_ls_returns_workers_from_lock_dirs(): void {
		mkdir( "{$this->tmp}/locks", 0755, true );
		mkdir( "{$this->tmp}/locks/firehose-workers.p0.lock.d", 0755, true );
		touch( "{$this->tmp}/locks/firehose-workers.p0.lock.d/heartbeat" );
		mkdir( "{$this->tmp}/locks/firehose-workers.p1.lock.d", 0755, true );
		touch( "{$this->tmp}/locks/firehose-workers.p1.lock.d/heartbeat" );

		$cli     = new Cli( $this->tmp );
		$workers = $cli->ls_workers();

		$this->assertCount( 2, $workers );
		$this->assertSame( 'firehose-workers', $workers[0]['type'] );
		$this->assertSame( 0, $workers[0]['partition'] );
		$this->assertSame( 1, $workers[1]['partition'] );
		$this->assertFalse( $workers[0]['stale'] );
	}

	public function test_ls_skips_stale_locks(): void {
		mkdir( "{$this->tmp}/locks", 0755, true );
		mkdir( "{$this->tmp}/locks/foo.p0.lock.d", 0755, true );
		touch( "{$this->tmp}/locks/foo.p0.lock.d/heartbeat", time() - 3600 );

		$cli     = new Cli( $this->tmp );
		$workers = $cli->ls_workers();

		$this->assertCount( 1, $workers );
		$this->assertTrue( $workers[0]['stale'] );
	}

	public function test_ls_returns_empty_when_locks_dir_missing(): void {
		// No locks/ dir created. ls_workers must not error and must return [].
		$cli = new Cli( $this->tmp );
		$this->assertSame( [], $cli->ls_workers() );
	}

	public function test_ls_skips_locks_with_missing_heartbeat(): void {
		// Lock dir present but no heartbeat file at all → treated as stale (mtime false).
		mkdir( "{$this->tmp}/locks", 0755, true );
		mkdir( "{$this->tmp}/locks/jobs.p0.lock.d", 0755, true );
		// No heartbeat file.

		$cli     = new Cli( $this->tmp );
		$workers = $cli->ls_workers();

		$this->assertCount( 1, $workers );
		$this->assertTrue( $workers[0]['stale'] );
		$this->assertSame( 0, $workers[0]['heartbeat_at'] );
	}

	public function test_ls_skips_unrelated_entries_in_locks_dir(): void {
		// Stale assumption: only entries matching {type}.p{N}.lock.d should be listed.
		mkdir( "{$this->tmp}/locks", 0755, true );
		mkdir( "{$this->tmp}/locks/firehose-workers.p0.lock.d", 0755, true );
		touch( "{$this->tmp}/locks/firehose-workers.p0.lock.d/heartbeat" );
		// Bogus entries that should be ignored:
		mkdir( "{$this->tmp}/locks/garbage", 0755, true );
		touch( "{$this->tmp}/locks/.hidden" );
		mkdir( "{$this->tmp}/locks/foo.bar", 0755, true );

		$cli     = new Cli( $this->tmp );
		$workers = $cli->ls_workers();

		$this->assertCount( 1, $workers );
		$this->assertSame( 'firehose-workers', $workers[0]['type'] );
	}

	public function test_ls_sorts_by_type_then_partition(): void {
		mkdir( "{$this->tmp}/locks", 0755, true );
		// Create out of order; expect sorted output.
		foreach ( [ 'jobs.p1', 'firehose.p0', 'jobs.p0', 'firehose.p1' ] as $name ) {
			mkdir( "{$this->tmp}/locks/{$name}.lock.d", 0755, true );
			touch( "{$this->tmp}/locks/{$name}.lock.d/heartbeat" );
		}

		$cli     = new Cli( $this->tmp );
		$workers = $cli->ls_workers();

		$this->assertCount( 4, $workers );
		$ordered = array_map( fn( $w ) => "{$w['type']}.p{$w['partition']}", $workers );
		$this->assertSame( [ 'firehose.p0', 'firehose.p1', 'jobs.p0', 'jobs.p1' ], $ordered );
	}

	// ── base_dir() ─────────────────────────────────────────────────────────────

	public function test_base_dir_returns_constructor_value_without_trailing_slash(): void {
		// Trailing slash should be stripped (rtrim(... '/') in constructor).
		$cli = new Cli( '/tmp/foo/' );
		$this->assertSame( '/tmp/foo', $cli->base_dir() );

		$cli = new Cli( '/tmp/bar' );
		$this->assertSame( '/tmp/bar', $cli->base_dir() );
	}

	// ── parse_reader_id() / attach_to_worker() ─────────────────────────────────

	public function test_parse_reader_id_returns_type_and_partition(): void {
		$this->assertSame( [ 'firehose-workers', 0 ], Cli::parse_reader_id( 'firehose-workers.p0' ) );
		$this->assertSame( [ 'jobs', 12 ], Cli::parse_reader_id( 'jobs.p12' ) );
	}

	public function test_parse_reader_id_handles_dotted_types(): void {
		// Type can contain dots — only the trailing .p{N} is partition.
		$this->assertSame( [ 'foo.bar', 3 ], Cli::parse_reader_id( 'foo.bar.p3' ) );
	}

	public function test_parse_reader_id_throws_on_invalid_input(): void {
		$this->expectException( \InvalidArgumentException::class );
		Cli::parse_reader_id( 'no-partition-suffix' );
	}

	public function test_parse_reader_id_throws_on_non_numeric_partition(): void {
		$this->expectException( \InvalidArgumentException::class );
		Cli::parse_reader_id( 'foo.pX' );
	}

	public function test_attach_to_worker_returns_ipc_paths(): void {
		// Lock dir must exist — that's how attach_to_worker verifies the
		// worker is actually registered (not just any parseable id).
		\mkdir( "{$this->tmp}/locks/firehose-workers.p2.lock.d", 0755, true );

		$cli = new Cli( $this->tmp );
		$ipc = $cli->attach_to_worker( 'firehose-workers.p2' );

		$this->assertSame( "{$this->tmp}/ipc/firehose-workers.p2/input", $ipc['input'] );
		$this->assertSame( "{$this->tmp}/ipc/firehose-workers.p2/output", $ipc['output'] );
		$this->assertSame( 'firehose-workers', $ipc['type'] );
		$this->assertSame( 2, $ipc['partition'] );
	}

	public function test_attach_to_worker_throws_when_lock_dir_missing(): void {
		// Worker isn't registered (no lock dir under `{base}/locks/`). cli
		// must hard-fail with a useful message instead of silently creating
		// ghost IPC partitions that nobody reads/writes. Without this,
		// `wp nodes cli typoed-name.p0` looks like it works but every
		// command is silently swallowed.
		$cli = new Cli( $this->tmp );
		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessageMatches( '/no worker.*typo-bad-name\.p0/' );
		$cli->attach_to_worker( 'typo-bad-name.p0' );
	}

	public function test_attach_to_worker_propagates_invalid_argument(): void {
		$cli = new Cli( $this->tmp );
		$this->expectException( \InvalidArgumentException::class );
		$cli->attach_to_worker( 'bad-id' );
	}

	// ── restart_workers() ──────────────────────────────────────────────────────

	public function test_restart_writes_flag_to_each_lock_dir(): void {
		mkdir( "{$this->tmp}/locks/firehose-workers.p0.lock.d", 0755, true );
		mkdir( "{$this->tmp}/locks/firehose-workers.p1.lock.d", 0755, true );
		mkdir( "{$this->tmp}/locks/jobs.p0.lock.d", 0755, true );

		$cli     = new Cli( $this->tmp );
		$workers = [
			[ 'type' => 'firehose-workers', 'partition' => 0 ],
			[ 'type' => 'firehose-workers', 'partition' => 1 ],
			[ 'type' => 'jobs', 'partition' => 0 ],
		];
		$count   = $cli->restart_workers( $workers );

		$this->assertSame( 3, $count );
		$this->assertFileExists( "{$this->tmp}/locks/firehose-workers.p0.lock.d/" . Lock::RESTART_FLAG );
		$this->assertFileExists( "{$this->tmp}/locks/firehose-workers.p1.lock.d/" . Lock::RESTART_FLAG );
		$this->assertFileExists( "{$this->tmp}/locks/jobs.p0.lock.d/" . Lock::RESTART_FLAG );
	}

	public function test_restart_filters_by_type(): void {
		mkdir( "{$this->tmp}/locks/firehose-workers.p0.lock.d", 0755, true );
		mkdir( "{$this->tmp}/locks/jobs.p0.lock.d", 0755, true );

		$cli     = new Cli( $this->tmp );
		$workers = [
			[ 'type' => 'firehose-workers', 'partition' => 0 ],
			[ 'type' => 'jobs', 'partition' => 0 ],
		];
		// Only restart 'jobs'.
		$count = $cli->restart_workers( $workers, [ 'jobs' => true ] );

		$this->assertSame( 1, $count );
		$this->assertFileDoesNotExist( "{$this->tmp}/locks/firehose-workers.p0.lock.d/" . Lock::RESTART_FLAG );
		$this->assertFileExists( "{$this->tmp}/locks/jobs.p0.lock.d/" . Lock::RESTART_FLAG );
	}

	public function test_restart_filters_by_partition(): void {
		mkdir( "{$this->tmp}/locks/firehose-workers.p0.lock.d", 0755, true );
		mkdir( "{$this->tmp}/locks/firehose-workers.p1.lock.d", 0755, true );

		$cli     = new Cli( $this->tmp );
		$workers = [
			[ 'type' => 'firehose-workers', 'partition' => 0 ],
			[ 'type' => 'firehose-workers', 'partition' => 1 ],
		];
		$count = $cli->restart_workers( $workers, [], 1 );

		$this->assertSame( 1, $count );
		$this->assertFileDoesNotExist( "{$this->tmp}/locks/firehose-workers.p0.lock.d/" . Lock::RESTART_FLAG );
		$this->assertFileExists( "{$this->tmp}/locks/firehose-workers.p1.lock.d/" . Lock::RESTART_FLAG );
	}

	public function test_restart_all_keyword_acts_as_wildcard(): void {
		mkdir( "{$this->tmp}/locks/firehose-workers.p0.lock.d", 0755, true );
		mkdir( "{$this->tmp}/locks/jobs.p0.lock.d", 0755, true );

		$cli     = new Cli( $this->tmp );
		$workers = [
			[ 'type' => 'firehose-workers', 'partition' => 0 ],
			[ 'type' => 'jobs', 'partition' => 0 ],
		];
		// 'all' filter keyword bypasses per-type filtering.
		$count = $cli->restart_workers( $workers, [ 'all' => true ] );

		$this->assertSame( 2, $count );
	}

	public function test_restart_skips_workers_with_empty_type(): void {
		mkdir( "{$this->tmp}/locks/jobs.p0.lock.d", 0755, true );

		$cli     = new Cli( $this->tmp );
		$workers = [
			[ 'type' => '', 'partition' => 0 ],         // skipped
			[ 'type' => 'jobs', 'partition' => 0 ],     // restarted
		];
		$count = $cli->restart_workers( $workers );

		$this->assertSame( 1, $count );
	}

	public function test_restart_skips_when_lock_dir_missing(): void {
		// No lock dirs created → request_restart_at returns false.
		$cli     = new Cli( $this->tmp );
		$workers = [ [ 'type' => 'jobs', 'partition' => 0 ] ];
		$count   = $cli->restart_workers( $workers );

		$this->assertSame( 0, $count );
	}

	// ── live_position() ────────────────────────────────────────────────────────

	public function test_live_position_returns_null_when_cache_is_null(): void {
		$cli = new Cli( $this->tmp );
		$this->assertNull( $cli->live_position( null, 'jobs', 0 ) );
	}

	public function test_live_position_returns_null_when_cache_lacks_get_method(): void {
		// Object with no get() method → method_exists() returns false → null.
		$cli         = new Cli( $this->tmp );
		$bogus_cache = new \stdClass();
		$this->assertNull( $cli->live_position( $bogus_cache, 'jobs', 0 ) );
	}

	public function test_live_position_returns_null_when_cache_throws(): void {
		// Cache::get throws → caught and returned as null (memcache unreachable).
		$cli   = new Cli( $this->tmp );
		$cache = new class() {
			public function get( $key ) {
				throw new \RuntimeException( 'memcache down' );
			}
		};
		$this->assertNull( $cli->live_position( $cache, 'jobs', 0 ) );
	}

	public function test_live_position_returns_null_for_malformed_value(): void {
		$cli   = new Cli( $this->tmp );
		// Missing 'seg' / 'off' → null. Also non-array values.
		$cache = new class() {
			public function get( $key ) {
				return 'not-an-array';
			}
		};
		$this->assertNull( $cli->live_position( $cache, 'jobs', 0 ) );

		$cache2 = new class() {
			public function get( $key ) {
				return [ 'foo' => 'bar' ];
			}
		};
		$this->assertNull( $cli->live_position( $cache2, 'jobs', 0 ) );
	}

	public function test_live_position_returns_normalized_position(): void {
		$cli   = new Cli( $this->tmp );
		$cache = new class() {
			public string $last_key = '';
			public function get( $key ) {
				$this->last_key = $key;
				return [ 'seg' => '12', 'off' => '345', 'ts' => '1700000000' ];
			}
		};
		$pos = $cli->live_position( $cache, 'firehose-workers', 3 );

		// Verify cache key built from POSITION_KEY_PREFIX + type + .p{partition}.
		$this->assertSame( Cli::POSITION_KEY_PREFIX . 'firehose-workers.p3', $cache->last_key );

		// Values cast to int.
		$this->assertSame( 12, $pos['seg'] );
		$this->assertSame( 345, $pos['off'] );
		$this->assertSame( 1700000000, $pos['ts'] );
	}

	public function test_live_position_defaults_ts_to_zero_when_missing(): void {
		$cli   = new Cli( $this->tmp );
		$cache = new class() {
			public function get( $key ) {
				return [ 'seg' => 5, 'off' => 100 ];
			}
		};
		$pos = $cli->live_position( $cache, 'jobs', 0 );

		$this->assertSame( 0, $pos['ts'] );
	}

	// ── saved_position() ───────────────────────────────────────────────────────

	public function test_saved_position_returns_null_when_offset_dir_missing(): void {
		$cli = new Cli( $this->tmp );
		$this->assertNull( $cli->saved_position( 'jobs', 0 ) );
	}

	public function test_saved_position_returns_null_when_no_segments_present(): void {
		// Dir exists but no .log files.
		mkdir( "{$this->tmp}/offsets/jobs.p0/p0", 0755, true );
		// Random non-segment files should be ignored.
		touch( "{$this->tmp}/offsets/jobs.p0/p0/random.txt" );

		$cli = new Cli( $this->tmp );
		$this->assertNull( $cli->saved_position( 'jobs', 0 ) );
	}

	public function test_saved_position_reads_last_line_of_newest_segment(): void {
		mkdir( "{$this->tmp}/offsets/jobs.p0/p0", 0755, true );
		// Older segment.
		file_put_contents(
			"{$this->tmp}/offsets/jobs.p0/p0/0.log",
			json_encode( [ 'seg' => 0, 'off' => 100, 'ts' => 1 ] ) . "\n"
		);
		// Newest segment with multiple lines — last line wins.
		file_put_contents(
			"{$this->tmp}/offsets/jobs.p0/p0/5.log",
			json_encode( [ 'seg' => 5, 'off' => 200, 'ts' => 1700 ] ) . "\n" .
			json_encode( [ 'seg' => 5, 'off' => 999, 'ts' => 1800 ] ) . "\n"
		);

		$cli = new Cli( $this->tmp );
		$pos = $cli->saved_position( 'jobs', 0 );

		$this->assertSame( 5, $pos['seg'] );
		$this->assertSame( 999, $pos['off'] );
		$this->assertSame( 1800, $pos['ts'] );
	}

	public function test_saved_position_returns_null_when_segment_empty(): void {
		mkdir( "{$this->tmp}/offsets/jobs.p0/p0", 0755, true );
		// Segment file present but empty.
		touch( "{$this->tmp}/offsets/jobs.p0/p0/0.log" );

		$cli = new Cli( $this->tmp );
		$this->assertNull( $cli->saved_position( 'jobs', 0 ) );
	}

	public function test_saved_position_returns_null_when_lines_only_blank(): void {
		mkdir( "{$this->tmp}/offsets/jobs.p0/p0", 0755, true );
		// Trailing newlines but no JSON content.
		file_put_contents( "{$this->tmp}/offsets/jobs.p0/p0/0.log", "\n\n\n" );

		$cli = new Cli( $this->tmp );
		$this->assertNull( $cli->saved_position( 'jobs', 0 ) );
	}

	public function test_saved_position_returns_null_for_invalid_json(): void {
		mkdir( "{$this->tmp}/offsets/jobs.p0/p0", 0755, true );
		file_put_contents( "{$this->tmp}/offsets/jobs.p0/p0/0.log", "not-json\n" );

		$cli = new Cli( $this->tmp );
		$this->assertNull( $cli->saved_position( 'jobs', 0 ) );
	}

	public function test_saved_position_returns_null_for_json_missing_required_keys(): void {
		mkdir( "{$this->tmp}/offsets/jobs.p0/p0", 0755, true );
		file_put_contents(
			"{$this->tmp}/offsets/jobs.p0/p0/0.log",
			json_encode( [ 'unrelated' => 'field' ] ) . "\n"
		);

		$cli = new Cli( $this->tmp );
		$this->assertNull( $cli->saved_position( 'jobs', 0 ) );
	}

	public function test_saved_position_defaults_ts_to_zero_when_missing(): void {
		mkdir( "{$this->tmp}/offsets/jobs.p0/p0", 0755, true );
		file_put_contents(
			"{$this->tmp}/offsets/jobs.p0/p0/0.log",
			json_encode( [ 'seg' => 1, 'off' => 50 ] ) . "\n"
		);

		$cli = new Cli( $this->tmp );
		$pos = $cli->saved_position( 'jobs', 0 );
		$this->assertSame( 0, $pos['ts'] );
	}

	public function test_saved_position_picks_highest_numbered_segment_not_alphabetical(): void {
		mkdir( "{$this->tmp}/offsets/jobs.p0/p0", 0755, true );
		// '10' would sort before '2' alphabetically; ensure we sort numerically.
		file_put_contents(
			"{$this->tmp}/offsets/jobs.p0/p0/2.log",
			json_encode( [ 'seg' => 2, 'off' => 0 ] ) . "\n"
		);
		file_put_contents(
			"{$this->tmp}/offsets/jobs.p0/p0/10.log",
			json_encode( [ 'seg' => 10, 'off' => 5000 ] ) . "\n"
		);

		$cli = new Cli( $this->tmp );
		$pos = $cli->saved_position( 'jobs', 0 );
		$this->assertSame( 10, $pos['seg'] );
		$this->assertSame( 5000, $pos['off'] );
	}

	// ── calculate_behind() ─────────────────────────────────────────────────────

	public function test_calculate_behind_returns_zero_when_partition_dir_missing(): void {
		$this->assertSame( 0, Cli::calculate_behind( "{$this->tmp}/missing", 0, 0 ) );
	}

	public function test_calculate_behind_returns_zero_when_no_segments(): void {
		mkdir( "{$this->tmp}/p0", 0755, true );
		$this->assertSame( 0, Cli::calculate_behind( "{$this->tmp}/p0", 0, 0 ) );
	}

	public function test_calculate_behind_sums_remaining_in_current_and_later_segments(): void {
		mkdir( "{$this->tmp}/p0", 0755, true );
		// Three 1KB segments: 0, 1, 2.
		file_put_contents( "{$this->tmp}/p0/0.log", str_repeat( 'a', 1000 ) );
		file_put_contents( "{$this->tmp}/p0/1.log", str_repeat( 'b', 2000 ) );
		file_put_contents( "{$this->tmp}/p0/2.log", str_repeat( 'c', 500 ) );

		// Cursor at seg=0 offset=200 → behind = 800 (seg 0) + 2000 + 500 = 3300.
		$this->assertSame( 3300, Cli::calculate_behind( "{$this->tmp}/p0", 0, 200 ) );

		// Cursor at end of seg 1 → behind = 0 + 500.
		$this->assertSame( 500, Cli::calculate_behind( "{$this->tmp}/p0", 1, 2000 ) );

		// Cursor caught up to end of seg 2 → 0.
		$this->assertSame( 0, Cli::calculate_behind( "{$this->tmp}/p0", 2, 500 ) );
	}

	public function test_calculate_behind_handles_cursor_seg_not_present(): void {
		// When cursor seg has been compacted away, all remaining segments count.
		mkdir( "{$this->tmp}/p0", 0755, true );
		file_put_contents( "{$this->tmp}/p0/5.log", str_repeat( 'x', 1000 ) );
		file_put_contents( "{$this->tmp}/p0/6.log", str_repeat( 'y', 1000 ) );

		// Cursor at seg 4 (no longer exists) → both later segs count.
		$this->assertSame( 2000, Cli::calculate_behind( "{$this->tmp}/p0", 4, 0 ) );
	}

	public function test_calculate_behind_ignores_non_segment_files(): void {
		mkdir( "{$this->tmp}/p0", 0755, true );
		file_put_contents( "{$this->tmp}/p0/0.log", str_repeat( 'a', 100 ) );
		file_put_contents( "{$this->tmp}/p0/foo.txt", str_repeat( 'b', 9999 ) );
		file_put_contents( "{$this->tmp}/p0/index.html", str_repeat( 'c', 9999 ) );

		// Only 0.log counts. Cursor at offset 50 → 50 bytes behind.
		$this->assertSame( 50, Cli::calculate_behind( "{$this->tmp}/p0", 0, 50 ) );
	}

	public function test_calculate_behind_clamps_negative_remaining_to_zero(): void {
		// Cursor offset > segment size (e.g., file truncated externally) → don't go negative.
		mkdir( "{$this->tmp}/p0", 0755, true );
		file_put_contents( "{$this->tmp}/p0/0.log", str_repeat( 'a', 100 ) );

		$this->assertSame( 0, Cli::calculate_behind( "{$this->tmp}/p0", 0, 9999 ) );
	}

	// ── format_bytes() ─────────────────────────────────────────────────────────

	public function test_format_bytes_units(): void {
		// Each branch of the unit ladder.
		$this->assertSame( '0B', Cli::format_bytes( 0 ) );
		$this->assertSame( '512B', Cli::format_bytes( 512 ) );
		$this->assertSame( '1023B', Cli::format_bytes( 1023 ) );
		$this->assertSame( '1KB', Cli::format_bytes( 1024 ) );
		$this->assertSame( '1.5KB', Cli::format_bytes( 1536 ) );
		$this->assertSame( '1MB', Cli::format_bytes( 1024 * 1024 ) );
		$this->assertSame( '2.5MB', Cli::format_bytes( (int) ( 1024 * 1024 * 2.5 ) ) );
		$this->assertSame( '1GB', Cli::format_bytes( 1024 * 1024 * 1024 ) );
		// Petabyte-scale falls into GB branch (no PB tier).
		$this->assertSame( '1024GB', Cli::format_bytes( 1024 * 1024 * 1024 * 1024 ) );
	}

	// ── format_duration() ──────────────────────────────────────────────────────

	public function test_format_duration_units(): void {
		$this->assertSame( '0s', Cli::format_duration( 0 ) );
		$this->assertSame( '59s', Cli::format_duration( 59 ) );
		$this->assertSame( '1m', Cli::format_duration( 60 ) );
		$this->assertSame( '5m', Cli::format_duration( 5 * 60 ) );
		$this->assertSame( '59m', Cli::format_duration( 59 * 60 + 30 ) );
		$this->assertSame( '1h', Cli::format_duration( 3600 ) );
		$this->assertSame( '23h', Cli::format_duration( 86399 ) );
		$this->assertSame( '1d', Cli::format_duration( 86400 ) );
		$this->assertSame( '7d', Cli::format_duration( 7 * 86400 ) );
	}
}
