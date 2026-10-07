<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Bootstrap;
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

	/** @var \Closure|null Bootstrap-installed curl seam, restored so a capturer cannot leak. */
	private $saved_curl_exec;

	protected function setUp(): void {
		parent::setUp();
		$this->saved_curl_exec = \Newspack_Nodes\Core::$curl_exec;
		$this->tmp = $this->make_temp_dir();
	}

	protected function tearDown(): void {
		\Newspack_Nodes\Core::$curl_exec = $this->saved_curl_exec;
		unset( $GLOBALS['_wp_options']['newspack_nodes_topologies'] );
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

	// ── worker_states() ────────────────────────────────────────────────────────

	/**
	 * Register `kea-idle`, an on-demand topology with a 41-second window and
	 * seven partitions, and `kea-resident`, which declares no window, as the
	 * active set.
	 */
	private function activate_idle_and_resident(): void {
		\add_filter(
			'newspack_nodes/topologies',
			static fn ( array $t ): array => $t + [
				'kea-idle'     => [ 'topology' => 'kea-idle', 'num_partitions' => 7, 'on_demand_idle' => 41, 'stale_timeout' => 73 ],
				'kea-resident' => [ 'topology' => 'kea-resident', 'num_partitions' => 1, 'on_demand_idle' => 0 ],
			]
		);
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'kea-idle', 'kea-resident' ];
		Config::reset();
	}

	/**
	 * A lock dir for `$id`, `$dir_age` seconds old, its heartbeat `$age`
	 * seconds old, or none when null.
	 */
	private function lock( string $id, ?int $age, int $dir_age = 0 ): void {
		$dir = "{$this->tmp}/locks/{$id}.lock.d";
		\mkdir( $dir, 0755, true );
		if ( null !== $age ) {
			\touch( "{$dir}/heartbeat", \time() - $age );
		}
		\touch( $dir, \time() - $dir_age );
	}

	/** Counts each application of the `newspack_nodes/topologies` filter. */
	private function count_topology_reads(): \ArrayObject {
		$reads = new \ArrayObject();
		\add_filter(
			'newspack_nodes/topologies',
			static function ( array $t ) use ( $reads ): array {
				$reads->append( 1 );
				return $t;
			}
		);
		return $reads;
	}

	/** @return list<string> Every `kea-idle` worker id, p0 through p6. */
	private static function kea_idle_ids(): array {
		return \array_map( static fn ( int $p ): string => CLI::worker_id( 'kea-idle', $p ), \range( 0, 6 ) );
	}

	public function test_worker_states_reads_a_lock_by_its_heartbeat_against_its_topologys_timeout(): void {
		$this->activate_idle_and_resident();
		$this->lock( 'kea-idle.p3', 60 );
		$this->lock( 'kea-idle.p4', 90 );
		$this->lock( 'kea-idle.p5', null, 29 );

		$states = \array_column( ( new CLI( $this->tmp ) )->worker_states( [ 'kea-idle.p3', 'kea-idle.p4', 'kea-idle.p5' ], Bootstrap::get_topologies(), true ), 'state' );

		$this->assertSame( [ 'live', 'stale', 'stale' ], $states, 'judged against 73s, not the flat default; no heartbeat past the grace is stale' );
	}

	/**
	 * Between mkdir and its first heartbeat a worker is acquiring, the
	 * window Lock_Node's orphan grace tolerates, so the classifier reads it
	 * live; past the grace the same lock dir is stale, well inside the 73s
	 * heartbeat timeout.
	 */
	public function test_worker_states_reads_a_heartbeatless_lock_by_the_orphan_grace(): void {
		$this->activate_idle_and_resident();
		$this->lock( 'kea-idle.p1', null );
		$this->lock( 'kea-idle.p2', null, Lock_Node::ORPHAN_GRACE_S + 29 );

		$states = \array_column( ( new CLI( $this->tmp ) )->worker_states( [ 'kea-idle.p1', 'kea-idle.p2' ], Bootstrap::get_topologies(), true ), 'state' );

		$this->assertSame( [ 'live', 'stale' ], $states );
	}

	public function test_worker_states_looks_up_a_lockless_slots_idle_window_from_its_topology(): void {
		$this->activate_idle_and_resident();

		$states = ( new CLI( $this->tmp ) )->worker_states( [ 'kea-idle.p6', 'kea-resident.p0', 'kea-inactive.p0' ], Bootstrap::get_topologies(), true );

		$this->assertSame( [ 'idle', 'down', 'inactive' ], \array_column( $states, 'state' ), 'a lockless slot of a topology outside the active set is inactive' );
		$this->assertNull( $states['kea-idle.p6']['lock'] );
	}

	public function test_worker_states_reads_a_lockless_slot_outside_the_active_set_as_inactive_even_under_the_hold(): void {
		$this->activate_idle_and_resident();
		\Newspack_Nodes\Spawn_Coordinator::set_hold( 1754500043 );

		$states = \array_column( ( new CLI( $this->tmp ) )->worker_states( [ 'kea-resident.p0', 'kea-inactive.p2' ], Bootstrap::get_topologies(), false ), 'state' );

		$this->assertSame( [ 'held', 'inactive' ], $states );
	}

	public function test_worker_states_reads_no_lock_as_held_under_the_hold_idle_window_or_not(): void {
		$this->activate_idle_and_resident();
		$this->lock( 'kea-idle.p2', 0 );
		\Newspack_Nodes\Spawn_Coordinator::set_hold( 1754500041 );
		try {
			$states = ( new CLI( $this->tmp ) )->worker_states( [ 'kea-idle.p1', 'kea-resident.p0', 'kea-idle.p2' ], Bootstrap::get_topologies(), true );
		} finally {
			\Newspack_Nodes\Spawn_Coordinator::clear_hold();
		}

		$this->assertSame( [ 'held', 'held', 'live' ], \array_column( $states, 'state' ), 'a lock outranks the hold' );
	}

	public function test_worker_states_answers_every_lock_outside_the_slots_after_them(): void {
		$this->activate_idle_and_resident();
		$this->lock( 'kea-gone.p4', 0 );

		$states = ( new CLI( $this->tmp ) )->worker_states( [ 'kea-resident.p0' ], Bootstrap::get_topologies(), true );

		$this->assertSame( [ 'kea-resident.p0', 'kea-gone.p4' ], \array_keys( $states ) );
		$this->assertSame( 'live', $states['kea-gone.p4']['state'] );
		$this->assertSame( 'kea-gone', $states['kea-gone.p4']['lock']['type'] );
	}

	public function test_worker_states_reads_the_topologies_once_for_every_slot_and_lock(): void {
		$this->activate_idle_and_resident();
		$this->lock( 'kea-idle.p0', 0 );
		$this->lock( 'kea-idle.p1', 500 );
		$active = Bootstrap::get_topologies();
		$reads  = $this->count_topology_reads();

		$states = ( new CLI( $this->tmp ) )->worker_states( self::kea_idle_ids(), $active, true );

		$this->assertSame( [ 'live', 'stale', 'idle', 'idle', 'idle', 'idle', 'idle' ], \array_column( $states, 'state' ) );
		$this->assertCount( 0, $reads, 'the caller\'s one read serves seven slots, two lock timeouts and five idle windows' );
	}

	public function test_worker_states_without_leftovers_answers_the_slots_alone(): void {
		$this->activate_idle_and_resident();
		$this->lock( 'kea-gone.p4', 0 );
		$this->lock( 'kea-idle.p3', 0 );

		$states = ( new CLI( $this->tmp ) )->worker_states( [ 'kea-idle.p3', 'kea-resident.p0' ], Bootstrap::get_topologies(), false );

		$this->assertSame( [ 'kea-idle.p3' => 'live', 'kea-resident.p0' => 'down' ], \array_map( static fn ( array $slot ): string => $slot['state'], $states ) );
	}

	public function test_slot_ids_names_every_partition_of_every_active_topology(): void {
		$this->activate_idle_and_resident();

		$slots = CLI::slot_ids( Bootstrap::get_topologies() );

		$this->assertSame( [ ...self::kea_idle_ids(), 'kea-resident.p0' ], \array_keys( $slots ) );
		$this->assertSame( [ 'kea-idle', 6 ], $slots['kea-idle.p6'] );
	}

	public function test_ls_workers_reads_the_topologies_once_for_every_lock(): void {
		$this->activate_idle_and_resident();
		foreach ( self::kea_idle_ids() as $id ) {
			$this->lock( $id, 0 );
		}
		$reads = $this->count_topology_reads();

		$this->assertCount( 7, ( new CLI( $this->tmp ) )->ls_workers() );
		$this->assertCount( 1, $reads );
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
		// Lock dir past the orphan grace, no heartbeat file at all → stale.
		mkdir( "{$this->tmp}/locks", 0755, true );
		mkdir( "{$this->tmp}/locks/jobs.p0.lock.d", 0755, true );
		touch( "{$this->tmp}/locks/jobs.p0.lock.d", time() - ( Lock_Node::ORPHAN_GRACE_S + 11 ) );

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

	/** The walk `Spawn_Coordinator::worker_lock_dirs()` owns, not a second one. */
	public function test_ls_reads_the_lock_dirs_the_coordinator_reads(): void {
		foreach ( [ 'foo.bar.p41', 'kea-7713.p07', 'kea.pX' ] as $name ) {
			mkdir( "{$this->tmp}/locks/{$name}.lock.d", 0755, true );
			touch( "{$this->tmp}/locks/{$name}.lock.d/heartbeat" );
		}

		$workers = ( new CLI( $this->tmp ) )->ls_workers();

		$this->assertSame(
			[ [ 'foo.bar.p41', 'foo.bar', 41 ] ],
			array_map( fn( $w ) => [ $w['id'], $w['type'], $w['partition'] ], $workers ),
			'a dotted type lists; a padded or non-numeric partition names no worker'
		);
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

	// ── worker_id() / parse_worker_id() / attach_to_worker() ───────────────────

	/**
	 * The case list `parseWorkerId()` in `src/shared/utils/workerId.js`
	 * reads too, so the two grammars cannot drift apart. A valid id also
	 * round-trips through `worker_id()`, the one writer.
	 *
	 * @param string                    $id       Candidate worker id.
	 * @param array{0:string,1:int}|null $expected Type and partition, or null.
	 */
	#[\PHPUnit\Framework\Attributes\DataProvider( 'worker_id_provider' )]
	public function test_parse_worker_id_matches_the_shared_case_list( string $id, ?array $expected ): void {
		$this->assertSame( $expected, CLI::parse_worker_id( $id ) );
		if ( null !== $expected ) {
			$this->assertSame( $id, CLI::worker_id( ...$expected ) );
		}
	}

	/** @return array<string,array{0:string,1:?array{0:string,1:int}}> */
	public static function worker_id_provider(): array {
		$cases = \json_decode( (string) \file_get_contents( __DIR__ . '/../fixtures/worker-ids.json' ), true, 512, \JSON_THROW_ON_ERROR );
		$out   = [];
		foreach ( $cases as [ $label, $id, $expected ] ) {
			$out[ $label ] = [ $id, $expected ];
		}
		return $out;
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

	public function test_attach_to_worker_resolves_a_dotted_type(): void {
		\mkdir( "{$this->tmp}/locks/foo.bar.p41.lock.d", 0755, true );

		$ipc = ( new CLI( $this->tmp ) )->attach_to_worker( 'foo.bar.p41' );

		$this->assertSame( "{$this->tmp}/ipc/foo.bar.p41/input", $ipc['input'] );
		$this->assertSame( "{$this->tmp}/ipc/foo.bar.p41/output", $ipc['output'] );
		$this->assertSame( [ 'foo.bar.p41', 'foo.bar', 41 ], [ $ipc['id'], $ipc['type'], $ipc['partition'] ] );
	}

	/**
	 * `kea-7713.p03` is no spelling of partition 3: attaching it would hand
	 * back an IPC tree the running `kea-7713.p3` never reads.
	 */
	public function test_attach_to_worker_refuses_a_padded_id_beside_a_live_worker(): void {
		\mkdir( "{$this->tmp}/locks/kea-7713.p3.lock.d", 0755, true );

		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( 'invalid reader id: kea-7713.p03' );
		( new CLI( $this->tmp ) )->attach_to_worker( 'kea-7713.p03' );
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

	/**
	 * A sleeping on-demand worker has no lock dir BY DESIGN, and the cli is the
	 * only thing that writes its IPC input — so refusing here is what stopped
	 * an attach from ever waking it. Attaching wakes it and proceeds.
	 */
	public function test_attach_wakes_a_sleeping_on_demand_worker_instead_of_refusing(): void {
		$posts = [];
		\Newspack_Nodes\Core::$curl_exec = static function ( \CurlHandle $ch, array $body ) use ( &$posts ) {
			$posts[] = $body;
			return '';
		};
		\add_filter(
			'newspack_nodes/topologies',
			static fn ( array $t ): array => $t + [
				'marmot-ondemand' => [
					'topology'       => 'marmot-ondemand',
					'num_partitions' => 1,
					'on_demand_idle' => 23,
				],
			]
		);
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'marmot-ondemand' ];

		$ipc = ( new CLI( $this->tmp ) )->attach_to_worker( 'marmot-ondemand.p0' );

		$this->assertSame( "{$this->tmp}/ipc/marmot-ondemand.p0/input", $ipc['input'] );
		$this->assertSame(
			[ 'marmot-ondemand.p0' ],
			\array_map( static fn ( array $b ): string => $b['type'] . '.p' . $b['partition'], $posts )
		);
	}

	/**
	 * `marmot-ondemand.p007` is not the worker `marmot-ondemand.p7`. The ipc
	 * tree the caller then attaches to is spelled with the padding, so waking
	 * p7 posts a spawn for a worker nobody is listening to and hands back a
	 * path no worker reads. The wake matches on the id the fleet spells.
	 */
	public function test_attach_refuses_a_zero_padded_id_instead_of_waking_another_partition(): void {
		$posts                           = [];
		\Newspack_Nodes\Core::$curl_exec = static function ( \CurlHandle $ch, array $body ) use ( &$posts ) {
			$posts[] = $body;
			return '';
		};
		\add_filter(
			'newspack_nodes/topologies',
			static fn ( array $t ): array => $t + [
				'marmot-ondemand' => [
					'topology'       => 'marmot-ondemand',
					'num_partitions' => 8,
					'on_demand_idle' => 23,
				],
			]
		);
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'marmot-ondemand' ];

		try {
			( new CLI( $this->tmp ) )->attach_to_worker( 'marmot-ondemand.p007' );
			$this->fail( 'expected InvalidArgumentException' );
		} catch ( \InvalidArgumentException $e ) {
			$this->assertStringContainsString( 'marmot-ondemand.p007', $e->getMessage() );
		}
		$this->assertSame( [], $posts, 'no spawn for a partition the caller is not attaching to' );
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

	public function test_restart_flags_every_worker_then_raises_the_write_it_could_not_make(): void {
		$refusing = "{$this->tmp}/locks/quarry-workers.p0.lock.d";
		$willing  = "{$this->tmp}/locks/quarry-workers.p1.lock.d";
		mkdir( $refusing, 0755, true );
		mkdir( $willing, 0755, true );
		chmod( $refusing, 0555 );

		$thrown = null;
		try {
			( new CLI( $this->tmp ) )->restart_workers( [
				[ 'type' => 'quarry-workers', 'partition' => 0 ],
				[ 'type' => 'quarry-workers', 'partition' => 1 ],
			] );
		} catch ( \RuntimeException $e ) {
			$thrown = $e;
		} finally {
			chmod( $refusing, 0755 );
		}

		$this->assertNotNull( $thrown, 'a restart that never landed must not report success' );
		$this->assertStringContainsString( $refusing, $thrown->getMessage() );
		$this->assertFileExists( $willing . '/' . Lock_Node::RESTART_FLAG, 'a sibling after the failure still hears' );
	}

	public function test_restart_skips_when_lock_dir_missing(): void {
		// No lock dirs created → request_restart_at returns false.
		$cli     = new CLI( $this->tmp );
		$workers = [ [ 'type' => 'jobs', 'partition' => 0 ] ];
		$count   = $cli->restart_workers( $workers );

		$this->assertSame( 0, $count );
	}

	// ── read_probe_frames() ───────────────────────────────────────────────────────

	/** Append a positional Probe_Record snapshot to logs/topicprobe.p0/0.log. */
	private function seed_probe_record( array $fields ): void {
		$dir = "{$this->tmp}/logs/topicprobe.p0";
		if ( ! is_dir( $dir ) ) {
			mkdir( $dir, 0755, true );
		}
		$record                             = [];
		$record[ Probe_Record::SOURCE ]     = $fields['source'] ?? 'firehose.p0';
		$record[ Probe_Record::READER ]     = $fields['reader'] ?? 'firehose.p0';
		$record[ Probe_Record::CURSOR_SEGMENT ] = \array_key_exists( 'cursor_segment', $fields ) ? $fields['cursor_segment'] : 0;
		$record[ Probe_Record::CURSOR_OFF ] = $fields['cursor_offset'] ?? 0;
		$record[ Probe_Record::END_SEGMENT ]    = \array_key_exists( 'end_segment', $fields ) ? $fields['end_segment'] : 0;
		$record[ Probe_Record::END_SIZE ]   = \array_key_exists( 'end_size', $fields ) ? $fields['end_size'] : 0;
		$record[ Probe_Record::DISTANCE ]   = \array_key_exists( 'distance', $fields ) ? $fields['distance'] : 0;
		$record[ Probe_Record::MSGS_DELTA ]       = $fields['msgs'] ?? 0;
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_STRUCT;
		$message[ Message::VALUE ] = $record;
		if ( isset( $fields['age_s'] ) ) {
			$message[ Message::TIMESTAMP ] -= $fields['age_s'];
		}
		file_put_contents( "{$dir}/0.log", Message::packed( $message ) . "\n", FILE_APPEND );
	}

	/** A partition segment of $bytes, as an external producer would leave it. */
	private function seed_source( string $name, int $bytes ): void {
		mkdir( "{$this->tmp}/logs/{$name}", 0755, true );
		file_put_contents( "{$this->tmp}/logs/{$name}/0.log", str_repeat( 'x', $bytes ) );
	}

	/** A durable read-cursor frame; $offset null leaves the dir with no frame. */
	private function seed_cursor( string $reader, ?int $offset, int $segment = 0 ): void {
		mkdir( "{$this->tmp}/offsets/{$reader}", 0755, true );
		if ( null === $offset ) {
			return;
		}
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_STRUCT;
		$message[ Message::VALUE ] = [ 'segment' => $segment, 'offset' => $offset ];
		file_put_contents(
			"{$this->tmp}/offsets/{$reader}/0.log",
			Message::packed( $message ) . "\n"
		);
	}

	public function test_consumer_rows_recomputes_a_stale_row_from_disk(): void {
		// Nobody has reported in two sweeps, so the record's DISTANCE is the last
		// thing a departed worker said — and it said caught up. 900 bytes have
		// landed since, of which the cursor covers 250.
		$this->seed_probe_record( [ 'reader' => 'firehose.p0', 'distance' => 0, 'age_s' => 300 ] );
		$this->seed_source( 'firehose.p0', 900 );
		$this->seed_cursor( 'firehose.p0', 250 );

		$rows = ( new CLI( $this->tmp ) )->consumer_rows()['rows'];

		$this->assertSame( 650, $rows[0]['distance'] );
		$this->assertSame( 250, $rows[0]['cursor_offset'] );
		$this->assertSame( 0, $rows[0]['msgs'], 'nobody reading means no rate' );
	}

	public function test_consumer_rows_reads_the_partition_through_the_worker_id_grammar(): void {
		$this->seed_probe_record( [ 'reader' => 'foo.bar.p41', 'distance' => 23 ] );
		$this->seed_probe_record( [ 'reader' => 'kea-7713.p07', 'distance' => 29 ] );
		$this->seed_probe_record( [ 'reader' => 'kea.pX', 'distance' => 31 ] );

		$rows = ( new CLI( $this->tmp ) )->consumer_rows()['rows'];

		$this->assertSame(
			[ [ 'foo.bar.p41', 41, 23 ] ],
			array_map( fn( $r ) => [ $r['reader'], $r['partition'], $r['distance'] ], $rows )
		);
	}

	public function test_consumer_rows_keeps_what_a_reader_does_not_know_unknown(): void {
		$this->seed_probe_record( [ 'reader' => 'hub-4417.remote-austin:sources:php.p3', 'source' => 'remote/austin:sources:php', 'cursor_segment' => null, 'cursor_offset' => 40913, 'end_segment' => null, 'end_size' => null, 'distance' => null ] );

		$row = ( new CLI( $this->tmp ) )->consumer_rows()['rows'][0];

		$this->assertSame(
			[ 'hub-4417.remote-austin:sources:php.p3', 3, null, 40913, null, null, null ],
			[ $row['reader'], $row['partition'], $row['cursor_segment'], $row['cursor_offset'], $row['end_segment'], $row['end_size'], $row['distance'] ]
		);
	}

	public function test_consumer_rows_keeps_a_fresh_row_as_reported(): void {
		// A live reader's record is a PAIRED measurement; recomputing its end
		// against a newer stat would overstate it by an interval of throughput.
		$this->seed_probe_record( [ 'reader' => 'firehose.p0', 'distance' => 17, 'msgs' => 5 ] );
		$this->seed_source( 'firehose.p0', 900 );
		$this->seed_cursor( 'firehose.p0', 250 );

		$rows = ( new CLI( $this->tmp ) )->consumer_rows()['rows'];

		$this->assertSame( 17, $rows[0]['distance'] );
		$this->assertSame( 5, $rows[0]['msgs'] );
	}

	public function test_consumer_rows_leaves_a_stale_row_alone_without_an_offsetlog_dir(): void {
		// A nested layout: the reader basename does not rebuild the cursor path.
		// Treating that as "no cursor" would report the whole partition behind.
		$this->activate_idle_and_resident();
		$this->seed_probe_record( [ 'reader' => 'kea-idle.firehose.p0', 'distance' => 0, 'age_s' => 300 ] );
		$this->seed_source( 'firehose.p0', 900 );

		$rows = ( new CLI( $this->tmp ) )->consumer_rows()['rows'];

		$this->assertSame( 0, $rows[0]['distance'] );
	}

	public function test_consumer_rows_drops_a_stale_row_of_an_inactive_topology_with_no_offsetlog_dir(): void {
		// `wp nodes deactivate` then `gc` removed the offsets; the last probe
		// still carries the departed reader's rate and backlog.
		$this->activate_idle_and_resident();
		$this->seed_probe_record( [ 'reader' => 'zorp-9.firehose.p2', 'source' => 'firehose.p2', 'distance' => 6_871_947, 'msgs' => 23797, 'age_s' => 300 ] );
		$this->seed_probe_record( [ 'reader' => 'kea-idle.requests.p3', 'source' => 'requests.p3', 'distance' => 4321, 'msgs' => 29, 'age_s' => 300 ] );
		$this->seed_probe_record( [ 'reader' => 'zorp-9.requests.p3', 'source' => 'requests.p3', 'distance' => 5, 'msgs' => 31 ] );

		$readers = array_column( ( new CLI( $this->tmp ) )->consumer_rows()['rows'], 'reader' );

		$this->assertSame( [ 'kea-idle.requests.p3', 'zorp-9.requests.p3' ], $readers );
	}

	public function test_consumer_rows_keeps_a_stale_row_of_an_inactive_topology_whose_offsetlog_dir_exists(): void {
		$this->activate_idle_and_resident();
		$this->seed_probe_record( [ 'reader' => 'zorp-9.firehose.p2', 'source' => 'firehose.p2', 'distance' => 0, 'msgs' => 23797, 'age_s' => 300 ] );
		$this->seed_source( 'firehose.p2', 900 );
		$this->seed_cursor( 'zorp-9.firehose.p2', 250 );

		$rows = ( new CLI( $this->tmp ) )->consumer_rows()['rows'];

		$this->assertSame( [ 'zorp-9.firehose.p2' ], array_column( $rows, 'reader' ) );
		$this->assertSame( 650, $rows[0]['distance'] );
		$this->assertSame( 0, $rows[0]['msgs'] );
	}

	public function test_consumer_rows_leaves_a_stale_row_alone_without_a_source_dir(): void {
		$this->seed_probe_record( [ 'reader' => 'firehose.p0', 'distance' => 0, 'age_s' => 300 ] );
		$this->seed_cursor( 'firehose.p0', 250 );

		$rows = ( new CLI( $this->tmp ) )->consumer_rows()['rows'];

		$this->assertSame( 0, $rows[0]['distance'] );
	}

	public function test_consumer_rows_leaves_a_stale_row_alone_before_the_first_checkpoint(): void {
		// The offsetlog dir exists (ensure_offsetlog() makes it at construction)
		// but holds no frame. That is an unknown cursor, not one parked at 0:0.
		$this->seed_probe_record( [ 'reader' => 'firehose.p0', 'distance' => 0, 'age_s' => 300 ] );
		$this->seed_source( 'firehose.p0', 900 );
		$this->seed_cursor( 'firehose.p0', null );

		$rows = ( new CLI( $this->tmp ) )->consumer_rows()['rows'];

		$this->assertSame( 0, $rows[0]['distance'], 'no cursor is no opinion' );
	}

	public function test_consumer_rows_raises_a_stale_row_whose_disk_read_fails(): void {
		$this->seed_probe_record( [ 'reader' => 'firehose.p0', 'distance' => 0, 'age_s' => 300 ] );
		$this->seed_source( 'firehose.p0', 900 );
		$this->seed_cursor( 'firehose.p0', 250 );
		$refused                                = new \RuntimeException( 'segment listing refused-8120' );
		\Newspack_Nodes\Partition_Node::$scandir = static function ( string $dir ) use ( $refused ): array {
			if ( \str_ends_with( $dir, '/logs/firehose.p0' ) ) {
				throw $refused;
			}
			return \scandir( $dir ) ?: [];
		};

		$caught = null;
		try {
			( new CLI( $this->tmp ) )->consumer_rows()['rows'];
		} catch ( \RuntimeException $e ) {
			$caught = $e;
		} finally {
			\Newspack_Nodes\Partition_Node::$scandir = null;
		}

		$this->assertSame( $refused, $caught );
	}

	public function test_read_probe_frames_keys_records_by_reader(): void {
		$this->seed_probe_record( [ 'reader' => 'firehose.p0', 'cursor_segment' => 2, 'cursor_offset' => 50 ] );
		$this->seed_probe_record( [ 'reader' => 'jobintake.p0', 'cursor_segment' => 1, 'cursor_offset' => 9 ] );

		$index = ( new CLI( $this->tmp ) )->read_probe_frames()['records'];

		$this->assertSame( [ 'firehose.p0', 'jobintake.p0' ], \array_keys( $index ) );
		$this->assertSame( 2, $index['firehose.p0']['value'][ Probe_Record::CURSOR_SEGMENT ] );
		$this->assertSame( 9, $index['jobintake.p0']['value'][ Probe_Record::CURSOR_OFF ] );
	}

	public function test_read_probe_frames_carries_the_snapshot_time(): void {
		// The age is the whole point: without it a departed worker's last record
		// is indistinguishable from a live one's.
		$this->seed_probe_record( [ 'reader' => 'firehose.p0' ] );

		$index = ( new CLI( $this->tmp ) )->read_probe_frames()['records'];

		$this->assertGreaterThan( 0, $index['firehose.p0']['timestamp'] );
	}

	/**
	 * The status tail reads 512 KiB of the newest segment: a reader whose
	 * record sits 300 KiB back is still found, one 600 KiB back is not.
	 */
	public function test_read_probe_frames_reads_half_a_mebibyte_of_tail(): void {
		$this->seed_probe_record( [ 'reader' => 'distant.p0' ] );
		$this->seed_probe_filler( 300 * 1024 );
		$this->seed_probe_record( [ 'reader' => 'recent.p0' ] );
		$this->seed_probe_filler( 600 * 1024 - 300 * 1024 );

		$index = ( new CLI( $this->tmp ) )->read_probe_frames()['records'];

		$this->assertArrayHasKey( 'recent.p0', $index, '300 KiB back is inside the window' );
		$this->assertArrayNotHasKey( 'distant.p0', $index, '600 KiB back is past it' );
	}

	/** Append Partition records, which name no reader, until $bytes are written. */
	private function seed_probe_filler( int $bytes ): void {
		$path    = "{$this->tmp}/logs/topicprobe.p0/0.log";
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_STRUCT;
		$message[ Message::VALUE ] = [ 'logs/filler.p0', '', 0, 0, 3, 7331, 0, 0, 7331, 0, 0, 0, 8192 ];
		$line    = Message::packed( $message ) . "\n";
		file_put_contents( $path, str_repeat( $line, (int) \ceil( $bytes / \strlen( $line ) ) ), FILE_APPEND );
	}

	public function test_read_probe_frames_empty_when_no_log(): void {
		$this->assertSame( [ 'records' => [], 'unparseable_lines' => 0 ], ( new CLI( $this->tmp ) )->read_probe_frames() );
	}

	// ── consumer_rows() ──────────────────────────────────────────────────────────

	public function test_consumer_rows_returns_lean_per_reader_state(): void {
		$this->seed_probe_record( [
			'reader' => 'firehose.job-router.p0', 'source' => 'firehose.p0',
			'cursor_segment' => 5, 'cursor_offset' => 100,
			'end_segment' => 7, 'end_size' => 2048, 'distance' => 4096, 'msgs' => 31,
		] );

		$rows = ( new CLI( $this->tmp ) )->consumer_rows()['rows'];

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

	/** A Partition record names no reader, so it is no Consumer row. */
	public function test_consumer_rows_skip_a_partition_record(): void {
		$this->seed_probe_record( [ 'reader' => '', 'source' => 'ledger.p4', 'end_segment' => 6, 'end_size' => 3371 ] );
		$this->seed_probe_record( [ 'reader' => 'jobs.ledger.p4', 'source' => 'ledger.p4' ] );

		$rows = ( new CLI( $this->tmp ) )->consumer_rows()['rows'];

		$this->assertSame( [ 'jobs.ledger.p4' ], \array_column( $rows, 'reader' ) );
	}

	public function test_consumer_rows_parses_partition_from_the_reader_name(): void {
		$this->seed_probe_record( [ 'reader' => 'requests.p3', 'source' => 'requests.p3' ] );
		$rows = ( new CLI( $this->tmp ) )->consumer_rows()['rows'];
		$this->assertSame( 3, $rows[0]['partition'] );
	}

	public function test_consumer_rows_skips_a_reader_without_a_partition_suffix(): void {
		$this->seed_probe_record( [ 'reader' => 'malformed' ] );
		$this->assertSame( [], ( new CLI( $this->tmp ) )->consumer_rows()['rows'] );
	}

	public function test_consumer_rows_counts_an_unparseable_probe_line(): void {
		// topicprobe.p0 has many writers, so a torn line is expected; the rows
		// around it still render, and the count says how many were skipped.
		$this->seed_probe_record( [ 'reader' => 'firehose.p0', 'distance' => 6203 ] );
		file_put_contents( "{$this->tmp}/logs/topicprobe.p0/0.log", "[16,\"torn\n", FILE_APPEND );
		$this->seed_probe_record( [ 'reader' => 'requests.p2', 'distance' => 91 ] );

		$result = ( new CLI( $this->tmp ) )->consumer_rows();

		$this->assertSame( 1, $result['unparseable_lines'] );
		$this->assertSame( [ 'firehose.p0', 'requests.p2' ], \array_column( $result['rows'], 'reader' ) );
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

	// ── require_flag_int() ─────────────────────────────────────────────────────

	public function test_require_flag_int_returns_the_fallback_when_the_flag_is_absent(): void {
		$this->assertSame( -7, CLI::require_flag_int( [ 'other' => '3' ], 'partition', -7 ) );
	}

	public function test_require_flag_int_returns_null_when_absent_with_no_fallback(): void {
		$this->assertNull( CLI::require_flag_int( [], 'partition' ) );
	}

	public function test_require_flag_int_reads_a_canonical_decimal(): void {
		$this->assertSame( 4271, CLI::require_flag_int( [ 'partition' => '4271' ], 'partition', -7 ) );
	}

	public function test_require_flag_int_errors_on_a_malformed_flag_naming_it(): void {
		$GLOBALS['_test_wp_cli_errors'] = [];
		$this->caught(
			fn () => CLI::require_flag_int( [ 'partition' => 'abc' ], 'partition', -7 ),
			'a malformed operator flag must not resolve to a partition'
		);
		$this->assertStringContainsString(
			'--partition must be a non-negative integer; got: abc',
			$GLOBALS['_test_wp_cli_errors'][0] ?? ''
		);
	}

	public function test_require_flag_int_renders_control_bytes_in_the_rejected_value(): void {
		// The refusal is echoed to a terminal; a stripped byte would hide from
		// the operator what was actually in the flag.
		$GLOBALS['_test_wp_cli_errors'] = [];
		$this->caught(
			fn () => CLI::require_flag_int( [ 'partition' => "4419\x1B[2J" ], 'partition', -7 ),
			'a malformed operator flag must not resolve to a partition'
		);
		$this->assertStringContainsString(
			'got: 4419<1B>[2J',
			$GLOBALS['_test_wp_cli_errors'][0] ?? ''
		);
	}

	public function test_attach_to_worker_renders_control_bytes_in_the_refusal(): void {
		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( 'invalid reader id: quarry<0D>granted' );
		( new CLI( $this->tmp ) )->attach_to_worker( "quarry\rgranted" );
	}

	public function test_require_flag_int_errors_on_zero_when_zero_is_disallowed(): void {
		$GLOBALS['_test_wp_cli_errors'] = [];
		$this->caught(
			fn () => CLI::require_flag_int( [ 'segment_size' => '0' ], 'segment_size', 1024, false ),
			'a zero segment size stores nothing and must be refused'
		);
		$this->assertStringContainsString(
			'--segment_size must be a positive integer; got: 0',
			$GLOBALS['_test_wp_cli_errors'][0] ?? ''
		);
	}

}
