<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Topology_Registry;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * Topology_Registry::expand() — the console's composed-graph baseline for an
 * include SET, with provenance (`origin` lists every top-level include that
 * provides a node; `via` is the path it first entered through).
 */
#[CoversClass( Topology_Registry::class )]
class TopologyRegistryExpandTest extends TestCase {

	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		Topology_Registry::reset();
		$this->tmp = $this->make_temp_dir( 'topology-expand-' );
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

	/**
	 * Quote type carries interpolation semantics (double interpolates <...>,
	 * single/backtick defer), so the console-facing records keep each authored
	 * arg as ONE raw span -- never shredded on whitespace, never re-quoted.
	 */
	public function test_expand_keeps_quoted_args_as_raw_spans(): void {
		$this->write_tsl(
			'vicuna-quoted',
			"make_node Topic vicuna-jobs <config:logs_dir>/jobs.p'<partition>' 4\n"
			. 'cmd vicuna-jobs:config add_profile "Engineers care about uptime"' . "\n"
		);

		$out    = Topology_Registry::expand( [ 'vicuna-quoted' ] );
		$byName = [];
		foreach ( $out['nodes'] as $node ) {
			$byName[ $node['name'] ] = $node;
		}

		$this->assertSame(
			[ "<config:logs_dir>/jobs.p'<partition>'", '4' ],
			$byName['vicuna-jobs']['args']
		);
		$this->assertSame(
			[
				[
					'verb' => 'add_profile',
					'args' => [ '"Engineers care about uptime"' ],
				],
			],
			$byName['vicuna-jobs']['verbs']
		);
	}

	public function test_graph_for_keeps_quoted_ctor_args_as_raw_spans(): void {
		$this->write_tsl(
			'vicuna-graphed',
			"make_node Hook vicuna-hook wp_loaded \"a b c\"\n"
		);

		$graph  = Topology_Registry::graph_for( 'vicuna-graphed' );
		$byName = [];
		foreach ( $graph['nodes'] as $node ) {
			$byName[ $node['name'] ] = $node;
		}

		$this->assertSame( [ 'wp_loaded', '"a b c"' ], $byName['vicuna-hook']['args'] );
	}

	public function test_frontmatter_splices_a_backslash_continuation_with_nothing(): void {
		// bash semantics: the backslash-newline is removed outright, so `1\` +
		// `6` reads 16 — a space join would corrupt it to `1 6`.
		$this->write_tsl( 'vicuna-folded', "var num_partitions = 1\\\n6\nmake_node Echo vicuna-echo\n" );

		$this->assertSame(
			[ 'num_partitions' => '16' ],
			Topology_Registry::frontmatter( 'vicuna-folded' )
		);
	}

	public function test_expand_tags_a_diamond_shared_node_with_both_origins(): void {
		$this->write_tsl( 'wombat-base', "make_node Tee shared-tee\n" );
		$this->write_tsl( 'wombat-left', "include wombat-base\nmake_node Echo left-echo\nconnect_node left-echo shared-tee\n" );
		$this->write_tsl( 'wombat-right', "include wombat-base\nmake_node Echo right-echo\n" );

		$out    = Topology_Registry::expand( [ 'wombat-left', 'wombat-right' ] );
		$byName = [];
		foreach ( $out['nodes'] as $node ) {
			$byName[ $node['name'] ] = $node;
		}

		$this->assertSame( [ 'wombat-left', 'wombat-right' ], $byName['shared-tee']['origin'] );
		$this->assertSame( [ 'wombat-left', 'wombat-base' ], $byName['shared-tee']['via'] );
		$this->assertSame( [ 'wombat-left' ], $byName['left-echo']['origin'] );
		$this->assertSame( 'Echo', $byName['right-echo']['class'] );
		$this->assertContains(
			[ 'from' => 'left-echo', 'to' => 'shared-tee', 'origin' => [ 'wombat-left' ], 'roles' => [ 'connect' ] ],
			$out['edges']
		);
		// The tree is DECLARED structure, not expansion order: wombat-right
		// declares `include wombat-base` too, so it shows there as well, even
		// though `#pragma once` expanded those statements only under -left.
		$this->assertSame(
			[
				'wombat-left'  => [ 'wombat-base' => [] ],
				'wombat-right' => [ 'wombat-base' => [] ],
			],
			$out['tree']
		);
	}

