<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Config;
use Newspack_Nodes\Topology_Analyzer;
use Newspack_Nodes\Topology_Registry;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * Layout-agnostic concrete-dir resolver. `resolved_resource_dirs` expands each
 * `write_set` token over 0..N-1 (substituting `<partition>` AND `{partition}`),
 * resolves `<config:…>` tokens, and extracts the first-level dir name under
 * logs_dir / offsets_dir — wherever the partition token sits in the path. No
 * `.p{N}` regex.
 */
#[CoversClass( Topology_Registry::class )]
class TopologyRegistryResolvedDirsTest extends TestCase {

	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		Topology_Registry::reset();
		$this->tmp = $this->make_temp_dir( 'topology-resolved-dirs-' );
		// Pin base_directory so <config:logs_dir>/<config:offsets_dir> resolve
		// to $this->tmp/logs and $this->tmp/offsets.
		$this->use_base_dir( $this->tmp );
		Config::register_token_namespace();
		Topology_Registry::register_stock_dir( $this->tmp );
	}

	protected function tearDown(): void {
		Topology_Registry::reset();
		Config::reset();
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	private function write_tsl( string $name, string $contents ): void {
		\file_put_contents( "{$this->tmp}/{$name}.tsl", $contents );
		Topology_Registry::reset_basename_cache();
	}

	public function test_suffix_partition_token_yields_per_partition_log_dirs(): void {
		$this->write_tsl(
			'req',
			"make_node Partition req:p <config:logs_dir>/req.p<partition> 1 2 0\n"
		);

		$result = Topology_Analyzer::resolved_resource_dirs( 'req', 2 );
		\ksort( $result['logs'] );

		// Map is `concrete dir name => enumerated partition index`.
		$this->assertSame( [ 'req.p0' => 0, 'req.p1' => 1 ], $result['logs'] );
		$this->assertSame( [], $result['offsets'] );
	}

	public function test_prefix_partition_token_yields_per_partition_log_dirs(): void {
		$this->write_tsl(
			'req',
			"make_node Partition req:p <config:logs_dir>/<partition>-req 1 2 0\n"
		);

		$result = Topology_Analyzer::resolved_resource_dirs( 'req', 2 );
		\ksort( $result['logs'] );

		$this->assertSame( [ '0-req' => 0, '1-req' => 1 ], $result['logs'] );
	}

	public function test_nested_partition_token_yields_first_level_dir_only(): void {
		$this->write_tsl(
			'req',
			"make_node Partition req:p <config:logs_dir>/req/<partition> 1 2 0\n"
		);

		$result = Topology_Analyzer::resolved_resource_dirs( 'req', 2 );

		// Nested layout: every partition collapses to one first-level dir; the
		// FIRST seen partition (0) is kept — nested layouts aren't represented
		// per-partition here.
		$this->assertSame( [ 'req' => 0 ], $result['logs'] );
	}

	public function test_topic_curly_partition_token_expands(): void {
		$this->write_tsl(
			'fan',
			"make_node Topic t <config:logs_dir>/fan.p{partition} 2 group\n"
		);

		$result = Topology_Analyzer::resolved_resource_dirs( 'fan', 2 );
		\ksort( $result['logs'] );

		$this->assertSame( [ 'fan.p0' => 0, 'fan.p1' => 1 ], $result['logs'] );
	}

	public function test_consumer_offsetlog_lands_in_offsets_and_source_is_not_a_log(): void {
		$this->write_tsl(
			'digest',
			"make_node Consumer c <config:logs_dir>/req.p<partition> <config:offsets_dir>/cur.p<partition>\n"
		);

		$result = Topology_Analyzer::resolved_resource_dirs( 'digest', 2 );
		\ksort( $result['offsets'] );

		$this->assertSame( [ 'cur.p0' => 0, 'cur.p1' => 1 ], $result['offsets'] );
		// The Consumer's source (1st arg) is a READ, not a write — no logs entry.
		$this->assertSame( [], $result['logs'] );
	}

	public function test_a_topic_declares_its_OWN_partition_count_not_the_workers(): void {
		// aggregator-fdn runs ONE worker but its Topic re-partitions to four, so
		// firehose.p1..p3 were undeclared — invisible on the dashboard, and
		// orphans to Log_Cleaner::sweep(), which deletes undeclared dirs.
		$this->write_tsl(
			'agg',
			"make_node Topic firehose:topic <config:logs_dir>/firehose.p{partition} 4\n"
		);

		$result = Topology_Analyzer::resolved_resource_dirs( 'agg', 1 );
		\ksort( $result['logs'] );

		$this->assertSame(
			[ 'firehose.p0' => 0, 'firehose.p1' => 1, 'firehose.p2' => 2, 'firehose.p3' => 3 ],
			$result['logs']
		);
	}

	public function test_a_topic_count_may_be_a_config_token(): void {
		$this->write_tsl(
			'agg',
			"make_node Topic firehose:topic <config:logs_dir>/firehose.p{partition} <config:num_partitions>\n"
		);
		// Distinct from the caller's N below, so a fallback cannot fake a pass.
		$this->use_base_dir( $this->tmp, [ 'num_partitions' => 3 ] );
		Config::register_token_namespace();

		$result = Topology_Analyzer::resolved_resource_dirs( 'agg', 1 );
		\ksort( $result['logs'] );

		$this->assertSame(
			[ 'firehose.p0' => 0, 'firehose.p1' => 1, 'firehose.p2' => 2 ],
			$result['logs']
		);
	}

	public function test_a_topic_declaring_fewer_than_the_workers_declares_only_its_own(): void {
		// Declaring fewer is deliberate and frequent; max() would declare dirs
		// the Topic never writes.
		$this->write_tsl(
			'agg',
			"make_node Topic firehose:topic <config:logs_dir>/firehose.p{partition} 2\n"
		);

		$result = Topology_Analyzer::resolved_resource_dirs( 'agg', 4 );
		\ksort( $result['logs'] );

		$this->assertSame( [ 'firehose.p0' => 0, 'firehose.p1' => 1 ], $result['logs'] );
	}

	public function test_pinned_partitions_still_collapse_to_one_dir(): void {
		// alerts/errors/completed/gyroscope are plain Partitions on literal .p0
		// paths, pinned across all four workers. No token to expand, so N
		// iterations must still yield ONE dir stamped partition 0.
		// The countless Topic takes the schema default, so config carries the 4
		// here exactly as it does on the live hub.
		$this->use_base_dir( $this->tmp, [ 'num_partitions' => 4 ] );
		Config::register_token_namespace();
		$this->write_tsl(
			'combined',
			"make_node Partition alerts <config:logs_dir>/alerts.p0 65536\n"
				. "make_node Partition errors <config:logs_dir>/errors.p0 65536\n"
				. "make_node Topic requests <config:logs_dir>/requests.p<partition>\n"
		);

		$result = Topology_Analyzer::resolved_resource_dirs( 'combined', 4 );
		\ksort( $result['logs'] );

		$this->assertSame(
			[
				'alerts.p0'   => 0,
				'errors.p0'   => 0,
				'requests.p0' => 0,
				'requests.p1' => 1,
				'requests.p2' => 2,
				'requests.p3' => 3,
			],
			$result['logs']
		);
	}

	public function test_a_topic_whose_template_cannot_expand_says_so(): void {
		// A literal path with a count of 4 writes everything to one dir. Silent
		// today; the pinned-Partition case above must NOT trip this.
		$this->write_tsl(
			'agg',
			"make_node Topic firehose:topic <config:logs_dir>/firehose.p0 4\n"
		);

		$errors = [];
		\Newspack_Nodes\Core::set_stderr_handler(
			static function ( string $line ) use ( &$errors ): void {
				$errors[] = $line;
			}
		);
		$result = Topology_Analyzer::resolved_resource_dirs( 'agg', 1 );

		$this->assertSame( [ 'firehose.p0' => 0 ], $result['logs'] );
		$this->assertNotEmpty( $errors, 'a Topic that cannot expand must say so' );
		$this->assertStringContainsString( 'firehose.p0', $errors[0] );
	}

	public function test_an_omitted_topic_count_uses_the_schema_default_not_the_workers(): void {
		// Omitting the arg does NOT mean "use the worker count" — Topic's schema
		// defaults it to <config:num_partitions>. A topology pinning
		// `var num_partitions = 1` under a global 3 therefore creates three dirs
		// at runtime while declaring one, and the GC deletes the other two.
		$this->use_base_dir( $this->tmp, [ 'num_partitions' => 3 ] );
		Config::register_token_namespace();
		$this->write_tsl(
			'agg',
			"make_node Topic firehose:topic <config:logs_dir>/firehose.p{partition}\n"
		);

		$result = Topology_Analyzer::resolved_resource_dirs( 'agg', 1 );
		\ksort( $result['logs'] );

		$this->assertSame(
			[ 'firehose.p0' => 0, 'firehose.p1' => 1, 'firehose.p2' => 2 ],
			$result['logs']
		);
	}

	public function test_the_omitted_count_default_tracks_the_topic_schema(): void {
		// One source of truth: if Topic's schema default ever changes, the
		// registry's assumption must move with it.
		$args = \Newspack_Nodes\Topic_Node::node_schema()['arguments'];
		$num  = null;
		foreach ( $args as $arg ) {
			if ( 'num_partitions' === ( $arg['name'] ?? '' ) ) {
				$num = $arg['default'] ?? null;
			}
		}
		$this->assertSame( Topology_Analyzer::TOPIC_PARTITIONS_DEFAULT, $num );
	}

	public function test_a_nested_layout_does_not_report_a_failed_expansion(): void {
		// Nested layouts are supported and documented: several partitions collapse
		// to ONE first-level dir. Counting first-level names would call that a
		// failed expansion on every sweep.
		$this->write_tsl(
			'agg',
			"make_node Topic firehose:topic <config:logs_dir>/firehose/p{partition} 4\n"
		);

		$errors = [];
		\Newspack_Nodes\Core::set_stderr_handler(
			static function ( string $line ) use ( &$errors ): void {
				$errors[] = $line;
			}
		);
		$result = Topology_Analyzer::resolved_resource_dirs( 'agg', 1 );

		$this->assertSame( [ 'firehose' => 0 ], $result['logs'] );
		$this->assertSame( [], $errors, 'a nested layout expanded fine' );
	}

	public function test_a_declared_count_is_clamped_like_every_other_path(): void {
		// A typo'd count would otherwise loop that many times per sweep and
		// return that many declared dirs. Every sibling path clamps.
		$this->write_tsl(
			'agg',
			"make_node Topic firehose:topic <config:logs_dir>/firehose.p{partition} 9999\n"
		);

		$result = Topology_Analyzer::resolved_resource_dirs( 'agg', 1 );

		$this->assertCount(
			\Newspack_Nodes\Supervisor_Base::MAX_PARTITIONS,
			$result['logs']
		);
	}

	public function test_unknown_topology_returns_empty_buckets(): void {
		$result = Topology_Analyzer::resolved_resource_dirs( 'does-not-exist', 2 );

		$this->assertSame( [ 'logs' => [], 'offsets' => [] ], $result );
	}

	// ── resolved_node_dirs: one named node, full paths, indexed by partition ──

	private function logs_root(): string {
		return \Newspack_Nodes\Core::resolve_config_token( 'config', 'logs_dir' );
	}

	public function test_resolved_node_dirs_expands_one_named_node_over_the_worker_count(): void {
		$this->write_tsl(
			'req',
			"make_node Partition requests:partition <config:logs_dir>/requests.p<partition>\n"
				. "make_node Partition alerts:partition <config:logs_dir>/alerts.p0\n"
		);

		$dirs = Topology_Analyzer::resolved_node_dirs( 'req', 'requests:partition', 3 );

		$root = $this->logs_root();
		$this->assertSame(
			[ 0 => "{$root}/requests.p0", 1 => "{$root}/requests.p1", 2 => "{$root}/requests.p2" ],
			$dirs
		);
	}

	public function test_resolved_node_dirs_of_a_tokenless_path_is_one_dir_whatever_the_count(): void {
		// alerts is pinned to .p0 on purpose: N workers all append to it.
		$this->write_tsl(
			'req',
			"make_node Partition requests:partition <config:logs_dir>/requests.p<partition>\n"
				. "make_node Partition alerts:partition <config:logs_dir>/alerts.p0\n"
		);

		$dirs = Topology_Analyzer::resolved_node_dirs( 'req', 'alerts:partition', 3 );

		$this->assertSame( [ 0 => $this->logs_root() . '/alerts.p0' ], $dirs );
	}

	public function test_resolved_node_dirs_prefers_a_topics_own_declared_count(): void {
		$this->write_tsl(
			'agg',
			"make_node Topic firehose:topic <config:logs_dir>/firehose.p{partition} 4\n"
		);

		$dirs = Topology_Analyzer::resolved_node_dirs( 'agg', 'firehose:topic', 3 );

		$this->assertCount( 4, $dirs );
		$this->assertSame( $this->logs_root() . '/firehose.p3', $dirs[3] );
	}

	public function test_resolved_node_dirs_of_an_undeclared_node_is_empty(): void {
		$this->write_tsl( 'req', "make_node Partition requests:partition <config:logs_dir>/requests.p<partition>\n" );

		$this->assertSame( [], Topology_Analyzer::resolved_node_dirs( 'req', 'nope:partition', 3 ) );
	}

	public function test_declares_node_sees_nodes_that_write_nothing(): void {
		$this->write_tsl( 'fb', "make_node Flame_Builder flame-builder\n" );

		$this->assertTrue( Topology_Analyzer::declares_node( 'fb', 'flame-builder' ) );
		$this->assertFalse( Topology_Analyzer::declares_node( 'fb', 'request-builder' ) );
	}
}
