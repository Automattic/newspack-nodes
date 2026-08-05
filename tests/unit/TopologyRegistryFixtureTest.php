<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Topology_Analyzer;
use Newspack_Nodes\Topology_Registry;
use Newspack_Nodes\Tests\TestCase;

/**
 * Topology_Analyzer::expand() against the shared request-builder.tsl fixture —
 * the console's static parser must accept everything the runtime Shell does:
 * make/connect/command aliases, backslash continuations, and cd cwd-pathing.
 * The identical fixture drives the JS parseTsl test.
 */
#[CoversClass( Topology_Registry::class )]
class TopologyRegistryFixtureTest extends TestCase {

	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		Topology_Registry::reset();
		$this->tmp = $this->make_temp_dir( 'topology-fixture-' );
		Topology_Registry::register_stock_dir( $this->tmp );
		\copy(
			\dirname( __DIR__ ) . '/fixtures/request-builder.tsl',
			"{$this->tmp}/request-builder.tsl"
		);
	}

	protected function tearDown(): void {
		Topology_Registry::reset();
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	public function test_continuation_joins_a_multiline_make_node(): void {
		$out    = Topology_Analyzer::expand( [ 'request-builder' ] );
		$byName = [];
		foreach ( $out['nodes'] as $node ) {
			$byName[ $node['name'] ] = $node;
		}

		// Three backslash-continued args, not one with the rest dropped.
		$this->assertSame(
			[
				'<config:logs_dir>/firehose.p<partition>',
				'<config:offsets_dir>/firehose.<topology>.p<partition>',
				'<config:deadletter_dir>/firehose.<topology>.p<partition>',
			],
			$byName['firehose:consumer']['args']
		);
		// The six declared nodes all parsed.
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
			\array_keys( $byName )
		);
	}

	public function test_cd_block_bare_verbs_become_config_edges(): void {
		$edges = Topology_Analyzer::expand( [ 'request-builder' ] )['edges'];
		$targets = [];
		foreach ( $edges as $e ) {
			if ( 'fanout' === $e['from'] && ( $e['roles'] ?? [] ) === [ 'config' ] ) {
				$targets[ $e['config_slots'][0] ] = $e['to'];
			}
		}

		$this->assertSame(
			[
				'set_completed_target' => 'completed:tee',
				'set_errors_target'    => 'errors:partition',
				'set_inflight_target'  => 'gyroscope:partition',
			],
			$targets
		);
	}

	public function test_command_aliases_capture_verbs(): void {
		$out    = Topology_Analyzer::expand( [ 'request-builder' ] );
		$byName = [];
		foreach ( $out['nodes'] as $node ) {
			$byName[ $node['name'] ] = $node;
		}

		// `command` alias, :config form with an arg + a bare boolean.
		$this->assertSame(
			[
				[ 'verb' => 'with_index', 'args' => [ 'request-index' ] ],
				[ 'verb' => 'void_warranty', 'args' => [] ],
			],
			$byName['requests:partition']['verbs']
		);
		// `command` alias, bare (no :config) form.
		$this->assertSame(
			[ [ 'verb' => 'void_warranty', 'args' => [] ] ],
			$byName['errors:partition']['verbs']
		);
		// `command_node` alias.
		$this->assertSame(
			[ [ 'verb' => 'void_warranty', 'args' => [] ] ],
			$byName['completed:partition']['verbs']
		);
		// `cmd` canonical, non-target config verb.
		$this->assertSame(
			[ [ 'verb' => 'set_multi_writer', 'args' => [ 'true' ] ] ],
			$byName['fanout']['verbs']
		);
	}

	public function test_graph_for_sees_continuation_args_and_cd_edges(): void {
		$graph = Topology_Analyzer::graph_for( 'request-builder' );
		$args  = [];
		foreach ( $graph['nodes'] as $node ) {
			$args[ $node['name'] ] = $node['args'];
		}
		$edges = \array_map(
			static fn ( array $e ): string => $e[0] . '->' . $e[1],
			$graph['edges']
		);

		// dump_graph shares statements(), so the tree path gets it too.
		$this->assertCount( 3, $args['firehose:consumer'] );
		$this->assertContains( 'fanout->completed:tee', $edges );
		$this->assertContains( 'fanout->errors:partition', $edges );
	}

	public function test_connect_aliases_and_continuation_wire_edges(): void {
		$edges = \array_map(
			static fn ( array $e ): string => $e['from'] . '->' . $e['to'],
			Topology_Analyzer::expand( [ 'request-builder' ] )['edges']
		);

		$this->assertContains( 'firehose:consumer->fanout', $edges ); // connect alias
		$this->assertContains( 'fanout->requests:partition', $edges ); // connect + continuation
		$this->assertContains( 'completed:tee->completed:partition', $edges ); // connect_node
		$this->assertContains( 'completed:tee->gyroscope:partition', $edges );
	}
}