	public function test_expand_carries_ctor_args_and_target_edges(): void {
		$this->write_tsl(
			'wombat-args',
			"make_node Grep zebra-grep giraffe-pattern\n"
			. "make_node Partition zebra:partition /var/wombat/zebra.log <partition> 1 2 0\n"
			. "cmd zebra-grep:config set_errors_target zebra:partition\n"
		);

		$out    = Topology_Registry::expand( [ 'wombat-args' ] );
		$byName = [];
		foreach ( $out['nodes'] as $node ) {
			$byName[ $node['name'] ] = $node;
		}

		$this->assertSame( [ 'giraffe-pattern' ], $byName['zebra-grep']['args'] );
		$this->assertContains(
			[ 'from' => 'zebra-grep', 'to' => 'zebra:partition', 'origin' => [ 'wombat-args' ], 'roles' => [ 'config' ], 'config_slots' => [ 'set_errors_target' ] ],
			$out['edges']
		);
	}

	public function test_expand_carries_config_verbs_on_the_node_record(): void {
		// A borrowed node's config verbs (the checkboxes the inspector shows —
		// void_warranty here, plus a with_index that takes an arg) must ride on
		// the node record so the console can show what's ticked. A set_*target
		// stays an EDGE, never a verb.
		$this->write_tsl(
			'wombat-verbs',
			"make_node Partition zebra:partition /var/wombat/zebra.log <partition> 1 2 0\n"
			. "make_node Echo giraffe-errors\n"
			. "cmd zebra:partition:config void_warranty\n"
			. "cmd zebra:partition:config with_index quokka-idx\n"
			. "cmd zebra:partition:config set_errors_target giraffe-errors\n"
		);

		$out    = Topology_Registry::expand( [ 'wombat-verbs' ] );
		$byName = [];
		foreach ( $out['nodes'] as $node ) {
			$byName[ $node['name'] ] = $node;
		}

		$this->assertSame(
			[
				[ 'verb' => 'void_warranty', 'args' => [] ],
				[ 'verb' => 'with_index', 'args' => [ 'quokka-idx' ] ],
			],
			$byName['zebra:partition']['verbs']
		);
		$this->assertContains(
			[ 'from' => 'zebra:partition', 'to' => 'giraffe-errors', 'origin' => [ 'wombat-verbs' ], 'roles' => [ 'config' ], 'config_slots' => [ 'set_errors_target' ] ],
			$out['edges']
		);
	}

	public function test_expand_resolves_a_config_token_in_a_named_target_slot(): void {
		\Newspack_Nodes\Core::register_config_namespace(
			'wombat_expand',
			static fn ( string $key ): ?string => 'stats_sink' === $key ? 'violet-flame-stats-947' : null
		);
		$this->write_tsl(
			'wombat-config-target',
			"make_node Echo cerulean-flame-builder-619\n"
			. "make_node Partition violet-flame-stats-947 /var/wombat/stats.p<partition> 1 2 0\n"
			. "cmd cerulean-flame-builder-619:config set_stats_target <wombat_expand:stats_sink>\n"
		);

		$this->assertContains(
			[
				'from'         => 'cerulean-flame-builder-619',
				'to'           => 'violet-flame-stats-947',
				'origin'       => [ 'wombat-config-target' ],
				'roles'        => [ 'config' ],
				'config_slots' => [ 'set_stats_target' ],
			],
			Topology_Registry::expand( [ 'wombat-config-target' ] )['edges']
		);
	}

	public function test_expand_empty_config_token_clears_only_its_named_target_slot(): void {
		\Newspack_Nodes\Core::register_config_namespace(
			'wombat_expand',
			static fn ( string $key ): ?string => 'disabled_stats_sink' === $key ? '' : null
		);
		$this->write_tsl(
			'wombat-empty-config-target',
			"make_node Echo cerulean-flame-builder-619\n"
			. "make_node Echo amber-completed-731\n"
			. "make_node Echo violet-old-stats-947\n"
			. "cmd cerulean-flame-builder-619:config set_stats_target violet-old-stats-947\n"
			. "cmd cerulean-flame-builder-619:config set_completed_target amber-completed-731\n"
			. "cmd cerulean-flame-builder-619:config set_stats_target <wombat_expand:disabled_stats_sink>\n"
		);

		$this->assertSame(
			[
				[
					'from'         => 'cerulean-flame-builder-619',
					'to'           => 'amber-completed-731',
					'origin'       => [ 'wombat-empty-config-target' ],
					'roles'        => [ 'config' ],
					'config_slots' => [ 'set_completed_target' ],
				],
			],
			Topology_Registry::expand( [ 'wombat-empty-config-target' ] )['edges']
		);
	}

