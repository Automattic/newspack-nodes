<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Topology_Analyzer;
use Newspack_Nodes\Topology_Registry;
use Newspack_Nodes\Tests\TestCase;

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
		$g = \Newspack_Nodes\Topology_Analyzer::graph_for( 'combined' );

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

	public function test_graph_for_resolves_a_config_token_in_a_named_target_slot(): void {
		\Newspack_Nodes\Core::register_config_namespace(
			'wombat_graph',
			static fn ( string $key ): ?string => 'stats_sink' === $key ? 'indigo-flame-stats-863' : null
		);
		$this->write_tsl(
			'wombat-config-target',
			"make_node Echo amber-flame-builder-731\n"
			. "make_node Partition indigo-flame-stats-863 /var/wombat/stats.p<partition> 1 2 0\n"
			. "cmd amber-flame-builder-731:config set_stats_target <wombat_graph:stats_sink>\n"
		);

		$this->assertContains(
			[ 'amber-flame-builder-731', 'indigo-flame-stats-863' ],
			Topology_Analyzer::graph_for( 'wombat-config-target' )['edges']
		);
	}

	public function test_graph_for_empty_config_token_clears_only_its_named_target_slot(): void {
		\Newspack_Nodes\Core::register_config_namespace(
			'wombat_graph',
			static fn ( string $key ): ?string => 'disabled_stats_sink' === $key ? '' : null
		);
		$this->write_tsl(
			'wombat-empty-config-target',
			"make_node Echo amber-flame-builder-731\n"
			. "make_node Echo green-completed-421\n"
			. "make_node Echo violet-old-stats-947\n"
			. "cmd amber-flame-builder-731:config set_stats_target violet-old-stats-947\n"
			. "cmd amber-flame-builder-731:config set_completed_target green-completed-421\n"
			. "cmd amber-flame-builder-731:config set_stats_target <wombat_graph:disabled_stats_sink>\n"
		);

		$this->assertSame(
			[ [ 'amber-flame-builder-731', 'green-completed-421' ] ],
			Topology_Analyzer::graph_for( 'wombat-empty-config-target' )['edges']
		);
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
		$g      = \Newspack_Nodes\Topology_Analyzer::graph_for( 'rb' );
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
		$g = \Newspack_Nodes\Topology_Analyzer::graph_for( 'x' );
		$this->assertSame( 'partition', $g['nodes'][0]['kind'] );
		$this->assertSame( 'out.log', $g['nodes'][0]['writes'] );
	}

	public function test_graph_for_log_sink_emits_kind_writes_path_segment_size_and_max_segments(): void {
		// A Log file-sink: make_node Log <name> <file> [segment_size] [min_segments] [max_segments].
		// kind 'log'; writes = basename; path/segment_size/max_segments carried so
		// dump_graph can stat the flat `{file}.{seg}` segments (max_segments is the
		// retained count, token 6).
		$this->write_tsl( 'l', "make_node Log lg /tmp/x.md 100 2 3\n" );
		$g = \Newspack_Nodes\Topology_Analyzer::graph_for( 'l' );
		$node = $g['nodes'][0];
		$this->assertSame( 'lg', $node['name'] );
		$this->assertSame( 'log', $node['kind'] );
		$this->assertSame( 'x.md', $node['writes'] );
		$this->assertSame( '/tmp/x.md', $node['path'] );
		$this->assertSame( 100, $node['segment_size'] );
		$this->assertSame( 3, $node['max_segments'] );
	}

	public function test_graph_for_topic_kind_and_cache_by_topology_name(): void {
		$this->write_tsl( 'topic-flow', "make_node Topic topic-node <config:logs_dir>/topic.log 2 group\n" );

		$first = \Newspack_Nodes\Topology_Analyzer::graph_for( 'topic-flow' );
		$this->write_tsl( 'topic-flow', "make_node Echo changed\n" );
		$second = \Newspack_Nodes\Topology_Analyzer::graph_for( 'topic-flow' );

		$this->assertSame( $first, $second );
		$this->assertSame( 'topic', $first['nodes'][0]['kind'] );
		$this->assertSame( 'topic.log', $first['nodes'][0]['writes'] );
	}

	public function test_graph_for_unknown_topology_is_empty(): void {
		$this->assertSame( [ 'nodes' => [], 'edges' => [] ], \Newspack_Nodes\Topology_Analyzer::graph_for( 'nope' ) );
	}

	/**
	 * graph_for is a DISPLAY helper — dump_graph walks every registered topology,
	 * so one cyclic .tsl must degrade to an empty graph, not throw and take the
	 * whole dashboard down with it. The LOADER still fails loud at boot.
	 */
	public function test_graph_for_degrades_to_empty_on_a_cyclic_include(): void {
		$this->write_tsl( 'ouroboros-a', "include ouroboros-b\nmake_node Echo wombat-echo\n" );
		$this->write_tsl( 'ouroboros-b', "include ouroboros-a\n" );

		$this->assertSame(
			[ 'nodes' => [], 'edges' => [] ],
			Topology_Analyzer::graph_for( 'ouroboros-a' )
		);
	}

	/** Same contract for a conflicting make_node across two included topologies. */
	public function test_graph_for_degrades_to_empty_on_a_conflicting_make_node(): void {
		$this->write_tsl( 'clash-a', "make_node Grep shared-grep zebra-pattern\n" );
		$this->write_tsl( 'clash-b', "make_node Grep shared-grep giraffe-pattern\n" );
		$this->write_tsl( 'clash-top', "include clash-a\ninclude clash-b\n" );

		$this->assertSame(
			[ 'nodes' => [], 'edges' => [] ],
			Topology_Analyzer::graph_for( 'clash-top' )
		);
	}

	public function test_graph_for_preserves_custom_node_type_and_positional_args(): void {
		// A custom node type flattens to kind:'logic', but must carry its make_node
		// type token + positional args so Aggregator_CI can discover wired sources.
		$this->write_tsl(
			'spoke',
			"make_node Remote_Source spoke-x austin firehose 0\n"
			. "connect_node spoke-x next-step\n"
		);
		$g    = \Newspack_Nodes\Topology_Analyzer::graph_for( 'spoke' );
		$node = $g['nodes'][0];

		$this->assertSame( 'spoke-x', $node['name'] );
		$this->assertSame( 'logic', $node['kind'] );
		$this->assertSame( 'Remote_Source', $node['type'] );
		$this->assertSame( [ 'austin', 'firehose', '0' ], $node['args'] );
	}

	public function test_graph_for_builtin_node_carries_type_and_args(): void {
		// A built-in type likewise carries its type + positional args additively.
		$this->write_tsl( 'b', "make_node Consumer firehose:consumer src.log <partition> off.p<partition>\n" );
		$g    = \Newspack_Nodes\Topology_Analyzer::graph_for( 'b' );
		$node = $g['nodes'][0];

		$this->assertSame( 'consumer', $node['kind'] );
		$this->assertSame( 'Consumer', $node['type'] );
		$this->assertSame( [ 'src.log', '<partition>', 'off.p<partition>' ], $node['args'] );
	}

	public function test_graph_for_node_without_args_has_empty_args_list(): void {
		// A bare make_node (type + name only) yields an empty args list.
		$this->write_tsl( 'e', "make_node Tee completed:tee\n" );
		$g    = \Newspack_Nodes\Topology_Analyzer::graph_for( 'e' );
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
		$g       = \Newspack_Nodes\Topology_Analyzer::graph_for( 'tap-flow' );
		$by_name = [];
		foreach ( $g['nodes'] as $n ) {
			$by_name[ $n['name'] ] = $n;
		}
		$this->assertSame( 'tee', $by_name['firehose:tap']['kind'] );
	}

	public function test_graph_for_one_arg_disconnect_removes_included_edges_before_rewire(): void {
		$this->write_tsl(
			'wombat-base',
			"make_node Consumer zebra:consumer /var/wombat/zebra.p<partition> /var/wombat/zebra-offset.p<partition>\n"
			. "make_node Echo giraffe-direct\n"
			. "connect_node zebra:consumer giraffe-direct\n"
		);
		$this->write_tsl(
			'wombat-rewire',
			"include wombat-base\n"
			. "make_node Tee zebra:tee\n"
			. "make_node Echo llama-handler\n"
			. "disconnect_node zebra:consumer\n"
			. "connect_node zebra:consumer zebra:tee\n"
			. "connect_node zebra:tee llama-handler\n"
		);

		$this->assertSame(
			[
				[ 'zebra:consumer', 'zebra:tee' ],
				[ 'zebra:tee', 'llama-handler' ],
			],
			Topology_Analyzer::graph_for( 'wombat-rewire' )['edges']
		);
	}

	public function test_graph_for_regular_connect_replaces_the_current_connect_edge(): void {
		$this->write_tsl(
			'wombat-regular-reconnect',
			"make_node Echo zebra-source\n"
			. "make_node Echo giraffe-old\n"
			. "make_node Echo llama-current\n"
			. "connect_node zebra-source giraffe-old\n"
			. "connect_node zebra-source llama-current\n"
		);

		$this->assertSame(
			[ [ 'zebra-source', 'llama-current' ] ],
			Topology_Analyzer::graph_for( 'wombat-regular-reconnect' )['edges']
		);
	}

	public function test_graph_for_regular_disconnect_ignores_target_and_preserves_config_edges(): void {
		$this->write_tsl(
			'wombat-regular-disconnect',
			"make_node Echo zebra-source\n"
			. "make_node Echo giraffe-old\n"
			. "make_node Echo llama-current\n"
			. "make_node Echo ibex-errors\n"
			. "cmd zebra-source:config set_errors_target ibex-errors\n"
			. "connect_node zebra-source giraffe-old\n"
			. "disconnect_node zebra-source ibex-errors\n"
			. "connect_node zebra-source llama-current\n"
		);

		$this->assertSame(
			[
				[ 'zebra-source', 'ibex-errors' ],
				[ 'zebra-source', 'llama-current' ],
			],
			Topology_Analyzer::graph_for( 'wombat-regular-disconnect' )['edges']
		);
	}

	public function test_graph_for_config_setter_replaces_its_slot_while_distinct_slots_coexist(): void {
		$this->write_tsl(
			'wombat-config-slots',
			"make_node Echo zebra-source\n"
			. "make_node Echo giraffe-old-errors\n"
			. "make_node Echo llama-completed\n"
			. "make_node Echo ibex-current-errors\n"
			. "cmd zebra-source:config set_errors_target giraffe-old-errors\n"
			. "cmd zebra-source:config set_completed_target llama-completed\n"
			. "cmd zebra-source:config set_errors_target ibex-current-errors\n"
		);

		$this->assertSame(
			[
				[ 'zebra-source', 'llama-completed' ],
				[ 'zebra-source', 'ibex-current-errors' ],
			],
			Topology_Analyzer::graph_for( 'wombat-config-slots' )['edges']
		);
	}

	public function test_graph_for_empty_config_setter_clears_only_its_named_slot(): void {
		$this->write_tsl(
			'wombat-empty-config-slot',
			"make_node Echo zebra-source\n"
			. "make_node Echo giraffe-errors\n"
			. "make_node Echo llama-completed\n"
			. "cmd zebra-source:config set_errors_target giraffe-errors\n"
			. "cmd zebra-source:config set_completed_target llama-completed\n"
			. "cmd zebra-source:config set_errors_target\n"
		);

		$this->assertSame(
			[ [ 'zebra-source', 'llama-completed' ] ],
			Topology_Analyzer::graph_for( 'wombat-empty-config-slot' )['edges']
		);
	}

	public function test_graph_for_targeted_disconnect_preserves_other_edges_and_later_reconnect_order(): void {
		$this->write_tsl(
			'wombat-retarget',
			"make_node Tee zebra:tee\n"
			. "make_node Echo giraffe-handler\n"
			. "make_node Echo llama-handler\n"
			. "connect_node zebra:tee giraffe-handler\n"
			. "connect_node zebra:tee llama-handler\n"
			. "disconnect_node zebra:tee giraffe-handler\n"
			. "disconnect_node zebra:tee\n"
			. "connect_node zebra:tee giraffe-handler\n"
		);

		$this->assertSame(
			[
				[ 'zebra:tee', 'llama-handler' ],
				[ 'zebra:tee', 'giraffe-handler' ],
			],
			Topology_Analyzer::graph_for( 'wombat-retarget' )['edges']
		);
	}

	public function test_graph_for_applies_tee_fanout_and_targeted_disconnect_to_a_tap_subclass(): void {
		\Newspack_Nodes\Command_Interpreter_Node::register_namespace( 'Newspack_Nodes\\' );
		$this->write_tsl(
			'wombat-tap-fanout',
			"make_node Tap zebra:tap\n"
			. "make_node Echo giraffe-handler\n"
			. "make_node Echo llama-handler\n"
			. "connect_node zebra:tap giraffe-handler\n"
			. "connect_node zebra:tap llama-handler\n"
			. "disconnect_node zebra:tap giraffe-handler\n"
		);

		$this->assertSame(
			[ [ 'zebra:tap', 'llama-handler' ] ],
			Topology_Analyzer::graph_for( 'wombat-tap-fanout' )['edges']
		);
	}

	/**
	 * Fan-out is the `Fanout_Targets` trait, not the Tee class. Settings_Sync and
	 * ELN's Discovery_Collector are Timer_Node subclasses that keep a target LIST
	 * and mint one signed command per spoke; testing for a Tee ancestor calls them
	 * single-target, so the graph collapses the second edge and the console offers
	 * no way to wire a hub to more than one spoke.
	 */
	public function test_graph_for_applies_fanout_to_a_trait_using_non_tee_class(): void {
		\Newspack_Nodes\Command_Interpreter_Node::register_namespace( 'Newspack_Nodes\\' );
		$this->write_tsl(
			'wombat-trait-fanout',
			"make_node Settings_Sync zebra:sync\n"
			. "make_node Echo giraffe-spoke\n"
			. "make_node Echo llama-spoke\n"
			. "connect_node zebra:sync giraffe-spoke\n"
			. "connect_node zebra:sync llama-spoke\n"
		);

		$this->assertSame(
			[
				[ 'zebra:sync', 'giraffe-spoke' ],
				[ 'zebra:sync', 'llama-spoke' ],
			],
			Topology_Analyzer::graph_for( 'wombat-trait-fanout' )['edges']
		);
	}

	/**
	 * Fan-out is not the layout kind. `kind: 'tee'` marks a pass-through hop the
	 * dashboard CONTRACTS out of the graph (x->T, T->y becomes x->y), which is
	 * right for a Tee and wrong for a minter: Settings_Sync is a destination that
	 * signs per spoke, and classing it 'tee' erases it from the topology view.
	 */
	public function test_graph_for_keeps_a_trait_fanout_minter_out_of_the_tee_layout_kind(): void {
		\Newspack_Nodes\Command_Interpreter_Node::register_namespace( 'Newspack_Nodes\\' );
		$this->write_tsl(
			'wombat-minter-kind',
			"make_node Settings_Sync zebra:sync\n"
			. "make_node Tee giraffe:tee\n"
		);

		$nodes = [];
		foreach ( Topology_Analyzer::graph_for( 'wombat-minter-kind' )['nodes'] as $node ) {
			$nodes[ $node['name'] ] = $node['kind'];
		}

		$this->assertSame( 'logic', $nodes['zebra:sync'] );
		$this->assertSame( 'tee', $nodes['giraffe:tee'] );
	}

	public function test_graph_for_expands_includes_so_a_borrowed_partition_is_not_a_hole(): void {
		$this->write_tsl(
			'wombat-base',
			"make_node Partition zebra:partition /var/wombat/zebra.log <partition> 1 2 0\n"
		);
		$this->write_tsl(
			'wombat-top',
			"include wombat-base\n"
			. "make_node Echo top-echo\n"
			. "connect_node top-echo zebra:partition\n"
		);

		$graph = Topology_Analyzer::graph_for( 'wombat-top' );
		$names = \array_column( $graph['nodes'], 'name' );

		$this->assertContains( 'zebra:partition', $names, 'the included Partition never made it into the graph' );
		$this->assertContains( 'top-echo', $names );
		$this->assertContains( [ 'top-echo', 'zebra:partition' ], $graph['edges'] );
	}

	public function test_statements_tags_origin_and_via_through_a_nested_include(): void {
		$this->write_tsl( 'wombat-leaf', "make_node Echo leaf-echo\n" );
		$this->write_tsl( 'wombat-mid', "include wombat-leaf\nmake_node Echo mid-echo\n" );
		$this->write_tsl( 'wombat-top', "include wombat-mid\nmake_node Echo own-echo\n" );

		$out = Topology_Analyzer::statements( 'wombat-top' );
		$by_line = [];
		foreach ( $out['statements'] as $s ) {
			$by_line[ $s['line'] ] = $s;
		}

		$this->assertNull( $by_line['make_node Echo own-echo']['origin'] );
		$this->assertSame( [], $by_line['make_node Echo own-echo']['via'] );
		$this->assertSame( 'wombat-mid', $by_line['make_node Echo mid-echo']['origin'] );
		$this->assertSame( [ 'wombat-mid' ], $by_line['make_node Echo mid-echo']['via'] );
		$this->assertSame( 'wombat-mid', $by_line['make_node Echo leaf-echo']['origin'] );
		$this->assertSame( [ 'wombat-mid', 'wombat-leaf' ], $by_line['make_node Echo leaf-echo']['via'] );
		$this->assertSame( [ 'wombat-mid' => [ 'wombat-leaf' => [] ] ], $out['tree'] );
	}

	public function test_statements_drops_an_identical_duplicate_and_throws_on_a_conflicting_one(): void {
		$this->write_tsl( 'dup-a', "make_node Grep shared-grep zebra-pattern\n" );
		$this->write_tsl( 'dup-b', "make_node Grep shared-grep zebra-pattern\n" );
		$this->write_tsl( 'dup-top', "include dup-a\ninclude dup-b\n" );

		$out   = Topology_Analyzer::statements( 'dup-top' );
		$greps = \array_filter( $out['statements'], fn ( $s ) => \str_contains( $s['line'], 'shared-grep' ) );
		$this->assertCount( 1, $greps, 'the identical duplicate make_node should collapse' );

		$this->write_tsl( 'dup-c', "make_node Grep shared-grep giraffe-pattern\n" );
		$this->write_tsl( 'conflict-top', "include dup-a\ninclude dup-c\n" );

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'shared-grep' );
		Topology_Analyzer::statements( 'conflict-top' );
	}
}
