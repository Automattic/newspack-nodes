<?php
/**
 * Front-end golden pin: the observable Topology_Registry outputs that the swap
 * from the legacy normalize_lines() pipeline to Shell_Node::parse_statements()
 * must leave undisturbed, asserted directly against the SHIPPED bundled .tsl
 * (not synthetic fixtures). Covers the trailing-`;` `var` fix — the runtime
 * Shell splits on unquoted `;`, so `var num_partitions = 1;` frontmatter reads
 * identically with the semicolon now stripped at the front-end.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Config;
use Newspack_Nodes\Shell_Node;
use Newspack_Nodes\Topology_Registry;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Shell_Node::class )]
#[CoversClass( Topology_Registry::class )]
class TopologyFrontEndParityTest extends TestCase {

	protected function setUp(): void {
		parent::setUp();
		$plugin_dir = \dirname( __DIR__, 2 );
		Topology_Registry::reset();
		$this->use_base_dir( $this->make_temp_dir( 'front-end-parity-' ) );
		Config::register_token_namespace();
		Topology_Registry::register_stock_dir( $plugin_dir . '/topologies' );
		Topology_Registry::register_stock_dir( \dirname( __DIR__ ) . '/fixtures' );
	}

	protected function tearDown(): void {
		Topology_Registry::reset();
		Config::reset();
		parent::tearDown();
	}

	/** @return list<string> Absolute paths of every bundled + example + ELN-fixture .tsl. */
	private function tsl_files(): array {
		$plugin_dir = \dirname( __DIR__, 2 );
		$files      = [
			...\glob( $plugin_dir . '/topologies/*.tsl' ) ?: [],
			...\glob( $plugin_dir . '/examples/example-ai-newsletter/topologies/*.tsl' ) ?: [],
			...\glob( \dirname( __DIR__ ) . '/fixtures/*.tsl' ) ?: [],
		];
		\sort( $files );
		return $files;
	}

	/** parse_statements accepts every shipped + ELN-fixture .tsl and each record is well-formed. */
	public function test_front_end_parses_every_bundled_topology(): void {
		foreach ( $this->tsl_files() as $path ) {
			$base = \basename( $path );
			foreach ( Shell_Node::parse_statements( (string) \file_get_contents( $path ) ) as $statement ) {
				$this->assertSame( $statement['values'][0], $statement['verb'], "verb != values[0] in {$base}" );
				$this->assertSameSize( $statement['values'], $statement['spans'], "values/spans misaligned in {$base}" );
				$this->assertNotSame( '', $statement['raw'], "empty raw in {$base}" );
				$this->assertGreaterThan( 0, $statement['line'], "no source line in {$base}" );
			}
		}
	}

	/** The trailing-`;` fix leaves frontmatter reads unchanged (semicolon stripped either way). */
	public function test_trailing_semicolon_var_frontmatter_is_stable(): void {
		$this->assertSame( [ 'num_partitions' => '1' ], Topology_Registry::frontmatter( 'settings-sync' ) );
		$this->assertSame( [ 'stale_timeout' => '600' ], Topology_Registry::frontmatter( 'job-worker' ) );
	}

	/** Write-set golden for a bundled topology (Partition + Consumer offsetlog/deadletter). */
	public function test_write_set_golden_for_job_intake(): void {
		$this->assertSame(
			[
				'deadletter:<config:deadletter_dir>/job-intake.jobintake.p<partition>',
				'offsetlog:<config:offsets_dir>/job-intake.jobintake.p<partition>',
				'partition:<config:logs_dir>/jobs.p<partition>',
				'partition:<config:logs_dir>/topicprobe.p0',
			],
			Topology_Registry::write_set( 'job-intake' )
		);
	}

	/** graph_for golden on the stress fixture: node names + fan-out edges survive the swap. */
	public function test_graph_for_golden_on_stress_fixture(): void {
		$graph = Topology_Registry::graph_for( 'request-builder' );
		$names = \array_column( $graph['nodes'], 'name' );
		$edges = \array_map(
			static fn ( array $e ): string => $e[0] . '->' . $e[1],
			$graph['edges']
		);

		$this->assertSame(
			[
				'firehose:consumer',
				'fanout',
				'completed:tee',
				'requests:partition',
				'errors:partition',
				'gyroscope:partition',
				'completed:partition',
			],
			$names
		);
		$this->assertContains( 'firehose:consumer->fanout', $edges );
		$this->assertContains( 'fanout->requests:partition', $edges );
		$this->assertContains( 'completed:tee->completed:partition', $edges );
	}
}
