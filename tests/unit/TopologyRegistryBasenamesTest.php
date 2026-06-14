<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Config;
use Newspack_Nodes\Topology_Registry;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * Per-topology basename extraction: scans the TSL for
 * `make_node Partition <name>:partition <config:logs_dir>/<basename>.p<partition> ...`
 * declarations and returns the basename list. Replaces
 * `NEWSPACK_EVENT_LOGGER_NODES_TOPOLOGY_BASENAMES` in the application
 * plugin — the TSL is the single source of truth.
 */
#[CoversClass( Topology_Registry::class )]
class TopologyRegistryBasenamesTest extends TestCase {

	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		Topology_Registry::reset();
		$this->tmp = $this->make_temp_dir( 'topology-basenames-' );
		Topology_Registry::register_stock_dir( $this->tmp );
	}

	protected function tearDown(): void {
		Topology_Registry::reset();
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	private function write_tsl( string $name, string $contents ): void {
		\file_put_contents( "{$this->tmp}/{$name}.tsl", $contents );
	}

	public function test_extracts_basenames_from_partition_declarations(): void {
		$this->write_tsl(
			'firehose-workers',
			<<<TSL
make_node Partition firehose:partition <config:logs_dir>/firehose.p<partition> <config:segment_size> <config:num_segments> <config:max_lifespan>
make_node Partition errors:partition <config:logs_dir>/errors.p<partition> <config:segment_size> <config:num_segments> <config:max_lifespan>
make_node Partition requests:partition <config:logs_dir>/requests.p<partition> <config:segment_size> <config:num_segments> <config:max_lifespan>
TSL
		);

		$this->assertSame(
			[ 'errors', 'firehose', 'requests' ],
			Topology_Registry::basenames_for( 'firehose-workers' )
		);
	}

	public function test_returns_empty_for_topology_with_no_partitions(): void {
		// Topologies that don't own any storage (e.g. an aggregator-only
		// topology that just wires remote pulls into local sinks) have no
		// `make_node Partition` lines. Returns empty, not error.
		$this->write_tsl(
			'aggregator',
			"# no Partition declarations\nmake_node Tee firehose:tee\n"
		);

		$this->assertSame( [], Topology_Registry::basenames_for( 'aggregator' ) );
	}

	public function test_returns_empty_for_unknown_topology(): void {
		$this->assertSame( [], Topology_Registry::basenames_for( 'does-not-exist' ) );
	}

	public function test_ignores_non_partition_make_node_lines(): void {
		// Only `Partition` nodes write to logs. Other node types must not
		// inflate the basename set.
		$this->write_tsl(
			'mixed',
			<<<TSL
make_node Partition real:partition <config:logs_dir>/real.p<partition> <config:segment_size> <config:num_segments> <config:max_lifespan>
make_node Tee fake:tee <config:logs_dir>/fake.log <partition>
make_node Tail other:tail <config:logs_dir>/other.log <partition>
TSL
		);

		$this->assertSame( [ 'real' ], Topology_Registry::basenames_for( 'mixed' ) );
	}

	public function test_skips_commented_partition_lines(): void {
		$this->write_tsl(
			'commented',
			<<<TSL
# make_node Partition disabled:partition <config:logs_dir>/disabled.p<partition>
make_node Partition active:partition <config:logs_dir>/active.p<partition> <config:segment_size> <config:num_segments> <config:max_lifespan>
TSL
		);

		$this->assertSame( [ 'active' ], Topology_Registry::basenames_for( 'commented' ) );
	}

	public function test_deduplicates_repeated_basenames(): void {
		// A single basename declared on two partition lines (legal — multiple
		// partitions of the same log) yields ONE entry.
		$this->write_tsl(
			'doubled',
			<<<TSL
make_node Partition a:partition <config:logs_dir>/shared.p<partition> <config:segment_size> <config:num_segments> <config:max_lifespan>
make_node Partition b:partition <config:logs_dir>/shared.p<partition> <config:segment_size> <config:num_segments> <config:max_lifespan>
TSL
		);

		$this->assertSame( [ 'shared' ], Topology_Registry::basenames_for( 'doubled' ) );
	}

	public function test_results_are_sorted_alphabetically(): void {
		$this->write_tsl(
			'order',
			<<<TSL
make_node Partition zeta:partition <config:logs_dir>/zeta.p<partition> <config:segment_size> <config:num_segments> <config:max_lifespan>
make_node Partition alpha:partition <config:logs_dir>/alpha.p<partition> <config:segment_size> <config:num_segments> <config:max_lifespan>
make_node Partition middle:partition <config:logs_dir>/middle.p<partition> <config:segment_size> <config:num_segments> <config:max_lifespan>
TSL
		);

		$this->assertSame(
			[ 'alpha', 'middle', 'zeta' ],
			Topology_Registry::basenames_for( 'order' )
		);
	}

	public function test_memoizes_per_topology(): void {
		$this->write_tsl(
			'memo',
			"make_node Partition foo:partition <config:logs_dir>/foo.p<partition>\n"
		);
		$first = Topology_Registry::basenames_for( 'memo' );

		// Rewrite the TSL after first call. Without memoization the second
		// call picks up the new content; with memoization, the cached result wins.
		$this->write_tsl(
			'memo',
			"make_node Partition bar:partition <config:logs_dir>/bar.p<partition>\n"
		);

		$this->assertSame( $first, Topology_Registry::basenames_for( 'memo' ) );
		$this->assertSame( [ 'foo' ], $first );
	}

	public function test_config_reset_action_clears_basename_cache_but_preserves_stock_dirs(): void {
		// Workers surviving a `Config::reset()` need their basename cache
		// invalidated so newly-edited TSLs are re-read. Unlike `reset()`
		// (which tears down stock_dirs + user_dir for test isolation), the
		// RESET_ACTION wiring must NOT clear those — production workers
		// would lose the topology lookup entirely. Pin both halves.
		$this->write_tsl(
			'wired',
			"make_node Partition v1:partition <config:logs_dir>/v1.p<partition>\n"
		);
		// Re-register the boot-time wiring; other tests in the suite wipe
		// `$GLOBALS['_wp_actions']` to isolate, dropping the registration
		// `newspack-nodes.php` adds at plugin load.
		\add_action(
			Config::RESET_ACTION,
			[ Topology_Registry::class, 'reset_basename_cache' ]
		);

		$this->assertSame( [ 'v1' ], Topology_Registry::basenames_for( 'wired' ) );

		// Edit the TSL behind the cache's back.
		\file_put_contents(
			"{$this->tmp}/wired.tsl",
			"make_node Partition v2:partition <config:logs_dir>/v2.p<partition>\n"
		);
		\do_action( Config::RESET_ACTION );

		// Cache invalidated → fresh parse.
		$this->assertSame( [ 'v2' ], Topology_Registry::basenames_for( 'wired' ) );
		// stock_dirs survived — `wired` still resolves.
		$this->assertNotNull( Topology_Registry::resolve( 'wired' ) );
	}

	// =========================================================================
	// segment_size_overrides_for — per-log segment_size from TSL
	// =========================================================================
	//
	// Some topologies hardcode a smaller segment_size on specific Partitions
	// (e.g. completed.log + gyroscope.log on the firehose-workers topology use
	// 1 MiB instead of the global config:segment_size). Workers dashboard wants
	// to render the right rotation budget per log, so the TSL is the source of
	// truth — Topology_Registry exposes the literal-int overrides; tokens like
	// `<config:segment_size>` flow through as "no override" so the consumer
	// keeps using the global default.

	public function test_segment_size_overrides_returns_literal_int_when_partition_hardcodes(): void {
		$this->write_tsl(
			'firehose-workers',
			<<<TSL
make_node Partition firehose:partition <config:logs_dir>/firehose.p<partition> <config:segment_size> <config:num_segments> <config:max_lifespan>
make_node Partition completed:partition <config:logs_dir>/completed.p<partition> 1048576 <config:num_segments> <config:max_lifespan>
make_node Partition gyroscope:partition <config:logs_dir>/gyroscope.p<partition> 1048576 <config:num_segments> <config:max_lifespan>
TSL
		);

		$this->assertSame(
			[
				'completed' => 1048576,
				'gyroscope' => 1048576,
			],
			Topology_Registry::segment_size_overrides_for( 'firehose-workers' )
		);
	}

	public function test_segment_size_overrides_returns_empty_for_topology_with_no_overrides(): void {
		// All Partitions use `<config:segment_size>` — caller falls back to
		// the global config default for every log.
		$this->write_tsl(
			'plain',
			<<<TSL
make_node Partition foo:partition <config:logs_dir>/foo.p<partition> <config:segment_size> <config:num_segments> <config:max_lifespan>
make_node Partition bar:partition <config:logs_dir>/bar.p<partition> <config:segment_size> <config:num_segments> <config:max_lifespan>
TSL
		);

		$this->assertSame( [], Topology_Registry::segment_size_overrides_for( 'plain' ) );
	}

	public function test_segment_size_overrides_returns_empty_for_unknown_topology(): void {
		$this->assertSame(
			[],
			Topology_Registry::segment_size_overrides_for( 'does-not-exist' )
		);
	}

	public function test_segment_size_overrides_skips_commented_lines(): void {
		$this->write_tsl(
			'commented',
			<<<TSL
# make_node Partition disabled:partition <config:logs_dir>/disabled.p<partition> 999 <config:num_segments> <config:max_lifespan>
make_node Partition active:partition <config:logs_dir>/active.p<partition> 2048 <config:num_segments> <config:max_lifespan>
TSL
		);

		$this->assertSame(
			[ 'active' => 2048 ],
			Topology_Registry::segment_size_overrides_for( 'commented' )
		);
	}

	public function test_segment_size_overrides_ignores_non_partition_lines(): void {
		// Tee / Tail / make_node-of-other-classes can reference paths too.
		// Only Partition declarations should contribute.
		$this->write_tsl(
			'mixed',
			<<<TSL
make_node Partition real:partition <config:logs_dir>/real.p<partition> 4096 <config:num_segments> <config:max_lifespan>
make_node Tee fake:tee <config:logs_dir>/fake.log <partition>
make_node Tail other:tail <config:logs_dir>/other.log <partition>
TSL
		);

		$this->assertSame(
			[ 'real' => 4096 ],
			Topology_Registry::segment_size_overrides_for( 'mixed' )
		);
	}

	public function test_offset_basenames_for_resolves_partition_token(): void {
		$this->write_tsl(
			'digest',
			"make_node Consumer scored:consumer <config:logs_dir>/scored.p<partition> <config:offsets_dir>/scored.p<partition>\n"
			. "make_node Consumer summ:consumer <config:logs_dir>/summarized.p<partition> <config:offsets_dir>/digest.summary.p<partition>\n"
		);

		$result = Topology_Registry::offset_basenames_for( 'digest', 2 );
		\sort( $result );
		$this->assertSame( [ 'digest.summary.p2', 'scored.p2' ], $result );
	}

	public function test_reset_clears_basename_cache(): void {
		$this->write_tsl(
			'cleared',
			"make_node Partition v1:partition <config:logs_dir>/v1.p<partition>\n"
		);
		$this->assertSame( [ 'v1' ], Topology_Registry::basenames_for( 'cleared' ) );

		\file_put_contents(
			"{$this->tmp}/cleared.tsl",
			"make_node Partition v2:partition <config:logs_dir>/v2.p<partition>\n"
		);
		Topology_Registry::reset();
		Topology_Registry::register_stock_dir( $this->tmp );

		$this->assertSame( [ 'v2' ], Topology_Registry::basenames_for( 'cleared' ) );
	}
}