	public function test_expand_throws_on_an_unknown_include(): void {
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'no-such-topology' );
		Topology_Registry::expand( [ 'no-such-topology' ] );
	}

	/**
	 * The interpreter aliases `make` to `make_node` and honors `disconnect_node`
	 * (one-arg = clear the sink). A static expander that ignores either one paints
	 * a graph the runtime never builds — ELN's own performance.tsl uses BOTH.
	 */
	public function test_expand_honors_the_make_alias_and_disconnect_node(): void {
		$this->write_tsl(
			'wombat-wiring',
			"make_node Consumer zebra:consumer /tmp/z.log 0\n"
			. "make_node Echo zebra-sink\n"
			. "make Tee zebra:tee\n"
			. "connect_node zebra:consumer zebra-sink\n"
			. "disconnect_node zebra:consumer\n"
			. "connect_node zebra:consumer zebra:tee\n"
			. "connect_node zebra:tee zebra-sink\n"
		);

		$out    = Topology_Registry::expand( [ 'wombat-wiring' ] );
		$names  = \array_column( $out['nodes'], 'name' );
		$edges  = \array_map(
			static fn ( array $e ): string => $e['from'] . '->' . $e['to'],
			$out['edges']
		);

		$this->assertContains( 'zebra:tee', $names, '`make` is a make_node alias' );
		$this->assertNotContains(
			'zebra:consumer->zebra-sink',
			$edges,
			'disconnect_node must remove the edge it disconnects'
		);
		$this->assertContains( 'zebra:consumer->zebra:tee', $edges );
		$this->assertContains( 'zebra:tee->zebra-sink', $edges );
	}

	/** Two-arg disconnect_node drops only that edge (a Tee keeps its others). */
	public function test_expand_two_arg_disconnect_drops_only_that_edge(): void {
		$this->write_tsl(
			'wombat-tee',
			"make_node Tee zebra:tee\n"
			. "make_node Echo giraffe-sink\n"
			. "make_node Echo llama-sink\n"
			. "connect_node zebra:tee giraffe-sink\n"
			. "connect_node zebra:tee llama-sink\n"
			. "disconnect_node zebra:tee giraffe-sink\n"
		);

		$edges = \array_map(
			static fn ( array $e ): string => $e['from'] . '->' . $e['to'],
			Topology_Registry::expand( [ 'wombat-tee' ] )['edges']
		);

		$this->assertNotContains( 'zebra:tee->giraffe-sink', $edges );
		$this->assertContains( 'zebra:tee->llama-sink', $edges );
	}

	public function test_expand_preserves_config_routing_and_reports_active_edge_roles(): void {
		$this->write_tsl(
			'wombat-roles',
			"make_node Echo zebra-source\n"
			. "make_node Tee zebra:tee\n"
			. "make_node Echo giraffe-connect\n"
			. "make_node Echo ibex-config\n"
			. "cmd zebra-source:config set_errors_target ibex-config\n"
			. "connect_node zebra-source giraffe-connect\n"
			. "disconnect_node zebra-source ibex-config\n"
		);

		$out     = Topology_Registry::expand( [ 'wombat-roles' ] );
		$by_name = [];
		foreach ( $out['nodes'] as $node ) {
			$by_name[ $node['name'] ] = $node;
		}

		$this->assertFalse( $by_name['zebra-source']['fans_out'] );
		$this->assertTrue( $by_name['zebra:tee']['fans_out'] );
		$this->assertSame(
			[
				[
					'from'   => 'zebra-source',
					'to'     => 'ibex-config',
					'origin' => [ 'wombat-roles' ],
					'roles'  => [ 'config' ],
					'config_slots' => [ 'set_errors_target' ],
				],
			],
			$out['edges']
		);
	}

	public function test_expand_unions_origins_when_regular_includes_repeat_the_same_connection(): void {
		$shared = "make_node Echo zebra-source\n"
			. "make_node Echo giraffe-target\n"
			. "connect_node zebra-source giraffe-target\n";
		$this->write_tsl( 'wombat-left', $shared );
		$this->write_tsl( 'wombat-right', $shared );

		$this->assertSame(
			[
				[
					'from'   => 'zebra-source',
					'to'     => 'giraffe-target',
					'origin' => [ 'wombat-left', 'wombat-right' ],
					'roles'  => [ 'connect' ],
				],
			],
			Topology_Registry::expand( [ 'wombat-left', 'wombat-right' ] )['edges']
		);
	}

	public function test_expand_uses_tap_fanout_and_targeted_disconnect_semantics(): void {
		$this->write_tsl(
			'wombat-tap-fanout',
			"make_node Tap zebra-tap\n"
			. "make_node Echo giraffe-removed\n"
			. "make_node Echo ibex-kept-557\n"
			. "connect_node zebra-tap giraffe-removed\n"
			. "connect_node zebra-tap ibex-kept-557\n"
			. "disconnect_node zebra-tap giraffe-removed\n"
		);

		$out = Topology_Registry::expand( [ 'wombat-tap-fanout' ] );

		$this->assertTrue( $out['nodes'][0]['fans_out'] );
		$this->assertSame(
			[
				[
					'from'   => 'zebra-tap',
					'to'     => 'ibex-kept-557',
					'origin' => [ 'wombat-tap-fanout' ],
					'roles'  => [ 'connect' ],
				],
			],
			$out['edges']
		);
	}

	public function test_expand_tracks_config_setters_as_independent_replacing_slots(): void {
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
				[
					'from'   => 'zebra-source',
					'to'     => 'llama-completed',
					'origin' => [ 'wombat-config-slots' ],
					'roles'  => [ 'config' ],
					'config_slots' => [ 'set_completed_target' ],
				],
				[
					'from'   => 'zebra-source',
					'to'     => 'ibex-current-errors',
					'origin' => [ 'wombat-config-slots' ],
					'roles'  => [ 'config' ],
					'config_slots' => [ 'set_errors_target' ],
				],
			],
			Topology_Registry::expand( [ 'wombat-config-slots' ] )['edges']
		);
	}

	public function test_expand_empty_config_setter_clears_only_its_named_slot(): void {
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
			[
				[
					'from'   => 'zebra-source',
					'to'     => 'llama-completed',
					'origin' => [ 'wombat-empty-config-slot' ],
					'roles'  => [ 'config' ],
					'config_slots' => [ 'set_completed_target' ],
				],
			],
			Topology_Registry::expand( [ 'wombat-empty-config-slot' ] )['edges']
		);
	}

	public function test_expand_evaluates_a_shared_include_once_while_unioning_top_level_provenance(): void {
		$this->write_tsl(
			'wombat-shared',
			"make_node Echo zebra-source\n"
			. "make_node Echo giraffe-shared\n"
			. "make_node Tee ibex-tee\n"
			. "make_node Echo kudu-shared\n"
			. "connect_node zebra-source giraffe-shared\n"
			. "connect_node ibex-tee kudu-shared\n"
		);
		$this->write_tsl(
			'wombat-left',
			"include wombat-shared\n"
			. "make_node Echo llama-left\n"
			. "connect_node zebra-source llama-left\n"
		);
		$this->write_tsl(
			'wombat-right',
			"include wombat-shared\n"
			. "make_node Echo okapi-right\n"
		);

		$out     = Topology_Registry::expand( [ 'wombat-left', 'wombat-right' ] );
		$by_name = [];
		foreach ( $out['nodes'] as $node ) {
			$by_name[ $node['name'] ] = $node;
		}

		$this->assertSame( [ 'wombat-left', 'wombat-right' ], $by_name['zebra-source']['origin'] );
		$this->assertSame( [ 'wombat-left', 'wombat-shared' ], $by_name['zebra-source']['via'] );
		$this->assertNotContains(
			[ 'from' => 'zebra-source', 'to' => 'giraffe-shared', 'origin' => [ 'wombat-left', 'wombat-right' ], 'roles' => [ 'connect' ] ],
			$out['edges'],
			'The right-hand include must not re-run a pragma-once shared connect after the left-hand rewire.'
		);
		$this->assertContains(
			[ 'from' => 'zebra-source', 'to' => 'llama-left', 'origin' => [ 'wombat-left' ], 'roles' => [ 'connect' ] ],
			$out['edges']
		);
		$this->assertContains(
			[ 'from' => 'ibex-tee', 'to' => 'kudu-shared', 'origin' => [ 'wombat-left', 'wombat-right' ], 'roles' => [ 'connect' ] ],
			$out['edges']
		);
	}

	public function test_expand_deduplicates_repeated_direct_include_provenance(): void {
		$this->write_tsl(
			'wombat-repeated',
			"make_node Echo zebra-source\n"
			. "make_node Echo giraffe-target\n"
			. "connect_node zebra-source giraffe-target\n"
		);

		$out = Topology_Registry::expand( [ 'wombat-repeated', 'wombat-repeated' ] );

		$this->assertSame( [ 'wombat-repeated' ], $out['nodes'][0]['origin'] );
		$this->assertSame( [ 'wombat-repeated' ], $out['edges'][0]['origin'] );
	}

	/**
	 * Only the TOP-LEVEL file's `var` frontmatter is honored (frontmatter() reads
	 * that file alone), so an included `var` is silently ignored: the line is
	 * skipped without a word and the sibling nodes still parse.
	 */
	public function test_an_included_var_is_silently_ignored(): void {
		$this->write_tsl( 'wombat-varbase', "var num_partitions = 7\nmake_node Echo zebra-echo\n" );
		$this->write_tsl( 'wombat-vartop', "include wombat-varbase\n" );

		$buf = '';
		\Newspack_Nodes\Core::set_stderr_handler(
			static function ( $message ) use ( &$buf ): void {
				$buf .= $message;
			}
		);

		$out = Topology_Registry::expand( [ 'wombat-vartop' ] );

		// The included `var` is skipped without a warning...
		$this->assertSame( '', $buf, 'an included `var` is ignored silently' );
		// ...and the sibling make_node still lands.
		$this->assertSame( [ 'zebra-echo' ], $out['hulls']['wombat-varbase'] );
	}

	/**
	 * Hulls are drawn for NESTED includes too, not just the directly-declared
	 * ones — so the canvas needs, for every topology at ANY depth, the nodes it
	 * provides. `origin` (top-level) and `via` (first path) can't answer that:
	 * a node two levels down belongs to BOTH hulls.
	 */
	public function test_expand_reports_the_node_set_of_every_include_at_every_depth(): void {
		$this->write_tsl( 'wombat-leaf', "make_node Echo leaf-echo\n" );
		$this->write_tsl( 'wombat-mid', "include wombat-leaf\nmake_node Echo mid-echo\n" );
		$this->write_tsl( 'wombat-top', "include wombat-mid\nmake_node Echo top-echo\n" );

		$out = Topology_Registry::expand( [ 'wombat-top' ] );

		// One entry per topology in the tree — including the nested ones.
		$this->assertSame(
			[ 'wombat-top', 'wombat-mid', 'wombat-leaf' ],
			\array_keys( $out['hulls'] )
		);
		// The outer hull contains everything it brings, transitively.
		$this->assertSame(
			[ 'leaf-echo', 'mid-echo', 'top-echo' ],
			$this->sorted( $out['hulls']['wombat-top'] )
		);
		$this->assertSame( [ 'leaf-echo', 'mid-echo' ], $this->sorted( $out['hulls']['wombat-mid'] ) );
		$this->assertSame( [ 'leaf-echo' ], $this->sorted( $out['hulls']['wombat-leaf'] ) );
	}

	/** @return list<string> */
	private function sorted( array $names ): array {
		\sort( $names );
		return $names;
	}

	/**
	 * `expand()` and `graph_for()` are two walks over one statement stream, and
	 * they had drifted on this exact line: expand built the config-target with
	 * `implode( ' ', array_slice( $values, 3 ) )` while graph_for used
	 * `$values[3] ?? ''`. The RUNTIME reads `$args[0]` — a single token — so
	 * graph_for matched it and expand did not. The same TSL line yielded a
	 * different edge target depending on which reader you asked.
	 */
	public function test_both_walks_agree_on_a_config_target_with_trailing_tokens(): void {
		$this->write_tsl(
			'wombat-drift',
			"make_node Partition zebra:partition /var/wombat/zebra.log <partition> 1 2 0\n"
			. "make_node Echo giraffe-errors\n"
			. "make_node Echo second-token\n"
			. "cmd zebra:partition:config set_errors_target giraffe-errors second-token\n"
		);

		$expanded = Topology_Registry::expand( [ 'wombat-drift' ] );
		$graph    = Topology_Registry::graph_for( 'wombat-drift' );

		$expand_targets = [];
		foreach ( $expanded['edges'] as $edge ) {
			if ( 'zebra:partition' === $edge['from'] ) {
				$expand_targets[] = $edge['to'];
			}
		}
		$graph_targets = [];
		foreach ( $graph['edges'] as $edge ) {
			if ( 'zebra:partition' === $edge[0] ) {
				$graph_targets[] = $edge[1];
			}
		}

		$this->assertSame(
			$graph_targets,
			$expand_targets,
			'one statement stream must yield one edge target'
		);
		$this->assertSame(
			[ 'giraffe-errors' ],
			$expand_targets,
			'the runtime reads $args[0]; extra tokens are not part of the target'
		);
	}
}
