<?php
/**
 * RawLogsCITest: unit tests for the substrate Raw_Logs_CI, which owns the
 * `list_logs` (catalog) + `log_status` (per-partition metadata)
 * verbs the Raw Logs admin dashboard subscribes to.
 *
 * Replaces the verbs' previous home on the application's Performance_CI;
 * patterns here mirror the legacy PerformanceCITest firehose_* tests.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
use Newspack_Nodes\Log_Discovery;
use Newspack_Nodes\Node_Names;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Rest\Raw_Logs_CI_Node;
use Newspack_Nodes\Tests\Helpers\VerbHarness;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Raw_Logs_CI_Node::class )]
class RawLogsCITest extends TestCase {

	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		$GLOBALS['_wp_options']               = [];
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => true ];
		$GLOBALS['_wp_actions']               = [];
		$this->tmp = (string) \realpath( \sys_get_temp_dir() ) . '/raw-logs-ci-test-' . \uniqid();
		\mkdir( $this->tmp, 0755, true );
		$this->use_base_dir( $this->tmp, [ 'num_partitions' => 1, 'max_lifespan' => 86400 ] );
		Log_Discovery::reset();
	}

	protected function tearDown(): void {
		Raw_Logs_CI_Node::$on_probe = null;
		VerbHarness::reset();
		Log_Discovery::reset();
		$GLOBALS['_wp_options']               = [];
		$GLOBALS['_wp_test_current_user_can'] = [];
		$GLOBALS['_wp_actions']               = [];
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	// -------------------------------------------------------------------------
	// schema + list_logs verb — disk-discovered catalog.
	// -------------------------------------------------------------------------

	public function test_node_schema_declares_its_verbs(): void {
		$schema = Raw_Logs_CI_Node::node_schema();
		$names  = \array_map( static fn ( array $v ): string => $v['name'], $schema['commands'] );
		\sort( $names );
		$this->assertSame( [ 'list_logs', 'log_status' ], $names );
		$this->assertNotEmpty( $schema['description'] );
	}

	public function test_list_logs_verb_returns_sorted_disk_catalog(): void {
		// Three concrete partition dirs on disk; the verb returns a sorted
		// catalog of {key, label} pairs where both are the concrete dir name
		// verbatim (flat partition-in-name layout) — the shape the React picker
		// mounts on.
		\mkdir( $this->tmp . '/logs/firehose.p0', 0755, true );
		\mkdir( $this->tmp . '/logs/jobs.p0',     0755, true );
		\mkdir( $this->tmp . '/logs/requests.p0', 0755, true );

		$result = VerbHarness::fire( new Raw_Logs_CI_Node(), 'raw-logs', 'list_logs' );

		$this->assertSame(
			[
				[ 'key' => 'firehose.p0', 'label' => 'firehose.p0' ],
				[ 'key' => 'jobs.p0',     'label' => 'jobs.p0' ],
				[ 'key' => 'requests.p0', 'label' => 'requests.p0' ],
			],
			$result
		);
	}

	public function test_list_logs_verb_returns_empty_when_no_logs_dir(): void {
		// No logs/ dir means no glob matches — the picker shows an empty
		// list and the dashboard renders a "no logs" affordance.
		$result = VerbHarness::fire( new Raw_Logs_CI_Node(), 'raw-logs', 'list_logs' );
		$this->assertSame( [], $result );
	}

	public function test_list_logs_verb_rejects_unauthorized(): void {
		$GLOBALS['_wp_test_current_user_can'] = [];
		$result = VerbHarness::fire( new Raw_Logs_CI_Node(), 'raw-logs', 'list_logs' );
		$this->assertIsString( $result );
		$this->assertStringContainsString( 'permission denied', $result );
	}

	// -------------------------------------------------------------------------
	// log_status verb — per-partition segment metadata.
	// -------------------------------------------------------------------------

	public function test_log_status_verb_returns_single_dir_summary(): void {
		// `log` is now a CONCRETE partition dir name; the verb stats THAT one
		// dir's segments (no num_partitions loop, no nested `/p{N}`).
		\mkdir( $this->tmp . '/logs/firehose.p0', 0755, true );

		$result = VerbHarness::fire(
			new Raw_Logs_CI_Node(),
			'raw-logs',
			'log_status',
			'firehose.p0'
		);

		$this->assertIsArray( $result );
		$this->assertSame( 'firehose.p0', $result['log_id'] );
		$this->assertArrayHasKey( 'segments', $result );
		$this->assertArrayHasKey( 'segment_count', $result );
		$this->assertArrayHasKey( 'total_size', $result );
	}

	public function test_log_status_verb_falls_back_on_unknown_log(): void {
		// Bogus key falls through to the firehose-ish concrete key when present
		// (str_starts_with 'firehose'), else the first discovered concrete dir.
		\mkdir( $this->tmp . '/logs/firehose.p0', 0755, true );

		$result = VerbHarness::fire(
			new Raw_Logs_CI_Node(),
			'raw-logs',
			'log_status',
			'bogus-log-name'
		);

		$this->assertIsArray( $result );
		$this->assertSame( 'firehose.p0', $result['log_id'] );
	}

	public function test_log_status_default_resolves_first_discovered_without_firehose(): void {
		// De-coupled default guard: concrete dirs present but none firehose-ish,
		// so a no-arg log_status resolves to the first-discovered key (sorted:
		// `jobs.p0`), proving the default isn't hardwired to firehose.
		\mkdir( $this->tmp . '/logs/jobs.p0',     0755, true );
		\mkdir( $this->tmp . '/logs/requests.p0', 0755, true );

		$result = VerbHarness::fire( new Raw_Logs_CI_Node(), 'raw-logs', 'log_status' );

		$this->assertIsArray( $result );
		$this->assertSame( 'jobs.p0', $result['log_id'] );
	}

	public function test_list_logs_includes_offsets_and_deadletter_keys(): void {
		\mkdir( $this->tmp . '/logs/firehose.p0', 0755, true );
		\mkdir( $this->tmp . '/offsets/combined.firehose.p0', 0755, true );
		\mkdir( $this->tmp . '/deadletter/job-worker.jobs.p0', 0755, true );

		$result = VerbHarness::fire( new Raw_Logs_CI_Node(), 'raw-logs', 'list_logs' );

		$this->assertSame(
			[
				[
					'key'   => 'firehose.p0',
					'label' => 'firehose.p0',
				],
				[
					'key'   => 'offsets/combined.firehose.p0',
					'label' => 'offsets/combined.firehose.p0',
				],
				[
					'key'   => 'deadletter/job-worker.jobs.p0',
					'label' => 'deadletter/job-worker.jobs.p0',
				],
			],
			$result
		);
	}

	public function test_log_status_reads_a_deadletter_dir_by_grouped_key(): void {
		$seg_dir = $this->tmp . '/deadletter/job-worker.jobs.p0';
		\mkdir( $seg_dir, 0755, true );
		\file_put_contents( "{$seg_dir}/7.log", \str_repeat( 'q', 977 ) );

		$result = VerbHarness::fire(
			new Raw_Logs_CI_Node(),
			'raw-logs',
			'log_status',
			'deadletter/job-worker.jobs.p0'
		);

		$this->assertSame( 'deadletter/job-worker.jobs.p0', $result['log_id'] );
		$this->assertSame( 977, $result['total_size'] );
		$this->assertSame( [ 7 ], \array_column( $result['segments'], 'id' ) );
	}

	public function test_log_status_verb_reflects_seeded_segments(): void {
		// Seed a 128-byte segment in the flat concrete dir so the verb reports
		// non-zero size for that single dir.
		$seg_dir = $this->tmp . '/logs/firehose.p0';
		\mkdir( $seg_dir, 0755, true );
		\file_put_contents( "{$seg_dir}/0.log", \str_repeat( 'x', 128 ) );

		$result = VerbHarness::fire(
			new Raw_Logs_CI_Node(),
			'raw-logs',
			'log_status',
			'firehose.p0'
		);

		$this->assertSame( 128, $result['total_size'] );
		$this->assertSame( 1, $result['segment_count'] );
		$this->assertCount( 1, $result['segments'] );
		$this->assertSame( 128, $result['segments'][0]['size'] );
	}

	public function test_log_status_verb_rejects_unauthorized(): void {
		$GLOBALS['_wp_test_current_user_can'] = [];
		$result = VerbHarness::fire(
			new Raw_Logs_CI_Node(),
			'raw-logs',
			'log_status',
			'firehose.p0'
		);

		$this->assertIsString( $result );
		$this->assertStringContainsString( 'permission denied', $result );
	}

	// -------------------------------------------------------------------------
	// Sibling-node discipline (Rule 2): the per-partition inspection Partition
	// is plumbing — it must be named, patron-set to the owning interpreter, and
	// sunk into the `_command_interpreter` while it's alive.
	// -------------------------------------------------------------------------

	public function test_log_status_probe_partition_is_named_patron_set_and_sunk(): void {
		\mkdir( $this->tmp . '/logs/firehose.p0', 0755, true );

		$seen = [];
		Raw_Logs_CI_Node::$on_probe = static function ( Partition_Node $probe ) use ( &$seen ): void {
			$seen[] = [
				'name'   => $probe->name(),
				'patron' => $probe->patron(),
				'sink'   => $probe->sink(),
			];
		};

		VerbHarness::fire( new Raw_Logs_CI_Node(), 'raw-logs', 'log_status', 'firehose.p0' );

		$this->assertCount( 1, $seen, 'one probe for the single concrete dir' );
		$ci    = Core::node( Node_Names::COMMAND_INTERPRETER );
		$owner = Core::node( 'raw-logs' );
		$this->assertSame( 'raw-logs:status', $seen[0]['name'] );
		$this->assertSame( $owner, $seen[0]['patron'], 'patron is the owning interpreter (plumbing-hidden)' );
		$this->assertSame( $ci, $seen[0]['sink'], 'sunk into the _command_interpreter' );
	}

	public function test_log_status_probe_partition_is_removed_after_use(): void {
		\mkdir( $this->tmp . '/logs/firehose.p0', 0755, true );

		// Confirm the probe is registered in Core WHILE inspecting (alive), so
		// the post-handler null assertion proves removal, not "never created".
		$alive_during = null;
		Raw_Logs_CI_Node::$on_probe = static function ( Partition_Node $probe ) use ( &$alive_during ): void {
			$alive_during = Core::node( $probe->name() );
		};

		VerbHarness::fire( new Raw_Logs_CI_Node(), 'raw-logs', 'log_status', 'firehose.p0' );

		$this->assertInstanceOf( Partition_Node::class, $alive_during, 'probe registered during inspection' );
		// Transient probe: registered while inspecting, unregistered before the
		// handler returns so re-invocation in a reused process can't collide.
		$this->assertNull( Core::node( 'raw-logs:status' ) );
	}
}
