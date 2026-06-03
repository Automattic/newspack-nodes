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
		$this->tmp = '/tmp/raw-logs-ci-test-' . \uniqid();
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
	// list_logs verb — disk-discovered catalog.
	// -------------------------------------------------------------------------

	public function test_node_schema_declares_its_verbs(): void {
		$schema = Raw_Logs_CI_Node::node_schema();
		$names  = \array_map( static fn ( array $v ): string => $v['name'], $schema['commands'] );
		\sort( $names );
		$this->assertSame( [ 'list_logs', 'log_status' ], $names );
		$this->assertNotEmpty( $schema['description'] );
	}

	public function test_list_logs_verb_returns_sorted_disk_catalog(): void {
		// Three logs on disk; the verb returns a sorted catalog of
		// {key, label} pairs with `.log`-stripped keys and `.log`-suffixed
		// labels — the shape the React picker mounts on.
		\mkdir( $this->tmp . '/logs/firehose.log', 0755, true );
		\mkdir( $this->tmp . '/logs/jobs.log',     0755, true );
		\mkdir( $this->tmp . '/logs/requests.log', 0755, true );

		$result = VerbHarness::fire( new Raw_Logs_CI_Node(), 'raw-logs', 'list_logs' );

		$this->assertSame(
			[
				[ 'key' => 'firehose', 'label' => 'firehose.log' ],
				[ 'key' => 'jobs',     'label' => 'jobs.log' ],
				[ 'key' => 'requests', 'label' => 'requests.log' ],
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

	public function test_log_status_verb_returns_partition_summary(): void {
		\mkdir( $this->tmp . '/logs/firehose.log', 0755, true );

		$result = VerbHarness::fire(
			new Raw_Logs_CI_Node(),
			'raw-logs',
			'log_status',
			'firehose'
		);

		$this->assertIsArray( $result );
		$this->assertSame( 'firehose', $result['log_id'] );
		$this->assertSame( 'firehose.log', $result['log_file'] );
		$this->assertArrayHasKey( 'partitions', $result );
		$this->assertArrayHasKey( 'num_partitions', $result );
		$this->assertArrayHasKey( 'total_segments', $result );
		$this->assertArrayHasKey( 'total_size', $result );
		$this->assertSame( 1, $result['num_partitions'] );
	}

	public function test_log_status_verb_accepts_log_with_dot_log_suffix(): void {
		// Mirrors legacy FirehoseController::sanitize_log_param — strips
		// the suffix so dashboards passing either `firehose` or
		// `firehose.log` get the same answer.
		\mkdir( $this->tmp . '/logs/firehose.log', 0755, true );

		$result = VerbHarness::fire(
			new Raw_Logs_CI_Node(),
			'raw-logs',
			'log_status',
			'firehose.log'
		);

		$this->assertIsArray( $result );
		$this->assertSame( 'firehose', $result['log_id'] );
	}

	public function test_log_status_verb_falls_back_on_unknown_log(): void {
		// Bogus key falls through to PREFERRED_LOG_KEY = 'firehose' (or the
		// first discovered log if `firehose.log` isn't on disk).
		\mkdir( $this->tmp . '/logs/firehose.log', 0755, true );

		$result = VerbHarness::fire(
			new Raw_Logs_CI_Node(),
			'raw-logs',
			'log_status',
			'bogus-log-name'
		);

		$this->assertIsArray( $result );
		$this->assertSame( 'firehose', $result['log_id'] );
	}

	public function test_log_status_default_resolves_first_discovered_without_firehose(): void {
		// De-coupled default guard: logs present but no firehose.log, so a
		// no-arg log_status resolves to the first-discovered key (sorted:
		// `jobs`), proving the default isn't hardwired to firehose.
		\mkdir( $this->tmp . '/logs/jobs.log',     0755, true );
		\mkdir( $this->tmp . '/logs/requests.log', 0755, true );

		$result = VerbHarness::fire( new Raw_Logs_CI_Node(), 'raw-logs', 'log_status' );

		$this->assertIsArray( $result );
		$this->assertSame( 'jobs', $result['log_id'] );
	}

	public function test_log_status_verb_reflects_seeded_segments(): void {
		// Seed a 128-byte segment on disk so the verb reports non-zero size.
		$seg_dir = $this->tmp . '/logs/firehose.log/p0';
		\mkdir( $seg_dir, 0755, true );
		\file_put_contents( "{$seg_dir}/0.log", \str_repeat( 'x', 128 ) );

		$result = VerbHarness::fire(
			new Raw_Logs_CI_Node(),
			'raw-logs',
			'log_status',
			'firehose'
		);

		$this->assertSame( 128, $result['total_size'] );
		$this->assertSame( 1, $result['total_segments'] );
		$this->assertArrayHasKey( 0, $result['partitions'] );
		$this->assertSame( 128, $result['partitions'][0]['size'] );
		$this->assertSame( 1, $result['partitions'][0]['segment_count'] );
	}

	public function test_log_status_verb_rejects_unauthorized(): void {
		$GLOBALS['_wp_test_current_user_can'] = [];
		$result = VerbHarness::fire(
			new Raw_Logs_CI_Node(),
			'raw-logs',
			'log_status',
			'firehose'
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
		\mkdir( $this->tmp . '/logs/firehose.log', 0755, true );

		$seen = [];
		Raw_Logs_CI_Node::$on_probe = static function ( Partition_Node $probe ) use ( &$seen ): void {
			$seen[] = [
				'name'   => $probe->name(),
				'patron' => $probe->patron(),
				'sink'   => $probe->sink(),
			];
		};

		VerbHarness::fire( new Raw_Logs_CI_Node(), 'raw-logs', 'log_status', 'firehose' );

		$this->assertCount( 1, $seen, 'one probe per partition (num_partitions=1)' );
		$ci    = Core::node( Node_Names::COMMAND_INTERPRETER );
		$owner = Core::node( 'raw-logs' );
		$this->assertSame( 'raw-logs:status:p0', $seen[0]['name'] );
		$this->assertSame( $owner, $seen[0]['patron'], 'patron is the owning interpreter (plumbing-hidden)' );
		$this->assertSame( $ci, $seen[0]['sink'], 'sunk into the _command_interpreter' );
	}

	public function test_log_status_probe_partition_is_removed_after_use(): void {
		\mkdir( $this->tmp . '/logs/firehose.log', 0755, true );

		// Confirm the probe is registered in Core WHILE inspecting (alive), so
		// the post-handler null assertion proves removal, not "never created".
		$alive_during = null;
		Raw_Logs_CI_Node::$on_probe = static function ( Partition_Node $probe ) use ( &$alive_during ): void {
			$alive_during = Core::node( $probe->name() );
		};

		VerbHarness::fire( new Raw_Logs_CI_Node(), 'raw-logs', 'log_status', 'firehose' );

		$this->assertInstanceOf( Partition_Node::class, $alive_during, 'probe registered during inspection' );
		// Transient probe: registered while inspecting, unregistered before the
		// handler returns so re-invocation in a reused process can't collide.
		$this->assertNull( Core::node( 'raw-logs:status:p0' ) );
	}

	public function test_log_status_removes_every_probe_across_partitions(): void {
		// With >1 partition each probe is named p{N}; all must be removed so a
		// later inspection of the same log can re-create them collision-free.
		$this->use_base_dir( $this->tmp, [ 'num_partitions' => 3, 'max_lifespan' => 86400 ] );
		\mkdir( $this->tmp . '/logs/firehose.log', 0755, true );

		$names = [];
		Raw_Logs_CI_Node::$on_probe = static function ( Partition_Node $probe ) use ( &$names ): void {
			$names[] = $probe->name();
		};

		VerbHarness::fire( new Raw_Logs_CI_Node(), 'raw-logs', 'log_status', 'firehose' );

		$this->assertSame( [ 'raw-logs:status:p0', 'raw-logs:status:p1', 'raw-logs:status:p2' ], $names );
		foreach ( $names as $name ) {
			$this->assertNull( Core::node( $name ), "probe {$name} removed after use" );
		}
	}
}
