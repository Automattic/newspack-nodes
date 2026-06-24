<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Topology_Registry;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * Raw structural graph extraction: node kind is derived from the make_node
 * CLASS token (never a node-name suffix), the log a node reads/writes from its
 * path ARG, and edges from `connect_node` plus `cmd <node>:config set_*_target`.
 */
#[CoversClass( Topology_Registry::class )]
class TopologyRegistryGraphTest extends TestCase {

	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		Topology_Registry::reset();
		$this->tmp = $this->make_temp_dir( 'topology-graph-' );
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

	public function test_graph_for_kinds_from_class_logs_from_args_edges_from_connect_and_targets(): void {
		$this->write_tsl(
			'combined',
			"make_node Consumer firehose:consumer <config:logs_dir>/firehose.log <partition> <config:offsets_dir>/firehose.p<partition>\n"
			. "make_node Request_Builder request-builder\n"
			. "make_node Partition requests:partition <config:logs_dir>/requests.log <partition> 1 2 0\n"
			. "make_node Partition errors:partition <config:logs_dir>/errors.log <partition> 1 2 0\n"
			. "make_node Tee completed:tee\n"
			. "cmd request-builder:config set_errors_target errors:partition\n"
			. "connect_node firehose:consumer request-builder\n"
			. "connect_node request-builder requests:partition\n"
		);
		$g = \Newspack_Nodes\Topology_Registry::graph_for( 'combined' );

		$byName = [];
		foreach ( $g['nodes'] as $n ) {
			$byName[ $n['name'] ] = $n;
		}
		$this->assertSame( 'consumer', $byName['firehose:consumer']['kind'] );
		$this->assertSame( 'logic', $byName['request-builder']['kind'] );
		$this->assertSame( 'partition', $byName['requests:partition']['kind'] );
		$this->assertSame( 'tee', $byName['completed:tee']['kind'] );
		$this->assertSame( 'firehose.log', $byName['firehose:consumer']['reads'] );
		$this->assertSame( 'requests.log', $byName['requests:partition']['writes'] );
		$this->assertContains( [ 'firehose:consumer', 'request-builder' ], $g['edges'] );
		$this->assertContains( [ 'request-builder', 'requests:partition' ], $g['edges'] );
		$this->assertContains( [ 'request-builder', 'errors:partition' ], $g['edges'] );
	}

	public function test_graph_for_consumer_carries_reader_from_offsetlog_arg(): void {
		// `make_node Consumer <node> <source> <offsetlog>` — the offsetlog basename
		// is the consumer's READER id, the unique key that disambiguates two
		// topologies reading the SAME source (e.g. request-builder + job-router both
		// tail firehose.p<N> but write distinct offsetlogs).
		$this->write_tsl(
			'rb',
			"make_node Consumer firehose:consumer <config:logs_dir>/firehose.p<partition> <config:offsets_dir>/firehose.request-builder.p<partition>\n"
		);
		$g      = \Newspack_Nodes\Topology_Registry::graph_for( 'rb' );
		$byName = [];
		foreach ( $g['nodes'] as $n ) {
			$byName[ $n['name'] ] = $n;
		}
		$this->assertSame( 'firehose.p<partition>', $byName['firehose:consumer']['reads'] );
		$this->assertSame( 'firehose.request-builder.p<partition>', $byName['firehose:consumer']['reader'] );
	}

	public function test_graph_for_kind_ignores_name_suffix(): void {
		// A Partition whose NAME has no :partition suffix — kind must still be 'partition' (from the class).
		$this->write_tsl( 'x', "make_node Partition plainname <config:logs_dir>/out.log <partition> 1 2 0\n" );
		$g = \Newspack_Nodes\Topology_Registry::graph_for( 'x' );
		$this->assertSame( 'partition', $g['nodes'][0]['kind'] );
		$this->assertSame( 'out.log', $g['nodes'][0]['writes'] );
	}

