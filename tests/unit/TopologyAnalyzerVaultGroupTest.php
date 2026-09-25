<?php
/**
 * The flatten appends each Vault_Group's children, so every static reader —
 * the write set, the GC, the graph, the aggregator — sees the nodes the
 * runtime group builds, and sees them change with the Vault.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Shell_Node;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Topology_Analyzer;
use Newspack_Nodes\Topology_Registry;
use Newspack_Nodes\Vault;

#[CoversClass( Topology_Analyzer::class )]
class TopologyAnalyzerVaultGroupTest extends TestCase {

	private const PULL_LAB = <<<'TSL'
make_node Tee sync-4
make_node Vault_Group firehose Remote_Source tw-edge firehose.p<partition> <config:offsets_dir>/<topology>.firehose.{id}.p<partition> <config:deadletter_dir>/<topology>.firehose.{id}.p<partition>
command_node firehose:config set_multi_writer true
connect_node firehose rewrite-17
connect_node sync-4 firehose
TSL;

	protected function setUp(): void {
		parent::setUp();
		Topology_Registry::reset();
		$this->stock_topology_dir( 'analyzer-vault-group-' );
		$this->seed_vault_servers(
			[
				'tw0'  => [ 'url' => 'https://tw0.example', 'group' => 'tw-edge' ],
				'tw9'  => [ 'url' => 'https://tw9.example', 'group' => 'tw-edge' ],
				'lone' => [ 'url' => 'https://lone.example' ],
				'aux'  => [ 'url' => 'https://aux.example', 'group' => 'llm' ],
			]
		);
	}

	protected function tearDown(): void {
		Topology_Registry::reset();
		Vault::get_instance()->reset_cache();
		parent::tearDown();
	}

	/** @return list<string> The flattened lines of `$name`. */
	private static function lines( string $name ): array {
		return \array_column( Topology_Analyzer::statements( $name )['statements'], 'line' );
	}

	public function test_flatten_keeps_the_group_and_derives_its_children(): void {
		$this->write_tsl( 'pull-lab', self::PULL_LAB );

		$lines   = self::lines( 'pull-lab' );
		$written = \explode( "\n", self::PULL_LAB );

		$this->assertSame( $written, \array_values( \array_intersect( $lines, $written ) ) );
		$this->assertContains( 'make_node Remote_Source firehose:tw9 tw9 firehose.p<partition> <config:offsets_dir>/<topology>.firehose.tw9.p<partition> <config:deadletter_dir>/<topology>.firehose.tw9.p<partition>', $lines );
		$this->assertContains( 'command_node firehose:tw9:config set_multi_writer true', $lines );
		$this->assertContains( 'connect_node firehose:tw9 rewrite-17', $lines );
		$this->assertContains( 'connect_node sync-4 firehose:tw9', $lines );
		$this->assertContains( 'connect_node sync-4 firehose:tw0', $lines );
		foreach ( [ 'lone', 'aux' ] as $outsider ) {
			$this->assertSame( [], \preg_grep( "/firehose:{$outsider}\\b/", $lines ), "{$outsider} is not in tw-edge" );
		}
	}

	public function test_each_derived_record_follows_the_statement_it_derives_from(): void {
		$this->write_tsl( 'pull-lab', self::PULL_LAB . "\ndisconnect_node sync-4 firehose\n" );

		$lines = self::lines( 'pull-lab' );
		$after = static fn ( string $line ): array => \array_slice( $lines, (int) \array_search( $line, $lines, true ) + 1, 2 );

		$this->assertSame( [ 'make_node Remote_Source firehose:tw0 tw0', 'make_node Remote_Source firehose:tw9 tw9' ], \array_map( static fn ( string $l ): string => \substr( $l, 0, 40 ), $after( $lines[1] ) ) );
		$this->assertSame( [ 'connect_node sync-4 firehose:tw0', 'connect_node sync-4 firehose:tw9' ], $after( 'connect_node sync-4 firehose' ) );
		$this->assertSame( [ 'disconnect_node sync-4 firehose:tw0', 'disconnect_node sync-4 firehose:tw9' ], $after( 'disconnect_node sync-4 firehose' ) );
		$edges = \array_map( static fn ( array $e ): string => "{$e[0]}>{$e[1]}", Topology_Analyzer::graph_for( 'pull-lab' )['edges'] );
		$this->assertSame( [], \preg_grep( '/^sync-4>firehose/', $edges ) );
	}

	public function test_a_later_line_on_a_child_outranks_the_groups_edge(): void {
		$this->write_tsl( 'pull-lab', self::PULL_LAB . "\nconnect_node firehose:tw0 audit-2\n" );

		$edges = \array_map( static fn ( array $e ): string => "{$e[0]}>{$e[1]}", Topology_Analyzer::graph_for( 'pull-lab' )['edges'] );

		$this->assertContains( 'firehose:tw0>audit-2', $edges );
		$this->assertNotContains( 'firehose:tw0>rewrite-17', $edges );
		$this->assertContains( 'firehose:tw9>rewrite-17', $edges );
	}

	public function test_only_a_fan_out_upstream_reaches_each_child(): void {
		$this->write_tsl( 'pull-lab', self::PULL_LAB . "\nmake_node Echo relay-8\nconnect_node relay-8 firehose\n" );

		$lines = self::lines( 'pull-lab' );

		$this->assertContains( 'connect_node sync-4 firehose:tw0', $lines );
		$this->assertSame( [], \preg_grep( '/^connect_node relay-8 firehose:/', $lines ) );
	}

	public function test_a_config_vault_id_derives_no_child(): void {
		Vault::get_instance()->add( 'config', [ 'url' => 'https://c.example', 'group' => 'tw-edge' ] );
		$this->write_tsl( 'pull-lab', self::PULL_LAB );

		$config = \preg_grep( '/firehose:config/', self::lines( 'pull-lab' ) );
		$this->assertSame( [ 'command_node firehose:config set_multi_writer true' ], \array_values( $config ) );
		$this->assertSame( [], \preg_grep( '/firehose\.config\./', Topology_Analyzer::write_set( 'pull-lab' ) ) );
	}

	public function test_a_written_node_suppresses_the_child_of_that_name(): void {
		$this->write_tsl( 'pull-lab', "make_node Echo firehose:tw9\n" . self::PULL_LAB );

		$lines = self::lines( 'pull-lab' );

		$this->assertSame( [], \preg_grep( '/^make_node Remote_Source firehose:tw9/', $lines ) );
		$this->assertNotContains( 'connect_node firehose:tw9 rewrite-17', $lines );
		$this->assertContains( 'connect_node firehose:tw0 rewrite-17', $lines );
		$this->assertNotContains( 'offsetlog:<config:offsets_dir>/pull-lab.firehose.tw9.p<partition>', Topology_Analyzer::write_set( 'pull-lab' ) );
	}

	public function test_a_quoted_child_argument_splits_like_a_written_line(): void {
		$this->write_tsl( 'pull-lab', "make_node Vault_Group firehose Remote_Source tw-edge 'fire hose.p<partition>' '<config:offsets_dir>/my cursor.{id}.p<partition>'\n" );
		$written = Shell_Node::parse_statements( "make_node Remote_Source firehose:tw9 tw9 'fire hose.p<partition>' '<config:offsets_dir>/my cursor.tw9.p<partition>'" )[0];

		$derived = \array_column( Topology_Analyzer::statements( 'pull-lab' )['statements'], null, 'line' )[ $written['raw'] ];

		$this->assertSame( $written['values'], $derived['values'] );
		$this->assertSame( $written['spans'], $derived['spans'] );
		$this->assertContains( 'offsetlog:<config:offsets_dir>/my cursor.tw9.p<partition>', Topology_Analyzer::write_set( 'pull-lab' ) );
		$nodes = \array_column( Topology_Analyzer::graph_for( 'pull-lab' )['nodes'], null, 'name' );
		$this->assertSame( [ 'tw9', "'fire hose.p<partition>'", "'<config:offsets_dir>/my cursor.tw9.p<partition>'" ], $nodes['firehose:tw9']['args'] );
	}

	public function test_a_derived_record_reads_like_a_written_one(): void {
		$this->write_tsl( 'pull-lab', self::PULL_LAB );

		$by_line = \array_column( Topology_Analyzer::statements( 'pull-lab' )['statements'], null, 'line' );
		$child   = $by_line['command_node firehose:tw0:config set_multi_writer true'];

		$this->assertSame( 'command_node', $child['verb'] );
		$this->assertSame( [ 'command_node', 'firehose:tw0:config', 'set_multi_writer', 'true' ], $child['values'] );
		$this->assertSame( $child['values'], $child['spans'] );
	}

	public function test_a_fan_out_path_through_the_group_is_copied_per_child(): void {
		$this->write_tsl( 'pull-lab', self::PULL_LAB . "\nconnect_node sync-4 firehose/x\n" );

		$lines = self::lines( 'pull-lab' );

		$this->assertContains( 'connect_node sync-4 firehose:tw0/x', $lines );
		$this->assertContains( 'connect_node sync-4 firehose:tw9/x', $lines );
	}

	public function test_disconnect_naming_the_group_is_copied_per_child(): void {
		$this->write_tsl( 'pull-lab', self::PULL_LAB . "\ndisconnect_node sync-4 firehose\n" );

		$lines = self::lines( 'pull-lab' );

		$this->assertContains( 'disconnect_node sync-4 firehose:tw0', $lines );
		$this->assertContains( 'disconnect_node sync-4 firehose:tw9', $lines );
	}

	public function test_write_set_holds_each_child_cursor(): void {
		$this->write_tsl( 'pull-lab', self::PULL_LAB );

		$set = Topology_Analyzer::write_set( 'pull-lab' );

		$this->assertContains( 'offsetlog:<config:offsets_dir>/pull-lab.firehose.tw9.p<partition>', $set );
		$this->assertContains( 'deadletter:<config:deadletter_dir>/pull-lab.firehose.tw0.p<partition>', $set );
		$this->assertNotContains( 'offsetlog:<config:offsets_dir>/pull-lab.firehose.lone.p<partition>', $set );
	}

	public function test_vault_change_is_seen_after_reset_caches(): void {
		$this->write_tsl( 'pull-lab', self::PULL_LAB );
		Topology_Analyzer::statements( 'pull-lab' );

		Vault::get_instance()->add( 'tw5', [ 'url' => 'https://tw5.example', 'group' => 'tw-edge' ] );
		Topology_Analyzer::reset_caches();

		$this->assertContains( 'connect_node firehose:tw5 rewrite-17', self::lines( 'pull-lab' ) );
	}

	public function test_graph_draws_each_child_with_the_group_include_as_origin(): void {
		$this->write_tsl( 'pull-lab', self::PULL_LAB );

		$graph = Topology_Analyzer::expand( [ 'pull-lab' ] );
		$nodes = \array_column( $graph['nodes'], null, 'name' );

		$this->assertSame( 'Remote_Source', $nodes['firehose:tw9']['class'] );
		$this->assertSame( [ 'pull-lab' ], $nodes['firehose:tw9']['origin'] );
		$this->assertContains( 'firehose:tw0', $graph['hulls']['pull-lab'] );
		$edges = \array_map( static fn ( array $e ): string => "{$e['from']}>{$e['to']}", $graph['edges'] );
		$this->assertContains( 'firehose:tw9>rewrite-17', $edges );
	}

	public function test_a_copied_edge_keeps_the_include_that_wrote_it(): void {
		$this->write_tsl( 'pull-base', "make_node Vault_Group firehose Remote_Source tw-edge firehose.p<partition>\n" );
		$this->write_tsl( 'sync-base', "make_node Tee sync-4\nconnect_node sync-4 firehose\n" );

		$edges = \array_column(
			\array_map(
				static fn ( array $e ): array => [ "{$e['from']}>{$e['to']}", $e['origin'] ],
				Topology_Analyzer::expand( [ 'pull-base', 'sync-base' ] )['edges']
			),
			1,
			0
		);

		$this->assertSame( [ 'sync-base' ], $edges['sync-4>firehose'] );
		$this->assertSame( [ 'sync-base' ], $edges['sync-4>firehose:tw0'] );
		$this->assertSame( [ 'sync-base' ], $edges['sync-4>firehose:tw9'] );
	}
}
