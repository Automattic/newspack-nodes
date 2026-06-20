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

	public function test_live_position_returns_null_when_no_matching_record(): void {
		$this->assertNull( ( new CLI( $this->tmp ) )->live_position( [], 'jobs', 0 ) );
	}

	public function test_live_position_returns_the_workers_consumer_position(): void {
		// Matches by worker_type + `.p{N}` suffix; cursor_seg/off/ts cast to int.
		$index = [
			'jobintake.p0' => [ 'worker_type' => 'jobs', 'cursor_seg' => '12', 'cursor_off' => '345', 'ts' => '1700000000' ],
		];
		$pos = ( new CLI( $this->tmp ) )->live_position( $index, 'jobs', 0 );
		$this->assertSame( 12, $pos['seg'] );
		$this->assertSame( 345, $pos['off'] );
		$this->assertSame( 1700000000, $pos['ts'] );
	}

	public function test_live_position_prefers_the_primary_input_over_disambiguated_readers(): void {
		// A worker reading one log under several offset dirs: the shortest
		// offset_dir is the base input; a disambiguated reader must not shadow it.
		$index = [
			'firehose.job-router.p0' => [ 'worker_type' => 'combined', 'cursor_seg' => 8, 'cursor_off' => 7 ],
			'firehose.p0'            => [ 'worker_type' => 'combined', 'cursor_seg' => 5, 'cursor_off' => 100 ],
		];
		$pos = ( new CLI( $this->tmp ) )->live_position( $index, 'combined', 0 );
		$this->assertSame( 5, $pos['seg'], 'primary input (shortest offset_dir) wins' );
		$this->assertSame( 100, $pos['off'] );
	}

	public function test_live_position_ignores_other_partitions_and_types(): void {
		$index = [
			'firehose.p1' => [ 'worker_type' => 'combined', 'cursor_seg' => 1, 'cursor_off' => 1 ],
			'jobs.p0'     => [ 'worker_type' => 'jobs', 'cursor_seg' => 2, 'cursor_off' => 2 ],
		];
		$this->assertNull( ( new CLI( $this->tmp ) )->live_position( $index, 'combined', 0 ) );
	}

	public function test_live_position_defaults_ts_to_zero_when_missing(): void {
		$index = [ 'jobs.p0' => [ 'worker_type' => 'jobs', 'cursor_seg' => 5, 'cursor_off' => 100 ] ];
		$pos   = ( new CLI( $this->tmp ) )->live_position( $index, 'jobs', 0 );
		$this->assertSame( 0, $pos['ts'] );
	}

	// ── read_probe_index() ───────────────────────────────────────────────────────

	/** Append a packed-Message probe record to logs/topicprobe.p0/0.log. */
	private function seed_probe_record( array $value ): void {
		$dir = "{$this->tmp}/logs/topicprobe.p0";
		if ( ! is_dir( $dir ) ) {
			mkdir( $dir, 0755, true );
		}
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_STRUCT;
		$message[ Message::VALUE ] = $value;
		file_put_contents( "{$dir}/0.log", Message::packed( $message ) . "\n", FILE_APPEND );
	}

	public function test_read_probe_index_keys_topicprobe_records_by_offset_dir(): void {
		$this->seed_probe_record( [ 'offset_dir' => 'firehose.p0', 'cursor_seg' => 2, 'cursor_off' => 50, 'consumer' => 'firehose' ] );
		$this->seed_probe_record( [ 'offset_dir' => 'jobintake.p0', 'cursor_seg' => 1, 'cursor_off' => 9, 'consumer' => 'jobintake' ] );

		$index = ( new CLI( $this->tmp ) )->read_probe_index();

		$this->assertSame( [ 'firehose.p0', 'jobintake.p0' ], \array_keys( $index ) );
		$this->assertSame( 2, $index['firehose.p0']['cursor_seg'] );
		$this->assertSame( 9, $index['jobintake.p0']['cursor_off'] );
	}

	public function test_read_probe_index_empty_when_no_log(): void {
		$this->assertSame( [], ( new CLI( $this->tmp ) )->read_probe_index() );
	}

	// ── consumer_rows() ──────────────────────────────────────────────────────────

	public function test_consumer_rows_enumerates_per_consumer_from_probe_records(): void {
		// Two readers tail the SAME firehose.log under distinct offset dirs; the
		// enumeration returns one row per Consumer, keyed by the source-named
		// offset_dir, carrying the worker_type + real source from the probe record.
		$this->seed_probe_record( [
			'offset_dir' => 'firehose.p0', 'consumer' => 'firehose',
			'cursor_seg' => 5, 'cursor_off' => 100, 'ts' => 1700000000.0,
			'worker_type' => 'combined', 'source' => 'firehose.log',
		] );
		$this->seed_probe_record( [
			'offset_dir' => 'firehose.job-router.p0', 'consumer' => 'firehose.job-router',
			'cursor_seg' => 8, 'cursor_off' => 7, 'ts' => 1700000001.0,
			'worker_type' => 'combined', 'source' => 'firehose.log',
		] );

		$rows = ( new CLI( $this->tmp ) )->consumer_rows();
		\usort( $rows, static fn ( $a, $b ) => $a['source_basename'] <=> $b['source_basename'] );

		$this->assertCount( 2, $rows );
		$this->assertSame( 'firehose', $rows[0]['source_basename'] );
		$this->assertSame( 'firehose', $rows[0]['name'] );
		$this->assertSame( 'firehose.log', $rows[0]['source_log'] );
		$this->assertSame( 'combined', $rows[0]['worker_type'] );
		$this->assertSame( 5, $rows[0]['seg'] );
		$this->assertSame( 100, $rows[0]['off'] );
		$this->assertSame( 'firehose.job-router', $rows[1]['source_basename'] );
		$this->assertSame( 8, $rows[1]['seg'] );
	}

	public function test_consumer_rows_skips_records_without_worker_type(): void {
		// A record with no worker_type can't be attributed to a worker — skip it.
		$this->seed_probe_record( [
			'offset_dir' => 'orphan.p0', 'consumer' => 'orphan',
			'cursor_seg' => 1, 'cursor_off' => 2, 'source' => 'orphan.log',
		] );
		$this->assertSame( [], ( new CLI( $this->tmp ) )->consumer_rows() );
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
