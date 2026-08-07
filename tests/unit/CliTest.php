<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\CLI;
use Newspack_Nodes\Config;
use Newspack_Nodes\Consumer_Node;
use Newspack_Nodes\Lock_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Probe_Record;
use Newspack_Nodes\Tests\TestCase;

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

	public function test_ls_workers_reports_started_at_from_the_lock_started_file(): void {
		$lock = "{$this->tmp}/locks/firehose-workers.p0.lock.d";
		mkdir( $lock, 0755, true );
		touch( "{$lock}/heartbeat" );
		$started = \time() - 3600;
		\file_put_contents( "{$lock}/started", (string) $started );
		// A restart request mid-life must NOT reset the reported start.
		\Newspack_Nodes\Lock_Node::request_restart_at( $lock );

		$workers = ( new CLI( $this->tmp ) )->ls_workers();

		$this->assertSame( $started, $workers[0]['started_at'] );
	}

	public function test_ls_workers_reports_zero_started_at_without_the_file(): void {
		mkdir( "{$this->tmp}/locks/firehose-workers.p0.lock.d", 0755, true );
		touch( "{$this->tmp}/locks/firehose-workers.p0.lock.d/heartbeat" );

		$workers = ( new CLI( $this->tmp ) )->ls_workers();

		$this->assertSame( 0, $workers[0]['started_at'] );
	}

	public function test_format_duration_renders_compact_units(): void {
		$this->assertSame( '44s', CLI::format_duration( 44 ) );
		$this->assertSame( '5m 3s', CLI::format_duration( 303 ) );
		$this->assertSame( '3h 12m', CLI::format_duration( 11520 ) );
		$this->assertSame( '2d 1h', CLI::format_duration( 176400 ) );
		$this->assertSame( '0s', CLI::format_duration( 0 ) );
		$this->assertSame( '0s', CLI::format_duration( -5 ), 'clock skew clamps to 0s' );
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

	/**
	 * Four readers of one heartbeat mtime had four policies. `wp nodes status`
	 * used a flat `Lock_Node::STALE_TIMEOUT`, so a job-worker mid-job — whose
	 * `job-worker.tsl` declares `stale_timeout = 600` precisely because job
	 * handlers run user code that can be slow — showed DOWN at 120s while the
	 * fleet (which honours the declaration) correctly left it alone and
	 * never respawned it. The operator saw a dead worker that was working.
	 *
	 * 300 is above the 60s default and below the declared 600.
	 */
	public function test_ls_honours_a_topologys_declared_stale_timeout(): void {
		\add_filter(
			'newspack_nodes/topologies',
			static fn (): array => [
				'job-worker' => [ 'stale_timeout' => 600, 'num_partitions' => 1 ],
			]
		);
		// Descriptors come from the ACTIVE set, not the whole catalog.
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'job-worker' ];
		Config::reset();
		mkdir( "{$this->tmp}/locks", 0755, true );
		mkdir( "{$this->tmp}/locks/job-worker.p0.lock.d", 0755, true );
		touch( "{$this->tmp}/locks/job-worker.p0.lock.d/heartbeat", time() - 300 );

		$workers = ( new CLI( $this->tmp ) )->ls_workers();

		$this->assertCount( 1, $workers );
		$this->assertFalse(
			$workers[0]['stale'],
			'300s is stale at the 60s default but live at the declared 600s'
		);
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

	public function test_no_worker_message_uses_literal_quotes_not_html_entities(): void {
		// This is a terminal error, so it must read  no worker 'x.p0'  — not the
		// HTML-escaped  no worker &#039;x.p0&#039;  that esc_html() produced.
		$cli = new CLI( $this->tmp );
		try {
			$cli->attach_to_worker( 'typo-bad-name.p0' );
			$this->fail( 'expected InvalidArgumentException' );
		} catch ( \InvalidArgumentException $e ) {
			$this->assertStringContainsString( "'typo-bad-name.p0'", $e->getMessage() );
			$this->assertStringNotContainsString( '&#039;', $e->getMessage() );
		}
	}

	public function test_attach_to_worker_strips_control_chars_from_echoed_id(): void {
		// An untrusted id can't smuggle an ANSI/escape sequence into the terminal:
		// control bytes are stripped from the echoed id, printable text kept.
		$cli = new CLI( $this->tmp );
		try {
			$cli->attach_to_worker( "ev\x1b[31mil.p0" );
			$this->fail( 'expected InvalidArgumentException' );
		} catch ( \InvalidArgumentException $e ) {
			$this->assertStringNotContainsString( "\x1b", $e->getMessage(), 'ESC byte stripped' );
			$this->assertStringContainsString( '.p0', $e->getMessage() );
		}
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

	// ── read_probe_index() ───────────────────────────────────────────────────────

	/** Append a positional Probe_Record snapshot to logs/topicprobe.p0/0.log. */
	private function seed_probe_record( array $fields ): void {
		$dir = "{$this->tmp}/logs/topicprobe.p0";
		if ( ! is_dir( $dir ) ) {
			mkdir( $dir, 0755, true );
		}
		$record                             = [];
		$record[ Probe_Record::SOURCE ]     = $fields['source'] ?? 'firehose.p0';
		$record[ Probe_Record::READER ]     = $fields['reader'] ?? 'firehose.p0';
		$record[ Probe_Record::CURSOR_SEGMENT ] = $fields['cursor_segment'] ?? 0;
		$record[ Probe_Record::CURSOR_OFF ] = $fields['cursor_offset'] ?? 0;
		$record[ Probe_Record::END_SEGMENT ]    = $fields['end_segment'] ?? 0;
		$record[ Probe_Record::END_SIZE ]   = $fields['end_size'] ?? 0;
		$record[ Probe_Record::DISTANCE ]   = $fields['distance'] ?? 0;
		$record[ Probe_Record::MSGS_DELTA ]       = $fields['msgs'] ?? 0;
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_STRUCT;
		$message[ Message::VALUE ] = $record;
		file_put_contents( "{$dir}/0.log", Message::packed( $message ) . "\n", FILE_APPEND );
	}

	public function test_read_probe_index_keys_records_by_reader(): void {
		$this->seed_probe_record( [ 'reader' => 'firehose.p0', 'cursor_segment' => 2, 'cursor_offset' => 50 ] );
		$this->seed_probe_record( [ 'reader' => 'jobintake.p0', 'cursor_segment' => 1, 'cursor_offset' => 9 ] );

		$index = ( new CLI( $this->tmp ) )->read_probe_index();

		$this->assertSame( [ 'firehose.p0', 'jobintake.p0' ], \array_keys( $index ) );
		$this->assertSame( 2, $index['firehose.p0'][ Probe_Record::CURSOR_SEGMENT ] );
		$this->assertSame( 9, $index['jobintake.p0'][ Probe_Record::CURSOR_OFF ] );
	}

	public function test_read_probe_index_empty_when_no_log(): void {
		$this->assertSame( [], ( new CLI( $this->tmp ) )->read_probe_index() );
	}

	// ── consumer_rows() ──────────────────────────────────────────────────────────

	public function test_consumer_rows_returns_lean_per_reader_state(): void {
		$this->seed_probe_record( [
			'reader' => 'firehose.job-router.p0', 'source' => 'firehose.p0',
			'cursor_segment' => 5, 'cursor_offset' => 100,
			'end_segment' => 7, 'end_size' => 2048, 'distance' => 4096, 'msgs' => 31,
		] );

		$rows = ( new CLI( $this->tmp ) )->consumer_rows();

		$this->assertCount( 1, $rows );
		$row = $rows[0];
		$this->assertSame( 'firehose.job-router.p0', $row['reader'] );
		$this->assertSame( 'firehose.p0', $row['source'] );
		$this->assertSame( 0, $row['partition'] );
		$this->assertSame( 5, $row['cursor_segment'] );
		$this->assertSame( 100, $row['cursor_offset'] );
		$this->assertSame( 7, $row['end_segment'] );
		$this->assertSame( 2048, $row['end_size'] );
		$this->assertSame( 4096, $row['distance'] );
		$this->assertSame( 31, $row['msgs'] );
	}

	public function test_consumer_rows_parses_partition_from_the_reader_name(): void {
		$this->seed_probe_record( [ 'reader' => 'requests.p3', 'source' => 'requests.p3' ] );
		$rows = ( new CLI( $this->tmp ) )->consumer_rows();
		$this->assertSame( 3, $rows[0]['partition'] );
	}

	public function test_consumer_rows_skips_a_reader_without_a_partition_suffix(): void {
		$this->seed_probe_record( [ 'reader' => 'malformed' ] );
		$this->assertSame( [], ( new CLI( $this->tmp ) )->consumer_rows() );
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

}
