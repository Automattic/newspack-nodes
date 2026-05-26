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
use Newspack_Nodes\Rest\Workers_CI_Node;
use Newspack_Nodes\Tests\Helpers\FakeMemcached;
use Newspack_Nodes\Tests\Helpers\VerbHarness;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Workers_CI_Node::class )]
class WorkersCITest extends TestCase {

	private ?string $tmp = null;

	protected function setUp(): void {
		parent::setUp();
		// Topology_Registry is static (stock dirs + a segment_size-override
		// cache). Reset per method or a prior test's topology state leaks —
		// e.g. dump_metadata reads a stale empty override cache and reports the
		// global segment_size for logs that should carry a literal override.
		// Matches the pattern in TopologyLoaderTest / CliWorkerCommandTest.
		\Newspack_Nodes\Topology_Registry::reset();
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
						'demo-workers',
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
		// Catalog registration no longer activates; declare the active set so
		// get_topologies()/the dump_metadata enumerate path sees these fleets.
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [
			'demo-workers',
			'request-workers',
			'job-workers',
			'aggregator',
		];
		\Newspack_Nodes\Config::reset();
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

	public function test_node_schema_declares_its_verbs(): void {
		$schema = Workers_CI_Node::node_schema();
		$names  = \array_map( static fn ( array $v ): string => $v['name'], $schema['verbs'] );
		\sort( $names );
		$this->assertSame(
			[ 'cleanup_status', 'dump_metadata', 'heartbeat', 'list', 'restart' ],
			$names
		);
		$this->assertNotEmpty( $schema['description'] );
	}

	public function test_list_verb_returns_workers_from_cli(): void {
		$fake_cli = new class {
			public function ls_workers(): array {
				return [
					[ 'type' => 'demo-workers', 'partition' => 0, 'live' => true ],
				];
			}
			public function live_position( $cache, string $type, int $partition ): ?array {
				return [ 'seg' => 0, 'off' => 100, 'ts' => 1747000000 ];
			}
			public function restart_workers( array $workers, array $filter = [], int $partition = -1 ): int { return 0; }
		};
		$ci = new Workers_CI_Node( $fake_cli );

		$result = VerbHarness::fire( $ci, 'workers', 'list' );

		$this->assertIsArray( $result );
		$this->assertCount( 1, $result );
		$this->assertSame( 'demo-workers', $result[0]['type'] );
	}

	public function test_restart_verb_calls_cli_and_returns_count(): void {
		$fake_cli = new class {
			public ?array $called_with = null;
			public function ls_workers(): array {
				return [
					[ 'type' => 'demo-workers', 'partition' => 0 ],
					[ 'type' => 'job-workers',                'partition' => 0 ],
				];
			}
			public function live_position( $cache, string $type, int $partition ): ?array { return null; }
			public function restart_workers( array $workers, array $filter = [], int $partition = -1 ): int {
				$this->called_with = [ 'workers' => $workers, 'filter' => $filter, 'partition' => $partition ];
				$matched = 0;
				foreach ( $workers as $w ) {
					if ( ! empty( $filter ) && empty( $filter[ $w['type'] ?? '' ] ) ) {
						continue;
					}
					++$matched;
				}
				return $matched;
			}
		};
		$ci = new Workers_CI_Node( $fake_cli );

		$result = VerbHarness::fire( $ci, 'workers', 'restart', [ 'types' => [ 'demo-workers' ] ] );

		$this->assertSame( [ 'restarted' => 1 ], $result );
		$this->assertSame( [ 'demo-workers' => true ], $fake_cli->called_with['filter'] );
	}

	public function test_restart_verb_routes_supervisor_through_restart_supervisor(): void {
		// The supervisor lives at `supervisor.lock.d` — no `.pN` suffix — so
		// `Cli::ls_workers()` never sees it and `restart_workers` (which
		// only knows the partitioned `{type}.p{N}` shape) can't touch it.
		// The verb routes supervisor restarts through the dedicated
		// `Cli::restart_supervisor()` and only delegates partitioned types
		// to `restart_workers`.
		$fake_cli = new class {
			public int  $supervisor_calls = 0;
			public ?array $restart_called_with = null;
			public function ls_workers(): array { return []; }
			public function live_position( $cache, string $type, int $partition ): ?array { return null; }
			public function restart_supervisor(): bool {
				++$this->supervisor_calls;
				return true;
			}
			public function restart_workers( array $workers, array $filter = [], int $partition = -1 ): int {
				$this->restart_called_with = [ 'filter' => $filter ];
				return 0;
			}
		};
		$ci = new Workers_CI_Node( $fake_cli );

		$result = VerbHarness::fire( $ci, 'workers', 'restart', [ 'types' => [ 'supervisor' ] ] );

		$this->assertSame( [ 'restarted' => 1 ], $result );
		$this->assertSame( 1, $fake_cli->supervisor_calls );
		// With only supervisor in the filter, restart_workers must NOT
		// fire — the filter is empty after the supervisor is peeled off,
		// and an empty filter would otherwise wildcard-restart every worker.
		$this->assertNull( $fake_cli->restart_called_with );
	}

	public function test_list_verb_threads_constructor_cache_into_cli(): void {
		// Stateful-migration guard: node_schema() is static and cannot `use`
		// the ctor-injected $cli/$cache, so the migrated handler must reach
		// them via instance access on the dispatched $self (`$self->cli` /
		// `$self->cache`). This pins that both arrive intact: the fake Cli
		// records the exact $cache object the handler passed into
		// live_position(); we assert it is the SAME instance we constructed
		// the CI with (not null, not some other handle).
		$sentinel_cache = new \stdClass();
		$fake_cli       = new class {
			public mixed $seen_cache = 'unset';
			public int   $list_calls = 0;
			public function ls_workers(): array {
				return [ [ 'type' => 'demo-workers', 'partition' => 0 ] ];
			}
			public function live_position( $cache, string $type, int $partition ): ?array {
				++$this->list_calls;
				$this->seen_cache = $cache;
				return [ 'seg' => 0, 'off' => 7 ];
			}
			public function restart_workers( array $workers, array $filter = [], int $partition = -1 ): int { return 0; }
		};
		$ci = new Workers_CI_Node( $fake_cli, $sentinel_cache );

		$result = VerbHarness::fire( $ci, 'workers', 'list' );

		$this->assertSame( 1, $fake_cli->list_calls, 'handler must reach $self->cli->live_position' );
		$this->assertSame( $sentinel_cache, $fake_cli->seen_cache, 'handler must thread $self->cache into the cli call' );
		$this->assertSame( [ 'seg' => 0, 'off' => 7 ], $result[0]['position'] );
	}

	public function test_heartbeat_verb_refreshes_slot_via_pool(): void {
		// Heartbeat refreshes the SSE slot through Sse_Slot_Pool::touch, keyed
		// off the shared Core::$memd handle. Seed a held slot then heartbeat it.
		\Newspack_Nodes\Core::$memd = new \Newspack_Nodes\Tests\Helpers\InMemoryMemcached();
		$user_id = \get_current_user_id();
		$ip_hash = \Newspack_Nodes\SSE_Slot_Pool::ip_hash();
		$slot    = \Newspack_Nodes\SSE_Slot_Pool::acquire( $user_id, $ip_hash, 8, 30, -1 );
		$this->assertSame( 0, $slot, 'first acquire claims slot 0' );

		$ci     = new Workers_CI_Node( $this->stub_cli(), \Newspack_Nodes\Core::$memd );
		$result = VerbHarness::fire( $ci, 'workers', 'heartbeat', null, (string) $slot );

		$this->assertSame( [ 'success' => true, 'slot' => 0 ], $result );
		\Newspack_Nodes\Core::$memd = null;
	}

	// ── heartbeat error paths ───────────────────────────────────────────────

	public function test_heartbeat_verb_errors_when_no_memd_configured(): void {
		// The shared Memcached handle is wired in production by the application
		// bootstrap; absent it, the verb fails fast with a clear runtime error
		// so the dashboard caller sees the misconfiguration instead of a silent
		// no-op. CommandInterpreter catches verb exceptions and wraps them as
		// TM_COMMAND|TM_ERROR with the message in VALUE, so the payload IS the
		// error string.
		\Newspack_Nodes\Core::$memd = null;
		$ci = new Workers_CI_Node( $this->stub_cli() );

		$result = VerbHarness::fire( $ci, 'workers', 'heartbeat', null, '7' );

		$this->assertSame( 'cache not configured', $result );
	}

	public function test_heartbeat_verb_errors_when_slot_is_missing_or_negative(): void {
		// `slot` is required and must be non-negative — the pool keys it
		// per-(user,ip,slot), so a -1 slot would silently collide across
		// browser sessions. Guard fires before the touch.
		\Newspack_Nodes\Core::$memd = new \Newspack_Nodes\Tests\Helpers\InMemoryMemcached();
		$ci = new Workers_CI_Node( $this->stub_cli(), \Newspack_Nodes\Core::$memd );

		$result = VerbHarness::fire( $ci, 'workers', 'heartbeat', null, '' );  // no slot

		$this->assertSame( 'slot required', $result );
		\Newspack_Nodes\Core::$memd = null;
	}

	// ── cleanup_status verb ─────────────────────────────────────────────────

	public function test_cleanup_status_returns_diagnostic_envelope_with_orphans(): void {
		// Verb is the Log_Cleaner sweep's mirror: same inputs the sweep
		// consults (LOGS_DIRTY_OPTION + FLEET_DESCRIPTORS_OPTION +
		// {base}/logs/*.log/ + 'expected_log_basenames' filter) plus the
		// computed orphan diff. Without this, dashboard cleanup-status
		// debugging requires shell access.
		$base    = $this->arrange_base_dir();
		$logs    = "{$base}/logs";
		\mkdir( "{$logs}/firehose.log", 0755, true );
		\mkdir( "{$logs}/orphan.log",   0755, true );  // not in expected list

		// Seed the two options the sweep keys on.
		\update_option( \Newspack_Nodes\Log_Cleaner::LOGS_DIRTY_OPTION, 1 );
		\update_option(
			\Newspack_Nodes\Log_Cleaner::FLEET_DESCRIPTORS_OPTION,
			[ 'demo-workers' => 1 ]
		);

		// Application bootstrap publishes the canonical expected-basenames
		// list via this filter. Mirror that here so the orphan diff has a
		// real `expected` to subtract from.
		\add_filter(
			'newspack_nodes/expected_log_basenames',
			static fn ( array $basenames ): array => [ 'firehose' ]
		);

		$ci     = new Workers_CI_Node( $this->stub_cli() );
		$result = VerbHarness::fire( $ci, 'workers', 'cleanup_status' );

		$this->assertSame( 1, $result['logs_dirty_option'] );
		$this->assertSame( [ 'demo-workers' => 1 ], $result['fleet_descriptors_option'] );
		$this->assertSame( $logs, $result['logs_dir'] );
		$this->assertSame( [ 'firehose', 'orphan' ], $result['on_disk_basenames'] );
		$this->assertSame( [ 'firehose' ], $result['expected_basenames'] );
		$this->assertSame( [ 'orphan' ], $result['orphans'] );
	}

	public function test_cleanup_status_handles_missing_options_and_filter(): void {
		// Defensive: when LOGS_DIRTY_OPTION isn't set, `get_option` returns
		// null (the explicit default we pass). When the
		// expected_log_basenames filter returns a non-array, the verb falls
		// back to an empty list — that branch is otherwise unreachable from
		// the happy-path test above.
		$base = $this->arrange_base_dir();
		\mkdir( "{$base}/logs", 0755, true );

		\add_filter(
			'newspack_nodes/expected_log_basenames',
			static fn (): mixed => 'not an array'
		);

		$ci     = new Workers_CI_Node( $this->stub_cli() );
		$result = VerbHarness::fire( $ci, 'workers', 'cleanup_status' );

		$this->assertNull( $result['logs_dirty_option'] );
		$this->assertNull( $result['fleet_descriptors_option'] );
		$this->assertSame( [], $result['on_disk_basenames'] );
		$this->assertSame( [], $result['expected_basenames'] );
		$this->assertSame( [], $result['orphans'] );
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
		// Envelope shape: workers[], supervisor, logs[], num_partitions,
		// num_segments, segment_size, timestamp. Even with no workers
		// configured + no disk state, every envelope key must be present so
		// the dashboard can fan out from a stable shape.
		$this->arrange_base_dir();
		$cache = new FakeMemcached();
		$ci    = new Workers_CI_Node( $this->stub_cli(), $cache );

		$result = VerbHarness::fire( $ci, 'workers', 'dump_metadata' );

		$this->assertIsArray( $result );
		foreach (
			[
				'workers',
				'supervisor',
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
		// Supervisor descriptor is always emitted as a single object.
		$this->assertIsArray( $result['supervisor'] );
		$this->assertSame( 'supervisor', $result['supervisor']['type'] );
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
				'worker_type' => 'demo-workers',
			]
		);
		$this->seed_heartbeat( $base, 'demo-workers', 0 );

		$cache  = new FakeMemcached();
		$ci     = new Workers_CI_Node( $this->stub_cli(), $cache );
		$result = VerbHarness::fire( $ci, 'workers', 'dump_metadata' );

		$rows = \array_values( \array_filter(
			$result['workers'],
			static fn ( $w ) => 'demo-workers' === ( $w['type'] ?? '' )
		) );
		$this->assertNotEmpty( $rows, 'expected a demo-workers row' );
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
		$this->assertSame( 'demo-workers', $row['type'] );
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

		$ci     = new Workers_CI_Node( $this->stub_cli(), new FakeMemcached() );
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

	public function test_dump_metadata_logs_carry_per_partition_segment_size_overrides(): void {
		// Workers dashboard surfaces a per-log "max segment size" indicator.
		// Topologies that hardcode an int as the Partition `segment_size`
		// positional arg (instead of the `<config:segment_size>` token) want
		// that override reflected — 1 MiB for completed.log / gyroscope.log
		// even when the global config default is much larger. Logs without
		// a literal override fall back to the global default.
		$base = $this->arrange_base_dir();

		// Drop a TSL file matching one of the topology names registered by
		// arrange_base_dir()'s filter, then point Topology_Registry at it.
		// `completed.log` gets a literal int; `requests.log` uses the
		// `<config:segment_size>` token (no override).
		$stock = "{$base}/topologies";
		\mkdir( $stock, 0755, true );
		\file_put_contents(
			"{$stock}/aggregator.tsl",
			"make_node Partition completed:partition <config:logs_dir>/completed.log <partition> 1048576 <config:num_segments> <config:max_lifespan>\n"
			. "make_node Partition requests:partition <config:logs_dir>/requests.log <partition> <config:segment_size> <config:num_segments> <config:max_lifespan>\n"
		);
		\Newspack_Nodes\Topology_Registry::register_stock_dir( $stock );

		$this->seed_log_segment( $base, 'completed', 0, 0, 32 );
		$this->seed_log_segment( $base, 'requests',  0, 0, 64 );

		$ci     = new Workers_CI_Node( $this->stub_cli(), new FakeMemcached() );
		$result = VerbHarness::fire( $ci, 'workers', 'dump_metadata' );

		$by_name = [];
		foreach ( $result['logs'] as $log ) {
			$by_name[ $log['name'] ] = $log;
		}
		$this->assertArrayHasKey( 'completed.log', $by_name );
		$this->assertArrayHasKey( 'requests.log',  $by_name );
		$pollution_hint = 'If this fails in the full suite but passes in isolation '
			. '(--filter test_dump_metadata_logs_carry_per_partition_segment_size_overrides), '
			. 'a prior test almost certainly threw mid-run and left Core/Config static '
			. 'state polluted — fix the throwing test, not this assertion.';
		$this->assertSame( 1048576,           $by_name['completed.log']['segment_size'], $pollution_hint );
		$this->assertSame( 16 * 1024 * 1024,  $by_name['requests.log']['segment_size'],  $pollution_hint );

		\Newspack_Nodes\Topology_Registry::reset();
	}

	public function test_dump_metadata_includes_supervisor_descriptor(): void {
		// The supervisor is a singleton — exactly one entry, always emitted,
		// at the un-suffixed lock dir `supervisor.lock.d`. No `partition`
		// field (it doesn't run as a partition fleet).
		$base = $this->arrange_base_dir();
		$ci     = new Workers_CI_Node( $this->stub_cli(), new FakeMemcached() );
		$result = VerbHarness::fire( $ci, 'workers', 'dump_metadata' );

		$this->assertIsArray( $result['supervisor'] );
		$this->assertSame( 'supervisor', $result['supervisor']['type'] );
		$this->assertArrayNotHasKey( 'partition', $result['supervisor'] );
		$this->assertArrayHasKey( 'status', $result['supervisor'] );
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
				'worker_type' => 'demo-workers',
				'seg'         => 0,
				'off'         => 50,
			]
		);
		$this->seed_heartbeat( $base, 'demo-workers', 0 );
		$this->seed_log_segment( $base, 'firehose', 0, 0, 200 );

		$ci     = new Workers_CI_Node( $this->stub_cli(), new FakeMemcached() );
		$result = VerbHarness::fire( $ci, 'workers', 'dump_metadata' );

		$rows = \array_values( \array_filter(
			$result['workers'],
			static fn ( $w ) => 'demo-workers' === ( $w['type'] ?? '' )
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

		$ci     = new Workers_CI_Node( $this->stub_cli(), new FakeMemcached() );
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
		$ci     = new Workers_CI_Node( $this->stub_cli(), new FakeMemcached() );
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
				'worker_type' => 'demo-workers',
				'seg'         => 0,
				'off'         => 0,
			]
		);
		$this->seed_heartbeat( $base, 'demo-workers', 0 );
		$this->seed_log_segment( $base, 'firehose', 0, 0, 1000 );

		$cache       = new \Newspack_Nodes\Tests\Helpers\InMemoryMemcached();
		$source_path = "{$base}/logs/firehose.log";
		$host        = \gethostname() ?: 'unknown';
		$cache->set(
			"np:pos:{$host}:{$source_path}:p0",
			[ 'seg' => 0, 'off' => 600, 'ts' => \microtime( true ) ],
			60
		);

		$ci     = new Workers_CI_Node( $this->stub_cli(), $cache );
		$result = VerbHarness::fire( $ci, 'workers', 'dump_metadata' );

		$rows = \array_values( \array_filter(
			$result['workers'],
			static fn ( $w ) => 'demo-workers' === ( $w['type'] ?? '' )
		) );
		$this->assertNotEmpty( $rows );
		$this->assertSame( 0, $rows[0]['cursor_seg'] );
		$this->assertSame( 600, $rows[0]['cursor_offset'] );
		$this->assertSame( 400, $rows[0]['behind'] );
	}
}
