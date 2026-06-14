<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\CLI;
use Newspack_Nodes\Consumer_Node;
use Newspack_Nodes\Lock_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( CLI::class )]
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

		$cli     = new CLI( $this->tmp );
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

		$cli     = new CLI( $this->tmp );
		$workers = $cli->ls_workers();

		$this->assertCount( 1, $workers );
		$this->assertTrue( $workers[0]['stale'] );
	}

	public function test_ls_returns_empty_when_locks_dir_missing(): void {
		// No locks/ dir created. ls_workers must not error and must return [].
		$cli = new CLI( $this->tmp );
		$this->assertSame( [], $cli->ls_workers() );
	}

	public function test_ls_skips_locks_with_missing_heartbeat(): void {
		// Lock dir present but no heartbeat file at all → treated as stale (mtime false).
		mkdir( "{$this->tmp}/locks", 0755, true );
		mkdir( "{$this->tmp}/locks/jobs.p0.lock.d", 0755, true );
		// No heartbeat file.

		$cli     = new CLI( $this->tmp );
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

		$cli     = new CLI( $this->tmp );
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

		$cli     = new CLI( $this->tmp );
		$workers = $cli->ls_workers();

		$this->assertCount( 4, $workers );
		$ordered = array_map( fn( $w ) => "{$w['type']}.p{$w['partition']}", $workers );
		$this->assertSame( [ 'firehose.p0', 'firehose.p1', 'jobs.p0', 'jobs.p1' ], $ordered );
	}

	// ── base_dir() ─────────────────────────────────────────────────────────────

	public function test_base_dir_returns_constructor_value_without_trailing_slash(): void {
		// Trailing slash should be stripped (rtrim(... '/') in constructor).
		$cli = new CLI( '/tmp/foo/' );
		$this->assertSame( '/tmp/foo', $cli->base_dir() );

		$cli = new CLI( '/tmp/bar' );
		$this->assertSame( '/tmp/bar', $cli->base_dir() );
	}

	// ── parse_worker_id() / attach_to_worker() ─────────────────────────────────

	public function test_parse_worker_id_returns_type_and_partition(): void {
		$this->assertSame( [ 'firehose-workers', 0 ], CLI::parse_worker_id( 'firehose-workers.p0' ) );
		$this->assertSame( [ 'jobs', 12 ], CLI::parse_worker_id( 'jobs.p12' ) );
	}

	public function test_parse_worker_id_handles_dotted_types(): void {
		// Type can contain dots — only the trailing .p{N} is partition.
		$this->assertSame( [ 'foo.bar', 3 ], CLI::parse_worker_id( 'foo.bar.p3' ) );
	}

	public function test_parse_worker_id_throws_on_invalid_input(): void {
		$this->expectException( \InvalidArgumentException::class );
		CLI::parse_worker_id( 'no-partition-suffix' );
	}

	public function test_parse_worker_id_throws_on_non_numeric_partition(): void {
		$this->expectException( \InvalidArgumentException::class );
		CLI::parse_worker_id( 'foo.pX' );
	}

	public function test_attach_to_worker_returns_ipc_paths(): void {
		// Lock dir must exist — that's how attach_to_worker verifies the
		// worker is actually registered (not just any parseable id).
		\mkdir( "{$this->tmp}/locks/firehose-workers.p2.lock.d", 0755, true );

		$cli = new CLI( $this->tmp );
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
		$cli = new CLI( $this->tmp );
		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessageMatches( '/no worker.*typo-bad-name\.p0/' );
		$cli->attach_to_worker( 'typo-bad-name.p0' );
	}

	public function test_attach_to_worker_propagates_invalid_argument(): void {
		$cli = new CLI( $this->tmp );
		$this->expectException( \InvalidArgumentException::class );
		$cli->attach_to_worker( 'bad-id' );
	}

	// ── restart_workers() ──────────────────────────────────────────────────────

	public function test_restart_writes_flag_to_each_lock_dir(): void {
		mkdir( "{$this->tmp}/locks/firehose-workers.p0.lock.d", 0755, true );
		mkdir( "{$this->tmp}/locks/firehose-workers.p1.lock.d", 0755, true );
		mkdir( "{$this->tmp}/locks/jobs.p0.lock.d", 0755, true );

		$cli     = new CLI( $this->tmp );
		$workers = [
			[ 'type' => 'firehose-workers', 'partition' => 0 ],
			[ 'type' => 'firehose-workers', 'partition' => 1 ],
			[ 'type' => 'jobs', 'partition' => 0 ],
		];
		$count   = $cli->restart_workers( $workers );

		$this->assertSame( 3, $count );
		$this->assertFileExists( "{$this->tmp}/locks/firehose-workers.p0.lock.d/" . Lock_Node::RESTART_FLAG );
		$this->assertFileExists( "{$this->tmp}/locks/firehose-workers.p1.lock.d/" . Lock_Node::RESTART_FLAG );
		$this->assertFileExists( "{$this->tmp}/locks/jobs.p0.lock.d/" . Lock_Node::RESTART_FLAG );
	}

	public function test_restart_filters_by_type(): void {
		mkdir( "{$this->tmp}/locks/firehose-workers.p0.lock.d", 0755, true );
		mkdir( "{$this->tmp}/locks/jobs.p0.lock.d", 0755, true );

		$cli     = new CLI( $this->tmp );
		$workers = [
			[ 'type' => 'firehose-workers', 'partition' => 0 ],
			[ 'type' => 'jobs', 'partition' => 0 ],
		];
		// Only restart 'jobs'.
		$count = $cli->restart_workers( $workers, [ 'jobs' => true ] );

		$this->assertSame( 1, $count );
		$this->assertFileDoesNotExist( "{$this->tmp}/locks/firehose-workers.p0.lock.d/" . Lock_Node::RESTART_FLAG );
		$this->assertFileExists( "{$this->tmp}/locks/jobs.p0.lock.d/" . Lock_Node::RESTART_FLAG );
	}

	public function test_restart_filters_by_partition(): void {
		mkdir( "{$this->tmp}/locks/firehose-workers.p0.lock.d", 0755, true );
		mkdir( "{$this->tmp}/locks/firehose-workers.p1.lock.d", 0755, true );

		$cli     = new CLI( $this->tmp );
		$workers = [
			[ 'type' => 'firehose-workers', 'partition' => 0 ],
			[ 'type' => 'firehose-workers', 'partition' => 1 ],
		];
		$count = $cli->restart_workers( $workers, [], 1 );

		$this->assertSame( 1, $count );
		$this->assertFileDoesNotExist( "{$this->tmp}/locks/firehose-workers.p0.lock.d/" . Lock_Node::RESTART_FLAG );
		$this->assertFileExists( "{$this->tmp}/locks/firehose-workers.p1.lock.d/" . Lock_Node::RESTART_FLAG );
	}

	public function test_restart_all_keyword_acts_as_wildcard(): void {
		mkdir( "{$this->tmp}/locks/firehose-workers.p0.lock.d", 0755, true );
		mkdir( "{$this->tmp}/locks/jobs.p0.lock.d", 0755, true );

		$cli     = new CLI( $this->tmp );
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

		$cli     = new CLI( $this->tmp );
		$workers = [
			[ 'type' => '', 'partition' => 0 ],         // skipped
			[ 'type' => 'jobs', 'partition' => 0 ],     // restarted
		];
		$count = $cli->restart_workers( $workers );

		$this->assertSame( 1, $count );
	}

	public function test_restart_skips_when_lock_dir_missing(): void {
		// No lock dirs created → request_restart_at returns false.
		$cli     = new CLI( $this->tmp );
		$workers = [ [ 'type' => 'jobs', 'partition' => 0 ] ];
		$count   = $cli->restart_workers( $workers );

		$this->assertSame( 0, $count );
	}

	public function test_restart_supervisor_writes_flag_at_un_suffixed_lock_dir(): void {
		// The supervisor is the only worker that doesn't run as a partition
		// fleet; it lives at `{locks}/supervisor.lock.d` with no `.pN`
		// suffix. `restart_workers` only knows the `{type}.p{N}` shape, so
		// the supervisor needs its own path.
		\mkdir( "{$this->tmp}/locks/supervisor.lock.d", 0755, true );

		$cli = new CLI( $this->tmp );

		$this->assertTrue( $cli->restart_supervisor() );
		$this->assertFileExists( "{$this->tmp}/locks/supervisor.lock.d/" . Lock_Node::RESTART_FLAG );
	}

	// ── live_position() ────────────────────────────────────────────────────────

	public function test_live_position_returns_null_when_cache_is_null(): void {
		$cli = new CLI( $this->tmp );
		$this->assertNull( $cli->live_position( null, 'jobs', 0 ) );
	}

	public function test_live_position_returns_null_when_cache_lacks_get_method(): void {
		// Object with no get() method → method_exists() returns false → null.
		$cli         = new CLI( $this->tmp );
		$bogus_cache = new \stdClass();
		$this->assertNull( $cli->live_position( $bogus_cache, 'jobs', 0 ) );
	}

	public function test_live_position_returns_null_when_cache_throws(): void {
		// Cache::get throws → caught and returned as null (memcache unreachable).
		$cli   = new CLI( $this->tmp );
		$cache = new class() {
			public function get( $key ) {
				throw new \RuntimeException( 'memcache down' );
			}
		};
		$this->assertNull( $cli->live_position( $cache, 'jobs', 0 ) );
	}

	public function test_live_position_returns_null_for_malformed_value(): void {
		$cli   = new CLI( $this->tmp );
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
		// Worker's offsetlog records source_basename so live_position can derive
		// the same key Consumer_Node::publish_position() wrote.
		$this->seed_offsetlog( 'firehose-workers', 3, 'firehose' );

		$cli      = new CLI( $this->tmp );
		$host     = \gethostname() ?: 'unknown';
		$expected = Consumer_Node::position_key( $host, 'firehose.p3' );

		$cache = new class() {
			public string $last_key = '';
			public function get( $key ) {
				$this->last_key = $key;
				return [ 'seg' => '12', 'off' => '345', 'ts' => '1700000000' ];
			}
		};
		$pos = $cli->live_position( $cache, 'firehose-workers', 3 );

		// CLI must hit the SAME key Workers_CI reads and Consumer writes.
		$this->assertSame( $expected, $cache->last_key );

		// Values cast to int.
		$this->assertSame( 12, $pos['seg'] );
		$this->assertSame( 345, $pos['off'] );
		$this->assertSame( 1700000000, $pos['ts'] );
	}

	public function test_live_position_key_matches_consumer_publish_key(): void {
		// The cli reads Consumer_Node's per-reader key: `np:pos:{host}:{offset-dir}`
		// (offset-dir = `{source_basename}.p{N}`). Pin the contract via
		// Consumer_Node::position_key() so reader and writer can't drift.
		$this->seed_offsetlog( 'jobs', 2, 'jobintake' );

		$cli      = new CLI( $this->tmp );
		$host     = \gethostname() ?: 'unknown';
		$expected = Consumer_Node::position_key( $host, 'jobintake.p2' );

		$cache = new class() {
			public string $last_key = '';
			public function get( $key ) {
				$this->last_key = $key;
				return [ 'seg' => 0, 'off' => 0 ];
			}
		};
		$cli->live_position( $cache, 'jobs', 2 );

		$this->assertSame( $expected, $cache->last_key );
	}

	public function test_live_position_falls_back_to_firehose_when_no_offsetlog(): void {
		// No offsetlog yet → CLI assumes the conventional `firehose` source.
		$cli      = new CLI( $this->tmp );
		$host     = \gethostname() ?: 'unknown';
		$expected = Consumer_Node::position_key( $host, 'firehose.p0' );

		$cache = new class() {
			public string $last_key = '';
			public function get( $key ) {
				$this->last_key = $key;
				return [ 'seg' => 0, 'off' => 0 ];
			}
		};
		$cli->live_position( $cache, 'fresh-worker', 0 );

		$this->assertSame( $expected, $cache->last_key );
	}

	/** Seed an offsetlog with one checkpoint that records $source_basename. */
	private function seed_offsetlog( string $type, int $partition, string $source_basename ): void {
		$dir = "{$this->tmp}/offsets/{$type}.p{$partition}";
		mkdir( $dir, 0755, true );
		file_put_contents(
			"{$dir}/0.log",
			json_encode( [
				'seg'             => 0,
				'off'             => 0,
				'ts'              => 1700000000,
				'source_basename' => $source_basename,
			] ) . "\n"
		);
	}

	public function test_live_position_defaults_ts_to_zero_when_missing(): void {
		$cli   = new CLI( $this->tmp );
		$cache = new class() {
			public function get( $key ) {
				return [ 'seg' => 5, 'off' => 100 ];
			}
		};
		$pos = $cli->live_position( $cache, 'jobs', 0 );

		$this->assertSame( 0, $pos['ts'] );
	}

	// ── consumer_rows() / read_offsetlog_entry() ────────────────────────────────

	/** Seed a real packed-Message checkpoint at offsets/{source_basename}.p{partition}/0.log. */
	private function seed_packed_checkpoint( string $source_basename, int $partition, array $value ): void {
		$dir = "{$this->tmp}/offsets/{$source_basename}.p{$partition}";
		mkdir( $dir, 0755, true );
		$msg                       = Message::new_message();
		$msg[ Message::TYPE ]      = Message::TM_STRUCT;
		$msg[ Message::TIMESTAMP ] = 1700000000.0;
		$msg[ Message::VALUE ]     = $value;
		file_put_contents( "{$dir}/0.log", Message::packed( $msg ) . "\n" );
	}

	public function test_consumer_rows_enumerates_per_consumer_from_packed_checkpoints(): void {
		// Two readers tail the SAME firehose.log under distinct offset dirs; the
		// enumeration returns one row per Consumer, keyed by the source-named dir,
		// carrying the worker_type + real source_log from the packed checkpoint.
		$this->seed_packed_checkpoint( 'firehose', 0, [
			'seg' => 5, 'off' => 100, 'ts' => 1700000000.0,
			'worker_type' => 'combined', 'source_log' => 'firehose.log',
		] );
		$this->seed_packed_checkpoint( 'firehose.job-router', 0, [
			'seg' => 8, 'off' => 7, 'ts' => 1700000001.0,
			'worker_type' => 'combined', 'source_log' => 'firehose.log',
		] );

		$rows = ( new CLI( $this->tmp ) )->consumer_rows();
		\usort( $rows, static fn ( $a, $b ) => $a['source_basename'] <=> $b['source_basename'] );

		$this->assertCount( 2, $rows );
		$this->assertSame( 'firehose', $rows[0]['source_basename'] );
		$this->assertSame( 'firehose.log', $rows[0]['source_log'] );
		$this->assertSame( 'combined', $rows[0]['worker_type'] );
		$this->assertSame( 5, $rows[0]['seg'] );
		$this->assertSame( 100, $rows[0]['off'] );
		$this->assertSame( 'firehose.job-router', $rows[1]['source_basename'] );
		$this->assertSame( 8, $rows[1]['seg'] );
	}

	public function test_consumer_rows_skips_checkpoints_without_worker_type(): void {
		// A checkpoint with no worker_type can't be attributed to a worker — skip it.
		$this->seed_packed_checkpoint( 'orphan', 0, [ 'seg' => 1, 'off' => 2, 'source_log' => 'orphan.log' ] );
		$this->assertSame( [], ( new CLI( $this->tmp ) )->consumer_rows() );
	}

	public function test_read_offsetlog_entry_reads_packed_value(): void {
		$this->seed_packed_checkpoint( 'jobintake', 0, [
			'seg' => 3, 'off' => 42, 'worker_type' => 'combined', 'source_log' => 'jobintake.log',
		] );
		$entry = ( new CLI( $this->tmp ) )->read_offsetlog_entry( 'jobintake.p0' );
		$this->assertIsArray( $entry );
		$this->assertSame( 3, $entry['seg'] );
		$this->assertSame( 42, $entry['off'] );
		$this->assertSame( 'jobintake.log', $entry['source_log'] );
	}

	public function test_read_offsetlog_entry_returns_null_for_missing_dir(): void {
		$this->assertNull( ( new CLI( $this->tmp ) )->read_offsetlog_entry( 'nope.p0' ) );
	}

	public function test_read_offsetlog_entry_returns_null_when_value_not_array(): void {
		// A checkpoint whose Message VALUE is a string (not the expected object)
		// must be rejected, not returned as a bogus entry.
		$dir = "{$this->tmp}/offsets/firehose.p0";
		mkdir( $dir, 0755, true );
		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$msg[ Message::VALUE ] = 'not-an-object';
		file_put_contents( "{$dir}/0.log", Message::packed( $msg ) . "\n" );

		$this->assertNull( ( new CLI( $this->tmp ) )->read_offsetlog_entry( 'firehose.p0' ) );
	}

	// ── calculate_behind() ─────────────────────────────────────────────────────

	public function test_calculate_behind_returns_zero_when_partition_dir_missing(): void {
		$this->assertSame( 0, CLI::calculate_behind( "{$this->tmp}/missing", 0, 0 ) );
	}

	public function test_calculate_behind_returns_zero_when_no_segments(): void {
		mkdir( "{$this->tmp}/p0", 0755, true );
		$this->assertSame( 0, CLI::calculate_behind( "{$this->tmp}/p0", 0, 0 ) );
	}

	public function test_calculate_behind_sums_remaining_in_current_and_later_segments(): void {
		mkdir( "{$this->tmp}/p0", 0755, true );
		// Three 1KB segments: 0, 1, 2.
		file_put_contents( "{$this->tmp}/p0/0.log", str_repeat( 'a', 1000 ) );
		file_put_contents( "{$this->tmp}/p0/1.log", str_repeat( 'b', 2000 ) );
		file_put_contents( "{$this->tmp}/p0/2.log", str_repeat( 'c', 500 ) );

		// Cursor at seg=0 offset=200 → behind = 800 (seg 0) + 2000 + 500 = 3300.
		$this->assertSame( 3300, CLI::calculate_behind( "{$this->tmp}/p0", 0, 200 ) );

		// Cursor at end of seg 1 → behind = 0 + 500.
		$this->assertSame( 500, CLI::calculate_behind( "{$this->tmp}/p0", 1, 2000 ) );

		// Cursor caught up to end of seg 2 → 0.
		$this->assertSame( 0, CLI::calculate_behind( "{$this->tmp}/p0", 2, 500 ) );
	}

	public function test_calculate_behind_handles_cursor_seg_not_present(): void {
		// When cursor seg has been compacted away, all remaining segments count.
		mkdir( "{$this->tmp}/p0", 0755, true );
		file_put_contents( "{$this->tmp}/p0/5.log", str_repeat( 'x', 1000 ) );
		file_put_contents( "{$this->tmp}/p0/6.log", str_repeat( 'y', 1000 ) );

		// Cursor at seg 4 (no longer exists) → both later segs count.
		$this->assertSame( 2000, CLI::calculate_behind( "{$this->tmp}/p0", 4, 0 ) );
	}

	public function test_calculate_behind_ignores_non_segment_files(): void {
		mkdir( "{$this->tmp}/p0", 0755, true );
		file_put_contents( "{$this->tmp}/p0/0.log", str_repeat( 'a', 100 ) );
		file_put_contents( "{$this->tmp}/p0/foo.txt", str_repeat( 'b', 9999 ) );
		file_put_contents( "{$this->tmp}/p0/index.html", str_repeat( 'c', 9999 ) );

		// Only 0.log counts. Cursor at offset 50 → 50 bytes behind.
		$this->assertSame( 50, CLI::calculate_behind( "{$this->tmp}/p0", 0, 50 ) );
	}

	public function test_calculate_behind_clamps_negative_remaining_to_zero(): void {
		// Cursor offset > segment size (e.g., file truncated externally) → don't go negative.
		mkdir( "{$this->tmp}/p0", 0755, true );
		file_put_contents( "{$this->tmp}/p0/0.log", str_repeat( 'a', 100 ) );

		$this->assertSame( 0, CLI::calculate_behind( "{$this->tmp}/p0", 0, 9999 ) );
	}

	// ── format_bytes() ─────────────────────────────────────────────────────────

	public function test_format_bytes_units(): void {
		// Each branch of the unit ladder.
		$this->assertSame( '0B', CLI::format_bytes( 0 ) );
		$this->assertSame( '512B', CLI::format_bytes( 512 ) );
		$this->assertSame( '1023B', CLI::format_bytes( 1023 ) );
		$this->assertSame( '1KB', CLI::format_bytes( 1024 ) );
		$this->assertSame( '1.5KB', CLI::format_bytes( 1536 ) );
		$this->assertSame( '1MB', CLI::format_bytes( 1024 * 1024 ) );
		$this->assertSame( '2.5MB', CLI::format_bytes( (int) ( 1024 * 1024 * 2.5 ) ) );
		$this->assertSame( '1GB', CLI::format_bytes( 1024 * 1024 * 1024 ) );
		// Petabyte-scale falls into GB branch (no PB tier).
		$this->assertSame( '1024GB', CLI::format_bytes( 1024 * 1024 * 1024 * 1024 ) );
	}

	// ── format_duration() ──────────────────────────────────────────────────────

	public function test_format_duration_units(): void {
		$this->assertSame( '0s', CLI::format_duration( 0 ) );
		$this->assertSame( '59s', CLI::format_duration( 59 ) );
		$this->assertSame( '1m', CLI::format_duration( 60 ) );
		$this->assertSame( '5m', CLI::format_duration( 5 * 60 ) );
		$this->assertSame( '59m', CLI::format_duration( 59 * 60 + 30 ) );
		$this->assertSame( '1h', CLI::format_duration( 3600 ) );
		$this->assertSame( '23h', CLI::format_duration( 86399 ) );
		$this->assertSame( '1d', CLI::format_duration( 86400 ) );
		$this->assertSame( '7d', CLI::format_duration( 7 * 86400 ) );
	}
}
