<?php
/**
 * One derivation for `num_partitions`.
 *
 * Every reader — the fleet's spawn count, the canonical per-topology count, the
 * catalog synthesizer and the health probe — must answer with the same number
 * for the same topology, whatever spelling of the clamp it used to carry.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Config;
use Newspack_Nodes\Rest\Status_CI_Node;
use Newspack_Nodes\Spawn_Coordinator;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Topology_Registry;

#[CoversClass( Bootstrap::class )]
#[CoversClass( Topology_Registry::class )]
#[CoversClass( Status_CI_Node::class )]
class NumPartitionsDerivationTest extends TestCase {

	private string $stock;

	protected function setUp(): void {
		parent::setUp();
		$this->stock = $this->make_temp_dir( 'num-partitions-stock-' );
		Topology_Registry::reset();
		Topology_Registry::register_stock_dir( $this->stock );
		Config::reset();
	}

	protected function tearDown(): void {
		unset(
			$GLOBALS['_wp_options']['newspack_nodes_topologies'],
			$GLOBALS['_wp_options']['newspack_nodes_num_partitions']
		);
		Topology_Registry::reset();
		$this->rmdir_recursive( $this->stock );
		Config::reset();
		parent::tearDown();
	}

	/** Activate $name and set the global option, distinct from every default. */
	private function with_global( string $name, mixed $num_partitions ): void {
		$GLOBALS['_wp_options']['newspack_nodes_topologies']     = [ $name ];
		$GLOBALS['_wp_options']['newspack_nodes_num_partitions'] = $num_partitions;
		Config::reset();
	}

	/** How many workers the fleet would spawn for $type. */
	private function spawn_count( string $type ): int {
		return \count( \array_filter(
			Bootstrap::expand_workers(),
			static fn ( array $w ): bool => $type === $w['type']
		) );
	}

	/**
	 * A third-party catalog entry omitting num_partitions: the fleet spawned 1
	 * while every reader saw the global count.
	 */
	public function test_catalog_entry_without_num_partitions_agrees_across_readers(): void {
		\add_filter(
			'newspack_nodes/topologies',
			static fn ( array $t ): array => $t + [ 'marmot-fleet' => [ 'topology' => 'marmot-fleet' ] ]
		);
		$this->with_global( 'marmot-fleet', 5 );

		$this->assertSame( 5, Bootstrap::global_num_partitions(), 'the global accessor' );
		$this->assertSame( 5, $this->spawn_count( 'marmot-fleet' ), 'the fleet spawn count' );
		$this->assertSame( 5, Bootstrap::num_partitions_for( 'marmot-fleet' ), 'the canonical per-topology count' );
		$this->assertSame( 5, Status_CI_Node::cmd_get()['num_partitions'], 'the health probe' );
	}

	/** A TSL frontmatter count still wins over the global default. */
	public function test_frontmatter_count_wins_over_the_global_default(): void {
		\file_put_contents( "{$this->stock}/marmot-tsl.tsl", "var num_partitions = 3\n" );
		$this->with_global( 'marmot-tsl', 5 );

		$this->assertSame( 3, $this->spawn_count( 'marmot-tsl' ) );
		$this->assertSame( 3, Bootstrap::num_partitions_for( 'marmot-tsl' ) );
		$catalog = Topology_Registry::publish_catalog( [] );
		$this->assertSame( 3, $catalog['marmot-tsl']['num_partitions'] );
	}

	/** An option above MAX_PARTITIONS is clamped by every reader, probe included. */
	public function test_an_over_cap_option_is_clamped_everywhere(): void {
		\file_put_contents( "{$this->stock}/marmot-cap.tsl", "# no frontmatter\n" );
		$this->with_global( 'marmot-cap', 40 );

		$capped = Spawn_Coordinator::MAX_PARTITIONS;
		$this->assertSame( $capped, Bootstrap::global_num_partitions() );
		$this->assertSame( $capped, $this->spawn_count( 'marmot-cap' ) );
		$this->assertSame( $capped, Bootstrap::num_partitions_for( 'marmot-cap' ) );
		$this->assertSame( $capped, Status_CI_Node::cmd_get()['num_partitions'], 'the probe must not report a count the fleet never runs' );
	}

	/**
	 * A junk option is not a declaration: the validated numeric read takes the
	 * default rather than the lenient cast's leading digits.
	 */
	public function test_a_non_numeric_option_falls_back_rather_than_truncating(): void {
		\file_put_contents( "{$this->stock}/marmot-junk.tsl", "# no frontmatter\n" );
		$this->with_global( 'marmot-junk', '9abc' );

		$this->assertSame( 1, Bootstrap::global_num_partitions() );
		$this->assertSame( 1, $this->spawn_count( 'marmot-junk' ) );
		$this->assertSame( 1, Bootstrap::num_partitions_for( 'marmot-junk' ) );
		$catalog = Topology_Registry::publish_catalog( [] );
		$this->assertSame( 1, $catalog['marmot-junk']['num_partitions'], 'the catalog synthesizer must not read 9 out of "9abc"' );
		$this->assertSame( 1, Status_CI_Node::cmd_get()['num_partitions'] );
	}

	/** Frontmatter is parsed with the same validated read as the option. */
	public function test_junk_frontmatter_falls_back_to_the_global_default(): void {
		\file_put_contents( "{$this->stock}/marmot-front.tsl", "var num_partitions = 7oops\n" );
		$this->with_global( 'marmot-front', 5 );

		$this->assertSame( 5, $this->spawn_count( 'marmot-front' ), 'junk frontmatter is not a declaration of 7' );
		$this->assertSame( 5, Bootstrap::num_partitions_for( 'marmot-front' ) );
	}
}
