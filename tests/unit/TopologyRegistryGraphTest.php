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
#[CoversClass( Topology_Analyzer::class )]
class TopologyRegistryGraphTest extends TestCase {

	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		Topology_Registry::reset();
		$this->tmp = $this->stock_topology_dir( 'topology-graph-' );
	}

	protected function tearDown(): void {
		Topology_Registry::reset();
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	public function test_graph_for_kinds_from_class_logs_from_args_edges_from_connect_and_targets(): void {
		$this->write_tsl(
			'combined',
			"make_node Consumer firehose:consumer <config:logs_dir>/firehose.p0 {partition} <config:offsets_dir>/firehose.p{partition}\n"
			. "make_node Request_Builder request-builder\n"
			. "make_node Partition requests:partition <config:logs_dir>/requests.log 4096 1 2 0\n"
			. "make_node Partition errors:partition <config:logs_dir>/errors.log 4096 1 2 0\n"
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
		$this->assertSame( 'firehose.p0', $byName['firehose:consumer']['reads'] );
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
			. "make_node Partition indigo-flame-stats-863 /var/wombat/stats.p{partition} 1 2 0\n"
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
			"make_node Consumer firehose:consumer <config:logs_dir>/firehose.p{partition} <config:offsets_dir>/firehose.request-builder.p{partition}\n"
		);
		$g      = \Newspack_Nodes\Topology_Analyzer::graph_for( 'rb' );
		$byName = [];
		foreach ( $g['nodes'] as $n ) {
			$byName[ $n['name'] ] = $n;
		}
		$this->assertSame( 'firehose.p{partition}', $byName['firehose:consumer']['reads'] );
		$this->assertSame( 'firehose.request-builder.p{partition}', $byName['firehose:consumer']['reader'] );
	}

	public function test_graph_for_kind_ignores_name_suffix(): void {
		// A Partition whose NAME has no :partition suffix — kind must still be 'partition' (from the class).
		$this->write_tsl( 'x', "make_node Partition plainname <config:logs_dir>/out.log 4096 1 2 0\n" );
		$g = \Newspack_Nodes\Topology_Analyzer::graph_for( 'x' );
		$this->assertSame( 'partition', $g['nodes'][0]['kind'] );
		$this->assertSame( 'out.log', $g['nodes'][0]['writes'] );
	}

	public function test_graph_for_log_sink_emits_kind_writes_path_and_segment_size(): void {
		// A Log file-sink: make_node Log <name> <file> [segment_size] [min_segments] [num_segments].
		// kind 'log'; writes = basename; path and segment_size carried so
		// dump_graph can stat the flat `{file}.{seg}` segments.
		$this->write_tsl( 'l', "make_node Log lg /tmp/x.md 100 2 3\n" );
		$g = \Newspack_Nodes\Topology_Analyzer::graph_for( 'l' );
		$node = $g['nodes'][0];
		$this->assertSame( 'lg', $node['name'] );
		$this->assertSame( 'log', $node['kind'] );
		$this->assertSame( 'x.md', $node['writes'] );
		$this->assertSame( '/tmp/x.md', $node['path'] );
		$this->assertSame( 100, $node['segment_size'] );
		$this->assertArrayNotHasKey( 'max_segments', $node );
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
	 * A broken include throws out of graph_for, so every caller — the restart
	 * planner, the wake map, dump_graph — sees the failure instead of an empty
	 * graph that reads as "declares nothing".
	 */
	public function test_graph_for_throws_on_a_cyclic_include(): void {
		$this->write_tsl( 'ouroboros-a', "include ouroboros-b\nmake_node Echo wombat-echo\n" );
		$this->write_tsl( 'ouroboros-b', "include ouroboros-a\n" );

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'ouroboros' );

		Topology_Analyzer::graph_for( 'ouroboros-a' );
	}

	/** Same contract for a conflicting make_node across two included topologies. */
	public function test_graph_for_throws_on_a_conflicting_make_node(): void {
		$this->write_tsl( 'clash-a', "make_node Grep shared-grep zebra-pattern\n" );
		$this->write_tsl( 'clash-b', "make_node Grep shared-grep giraffe-pattern\n" );
		$this->write_tsl( 'clash-top', "include clash-a\ninclude clash-b\n" );

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'shared-grep' );

		Topology_Analyzer::graph_for( 'clash-top' );
	}

	/**
	 * A failed walk is memoized like a good one: every reader in the request
	 * gets the SAME throwable without re-parsing, and a repaired file is read
	 * once the parsed caches reset — the next request, or a config reload.
	 */
	public function test_graph_for_memoizes_the_failure_until_the_caches_reset(): void {
		$this->write_tsl( 'mended-top', "include mended-missing-4417\nmake_node Echo mended-echo-4417\n" );
		$first = $this->caught(
			fn () => Topology_Analyzer::graph_for( 'mended-top' ),
			'an unresolvable include must throw'
		);
		$this->assertStringContainsString( 'mended-missing-4417', $first->getMessage() );

		$this->write_tsl( 'mended-missing-4417', "make_node Echo mended-base-4417\n" );

		$this->assertSame(
			$first,
			$this->caught( fn () => Topology_Analyzer::graph_for( 'mended-top' ), 'the memoized failure re-raises' ),
			'the second ask parses nothing and re-raises the first failure'
		);
		$this->assertSame(
			$first,
			$this->caught( fn () => Topology_Analyzer::write_set( 'mended-top' ), 'every reader shares the walk' ),
			'a sibling reader of the same walk re-raises it too'
		);

		Topology_Analyzer::reset_caches();

		$this->assertSame(
			[ 'mended-base-4417', 'mended-echo-4417' ],
			\array_column( Topology_Analyzer::graph_for( 'mended-top' )['nodes'], 'name' )
		);
	}

	public function test_graph_for_preserves_custom_node_type_and_positional_args(): void {
		// A custom node type flattens to kind:'logic', but must carry its make_node
		// type token + positional args so Aggregator_CI can discover wired sources.
		$this->write_tsl(
			'spoke',
			"make_node Remote_Source spoke-x austin /var/x/off /var/x/dl firehose:next-step 0\n"
		);
		$g    = \Newspack_Nodes\Topology_Analyzer::graph_for( 'spoke' );
		$node = $g['nodes'][0];

		$this->assertSame( 'spoke-x', $node['name'] );
		$this->assertSame( 'logic', $node['kind'] );
		$this->assertSame( 'Remote_Source', $node['type'] );
		$this->assertSame( [ 'austin', '/var/x/off', '/var/x/dl', 'firehose:next-step', '0' ], $node['args'] );
	}

	public function test_graph_for_builtin_node_carries_type_and_args(): void {
		// A built-in type likewise carries its type + positional args additively.
		$this->write_tsl( 'b', "make_node Consumer firehose:consumer src.log {partition} off.p{partition}\n" );
		$g    = \Newspack_Nodes\Topology_Analyzer::graph_for( 'b' );
		$node = $g['nodes'][0];

		$this->assertSame( 'consumer', $node['kind'] );
		$this->assertSame( 'Consumer', $node['type'] );
		$this->assertSame( [ 'src.log', '{partition}', 'off.p{partition}' ], $node['args'] );
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

	/**
	 * Kind classification must ask the type system, not string-match the token.
	 * `Tail_Node extends Consumer_Node`, so a Tail IS a durable reader with a
	 * source + offsetlog — but the literal `match` called it 'logic', which drops
	 * it out of `consumer_positions()`, the list `Bootstrap` reads to report
	 * reader lag. A Partition subclass fell out the same way, so its real log was
	 * invisible to the console, the GC's declared set and the conflict gate.
	 */
	public function test_graph_for_classifies_consumer_and_partition_subclasses_by_lineage(): void {
		\Newspack_Nodes\Command_Interpreter_Node::register_namespace( 'Newspack_Nodes\\' );
		$this->write_tsl(
			'vicuna-subclasses',
			"make_node Tail zebra:tail /var/vicuna/zebra.log /var/vicuna/zebra-offset.p{partition}\n"
			. "make_node Log giraffe:log /var/vicuna/giraffe.p{partition} 4096\n"
		);

		$by_name = [];
		foreach ( Topology_Analyzer::graph_for( 'vicuna-subclasses' )['nodes'] as $node ) {
			$by_name[ $node['name'] ] = $node;
		}

		$this->assertSame( 'consumer', $by_name['zebra:tail']['kind'] );
		$this->assertSame( 'log', $by_name['giraffe:log']['kind'], 'Log stays Log, not its Partition base' );
	}

	/** A Consumer subclass reports its source + offsetlog like any other reader. */
	public function test_consumer_positions_include_a_consumer_subclass(): void {
		\Newspack_Nodes\Command_Interpreter_Node::register_namespace( 'Newspack_Nodes\\' );
		$this->write_tsl(
			'vicuna-tail-reader',
			"make_node Tail zebra:tail /var/vicuna/zebra.log /var/vicuna/zebra-offset.p{partition}\n"
		);

		$this->assertSame(
			[
				[
					'source'    => '/var/vicuna/zebra.log',
					'offsetlog' => '/var/vicuna/zebra-offset.p{partition}',
				],
			],
			Topology_Analyzer::consumer_positions( 'vicuna-tail-reader' )
		);
	}

	/** A quoted argument reads as the value the runtime binds, never its quotes. */
	public function test_graph_for_reads_quoted_arguments_as_their_values(): void {
		$this->write_tsl(
			'vicuna-quoted',
			"make_node Log zebra:log '/var/vicuna/zebra.p{partition}' '8192'\n"
			. "make_node Partition quokka:partition '/var/vicuna/quokka.p{partition}'\n"
			. "make_node Consumer okapi:consumer \"/var/vicuna/okapi.p{partition}\" '/var/vicuna/okapi-offset.p{partition}'\n"
			. "make_node Hook vicuna-hook wp_loaded \"a b c\"\n"
		);

		$by_name = \array_column( Topology_Analyzer::graph_for( 'vicuna-quoted' )['nodes'], null, 'name' );

		$this->assertSame( 'zebra.p{partition}', $by_name['zebra:log']['writes'] );
		$this->assertSame( '/var/vicuna/zebra.p{partition}', $by_name['zebra:log']['path'] );
		$this->assertSame( 8192, $by_name['zebra:log']['segment_size'] );
		$this->assertSame( 'quokka.p{partition}', $by_name['quokka:partition']['writes'] );
		$this->assertSame( 'okapi.p{partition}', $by_name['okapi:consumer']['reads'] );
		$this->assertSame( 'okapi-offset.p{partition}', $by_name['okapi:consumer']['reader'] );
		$this->assertSame( [ 'wp_loaded', 'a b c' ], $by_name['vicuna-hook']['args'] );
		$this->assertSame(
			[ [ 'source' => '/var/vicuna/okapi.p{partition}', 'offsetlog' => '/var/vicuna/okapi-offset.p{partition}' ] ],
			Topology_Analyzer::consumer_positions( 'vicuna-quoted' )
		);
	}

	/** A type match asks the type system: a subclass counts, a lookalike token does not. */
	public function test_nodes_of_type_matches_the_class_and_its_subclasses_in_order(): void {
		\Newspack_Nodes\Command_Interpreter_Node::register_namespace( 'Newspack_Nodes\\' );
		$this->write_tsl( 'vicuna-readers-base', "make_node Tail zebra:tail /var/vicuna/zebra.log /var/vicuna/zebra-offset.p{partition}\n" );
		$this->write_tsl(
			'vicuna-readers',
			"make_node Consumer okapi:consumer /var/vicuna/okapi.p{partition} /var/vicuna/okapi-offset.p{partition}\n"
			. "include vicuna-readers-base\n"
			. "make_node Echo consumer-ish\n"
		);

		$this->assertSame(
			[ 'okapi:consumer', 'zebra:tail' ],
			\array_column( Topology_Analyzer::nodes_of_type( 'vicuna-readers', \Newspack_Nodes\Consumer_Node::class ), 'name' )
		);
		$this->assertSame( [], Topology_Analyzer::nodes_of_type( 'vicuna-readers', \Newspack_Nodes\Tee_Node::class ) );
		$this->assertSame(
			[ 'okapi:consumer', 'zebra:tail', 'consumer-ish' ],
			\array_column( Topology_Analyzer::nodes_of_type( 'vicuna-readers', \Newspack_Nodes\Echo_Node::class, \Newspack_Nodes\Consumer_Node::class ), 'name' ),
			'any of several classes, in declaration order'
		);
	}

	/** An HTTP_Source is a broker by the base, as the Vault reload finds one. */
	public function test_nodes_of_type_finds_an_http_source_as_a_broker(): void {
		\Newspack_Nodes\Command_Interpreter_Node::register_namespace( 'Newspack_Nodes\\' );
		$this->write_tsl( 'vicuna-http-pull', "make_node HTTP_Source pull:okapi okapi-5521 /var/vicuna/off /var/vicuna/dl ledger.p0:ledger-sink-5521\n" );

		$brokers = Topology_Analyzer::nodes_of_type( 'vicuna-http-pull', \Newspack_Nodes\Remote_Broker_Node::class );

		$this->assertSame( [ 'pull:okapi' ], \array_column( $brokers, 'name' ) );
		$this->assertSame( 'okapi-5521', $brokers[0]['vault_id'] );
		$this->assertSame( [ [ 'source' => 'ledger.p0', 'target' => 'ledger-sink-5521' ] ], $brokers[0]['pairs'] );
	}

	/** A broker subclass binding one more argument starts its pairs one token later. */
	public function test_graph_for_starts_a_broker_subclass_s_pairs_past_its_own_bound_arguments(): void {
		require_once __DIR__ . '/../Helpers/fixtures/class-wombat-quad-source-node.php';
		\Newspack_Nodes\Command_Interpreter_Node::register_namespace( 'Newspack_Nodes\\Tests\\Fixtures\\' );
		$this->write_tsl( 'quad-pull', "make_node Wombat_Quad_Source quad:okapi okapi-7 /var/quad/off /var/quad/dl cap.p0:cap-sink ledger.p0:ledger-sink tapir.p0:tapir-sink\n" );

		$graph = Topology_Analyzer::graph_for( 'quad-pull' );

		$this->assertSame(
			[ [ 'source' => 'ledger.p0', 'target' => 'ledger-sink' ], [ 'source' => 'tapir.p0', 'target' => 'tapir-sink' ] ],
			$graph['nodes'][0]['pairs']
		);
		$this->assertNotContains( [ 'quad:okapi', 'cap-sink' ], $graph['edges'] );
	}

	/** Before any namespace registers, a broker token still reads as a broker by its class's lineage. */
	public function test_an_unregistered_namespace_still_reads_a_remote_source_as_a_broker(): void {
		foreach ( [ 'namespaces', 'resolve_cache' ] as $property ) {
			( new \ReflectionProperty( \Newspack_Nodes\Command_Interpreter_Node::class, $property ) )->setValue( null, [] );
		}
		$this->assertNull( \Newspack_Nodes\Command_Interpreter_Node::resolve_class( 'Remote_Source' ), 'precondition: nothing resolves' );
		$this->write_tsl( 'vicuna-cold', "make_node Remote_Source pull:okapi okapi-3307 /var/vicuna/off /var/vicuna/dl ledger.p0:ledger-sink-3307\n" );

		$node = Topology_Analyzer::graph_for( 'vicuna-cold' )['nodes'][0];

		$this->assertSame( 'okapi-3307', $node['vault_id'] );
		$this->assertSame( [ [ 'source' => 'ledger.p0', 'target' => 'ledger-sink-3307' ] ], $node['pairs'] );
	}

	/** A broker's spoke and pairs are read by name, quotes stripped; each pair draws an edge. */
	public function test_graph_for_names_what_a_remote_source_pulls_and_where(): void {
		$this->write_tsl( 'vicuna-pull', "make_node Remote_Source pull:okapi okapi-7 /var/vicuna/off /var/vicuna/dl \"ledger.p{partition}:ledger-sink\" sources/php:php-errors:partition\n" );

		$graph = Topology_Analyzer::graph_for( 'vicuna-pull' );
		$node  = $graph['nodes'][0];

		$this->assertSame( 'okapi-7', $node['vault_id'] );
		$this->assertSame(
			[ [ 'source' => 'ledger.p{partition}', 'target' => 'ledger-sink' ], [ 'source' => 'sources/php', 'target' => 'php-errors:partition' ] ],
			$node['pairs']
		);
		$this->assertArrayNotHasKey( 'reads', $node, 'a remote pull reads no local log' );
		$this->assertContains( [ 'pull:okapi', 'ledger-sink' ], $graph['edges'] );
		$this->assertContains( [ 'pull:okapi', 'php-errors:partition' ], $graph['edges'] );
	}

	public function test_graph_for_skips_a_malformed_pair_without_failing(): void {
		$this->write_tsl( 'vicuna-bad', "make_node Remote_Source pull:okapi okapi-7 /var/vicuna/off /var/vicuna/dl ledger.p0 sources/php:php-errors\n" );

		$this->assertSame( [ [ 'source' => 'sources/php', 'target' => 'php-errors' ] ], Topology_Analyzer::graph_for( 'vicuna-bad' )['nodes'][0]['pairs'] );
	}

	/** A pair the load would refuse draws no edge, so the graph shows only what loads. */
	public function test_a_pair_the_runtime_refuses_draws_no_edge(): void {
		$this->write_tsl( 'vicuna-orphan', "make_node Remote_Source pull:okapi okapi-7 /var/vicuna/off /var/vicuna/dl :orphan-4 sources/php: ledger.p{partition}:ledger-sink-7\n" );

		$drawn = \array_map( static fn ( array $edge ): string => "{$edge[0]}>{$edge[1]}", Topology_Analyzer::graph_for( 'vicuna-orphan' )['edges'] );
		$expanded = \array_map( static fn ( array $edge ): string => "{$edge['from']}>{$edge['to']}", Topology_Analyzer::expand( [ 'vicuna-orphan' ] )['edges'] );

		$this->assertSame( [ 'pull:okapi>ledger-sink-7' ], $drawn );
		$this->assertSame( [ 'pull:okapi>ledger-sink-7' ], $expanded );
	}

	/** A target naming `{partition}` draws its edge to the node as the TSL names it. */
	public function test_a_pair_target_keeps_its_partition_token(): void {
		$this->write_tsl( 'vicuna-lane', "make_node Remote_Source pull:okapi okapi-7 /var/vicuna/off /var/vicuna/dl ledger.p{partition}:lane-sink.p{partition}\n" );

		$this->assertSame( [ [ 'pull:okapi', 'lane-sink.p{partition}' ] ], Topology_Analyzer::graph_for( 'vicuna-lane' )['edges'] );
		$this->assertSame( [ 'lane-sink.p{partition}' ], \array_column( Topology_Analyzer::expand( [ 'vicuna-lane' ] )['edges'], 'to' ) );
	}

	public function test_graph_for_splits_a_config_token_source_outside_its_brackets(): void {
		\Newspack_Nodes\Core::register_config_namespace(
			'zeta_pairs',
			static fn ( string $key ): ?string => 'lane' === $key ? 'quagga-lane' : null
		);
		$this->write_tsl( 'vicuna-token', "make_node Remote_Source pull:okapi okapi-7 /var/vicuna/off /var/vicuna/dl '<zeta_pairs:lane>.p{partition}:lane-sink-3'\n" );

		$graph = Topology_Analyzer::graph_for( 'vicuna-token' );

		$this->assertSame( [ [ 'source' => '<zeta_pairs:lane>.p{partition}', 'target' => 'lane-sink-3' ] ], $graph['nodes'][0]['pairs'] );
		$this->assertContains( [ 'pull:okapi', 'lane-sink-3' ], $graph['edges'] );
	}

	/** A pair edge has a role of its own, and a disconnect on the broker leaves it. */
	public function test_a_pair_edge_carries_the_pair_role_and_outlives_a_disconnect(): void {
		$line = "make_node Remote_Source pull:okapi okapi-7 /var/vicuna/off /var/vicuna/dl ledger.p0:ledger-sink-5 errors.p0:errors-sink-6\n";
		$this->write_tsl( 'vicuna-cut', $line . "disconnect_node pull:okapi\n" );

		$edges = Topology_Analyzer::graph_for( 'vicuna-cut' )['edges'];
		$this->assertContains( [ 'pull:okapi', 'ledger-sink-5' ], $edges );
		$this->assertContains( [ 'pull:okapi', 'errors-sink-6' ], $edges );

		$expanded = [];
		foreach ( Topology_Analyzer::expand( [ 'vicuna-cut' ] )['edges'] as $edge ) {
			$expanded[ "{$edge['from']}>{$edge['to']}" ] = $edge;
		}
		$this->assertSame( [ 'pair' ], $expanded['pull:okapi>ledger-sink-5']['roles'] );
		$this->assertArrayNotHasKey( 'config_slots', $expanded['pull:okapi>ledger-sink-5'], 'no setter verb made a pair edge' );
		$this->assertSame( [ 'vicuna-cut' ], $expanded['pull:okapi>errors-sink-6']['origin'] );
	}

	/** The analyzer refuses the connect a load would refuse, so no reader draws it. */
	public function test_a_connect_onto_a_broker_fails_the_topology(): void {
		$this->write_tsl( 'vicuna-wired', "make_node Remote_Source pull:okapi okapi-7 /var/vicuna/off /var/vicuna/dl ledger.p0:ledger-sink-5\nconnect_node pull:okapi tapir-sink-8\n" );

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'pull:okapi takes no target: Remote_Source declares has_target false' );
		Topology_Analyzer::graph_for( 'vicuna-wired' );
	}

	/** @return array<string,array{string,string}> Label => a `make_node` line naming `<partition>`, then the span it names. */
	public static function angle_partition_lines(): array {
		return [
			'a bare pair source'          => [ "make_node Remote_Source pull:tapir tapir-3 /var/vicuna/off /var/vicuna/dl sources/php:php-errors ledger.p<partition>:ledger-sink-5\n", 'ledger.p<partition>:ledger-sink-5' ],
			'a double-quoted pair source' => [ "make_node Remote_Source pull:tapir tapir-3 /var/vicuna/off /var/vicuna/dl \"jobs.p<partition>:jobs-sink-6\"\n", '"jobs.p<partition>:jobs-sink-6"' ],
			'a single-quoted pair'        => [ "make_node Remote_Source pull:tapir tapir-3 /var/vicuna/off /var/vicuna/dl 'jobs.p<partition>:jobs-sink-7'\n", "'jobs.p<partition>:jobs-sink-7'" ],
			'a backticked pair'           => [ "make_node Remote_Source pull:tapir tapir-3 /var/vicuna/off /var/vicuna/dl `jobs.p<partition>:jobs-sink-7`\n", '`jobs.p<partition>:jobs-sink-7`' ],
			'a File_Tail source_file'     => [ "make_node File_Tail app:tail-6 /var/log/heron.<partition>.log /var/heron/off\n", '/var/log/heron.<partition>.log' ],
			'a target'                    => [ "make_node Remote_Source pull:tapir tapir-3 /var/vicuna/off /var/vicuna/dl jobs.p{partition}:jobs-sink.p<partition>\n", 'jobs.p{partition}:jobs-sink.p<partition>' ],
		];
	}

	/**
	 * The analyzer reads a line as the load would, so `<partition>`, which
	 * the Shell refuses however it is quoted, fails the topology.
	 *
	 * @param string $line The line.
	 * @param string $span The span the refusal names.
	 */
	#[\PHPUnit\Framework\Attributes\DataProvider( 'angle_partition_lines' )]
	public function test_angle_partition_fails_the_topology( string $line, string $span ): void {
		$this->write_tsl( 'vicuna-angle', $line );

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( "\"{$span}\": <partition> resolves before the node sees it; write {partition}" );
		Topology_Analyzer::graph_for( 'vicuna-angle' );
	}

	/** @return array<string,array{string,string}> Label => a line `make_node` refuses at load, then the refusal. */
	public static function partition_layout_lines(): array {
		return [
			'an unmarked argument'   => [ "make_node Remote_Source pull:okapi okapi-{partition} /var/vicuna/off /var/vicuna/dl firehose.p0:ledger-sink\n", "vault_id takes no {partition}" ],
			'a fixed offsetlog'      => [ "make_node File_Tail app:tail-8 /var/log/heron.{partition}.log /var/heron/off /var/heron/dl.{partition}\n", 'File_Tail app:tail-8: a per-partition source needs per-partition offsetlog and deadletter dirs; add {partition}' ],
			'a fixed deadletter'     => [ "make_node File_Tail app:tail-8 /var/log/heron.{partition}.log /var/heron/off.{partition} /var/heron/dl\n", 'File_Tail app:tail-8: a per-partition source needs per-partition offsetlog and deadletter dirs; add {partition}' ],
			'a Consumer, fixed offsetlog' => [ "make_node Consumer heron:consumer-8 /var/heron/log.p{partition} /var/heron/off /var/heron/dl.p{partition}\n", 'Consumer heron:consumer-8: a per-partition source needs per-partition offsetlog and deadletter dirs; add {partition}' ],
			'a Tail, fixed deadletter'    => [ "make_node Tail heron:tail-8 /var/heron/log.{partition} /var/heron/off.{partition} /var/heron/dl\n", 'Tail heron:tail-8: a per-partition source needs per-partition offsetlog and deadletter dirs; add {partition}' ],
		];
	}

	/**
	 * The analyzer refuses what the load would refuse of a line's partition
	 * layout, so `wp nodes activate` and `topologies save` refuse it too.
	 *
	 * @param string $line    The line.
	 * @param string $refusal What it is refused with.
	 */
	#[\PHPUnit\Framework\Attributes\DataProvider( 'partition_layout_lines' )]
	public function test_a_partition_layout_the_load_refuses_fails_the_topology( string $line, string $refusal ): void {
		$this->write_tsl( 'vicuna-layout', $line );

		try {
			Topology_Analyzer::graph_for( 'vicuna-layout' );
			$this->fail( 'the topology analyzed' );
		} catch ( \InvalidArgumentException $e ) {
			$this->assertStringContainsString( $refusal, \html_entity_decode( $e->getMessage(), \ENT_QUOTES ) );
		}
	}

	/** @return array<string,array{string}> Label => a line written in `{partition}`, or naming none. */
	public static function brace_partition_lines(): array {
		return [
			'a pair source'                 => [ "make_node Remote_Source pull:tapir tapir-3 /var/vicuna/off /var/vicuna/dl jobs.p{partition}:jobs-sink-7\n" ],
			'a per-worker File_Tail'        => [ "make_node File_Tail app:tail-7 /var/log/heron.{partition}.log /var/heron/off.{partition} /var/heron/dl.{partition}\n" ],
			'a fixed File_Tail, fixed dirs' => [ "make_node File_Tail app:tail-7 /var/log/heron.log /var/heron/off /var/heron/dl\n" ],
			'a target naming {partition}'   => [ "make_node Remote_Source pull:tapir tapir-3 /var/vicuna/off /var/vicuna/dl jobs.p{partition}:jobs-sink.p{partition}\n" ],
		];
	}

	/**
	 * `{partition}` reaches the node whole, so the line loads.
	 *
	 * @param string $line The line.
	 */
	#[\PHPUnit\Framework\Attributes\DataProvider( 'brace_partition_lines' )]
	public function test_a_brace_partition_loads( string $line ): void {
		$this->write_tsl( 'vicuna-brace', $line );

		$this->assertCount( 1, Topology_Analyzer::graph_for( 'vicuna-brace' )['nodes'] );
	}

	public function test_graph_for_one_arg_disconnect_removes_included_edges_before_rewire(): void {
		$this->write_tsl(
			'wombat-base',
			"make_node Consumer zebra:consumer /var/wombat/zebra.p{partition} /var/wombat/zebra-offset.p{partition}\n"
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
			"make_node Partition zebra:partition /var/wombat/zebra.log 4096 1 2 0\n"
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
