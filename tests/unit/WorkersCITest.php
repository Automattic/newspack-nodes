<?php
/**
 * WorkersCITest: unit tests for Workers_CI, the M2 service-interpreter that
 * replaces the legacy WorkersController + FirehoseController::heartbeat.
 *
 * These tests establish the pattern every other M2 interpreter test will
 * follow: instantiate the interpreter with stubbed dependencies, fire a verb
 * through VerbHarness, assert on the decoded payload.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Consumer_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Probe_Record;
use Newspack_Nodes\Rest\Workers_CI_Node;
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
	 * Seed a TopicProbe record at logs/topicprobe.p0 for a `{source}.p{partition}`
	 * consumer — the single enumeration + cursor source dump_metadata now reads.
	 * Accepts the legacy offsetlog-shaped `$extra` (seg/off/source_log/name) and
	 * maps it onto the probe record's fields. Appends so several seeds accumulate.
	 */
	private function seed_probe_record( string $base_dir, string $source_basename, int $partition, array $extra = [] ): void {
		$dir = "{$base_dir}/logs/topicprobe.p0";
		if ( ! \is_dir( $dir ) ) {
			\mkdir( $dir, 0755, true );
		}
		$record                             = [];
		$record[ Probe_Record::SOURCE ]     = $extra['source'] ?? $extra['source_log'] ?? "{$source_basename}.p{$partition}";
		$record[ Probe_Record::READER ]     = "{$source_basename}.p{$partition}";
		$record[ Probe_Record::CURSOR_SEG ] = $extra['seg'] ?? 0;
		$record[ Probe_Record::CURSOR_OFF ] = $extra['off'] ?? 0;
		$record[ Probe_Record::END_SEG ]    = $extra['end_seg'] ?? 0;
		$record[ Probe_Record::END_SIZE ]   = $extra['end_size'] ?? 0;
		$record[ Probe_Record::DISTANCE ]   = $extra['distance'] ?? $extra['bytes_behind'] ?? 0;
		$record[ Probe_Record::MSGS ]       = $extra['msgs'] ?? 0;
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_STRUCT;
		$message[ Message::VALUE ] = $record;
		\file_put_contents( "{$dir}/0.log", Message::packed( $message ) . "\n", FILE_APPEND );
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
	 * Seed a segment file in the FLAT partition layout
	 * `{base}/logs/{name}.p{partition}/{seg}.log` so the resolver-driven logs
	 * enumeration picks it up. `$log_name` is the basename without any suffix;
	 * the partition is part of the concrete dir NAME (flat Partition layout),
	 * not a nested `p{N}` subdir.
	 */
	private function seed_log_segment( string $base_dir, string $log_name, int $partition, int $segment_id, int $size = 64 ): void {
		$dir = "{$base_dir}/logs/{$log_name}.p{$partition}";
		if ( ! \is_dir( $dir ) ) {
			\mkdir( $dir, 0755, true );
		}
		\file_put_contents( "{$dir}/{$segment_id}.log", \str_repeat( 'x', $size ) );
	}

	/**
	 * Drop a `.tsl` declaring `$name`'s flat-layout Partition nodes so the
	 * resolver (`resolved_resource_dirs`) yields concrete per-partition log dir
	 * names for the enumeration. One `make_node Partition` per basename.
	 *
	 * @param array<int,string> $basenames Log basenames (e.g. `firehose`, `requests`).
	 */
	private function declare_partitions( string $base_dir, string $topology, array $basenames, int $num_partitions = 1 ): void {
		$stock = "{$base_dir}/topologies";
		if ( ! \is_dir( $stock ) ) {
			\mkdir( $stock, 0755, true );
		}
		$lines = '';
		if ( 1 !== $num_partitions ) {
			$lines .= "var num_partitions = {$num_partitions}\n";
		}
		foreach ( $basenames as $basename ) {
			$lines .= "make_node Partition {$basename}:partition <config:logs_dir>/{$basename}.p<partition> <config:segment_size> <config:num_segments> <config:max_lifespan>\n";
		}
		\file_put_contents( "{$stock}/{$topology}.tsl", $lines );
		\Newspack_Nodes\Topology_Registry::register_stock_dir( $stock );
	}

	public function test_node_schema_declares_its_verbs(): void {
		$schema = Workers_CI_Node::node_schema();
		$names  = \array_map( static fn ( array $v ): string => $v['name'], $schema['commands'] );
		\sort( $names );
		$this->assertSame(
			[ 'cleanup_status', 'dump_graph', 'heartbeat', 'list', 'restart' ],
			$names
		);
		$this->assertNotEmpty( $schema['description'] );
	}

	public function test_dump_metadata_verb_is_no_longer_registered(): void {
		// The dashboard payload verb was renamed dump_metadata -> dump_graph;
		// the old name must dispatch to nothing. CommandInterpreter throws
		// "unknown command: <name>" and wraps it as TM_COMMAND|TM_ERROR, so
		// the harness surfaces the error-message string.
		$this->arrange_base_dir();
		$interpreter        = new Workers_CI_Node();
		$interpreter->cli   = $this->stub_cli();

		$result = VerbHarness::fire( $interpreter, 'workers', 'dump_metadata' );

		$this->assertIsString( $result );
		$this->assertStringContainsString( 'unknown command: dump_metadata', $result );
	}

	public function test_dump_graph_payload_includes_per_topology_tsl_graph(): void {
		// dump_graph attaches a `graph` map: active-topology-name ->
		// Topology_Registry::graph_for(name) ({nodes, edges}). Seed a topology
		// whose .tsl has a make_node so graph[name]['nodes'] is non-empty.
		$base  = $this->arrange_base_dir();
		$stock = "{$base}/topologies";
		\mkdir( $stock, 0755, true );
		\file_put_contents(
			"{$stock}/demo-workers.tsl",
			"make_node Consumer firehose:consumer <config:logs_dir>/firehose.log\n"
			. "make_node Callback request-builder\n"
			. "connect_node firehose:consumer request-builder\n"
		);
		\Newspack_Nodes\Topology_Registry::register_stock_dir( $stock );

		$interpreter        = new Workers_CI_Node();
		$interpreter->cli   = $this->stub_cli();

		$result = VerbHarness::fire( $interpreter, 'workers', 'dump_graph' );

		$this->assertArrayHasKey( 'graph', $result );
		$this->assertIsArray( $result['graph'] );
		// One entry per active topology declared in arrange_base_dir().
		foreach ( [ 'demo-workers', 'request-workers', 'job-workers', 'aggregator' ] as $name ) {
			$this->assertArrayHasKey( $name, $result['graph'], "missing graph for topology: $name" );
			$this->assertArrayHasKey( 'nodes', $result['graph'][ $name ] );
			$this->assertArrayHasKey( 'edges', $result['graph'][ $name ] );
		}
		// The seeded .tsl yields a non-empty node list for demo-workers.
		$this->assertNotEmpty( $result['graph']['demo-workers']['nodes'] );
		$node_names = \array_column( $result['graph']['demo-workers']['nodes'], 'name' );
		$this->assertContains( 'firehose:consumer', $node_names );

		\Newspack_Nodes\Topology_Registry::reset();
	}

	public function test_dump_graph_payload_includes_heartbeat_interval(): void {
		// The dashboard computes a stall threshold from the substrate heartbeat
		// cadence; dump_graph must emit it so the frontend doesn't hardcode it.
		$this->arrange_base_dir();

		$interpreter        = new Workers_CI_Node();
		$interpreter->cli   = $this->stub_cli();

		$result = VerbHarness::fire( $interpreter, 'workers', 'dump_graph' );

		$this->assertArrayHasKey( 'heartbeat_interval_s', $result );
		$this->assertSame(
			\Newspack_Nodes\Worker_Base::HEARTBEAT_INTERVAL_S,
			$result['heartbeat_interval_s']
		);
	}

	public function test_list_verb_returns_workers_from_cli(): void {
		$fake_cli = new class {
			public function ls_workers(): array {
				return [
					[ 'type' => 'demo-workers', 'partition' => 0, 'live' => true ],
				];
			}
			public function read_probe_index(): array { return []; }
			public function live_position( array $index, string $type, int $partition ): ?array {
				return [ 'seg' => 0, 'off' => 100, 'ts' => 1747000000 ];
			}
			public function restart_workers( array $workers, array $filter = [], int $partition = -1 ): int { return 0; }
		};
		$interpreter = new Workers_CI_Node();
		$interpreter->cli = $fake_cli;

		$result = VerbHarness::fire( $interpreter, 'workers', 'list' );

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
			public function read_probe_index(): array { return []; }
			public function live_position( array $index, string $type, int $partition ): ?array { return null; }
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
		$interpreter = new Workers_CI_Node();
		$interpreter->cli = $fake_cli;

		$result = VerbHarness::fire( $interpreter, 'workers', 'restart', 'demo-workers' );

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
			public function read_probe_index(): array { return []; }
			public function live_position( array $index, string $type, int $partition ): ?array { return null; }
			public function restart_supervisor(): bool {
				++$this->supervisor_calls;
				return true;
			}
			public function restart_workers( array $workers, array $filter = [], int $partition = -1 ): int {
				$this->restart_called_with = [ 'filter' => $filter ];
				return 0;
			}
		};
		$interpreter = new Workers_CI_Node();
		$interpreter->cli = $fake_cli;

		$result = VerbHarness::fire( $interpreter, 'workers', 'restart', 'supervisor' );

		$this->assertSame( [ 'restarted' => 1 ], $result );
		$this->assertSame( 1, $fake_cli->supervisor_calls );
		// With only supervisor in the filter, restart_workers must NOT
		// fire — the filter is empty after the supervisor is peeled off,
		// and an empty filter would otherwise wildcard-restart every worker.
		$this->assertNull( $fake_cli->restart_called_with );
	}

	public function test_heartbeat_verb_refreshes_slot_via_pool(): void {
		// Heartbeat refreshes the SSE slot through Sse_Slot_Pool::touch, keyed
		// off the shared Core::$memd handle. Seed a held slot then heartbeat it.
		\Newspack_Nodes\Core::$memd = new \Newspack_Nodes\Tests\Helpers\InMemoryMemcached();
		$user_id = \get_current_user_id();
		$ip_hash = \Newspack_Nodes\SSE_Slot_Pool::ip_hash();
		$slot    = \Newspack_Nodes\SSE_Slot_Pool::acquire( $user_id, $ip_hash, 8, 30, -1 );
		$this->assertSame( 0, $slot, 'first acquire claims slot 0' );

		$interpreter     = new Workers_CI_Node();
		$interpreter->cli   = $this->stub_cli();
		$result = VerbHarness::fire( $interpreter, 'workers', 'heartbeat', (string) $slot );

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
		$interpreter = new Workers_CI_Node();
		$interpreter->cli = $this->stub_cli();

		$result = VerbHarness::fire( $interpreter, 'workers', 'heartbeat', '7' );

		$this->assertSame( 'cache not configured', $result );
	}

	public function test_heartbeat_verb_errors_when_slot_is_missing_or_negative(): void {
		// `slot` is required and must be non-negative — the pool keys it
		// per-(user,ip,slot), so a -1 slot would silently collide across
		// browser sessions. Guard fires before the touch.
		\Newspack_Nodes\Core::$memd = new \Newspack_Nodes\Tests\Helpers\InMemoryMemcached();
		$interpreter = new Workers_CI_Node();
		$interpreter->cli   = $this->stub_cli();

		$result = VerbHarness::fire( $interpreter, 'workers', 'heartbeat', '' );  // no slot

		$this->assertSame( 'slot required', $result );
		\Newspack_Nodes\Core::$memd = null;
	}

	// ── cleanup_status verb ─────────────────────────────────────────────────

	public function test_cleanup_status_returns_diagnostic_envelope_with_orphans(): void {
		// Verb mirrors the Log_Cleaner sweep: it globs the flat `{base}/logs/*` dirs
		// (GLOB_ONLYDIR, layout-agnostic — no `.p{N}` regex) and diffs against the
		// resolved declared set, so the diagnostic matches what the GC actually deletes
		// (including non-`.p{N}`-shaped dir names like `0-req`).
		$base = $this->arrange_base_dir();
		$logs = "{$base}/logs";
		\mkdir( "{$logs}/0-req",    0755, true );  // declared (token-in-prefix layout)
		\mkdir( "{$logs}/1-req",    0755, true );  // declared
		\mkdir( "{$logs}/ghost",    0755, true );  // not declared, no `.p{N}` suffix
		\file_put_contents( "{$logs}/req.0", 'X' ); // a Log segment FILE — GLOB_ONLYDIR skips it

		// A real .tsl declares the token-in-prefix `<partition>-req` layout (2 parts).
		$stock = "{$base}/topologies";
		\mkdir( $stock, 0755, true );
		\file_put_contents(
			"{$stock}/req-workers.tsl",
			"var num_partitions = 2\n"
			. "make_node Partition req:p <config:logs_dir>/<partition>-req 1 2 0\n"
		);
		\Newspack_Nodes\Topology_Registry::register_stock_dir( $stock );
		\Newspack_Nodes\Topology_Registry::reset_basename_cache();

		$interpreter      = new Workers_CI_Node();
		$interpreter->cli = $this->stub_cli();
		$result = VerbHarness::fire( $interpreter, 'workers', 'cleanup_status' );

		$this->assertSame( $logs, $result['logs_dir'] );
		$this->assertSame( [ '0-req', '1-req', 'ghost' ], $result['on_disk_basenames'] );
		// topicprobe.p0 is an expected substrate log (auto-mounted, GC-whitelisted).
		$this->assertSame( [ '0-req', '1-req', 'topicprobe.p0' ], $result['expected_basenames'] );
		$this->assertSame( [ 'ghost' ], $result['orphans'] );

		\Newspack_Nodes\Topology_Registry::reset();
	}

	public function test_cleanup_status_handles_empty_layout(): void {
		// Defensive: no flat log dirs on disk and no declared topologies →
		// every list is empty, no orphans.
		$base = $this->arrange_base_dir();
		\mkdir( "{$base}/logs", 0755, true );
		\Newspack_Nodes\Topology_Registry::reset();

		$interpreter      = new Workers_CI_Node();
		$interpreter->cli = $this->stub_cli();
		$result = VerbHarness::fire( $interpreter, 'workers', 'cleanup_status' );

		$this->assertSame( [], $result['on_disk_basenames'] );
		$this->assertSame( [], $result['expected_basenames'] );
		$this->assertSame( [], $result['orphans'] );
	}

	private function stub_cli(): object {
		return new class {
			public function ls_workers(): array { return []; }
			public function read_probe_index(): array { return []; }
			public function live_position( array $index, string $type, int $partition ): ?array { return null; }
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
		$interpreter    = new Workers_CI_Node();
		$interpreter->cli   = $this->stub_cli();

		$result = VerbHarness::fire( $interpreter, 'workers', 'dump_graph' );

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

	public function test_dump_metadata_workers_carry_liveness_and_consumers_carry_state(): void {
		// workers[] is pure per-(type,partition) liveness; the per-reader cursor /
		// distance / msgs live in consumers[] (the probe snapshot), which the
		// dashboard joins onto the .tsl graph.
		$base = $this->arrange_base_dir();
		$this->seed_probe_record(
			$base,
			'firehose',
			0,
			[ 'source' => 'firehose.p0', 'seg' => 2, 'off' => 50, 'distance' => 128, 'msgs' => 7 ]
		);
		$this->seed_heartbeat( $base, 'demo-workers', 0 );

		$interpreter      = new Workers_CI_Node();
		$interpreter->cli = $this->stub_cli();
		$result           = VerbHarness::fire( $interpreter, 'workers', 'dump_graph' );

		$workers = \array_values( \array_filter(
			$result['workers'],
			static fn ( $w ) => 'demo-workers' === ( $w['type'] ?? '' )
		) );
		$this->assertNotEmpty( $workers, 'expected a demo-workers liveness row' );
		foreach (
			[ 'type', 'partition', 'status', 'started_at', 'heartbeat_age', 'heartbeat_at', 'live', 'stale', 'restart_pending' ] as $field
		) {
			$this->assertArrayHasKey( $field, $workers[0], "worker missing liveness field: $field" );
		}
		$this->assertTrue( $workers[0]['live'] );
		$this->assertSame( 'running', $workers[0]['status'] );

		$consumers = \array_values( \array_filter(
			$result['consumers'],
			static fn ( $c ) => 'firehose.p0' === ( $c['reader'] ?? '' )
		) );
		$this->assertNotEmpty( $consumers, 'expected a probe consumer row' );
		$this->assertSame( 'firehose.p0', $consumers[0]['source'] );
		$this->assertSame( 2, $consumers[0]['cursor_seg'] );
		$this->assertSame( 128, $consumers[0]['distance'] );
		$this->assertSame( 7, $consumers[0]['msgs'] );
	}

	public function test_dump_metadata_consumers_carry_the_recorded_source_partition(): void {
		// A disambiguated reader (`firehose.job-router.p0`) reports the REAL source
		// partition it tails (`firehose.p0`) via SOURCE — not its offset-dir name.
		$base = $this->arrange_base_dir();
		$this->seed_probe_record( $base, 'firehose.job-router', 0, [ 'source' => 'firehose.p0' ] );

		$interpreter      = new Workers_CI_Node();
		$interpreter->cli = $this->stub_cli();
		$result           = VerbHarness::fire( $interpreter, 'workers', 'dump_graph' );

		$consumers = \array_values( \array_filter(
			$result['consumers'],
			static fn ( $c ) => 'firehose.job-router.p0' === ( $c['reader'] ?? '' )
		) );
		$this->assertNotEmpty( $consumers );
		$this->assertSame( 'firehose.p0', $consumers[0]['source'] );
	}

	public function test_dump_metadata_each_reader_carries_its_own_cursor(): void {
		// Two readers tail the same source under distinct reader ids; each keeps its
		// OWN cursor in consumers[], keyed by reader.
		$base = $this->arrange_base_dir();
		$this->seed_probe_record( $base, 'firehose.job-router', 0, [ 'source' => 'firehose.p0', 'seg' => 5, 'off' => 100 ] );
		$this->seed_probe_record( $base, 'firehose', 0, [ 'source' => 'firehose.p0', 'seg' => 9, 'off' => 999 ] );

		$interpreter      = new Workers_CI_Node();
		$interpreter->cli = $this->stub_cli();
		$result           = VerbHarness::fire( $interpreter, 'workers', 'dump_graph' );

		$by_reader = [];
		foreach ( $result['consumers'] as $c ) {
			$by_reader[ $c['reader'] ] = $c;
		}
		$this->assertSame( 5, $by_reader['firehose.job-router.p0']['cursor_seg'] );
		$this->assertSame( 100, $by_reader['firehose.job-router.p0']['cursor_off'] );
		$this->assertSame( 9, $by_reader['firehose.p0']['cursor_seg'] );
	}

	public function test_dump_metadata_includes_logs_enumeration(): void {
		// `logs[]` is the resolver-driven concrete-dir scan: ONE flat entry per
		// concrete partition dir, NAMED by that dir (`firehose.p0`). Each entry
		// holds a single partition's segments. The 0..N-1 expansion enumerates
		// every partition dir whether or not it exists on disk.
		$base = $this->arrange_base_dir();
		$this->declare_partitions( $base, 'demo-workers', [ 'firehose', 'requests' ] );
		$this->seed_log_segment( $base, 'firehose', 0, 0, 128 );
		$this->seed_log_segment( $base, 'firehose', 0, 1, 256 );
		$this->seed_log_segment( $base, 'requests', 0, 0, 64 );

		$interpreter     = new Workers_CI_Node();
		$interpreter->cli   = $this->stub_cli();
		$result = VerbHarness::fire( $interpreter, 'workers', 'dump_graph' );

		$this->assertIsArray( $result['logs'] );
		$names = \array_column( $result['logs'], 'name' );
		// Concrete per-partition entry names — no `.log` logical name, no nesting.
		$this->assertContains( 'firehose.p0', $names );
		$this->assertContains( 'requests.p0', $names );

		$firehose = null;
		foreach ( $result['logs'] as $log ) {
			if ( 'firehose.p0' === $log['name'] ) {
				$firehose = $log;
				break;
			}
		}
		$this->assertNotNull( $firehose );
		// One partition's worth of data — the concrete dir IS one partition.
		$this->assertCount( 1, $firehose['partitions'] );
		$this->assertSame( 0, $firehose['partitions'][0]['partition'] );
		$this->assertCount( 2, $firehose['partitions'][0]['segments'] );
		$this->assertSame( 128 + 256, $firehose['partitions'][0]['total_size'] );

		\Newspack_Nodes\Topology_Registry::reset();
	}

	public function test_dump_metadata_includes_request_scope_producer_logs(): void {
		// The request-scope PRODUCER logs (firehose, jobintake — written by ELN's
		// Log_Manager / Job_Intake, declared in NO .tsl) get NO topology catalog
		// entry. They must still appear in the dump_graph `logs[]` so the React
		// `firehose.p<partition>` vertex resolves to a concrete match instead of
		// rendering the raw template. Sourced from the same
		// `registered_log_producers` filter the GC uses, × clamped config
		// num_partitions.
		$base = $this->arrange_base_dir();
		// Two partitions so the producer-dir expansion is observable per partition.
		$this->use_base_dir(
			$base,
			[
				'num_partitions' => 2,
				'num_segments'   => 8,
				'segment_size'   => 16 * 1024 * 1024,
			]
		);
		\add_filter(
			'newspack_nodes/registered_log_producers',
			static fn (): array => [ 'firehose', 'jobintake' ]
		);
		$this->seed_log_segment( $base, 'firehose',  0, 0, 128 );
		$this->seed_log_segment( $base, 'jobintake', 1, 0, 64 );

		$interpreter        = new Workers_CI_Node();
		$interpreter->cli   = $this->stub_cli();
		$result             = VerbHarness::fire( $interpreter, 'workers', 'dump_graph' );

		$by_name = [];
		foreach ( $result['logs'] as $log ) {
			$by_name[ $log['name'] ] = $log;
		}
		foreach ( [ 'firehose.p0', 'firehose.p1', 'jobintake.p0', 'jobintake.p1' ] as $name ) {
			$this->assertArrayHasKey( $name, $by_name, "missing producer catalog entry: {$name}" );
		}
		// The seeded segments surface on their concrete dirs.
		$this->assertCount( 1, $by_name['firehose.p0']['partitions'][0]['segments'] );
		$this->assertSame( 128, $by_name['firehose.p0']['partitions'][0]['total_size'] );
		$this->assertCount( 1, $by_name['jobintake.p1']['partitions'][0]['segments'] );
		$this->assertSame( 64, $by_name['jobintake.p1']['partitions'][0]['total_size'] );
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
			"make_node Partition completed:partition <config:logs_dir>/completed.p<partition> 1048576 <config:num_segments> <config:max_lifespan>\n"
			. "make_node Partition requests:partition <config:logs_dir>/requests.p<partition> <config:segment_size> <config:num_segments> <config:max_lifespan>\n"
		);
		\Newspack_Nodes\Topology_Registry::register_stock_dir( $stock );

		$this->seed_log_segment( $base, 'completed', 0, 0, 32 );
		$this->seed_log_segment( $base, 'requests',  0, 0, 64 );

		$interpreter     = new Workers_CI_Node();
		$interpreter->cli   = $this->stub_cli();
		$result = VerbHarness::fire( $interpreter, 'workers', 'dump_graph' );

		$by_name = [];
		foreach ( $result['logs'] as $log ) {
			$by_name[ $log['name'] ] = $log;
		}
		$this->assertArrayHasKey( 'completed.p0', $by_name );
		$this->assertArrayHasKey( 'requests.p0',  $by_name );
		$pollution_hint = 'If this fails in the full suite but passes in isolation '
			. '(--filter test_dump_metadata_logs_carry_per_partition_segment_size_overrides), '
			. 'a prior test almost certainly threw mid-run and left Core/Config static '
			. 'state polluted — fix the throwing test, not this assertion.';
		$this->assertSame( 1048576,           $by_name['completed.p0']['segment_size'], $pollution_hint );
		$this->assertSame( 16 * 1024 * 1024,  $by_name['requests.p0']['segment_size'],  $pollution_hint );

		\Newspack_Nodes\Topology_Registry::reset();
	}

	public function test_segment_size_override_respects_basename_word_boundary(): void {
		// An override basename that is a string-PREFIX of another concrete log
		// must not bleed onto it. `job` (override 2048) declared on a `job`
		// Partition + a sibling `jobs` Partition on the global default: `jobs.p0`
		// must keep the global default, not inherit `job`'s 2048.
		$base = $this->arrange_base_dir();

		$stock = "{$base}/topologies";
		\mkdir( $stock, 0755, true );
		\file_put_contents(
			"{$stock}/aggregator.tsl",
			"make_node Partition job:partition <config:logs_dir>/job.p<partition> 2048 <config:num_segments> <config:max_lifespan>\n"
			. "make_node Partition jobs:partition <config:logs_dir>/jobs.p<partition> <config:segment_size> <config:num_segments> <config:max_lifespan>\n"
		);
		\Newspack_Nodes\Topology_Registry::register_stock_dir( $stock );

		$this->seed_log_segment( $base, 'job',  0, 0, 32 );
		$this->seed_log_segment( $base, 'jobs', 0, 0, 64 );

		$interpreter        = new Workers_CI_Node();
		$interpreter->cli   = $this->stub_cli();
		$result             = VerbHarness::fire( $interpreter, 'workers', 'dump_graph' );

		$by_name = [];
		foreach ( $result['logs'] as $log ) {
			$by_name[ $log['name'] ] = $log;
		}
		$this->assertArrayHasKey( 'job.p0',  $by_name );
		$this->assertArrayHasKey( 'jobs.p0', $by_name );
		// `job.p0` keeps its literal override; `jobs.p0` must NOT inherit it.
		$this->assertSame( 2048,             $by_name['job.p0']['segment_size'] );
		$this->assertSame( 16 * 1024 * 1024, $by_name['jobs.p0']['segment_size'] );

		\Newspack_Nodes\Topology_Registry::reset();
	}

	public function test_dump_metadata_logs_honor_per_topology_num_partitions(): void {
		// A log's partition-slot count must come from ITS owning topology's
		// `var num_partitions`, NOT the global config default. `scored.log`
		// lives in a topology declaring 1 partition; even when the global
		// default is 2, the dashboard must show only P0 — no phantom P1 slot.
		$base = $this->arrange_base_dir();
		// Raise the GLOBAL default to 2 — this is what the buggy code padded to.
		$this->use_base_dir(
			$base,
			[
				'num_partitions' => 2,
				'num_segments'   => 8,
				'segment_size'   => 16 * 1024 * 1024,
			]
		);

		// `aggregator` is registered (catalog num_partitions=1) by arrange_base_dir().
		// Declare its `scored.log` Partition so resolved_resource_dirs() maps scored → aggregator.
		$stock = "{$base}/topologies";
		\mkdir( $stock, 0755, true );
		\file_put_contents(
			"{$stock}/aggregator.tsl",
			"var num_partitions = 1\n"
			. "make_node Partition scored:partition <config:logs_dir>/scored.p<partition> <config:segment_size> <config:num_segments> <config:max_lifespan>\n"
		);
		\Newspack_Nodes\Topology_Registry::register_stock_dir( $stock );

		$this->seed_log_segment( $base, 'scored', 0, 0, 64 );

		$interpreter        = new Workers_CI_Node();
		$interpreter->cli   = $this->stub_cli();
		$result             = VerbHarness::fire( $interpreter, 'workers', 'dump_graph' );

		$names = \array_column( $result['logs'], 'name' );
		// num_partitions=1 → the resolver yields exactly the P0 concrete dir,
		// `scored.p0`. No phantom `scored.p1` from the global default of 2.
		$this->assertContains( 'scored.p0', $names );
		$this->assertNotContains( 'scored.p1', $names );
		$by_name = [];
		foreach ( $result['logs'] as $log ) {
			$by_name[ $log['name'] ] = $log;
		}
		$this->assertCount( 1, $by_name['scored.p0']['partitions'] );
		$this->assertSame( 0, $by_name['scored.p0']['partitions'][0]['partition'] );

		\Newspack_Nodes\Topology_Registry::reset();
	}

	public function test_dump_graph_logs_include_log_file_sinks(): void {
		// A `make_node Log` file-sink (kind 'log') in an active topology gets a
		// `logs` catalog entry so the dashboard renders it as a LOG entity:
		// segments stat'd from the flat `{file}.{seg}` monotonic segments, with
		// the highest-suffix segment current/newest, and segment_size set from
		// the Log's segment_size positional arg.
		$base = $this->arrange_base_dir();

		// A literal-path Log sink: flat monotonic segments, NO bare current file.
		$digest_path = "{$base}/digest.md";
		\file_put_contents( "{$digest_path}.0", \str_repeat( 'c', 10 ) );  // oldest
		\file_put_contents( "{$digest_path}.1", \str_repeat( 'b', 20 ) );
		\file_put_contents( "{$digest_path}.2", \str_repeat( 'a', 30 ) );  // newest / current

		$stock = "{$base}/topologies";
		\mkdir( $stock, 0755, true );
		\file_put_contents(
			"{$stock}/aggregator.tsl",
			"make_node Log digest:log {$digest_path} 100 7\n"
		);
		\Newspack_Nodes\Topology_Registry::register_stock_dir( $stock );

		$interpreter        = new Workers_CI_Node();
		$interpreter->cli   = $this->stub_cli();
		$result             = VerbHarness::fire( $interpreter, 'workers', 'dump_graph' );

		$by_name = [];
		foreach ( $result['logs'] as $log ) {
			$by_name[ $log['name'] ] = $log;
		}
		$this->assertArrayHasKey( 'digest.md', $by_name );
		$entry = $by_name['digest.md'];
		$this->assertSame( 100, $entry['segment_size'] );
		$this->assertCount( 1, $entry['partitions'] );
		$segments = $entry['partitions'][0]['segments'];
		$this->assertCount( 3, $segments );
		$this->assertSame( 10 + 20 + 30, $entry['partitions'][0]['total_size'] );

		// Segment ids come from the numeric suffix; highest-suffix is newest.
		$by_id = [];
		foreach ( $segments as $seg ) {
			$by_id[ $seg['id'] ] = $seg['size'];
		}
		$this->assertSame( [ 0, 1, 2 ], \array_keys( $by_id ) );
		$this->assertSame( 10, $by_id[0] );
		$this->assertSame( 20, $by_id[1] );
		$this->assertSame( 30, $by_id[2] );
		$max_id = \max( \array_keys( $by_id ) );
		$this->assertSame( 30, $by_id[ $max_id ] );

		\Newspack_Nodes\Topology_Registry::reset();
	}

	public function test_dump_metadata_includes_supervisor_descriptor(): void {
		// The supervisor is a singleton — exactly one entry, always emitted,
		// at the un-suffixed lock dir `supervisor.lock.d`. No `partition`
		// field (it doesn't run as a partition fleet).
		$base = $this->arrange_base_dir();
		$interpreter     = new Workers_CI_Node();
		$interpreter->cli   = $this->stub_cli();
		$result = VerbHarness::fire( $interpreter, 'workers', 'dump_graph' );

		$this->assertIsArray( $result['supervisor'] );
		$this->assertSame( 'supervisor', $result['supervisor']['type'] );
		$this->assertArrayNotHasKey( 'partition', $result['supervisor'] );
		$this->assertArrayHasKey( 'status', $result['supervisor'] );
	}

	public function test_dump_metadata_logs_carry_segments_and_consumers_carry_cursor(): void {
		// Segment lists (the bar's raw data) come from logs[] — the live scandir.
		// The reader's cursor + distance come from consumers[] — the probe snapshot.
		// The topologies tab joins the two (trim live segments to the probe end).
		$base = $this->arrange_base_dir();
		$this->declare_partitions( $base, 'demo-workers', [ 'firehose' ] );
		$this->seed_log_segment( $base, 'firehose', 0, 0, 200 );
		$this->seed_probe_record(
			$base,
			'firehose',
			0,
			[ 'source' => 'firehose.p0', 'seg' => 0, 'off' => 50, 'distance' => 150, 'end_seg' => 0, 'end_size' => 200 ]
		);

		$interpreter      = new Workers_CI_Node();
		$interpreter->cli = $this->stub_cli();
		$result           = VerbHarness::fire( $interpreter, 'workers', 'dump_graph' );

		$logs = [];
		foreach ( $result['logs'] as $l ) {
			$logs[ $l['name'] ] = $l;
		}
		$this->assertArrayHasKey( 'firehose.p0', $logs );
		$segments = $logs['firehose.p0']['partitions'][0]['segments'];
		$this->assertCount( 1, $segments );
		$this->assertSame( 200, $segments[0]['size'] );

		$consumers = \array_values( \array_filter(
			$result['consumers'],
			static fn ( $c ) => 'firehose.p0' === ( $c['reader'] ?? '' )
		) );
		$this->assertNotEmpty( $consumers );
		$this->assertSame( 0, $consumers[0]['cursor_seg'] );
		$this->assertSame( 50, $consumers[0]['cursor_off'] );
		$this->assertSame( 150, $consumers[0]['distance'] );
		$this->assertSame( 0, $consumers[0]['end_seg'] );
		$this->assertSame( 200, $consumers[0]['end_size'] );
	}

	public function test_dump_metadata_emits_a_liveness_row_for_a_worker_with_no_consumers(): void {
		// A worker with no probe record yet still appears in workers[] (liveness),
		// and simply has no consumers[] row.
		$base = $this->arrange_base_dir();
		$this->seed_heartbeat( $base, 'request-workers', 0 );

		$interpreter      = new Workers_CI_Node();
		$interpreter->cli = $this->stub_cli();
		$result           = VerbHarness::fire( $interpreter, 'workers', 'dump_graph' );

		$rows = \array_values( \array_filter(
			$result['workers'],
			static fn ( $w ) => 'request-workers' === ( $w['type'] ?? '' )
		) );
		$this->assertNotEmpty( $rows, 'expected a liveness row for request-workers' );
		$this->assertTrue( $rows[0]['live'] );
		$this->assertSame( [], \array_values( \array_filter(
			$result['consumers'],
			static fn ( $c ) => \str_starts_with( $c['reader'] ?? '', 'request' )
		) ) );
	}

	public function test_dump_metadata_rejects_unauthorized(): void {
		// Legacy WorkersController gated through read_permissions_check ==
		// manage_options. dump_metadata enforces the same gate so the
		// REST -> interpreter swap is a no-op for callers.
		$this->arrange_base_dir();
		$GLOBALS['_wp_test_current_user_can'] = [];
		$interpreter     = new Workers_CI_Node();
		$interpreter->cli   = $this->stub_cli();
		$result = VerbHarness::fire( $interpreter, 'workers', 'dump_graph' );

		$this->assertIsString( $result );
		$this->assertStringContainsString( 'permission denied', $result );
	}

	/**
	 * Tachikoma uniform-construction parity: the substrate `make_node` no
	 * longer forwards positional ctor args (it filters to scalar-only and
	 * the simplified path calls `new $fqcn()` then `arguments()`). The
	 * programmatic dependency — Cli — must therefore reach the interpreter via
	 * public property assignment AFTER construction, not through the ctor.
	 *
	 * This pins that contract: a bare `new Workers_CI_Node()` succeeds, and
	 * `$interpreter->cli = ...` plus a verb dispatch threads the assigned dep
	 * into the handler exactly as the ctor used to.
	 */
	public function test_constructible_via_no_arg_ctor_and_public_property_assignment(): void {
		$fake_cli = new class {
			public function ls_workers(): array {
				return [ [ 'type' => 'demo-workers', 'partition' => 0, 'live' => true ] ];
			}
			public function restart_workers( array $workers, array $filter = [], int $partition = -1 ): int { return 0; }
		};

		$interpreter      = new Workers_CI_Node();
		$interpreter->cli = $fake_cli;

		$this->assertSame( $fake_cli, $interpreter->cli );

		// `list` is the Cli::ls_workers() liveness projection, threaded off $self->cli.
		$result = VerbHarness::fire( $interpreter, 'workers', 'list' );
		$this->assertSame( 'demo-workers', $result[0]['type'] );
		$this->assertTrue( $result[0]['live'] );
	}
}
