<?php
/**
 * WorkersCITest: unit tests for Workers_CI, the M2 service-CI that
 * replaces the legacy WorkersController + FirehoseController::heartbeat.
 *
 * These tests establish the pattern every other M2 CI test will
 * follow: instantiate the CI with stubbed dependencies, fire a verb
 * through VerbHarness, assert on the decoded payload.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Message;
use Newspack_Nodes\Rest\Workers_CI;
use Newspack_Nodes\Tests\Helpers\FakeMemcached;
use Newspack_Nodes\Tests\Helpers\VerbHarness;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Workers_CI::class )]
class WorkersCITest extends TestCase {

	private ?string $tmp = null;

	protected function setUp(): void {
		parent::setUp();
		$GLOBALS['_wp_options']               = [];
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => true ];
		$GLOBALS['_wp_actions']               = [];
	}

	protected function tearDown(): void {
		VerbHarness::reset();
		$GLOBALS['_wp_options']               = [];
		$GLOBALS['_wp_test_current_user_can'] = [];
		$GLOBALS['_wp_actions']               = [];
		if ( null !== $this->tmp ) {
			$this->rmdir_recursive( $this->tmp );
			$this->tmp = null;
		}
		parent::tearDown();
	}

	/**
	 * Set up a per-test base dir + register topologies so the dump_metadata
	 * verb has a fleet to enumerate. Mirrors WorkersControllerRealShapeTest's
	 * topology filter and the per-test tmp-dir pattern from PerformanceCITest.
	 *
	 * @return string The base dir path (so tests can seed files under it).
	 */
	private function arrange_base_dir(): string {
		$this->tmp = '/tmp/workers-ci-test-' . \uniqid();
		\mkdir( $this->tmp, 0755, true );
		$this->use_base_dir(
			$this->tmp,
			[
				'num_partitions' => 1,
				'num_segments'   => 8,
				'segment_size'   => 16 * 1024 * 1024,
			]
		);
		\add_filter(
			'newspack_nodes/topologies',
			static function ( array $topologies ): array {
				foreach (
					[
						'firehose-workers-and-jobs',
						'request-workers',
						'job-workers',
						'aggregator',
					] as $name
				) {
					$topologies[ $name ] = [
						'topology'       => $name,
						'num_partitions' => 1,
						'stale_timeout'  => 60,
					];
				}
				return $topologies;
			}
		);
		return $this->tmp;
	}

	/**
	 * Seed an offsetlog entry for a `{source}.p{partition}` worker.
	 * Mirrors Consumer::checkpoint shape so the dump_metadata verb's
	 * enumerate path picks up the row.
	 */
	private function seed_offsetlog( string $base_dir, string $source_basename, int $partition, array $extra = [] ): void {
		$dir = "{$base_dir}/offsets/{$source_basename}.p{$partition}/p0";
		if ( ! \is_dir( $dir ) ) {
			\mkdir( $dir, 0755, true );
		}
		$entry                     = \array_merge(
			[
				'seg'         => 0,
				'off'         => 0,
				'ts'          => \microtime( true ),
				'name'        => "{$source_basename}:consumer",
				'target'      => '',
				'worker_type' => '',
			],
			$extra
		);
		$msg                       = Message::new_message();
		$msg[ Message::TYPE ]      = Message::TM_STRUCT;
		$msg[ Message::TIMESTAMP ] = \microtime( true );
		$msg[ Message::VALUE ]     = $entry;
		\file_put_contents( "{$dir}/0.log", Message::packed( $msg ) . "\n" );
	}

	/**
	 * Seed a heartbeat file under a worker lock dir so its status flips to
	 * `running` and `live=true`.
	 */
	private function seed_heartbeat( string $base_dir, string $type, int $partition, int $age_seconds = 0 ): string {
		$lock_dir = "{$base_dir}/locks/{$type}.p{$partition}.lock.d";
		if ( ! \is_dir( $lock_dir ) ) {
			\mkdir( $lock_dir, 0755, true );
		}
		$hb = "{$lock_dir}/heartbeat";
		\touch( $hb, \time() - $age_seconds );
		return $lock_dir;
	}

	/**
	 * Seed a segment file in `{base}/logs/{name}.log/p{partition}/{seg}.log`
	 * so the logs-enumeration walk picks it up. `$log_name` is the basename
	 * without the `.log` suffix; the outer dir gets the suffix appended to
	 * match the legacy controller's regex match (`/^(.+)\.log$/`).
	 */
	private function seed_log_segment( string $base_dir, string $log_name, int $partition, int $segment_id, int $size = 64 ): void {
		$dir = "{$base_dir}/logs/{$log_name}.log/p{$partition}";
		if ( ! \is_dir( $dir ) ) {
			\mkdir( $dir, 0755, true );
		}
		\file_put_contents( "{$dir}/{$segment_id}.log", \str_repeat( 'x', $size ) );
	}

	public function test_list_verb_returns_workers_from_cli(): void {
		$fake_cli = new class {
			public function ls_workers(): array {
				return [
					[ 'type' => 'firehose-workers-and-jobs', 'partition' => 0, 'live' => true ],
				];
			}
			public function live_position( $cache, string $type, int $partition ): ?array {
				return [ 'seg' => 0, 'off' => 100, 'ts' => 1747000000 ];
			}
			public function restart_workers( array $workers, array $filter = [], int $partition = -1 ): int { return 0; }
		};
		$ci = new Workers_CI( $fake_cli );

		$result = VerbHarness::fire( $ci, 'workers', 'list' );

		$this->assertIsArray( $result );
		$this->assertCount( 1, $result );
		$this->assertSame( 'firehose-workers-and-jobs', $result[0]['type'] );
	}

	public function test_restart_verb_calls_cli_and_returns_count(): void {
		$fake_cli = new class {
			public ?array $called_with = null;
			public function ls_workers(): array {
				return [
					[ 'type' => 'firehose-workers-and-jobs', 'partition' => 0 ],
					[ 'type' => 'job-workers',                'partition' => 0 ],
				];
			}
			public function live_position( $cache, string $type, int $partition ): ?array { return null; }
			public function restart_workers( array $workers, array $filter = [], int $partition = -1 ): int {
				$this->called_with = [ 'workers' => $workers, 'filter' => $filter, 'partition' => $partition ];
				return \count( $workers );
			}
		};
		$ci = new Workers_CI( $fake_cli );

		$result = VerbHarness::fire( $ci, 'workers', 'restart', \wp_json_encode( [ 'types' => [ 'firehose-workers-and-jobs' ] ] ) );

		$this->assertSame( [ 'restarted' => 2 ], $result );
		$this->assertSame( [ 'firehose-workers-and-jobs' => true ], $fake_cli->called_with['filter'] );
	}

	public function test_heartbeat_verb_records_slot_via_cache(): void {
		// touch_sse_slot is the real Cache_Interface method (legacy
		// FirehoseController::heartbeat calls it directly). The plan's
		// stub of `heartbeat_sse_slot` doesn't exist on Cache_Interface;
		// aligning here per the plan's "fix divergences" guidance.
		$fake_cache = new class {
			public ?array $recorded = null;
			public function touch_sse_slot( int $user_id, string $ip_hash, int $slot, int $ttl, int $partition = -1 ): bool {
				$this->recorded = [ 'slot' => $slot, 'ttl' => $ttl, 'partition' => $partition ];
				return true;
			}
		};
		$ci = new Workers_CI( $this->stub_cli(), $fake_cache );

		$result = VerbHarness::fire( $ci, 'workers', 'heartbeat', \wp_json_encode( [ 'slot' => 7 ] ) );

		$this->assertSame( [ 'success' => true, 'slot' => 7 ], $result );
		$this->assertSame( 7, $fake_cache->recorded['slot'] );
	}

	private function stub_cli(): object {
		return new class {
			public function ls_workers(): array { return []; }
			public function live_position( $cache, string $type, int $partition ): ?array { return null; }
			public function restart_workers( array $workers, array $filter = [], int $partition = -1 ): int { return 0; }
		};
	}

	// -------------------------------------------------------------------------
	// dump_metadata verb — the operator-grade payload ported from the legacy
	// WorkersController::get_workers. Dashboard-#5 (event-dashboards /
	// WorkerStatus.js) consumes this; .list stays minimal for CLI / topology
	// callers.
	// -------------------------------------------------------------------------

	public function test_dump_metadata_returns_seven_top_level_keys(): void {
		// Envelope shape (post-WorkersController parity): workers[],
		// standalone[], logs[], num_partitions, num_segments, segment_size,
		// timestamp. Even with no workers configured + no disk state, the
		// envelope keys must be present so the dashboard can fan out from a
		// stable shape.
		$this->arrange_base_dir();
		$cache = new FakeMemcached();
		$ci    = new Workers_CI( $this->stub_cli(), $cache );

		$result = VerbHarness::fire( $ci, 'workers', 'dump_metadata' );

		$this->assertIsArray( $result );
		foreach (
			[
				'workers',
				'standalone',
				'logs',
				'num_partitions',
				'num_segments',
				'segment_size',
				'timestamp',
			] as $key
		) {
			$this->assertArrayHasKey( $key, $result, "Missing envelope key: $key" );
		}
		// Config seeded by arrange_base_dir().
		$this->assertSame( 1, $result['num_partitions'] );
		$this->assertSame( 8, $result['num_segments'] );
		$this->assertSame( 16 * 1024 * 1024, $result['segment_size'] );
		// supervisor is always emitted into standalone[].
		$this->assertNotEmpty( $result['standalone'] );
		$this->assertSame( 'supervisor', $result['standalone'][0]['type'] );
	}

	public function test_dump_metadata_workers_each_have_rich_descriptor_fields(): void {
		// Each worker entry must carry the dashboard's full read surface:
		// type, partition, handler, source, target, inputs, outputs,
		// inputs_status, outputs_status, heartbeat_age, behind, cursor_seg,
		// cursor_offset, live, heartbeat_at, stale (plus legacy parity
		// fields the WorkerStatus.js code already touches: status,
		// started_at, restart_pending).
		$base = $this->arrange_base_dir();
		$this->seed_offsetlog(
			$base,
			'firehose',
			0,
			[
				'name'        => 'firehose:consumer',
				'target'      => 'firehose:tee',
				'targets'     => [ [ 'name' => 'request-builder' ] ],
				'worker_type' => 'firehose-workers-and-jobs',
			]
		);
		$this->seed_heartbeat( $base, 'firehose-workers-and-jobs', 0 );

		$cache  = new FakeMemcached();
		$ci     = new Workers_CI( $this->stub_cli(), $cache );
		$result = VerbHarness::fire( $ci, 'workers', 'dump_metadata' );

		$rows = \array_values( \array_filter(
			$result['workers'],
			static fn ( $w ) => 'firehose-workers-and-jobs' === ( $w['type'] ?? '' )
		) );
		$this->assertNotEmpty( $rows, 'expected a firehose-workers-and-jobs row' );
		$row = $rows[0];

		foreach (
			[
				'type',
				'partition',
				'handler',
				'source',
				'target',
				'inputs',
				'outputs',
				'inputs_status',
				'outputs_status',
				'heartbeat_age',
				'behind',
				'cursor_seg',
				'cursor_offset',
				'live',
				'heartbeat_at',
				'stale',
				// Legacy parity fields WorkerStatus.js reads directly.
				'status',
				'started_at',
				'restart_pending',
			] as $field
		) {
			$this->assertArrayHasKey( $field, $row, "worker missing field: $field" );
		}
		$this->assertSame( 'firehose-workers-and-jobs', $row['type'] );
		$this->assertSame( 0, $row['partition'] );
		$this->assertSame( 'request-builder', $row['handler'] );
		$this->assertSame( 'firehose:consumer', $row['source'] );
		$this->assertTrue( $row['live'] );
		$this->assertFalse( $row['stale'] );
		$this->assertSame( 'running', $row['status'] );
		$this->assertIsArray( $row['inputs_status'] );
		$this->assertNotEmpty( $row['inputs_status'] );
	}

	public function test_dump_metadata_includes_logs_enumeration(): void {
		// `logs[]` is the per-log per-partition disk-scan output. Each entry
		// = {name, partitions: [{partition, segments[], total_size}, ...]}.
		// Configured-but-empty partitions show up as padded slots; on-disk
		// segments populate segments[] with {id, size, mtime}.
		$base = $this->arrange_base_dir();
		$this->seed_log_segment( $base, 'firehose', 0, 0, 128 );
		$this->seed_log_segment( $base, 'firehose', 0, 1, 256 );
		$this->seed_log_segment( $base, 'requests', 0, 0, 64 );

		$ci     = new Workers_CI( $this->stub_cli(), new FakeMemcached() );
		$result = VerbHarness::fire( $ci, 'workers', 'dump_metadata' );

		$this->assertIsArray( $result['logs'] );
		$names = \array_column( $result['logs'], 'name' );
		$this->assertContains( 'firehose.log', $names );
		$this->assertContains( 'requests.log', $names );

		$firehose = null;
		foreach ( $result['logs'] as $log ) {
			if ( 'firehose.log' === $log['name'] ) {
				$firehose = $log;
				break;
			}
		}
		$this->assertNotNull( $firehose );
		$this->assertSame( 0, $firehose['partitions'][0]['partition'] );
		$this->assertCount( 2, $firehose['partitions'][0]['segments'] );
		$this->assertSame( 128 + 256, $firehose['partitions'][0]['total_size'] );
	}

	public function test_dump_metadata_includes_standalone_workers(): void {
		// supervisor is always present; additional standalone workers come
		// from the `newspack_nodes/standalone_workers` filter, each emitted
		// per-partition when `partitions=true` is set or as a singleton row
		// otherwise.
		$base = $this->arrange_base_dir();
		\add_filter(
			'newspack_nodes/standalone_workers',
			static fn ( $w ) => \array_merge(
				(array) $w,
				[
					'health-check' => [ 'partitions' => false ],
					'sse-pump'     => [ 'partitions' => true ],
				]
			)
		);
		$ci     = new Workers_CI( $this->stub_cli(), new FakeMemcached() );
		$result = VerbHarness::fire( $ci, 'workers', 'dump_metadata' );

		$standalone_types = \array_column( $result['standalone'], 'type' );
		$this->assertContains( 'supervisor', $standalone_types );
		$this->assertContains( 'health-check', $standalone_types );
		$this->assertContains( 'sse-pump', $standalone_types );
	}

	public function test_dump_metadata_inputs_status_includes_segments_metadata(): void {
		// inputs_status[] is the per-input segment metadata + cursor. Each
		// entry = {name, partition, segments: [{id, size, mtime}], total_size,
		// cursor_seg, cursor_offset}. Cursor_seg/offset are present only when
		// the worker has checkpointed (matches `build_log_status_entry`'s
		// conditional inclusion).
		$base = $this->arrange_base_dir();
		// Seed offsetlog metadata + heartbeat + the corresponding log
		// segments so build_worker_status's Partition scan finds something.
		$this->seed_offsetlog(
			$base,
			'firehose',
			0,
			[
				'name'        => 'firehose:consumer',
				'target'      => 'request-builder',
				'targets'     => [ [ 'name' => 'request-builder' ] ],
				'worker_type' => 'firehose-workers-and-jobs',
				'seg'         => 0,
				'off'         => 50,
			]
		);
		$this->seed_heartbeat( $base, 'firehose-workers-and-jobs', 0 );
		$this->seed_log_segment( $base, 'firehose', 0, 0, 200 );

		$ci     = new Workers_CI( $this->stub_cli(), new FakeMemcached() );
		$result = VerbHarness::fire( $ci, 'workers', 'dump_metadata' );

		$rows = \array_values( \array_filter(
			$result['workers'],
			static fn ( $w ) => 'firehose-workers-and-jobs' === ( $w['type'] ?? '' )
		) );
		$this->assertNotEmpty( $rows );
		$row    = $rows[0];
		$status = $row['inputs_status'][0];
		$this->assertSame( 'firehose.log', $status['name'] );
		$this->assertSame( 0, $status['partition'] );
		$this->assertIsArray( $status['segments'] );
		$this->assertCount( 1, $status['segments'] );
		$this->assertSame( 0, $status['segments'][0]['id'] );
		$this->assertSame( 200, $status['segments'][0]['size'] );
		$this->assertSame( 200, $status['total_size'] );
		// Cursor came from the on-disk offsetlog read.
		$this->assertSame( 0, $row['cursor_seg'] );
		$this->assertSame( 50, $row['cursor_offset'] );
		// Behind = (200 - 50) = 150.
		$this->assertSame( 150, $row['behind'] );
	}

	public function test_dump_metadata_emits_placeholder_when_worker_has_not_checkpointed(): void {
		// A topology worker with no offsetlog entry (fresh spawn, no
		// Consumer checkpoint yet) must still emit one row so the
		// dashboard sees the worker_type. The row's inputs/outputs/etc.
		// are empty arrays; target = ''.
		$base = $this->arrange_base_dir();
		$this->seed_heartbeat( $base, 'request-workers', 0 );

		$ci     = new Workers_CI( $this->stub_cli(), new FakeMemcached() );
		$result = VerbHarness::fire( $ci, 'workers', 'dump_metadata' );

		$rows = \array_values( \array_filter(
			$result['workers'],
			static fn ( $w ) => 'request-workers' === ( $w['type'] ?? '' )
		) );
		$this->assertNotEmpty( $rows, 'expected placeholder row for request-workers' );
		$placeholder = $rows[0];
		$this->assertSame( [], $placeholder['inputs'] );
		$this->assertSame( [], $placeholder['outputs'] );
		$this->assertSame( [], $placeholder['inputs_status'] );
		$this->assertSame( [], $placeholder['outputs_status'] );
		$this->assertSame( '', $placeholder['target'] );
	}

	public function test_dump_metadata_rejects_unauthorized(): void {
		// Legacy WorkersController gated through read_permissions_check ==
		// manage_options. dump_metadata enforces the same gate so the
		// REST -> CI swap is a no-op for callers.
		$this->arrange_base_dir();
		$GLOBALS['_wp_test_current_user_can'] = [];
		$ci     = new Workers_CI( $this->stub_cli(), new FakeMemcached() );
		$result = VerbHarness::fire( $ci, 'workers', 'dump_metadata' );

		$this->assertIsString( $result );
		$this->assertStringContainsString( 'permission denied', $result );
	}

	public function test_dump_metadata_uses_live_position_from_memcache(): void {
		// Memcache cursor wins over on-disk offsetlog. Same key shape
		// the legacy controller uses: `np:pos:{host}:{base}/logs/{input}:p{N}`.
		$base = $this->arrange_base_dir();
		$this->seed_offsetlog(
			$base,
			'firehose',
			0,
			[
				'name'        => 'firehose:consumer',
				'target'      => 'request-builder',
				'targets'     => [ [ 'name' => 'request-builder' ] ],
				'worker_type' => 'firehose-workers-and-jobs',
				'seg'         => 0,
				'off'         => 0,
			]
		);
		$this->seed_heartbeat( $base, 'firehose-workers-and-jobs', 0 );
		$this->seed_log_segment( $base, 'firehose', 0, 0, 1000 );

		$cache       = new FakeMemcached();
		$source_path = "{$base}/logs/firehose.log";
		$host        = \gethostname() ?: 'unknown';
		$cache->set(
			"np:pos:{$host}:{$source_path}:p0",
			[ 'seg' => 0, 'off' => 600, 'ts' => \microtime( true ) ],
			60
		);

		$ci     = new Workers_CI( $this->stub_cli(), $cache );
		$result = VerbHarness::fire( $ci, 'workers', 'dump_metadata' );

		$rows = \array_values( \array_filter(
			$result['workers'],
			static fn ( $w ) => 'firehose-workers-and-jobs' === ( $w['type'] ?? '' )
		) );
		$this->assertNotEmpty( $rows );
		$this->assertSame( 0, $rows[0]['cursor_seg'] );
		$this->assertSame( 600, $rows[0]['cursor_offset'] );
		$this->assertSame( 400, $rows[0]['behind'] );
	}
}