	public function test_graph_for_log_sink_emits_kind_writes_path_segment_size_and_num_segments(): void {
		// A Log file-sink: make_node Log <name> <file> [segment_size] [num_segments].
		// kind 'log'; writes = basename; path/segment_size/num_segments carried so
		// dump_graph can stat the flat `{file}.{seg}` segments.
		$this->write_tsl( 'l', "make_node Log lg /tmp/x.md 100 3\n" );
		$g = \Newspack_Nodes\Topology_Registry::graph_for( 'l' );
		$node = $g['nodes'][0];
		$this->assertSame( 'lg', $node['name'] );
		$this->assertSame( 'log', $node['kind'] );
		$this->assertSame( 'x.md', $node['writes'] );
		$this->assertSame( '/tmp/x.md', $node['path'] );
		$this->assertSame( 100, $node['segment_size'] );
		$this->assertSame( 3, $node['num_segments'] );
	}

	public function test_graph_for_topic_kind_and_cache_by_topology_name(): void {
		$this->write_tsl( 'topic-flow', "make_node Topic topic-node <config:logs_dir>/topic.log 2 group\n" );

		$first = \Newspack_Nodes\Topology_Registry::graph_for( 'topic-flow' );
		$this->write_tsl( 'topic-flow', "make_node Echo changed\n" );
		$second = \Newspack_Nodes\Topology_Registry::graph_for( 'topic-flow' );

		$this->assertSame( $first, $second );
		$this->assertSame( 'topic', $first['nodes'][0]['kind'] );
		$this->assertSame( 'topic.log', $first['nodes'][0]['writes'] );
	}

	public function test_graph_for_unknown_topology_is_empty(): void {
		$this->assertSame( [ 'nodes' => [], 'edges' => [] ], \Newspack_Nodes\Topology_Registry::graph_for( 'nope' ) );
	}

	public function test_graph_for_preserves_custom_node_type_and_positional_args(): void {
		// A custom node type flattens to kind:'logic', but must carry its make_node
		// type token + positional args so Aggregator_CI can discover wired sources.
		$this->write_tsl(
			'spoke',
			"make_node Remote_Source spoke-x austin firehose 0\n"
			. "connect_node spoke-x next-step\n"
		);
		$g    = \Newspack_Nodes\Topology_Registry::graph_for( 'spoke' );
		$node = $g['nodes'][0];

		$this->assertSame( 'spoke-x', $node['name'] );
		$this->assertSame( 'logic', $node['kind'] );
		$this->assertSame( 'Remote_Source', $node['type'] );
		$this->assertSame( [ 'austin', 'firehose', '0' ], $node['args'] );
	}

	public function test_graph_for_builtin_node_carries_type_and_args(): void {
		// A built-in type likewise carries its type + positional args additively.
		$this->write_tsl( 'b', "make_node Consumer firehose:consumer src.log <partition> off.p<partition>\n" );
		$g    = \Newspack_Nodes\Topology_Registry::graph_for( 'b' );
		$node = $g['nodes'][0];

		$this->assertSame( 'consumer', $node['kind'] );
		$this->assertSame( 'Consumer', $node['type'] );
		$this->assertSame( [ 'src.log', '<partition>', 'off.p<partition>' ], $node['args'] );
	}

	public function test_graph_for_node_without_args_has_empty_args_list(): void {
		// A bare make_node (type + name only) yields an empty args list.
		$this->write_tsl( 'e', "make_node Tee completed:tee\n" );
		$g    = \Newspack_Nodes\Topology_Registry::graph_for( 'e' );
		$node = $g['nodes'][0];

		$this->assertSame( 'Tee', $node['type'] );
		$this->assertSame( [], $node['args'] );
	}

	public function test_graph_for_tee_subclass_resolves_to_tee_kind(): void {
		// Tap_Node extends Tee_Node — the exact-name match misses `Tap`, so the
		// kind falls to 'logic', then the lineage check on the resolved FQCN must
		// promote it to 'tee' (the Tee-family fan-out treatment).
		\Newspack_Nodes\Command_Interpreter_Node::register_namespace( 'Newspack_Nodes\\' );
		$this->write_tsl( 'tap-flow', "make_node Tap firehose:tap\n" );
		$g       = \Newspack_Nodes\Topology_Registry::graph_for( 'tap-flow' );
		$by_name = [];
		foreach ( $g['nodes'] as $n ) {
			$by_name[ $n['name'] ] = $n;
		}
		$this->assertSame( 'tee', $by_name['firehose:tap']['kind'] );
	}
}
