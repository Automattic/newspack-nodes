<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Config;
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

		$result = Topology_Registry::resolved_resource_dirs( 'req', 2 );
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

		$result = Topology_Registry::resolved_resource_dirs( 'req', 2 );
		\ksort( $result['logs'] );

		$this->assertSame( [ '0-req' => 0, '1-req' => 1 ], $result['logs'] );
	}

	public function test_nested_partition_token_yields_first_level_dir_only(): void {
		$this->write_tsl(
			'req',
			"make_node Partition req:p <config:logs_dir>/req/<partition> 1 2 0\n"
		);

		$result = Topology_Registry::resolved_resource_dirs( 'req', 2 );

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

		$result = Topology_Registry::resolved_resource_dirs( 'fan', 2 );
		\ksort( $result['logs'] );

		$this->assertSame( [ 'fan.p0' => 0, 'fan.p1' => 1 ], $result['logs'] );
	}

	public function test_consumer_offsetlog_lands_in_offsets_and_source_is_not_a_log(): void {
		$this->write_tsl(
			'digest',
			"make_node Consumer c <config:logs_dir>/req.p<partition> <config:offsets_dir>/cur.p<partition>\n"
		);

		$result = Topology_Registry::resolved_resource_dirs( 'digest', 2 );
		\ksort( $result['offsets'] );

		$this->assertSame( [ 'cur.p0' => 0, 'cur.p1' => 1 ], $result['offsets'] );
		// The Consumer's source (1st arg) is a READ, not a write — no logs entry.
		$this->assertSame( [], $result['logs'] );
	}

	public function test_unknown_topology_returns_empty_buckets(): void {
		$result = Topology_Registry::resolved_resource_dirs( 'does-not-exist', 2 );

		$this->assertSame( [ 'logs' => [], 'offsets' => [] ], $result );
	}
}
