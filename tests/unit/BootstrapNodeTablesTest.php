<?php
/**
 * `Bootstrap::node_tables()`: each declared Table resolved per partition
 * across the active topologies; `Bootstrap::mount_table()`: those partitions
 * mounted into the request graph.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Config;
use Newspack_Nodes\Core;
use Newspack_Nodes\Failures;
use Newspack_Nodes\Message;
use Newspack_Nodes\Node;
use Newspack_Nodes\Node_Names;
use Newspack_Nodes\Sqlite_Arm;
use Newspack_Nodes\Table_Node;
use Newspack_Nodes\Table_Unavailable;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Topology_Registry;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Bootstrap::class )]
final class BootstrapNodeTablesTest extends TestCase {
	private string $base  = '';
	private string $stock = '';

	/** @var \Closure|null The catalog-read counter, while one is installed. */
	private ?\Closure $counter = null;

	protected function setUp(): void {
		parent::setUp();
		$this->base = $this->make_temp_dir( 'node-tables-' );
		$this->use_base_dir( $this->base );
		Topology_Registry::reset();
		Core::register_config_namespace(
			'lab',
			static fn ( string $key ): ?string => [ 'store' => 'sqlite', 'bin' => 'kea-bin' ][ $key ] ?? null
		);
		$this->stock = $this->stock_topology_dir( 'node-tables-stock-' );
		$this->write_tsl( 'kea-a', "var num_partitions = 2\nmake_node Table lab-7:kea kea:p{partition} 777 sqlite\n" );
		$this->write_tsl( 'kea-b', "var num_partitions = 3\nmake_node Table lab-7:kea kea:p{partition} 900 sqlite\n" );
		$this->write_tsl( 'kea-token', "var num_partitions = 2\nmake_node Table lab-7:kea kea:p{partition} 777 <lab:store>\n" );
		$this->write_tsl( 'owl-a', "var num_partitions = 2\nmake_node Table lab-7:owl owl:p{partition} 37 wpdb\n" );
		$this->write_tsl( 'owl-c', "var num_partitions = 3\nmake_node Table lab-7:owl owl:p{partition} 37 wpdb\n" );
		$this->write_tsl( 'owl-echo', "var num_partitions = 4\nmake_node Echo lab-7:owl\n" );
		$this->write_tsl( 'emu-a', "var num_partitions = 2\nmake_node Table lab-7:emu emu:<topology>:p{partition} 37 wpdb\n" );
		$this->write_tsl( 'emu-b', "var num_partitions = 2\nmake_node Table lab-7:emu emu:<topology>:p{partition} 37 wpdb\n" );
		$this->write_tsl( 'ibis-bare', "var num_partitions = 2\nmake_node Table lab-7:ibis ibis:p{partition} 37\n" );
		$this->write_tsl( 'ibis-spelled', "var num_partitions = 3\nmake_node Table lab-7:ibis ibis:p{partition} 37 auto\n" );
		$this->write_tsl( 'crawl-a', "var num_partitions = 2\nmake_node Crawler crawl-8821 4407\n" );
		$this->write_tsl( 'yak-a', "make_node Table lab-7:yak yak:p{partition} 3x7 wpdb\n" );
		$this->write_tsl( 'yak-zero', "make_node Table lab-7:yak yak:p{partition} 0 wpdb\n" );
		$this->write_tsl( 'yak-negative', "make_node Table lab-7:yak yak:p{partition} -3 wpdb\n" );
		$this->write_tsl( 'yak-bare', "make_node Table lab-7:yak yak:p{partition}\n" );
		$this->write_tsl( 'heron-token', "var num_partitions = 2\nmake_node Table lab-7:heron <lab:bin>:p{partition} 37 wpdb\n" );
		$this->write_tsl( 'heron-literal', "var num_partitions = 3\nmake_node Table lab-7:heron kea-bin:p{partition} 37 wpdb\n" );
		$this->write_tsl( 'heron-nope', "make_node Table lab-7:heron <lab:nope>:p{partition} 37 wpdb\n" );
	}

	protected function tearDown(): void {
		if ( null !== $this->counter ) {
			\remove_action( 'newspack_nodes/topologies', $this->counter );
		}
		unset( Core::$config_resolvers['lab'] );
		\delete_option( 'newspack_nodes_topologies' );
		Config::reset();
		Topology_Registry::reset();
		$this->rmdir_recursive( $this->stock );
		$this->rmdir_recursive( $this->base );
		parent::tearDown();
	}

	/**
	 * Each named partition's SQLite file, created as its worker creates it,
	 * holding `sku-{p}` under the `{bird}:p{p}` namespace every `.tsl` here
	 * declares.
	 *
	 * @param string $table         A declared `lab-7:{bird}` Table.
	 * @param int    ...$partitions Its partitions.
	 */
	private function write_files( string $table, int ...$partitions ): void {
		$bird = \substr( $table, \strlen( 'lab-7:' ) );
		foreach ( $partitions as $p ) {
			( new Sqlite_Arm( Table_Node::file( $table, $p ), 'kea:p3' ) )->set( "{$bird}:p{$p}:sku-{$p}", "{$table}.p{$p}", 0 );
		}
	}

	private function activate( string ...$names ): void {
		\update_option( 'newspack_nodes_topologies', $names );
		Config::reset();
	}

	public function test_a_declared_table_resolves_per_partition(): void {
		$this->activate( 'kea-a' );
		$this->assertSame(
			[
				'lab-7:kea' => [
					0 => [ 'namespace' => 'kea:p0', 'ttl' => 777, 'backend' => 'sqlite' ],
					1 => [ 'namespace' => 'kea:p1', 'ttl' => 777, 'backend' => 'sqlite' ],
				],
			],
			Bootstrap::node_tables( 'lab-7:kea' )
		);
	}

	public function test_a_crawler_s_seen_table_resolves_per_partition(): void {
		$this->activate( 'crawl-a' );
		$this->assertSame(
			[
				'crawl-8821:seen' => [
					0 => [ 'namespace' => 'crawl-8821', 'ttl' => 4407, 'backend' => 'sqlite' ],
					1 => [ 'namespace' => 'crawl-8821', 'ttl' => 4407, 'backend' => 'sqlite' ],
				],
			],
			Bootstrap::node_tables( 'crawl-8821:seen' )
		);
	}

	public function test_several_tables_resolve_from_one_catalog_read(): void {
		$this->activate( 'kea-a', 'owl-c' );
		$reads         = 0;
		$this->counter = static function ( array $topologies ) use ( &$reads ): array {
			++$reads;
			return $topologies;
		};
		\add_filter( 'newspack_nodes/topologies', $this->counter );
		$tables = Bootstrap::node_tables( 'lab-7:kea', 'lab-7:owl', 'lab-7:gone' );
		$this->assertSame( 1, $reads, 'every name shares one read of the active set' );
		$this->assertSame( [ 'lab-7:kea', 'lab-7:owl', 'lab-7:gone' ], \array_keys( $tables ) );
		$this->assertSame( [ 0, 1, 2 ], \array_keys( $tables['lab-7:owl'] ) );
		$this->assertSame( [], $tables['lab-7:gone'] );
	}

	public function test_a_backend_token_resolves(): void {
		$this->activate( 'kea-token' );
		$this->assertSame( 'sqlite', Bootstrap::node_tables( 'lab-7:kea' )['lab-7:kea'][1]['backend'] );
	}

	public function test_identical_declarations_union_their_partitions(): void {
		$this->activate( 'owl-a', 'owl-c' );
		$tables = Bootstrap::node_tables( 'lab-7:owl' )['lab-7:owl'];
		$this->assertSame( [ 0, 1, 2 ], \array_keys( $tables ) );
		$this->assertSame( [ 'namespace' => 'owl:p2', 'ttl' => 37, 'backend' => 'wpdb' ], $tables[2] );
	}

	public function test_a_declaration_spelling_out_its_default_backend_is_the_same_table(): void {
		$this->activate( 'ibis-bare', 'ibis-spelled' );
		$this->assertSame(
			[ 'namespace' => 'ibis:p2', 'ttl' => 37, 'backend' => 'auto' ],
			Bootstrap::node_tables( 'lab-7:ibis' )['lab-7:ibis'][2]
		);
	}

	public function test_a_namespace_token_resolves_as_the_worker_resolves_it(): void {
		$this->activate( 'heron-token' );
		$this->assertSame( 'kea-bin:p1', Bootstrap::node_tables( 'lab-7:heron' )['lab-7:heron'][1]['namespace'] );
	}

	public function test_a_namespace_spelled_by_token_or_literally_is_the_same_table(): void {
		$this->activate( 'heron-token', 'heron-literal' );
		$this->assertSame( [ 0, 1, 2 ], \array_keys( Bootstrap::node_tables( 'lab-7:heron' )['lab-7:heron'] ) );
	}

	public function test_a_namespace_token_nothing_resolves_is_refused(): void {
		$this->activate( 'heron-nope' );
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'unresolvable config token &lt;lab:nope&gt;: not owned by its namespace' );
		Bootstrap::node_tables( 'lab-7:heron' );
	}

	public function test_two_topologies_declaring_a_table_differently_is_refused(): void {
		$this->activate( 'kea-a', 'kea-b' );
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'Table lab-7:kea is declared differently by kea-a and kea-b' );
		Bootstrap::node_tables( 'lab-7:kea' );
	}

	public function test_a_topology_token_resolves_to_the_declaring_fleet(): void {
		$this->activate( 'emu-a' );
		$this->assertSame( 'emu:emu-a:p1', Bootstrap::node_tables( 'lab-7:emu' )['lab-7:emu'][1]['namespace'] );
	}

	public function test_one_line_naming_two_fleets_is_declared_differently(): void {
		$this->activate( 'emu-a', 'emu-b' );
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'Table lab-7:emu is declared differently by emu-a and emu-b' );
		Bootstrap::node_tables( 'lab-7:emu' );
	}

	public function test_a_ttl_that_is_not_a_whole_number_is_refused(): void {
		$this->activate( 'yak-a' );
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'Table lab-7:yak declares a TTL that is not a whole number of at least 1 second: 3x7' );
		Bootstrap::node_tables( 'lab-7:yak' );
	}

	public function test_a_ttl_below_one_second_is_refused(): void {
		foreach ( [ 'yak-zero' => '0', 'yak-negative' => '-3' ] as $topology => $ttl ) {
			$this->activate( $topology );
			try {
				Bootstrap::node_tables( 'lab-7:yak' );
				$this->fail( "a TTL of {$ttl} resolved" );
			} catch ( \RuntimeException $e ) {
				$this->assertSame( "Table lab-7:yak declares a TTL that is not a whole number of at least 1 second: {$ttl}", $e->getMessage() );
			}
		}
	}

	public function test_an_omitted_ttl_is_refused(): void {
		$this->activate( 'yak-bare' );
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'Table lab-7:yak declares no TTL' );
		Bootstrap::node_tables( 'lab-7:yak' );
	}

	public function test_a_node_of_the_same_name_that_is_no_table_contributes_nothing(): void {
		$this->activate( 'owl-echo', 'owl-a' );
		$this->assertSame( [ 0, 1 ], \array_keys( Bootstrap::node_tables( 'lab-7:owl' )['lab-7:owl'] ) );
	}

	public function test_an_undeclared_table_resolves_to_nothing(): void {
		$this->activate( 'kea-a' );
		$this->assertSame( [ 'lab-7:gone' => [] ], Bootstrap::node_tables( 'lab-7:gone' ) );
	}

	public function test_mount_table_mounts_every_partition_of_every_name_once(): void {
		$this->write_tsl( 'rook-a', "var num_partitions = 3\nmake_node Table lab-7:rook rook:p{partition} 37 sqlite\n" );
		$this->activate( 'kea-a', 'rook-a' );
		$this->write_files( 'lab-7:kea', 0, 1 );
		$this->write_files( 'lab-7:rook', 0, 1, 2 );
		Bootstrap::mount_request_graph();
		$this->assertSame(
			[
				'lab-7:kea'  => [ 0 => 'lab-7:kea.p0', 1 => 'lab-7:kea.p1' ],
				'lab-7:rook' => [ 0 => 'lab-7:rook.p0', 1 => 'lab-7:rook.p1', 2 => 'lab-7:rook.p2' ],
				'lab-7:gone' => [],
			],
			Bootstrap::mount_table( [ 'lab-7:kea', 'lab-7:rook', 'lab-7:gone' ] )
		);
		$this->assertSame( 'lab-7:rook.p2', Core::node( 'lab-7:rook.p2' )->lookup( 'sku-2' ) );
		$this->assertInstanceOf( Table_Node::class, Core::node( 'lab-7:kea.p1' ) );
		$this->assertSame( Core::node( Node_Names::COMMAND_INTERPRETER ), Core::node( 'lab-7:kea.p1' )->sink() );
	}

	public function test_mount_table_is_idempotent_within_a_request_and_builds_each_arm_once(): void {
		$this->activate( 'kea-a' );
		$this->write_files( 'lab-7:kea', 0, 1 );
		Bootstrap::mount_request_graph();
		$opens                 = 0;
		Sqlite_Arm::$available = static function () use ( &$opens ): bool {
			++$opens;
			return true;
		};
		try {
			$first   = Bootstrap::mount_table( [ 'lab-7:kea' ] );
			$mounted = Core::node( 'lab-7:kea.p1' );
			$again   = Bootstrap::mount_table( [ 'lab-7:kea' ] );
		} finally {
			Sqlite_Arm::$available = null;
		}
		$this->assertSame( [ 'lab-7:kea' => [ 0 => 'lab-7:kea.p0', 1 => 'lab-7:kea.p1' ] ], $again );
		$this->assertSame( $first, $again );
		$this->assertSame( 2, $opens, 'two partitions, each arm built once across both calls' );
		$this->assertSame( $mounted, Core::node( 'lab-7:kea.p1' ), 'the second call builds nothing' );
	}

	public function test_mount_table_reads_the_active_set_once_for_every_name(): void {
		$this->write_tsl( 'rook-a', "var num_partitions = 3\nmake_node Table lab-7:rook rook:p{partition} 37 sqlite\n" );
		$this->activate( 'kea-a', 'rook-a' );
		$this->write_files( 'lab-7:kea', 0, 1 );
		$this->write_files( 'lab-7:rook', 0, 1, 2 );
		Bootstrap::mount_request_graph();
		$reads         = 0;
		$this->counter = static function ( array $topologies ) use ( &$reads ): array {
			++$reads;
			return $topologies;
		};
		\add_filter( 'newspack_nodes/topologies', $this->counter );
		Bootstrap::mount_table( [ 'lab-7:kea', 'lab-7:rook' ] );
		$this->assertSame( 1, $reads );
	}

	public function test_mount_table_unmounts_what_it_built_before_a_partition_fails(): void {
		$this->write_tsl( 'rook-a', "var num_partitions = 3\nmake_node Table lab-7:rook rook:p{partition} 37 sqlite\n" );
		$this->activate( 'kea-a', 'rook-a' );
		$this->write_files( 'lab-7:kea', 0, 1 );
		$this->write_files( 'lab-7:rook', 0 );
		Bootstrap::mount_request_graph();
		\mkdir( "{$this->base}/tables/lab-7:rook.p1.sqlite", 0700, true );
		try {
			Bootstrap::mount_table( [ 'lab-7:kea', 'lab-7:rook' ] );
			$this->fail( 'a partition whose file cannot open must throw' );
		} catch ( \RuntimeException $e ) {
			$this->assertStringContainsString( 'Table lab-7:rook', $e->getMessage() );
		}
		foreach ( [ 'lab-7:kea.p0', 'lab-7:kea.p1', 'lab-7:rook.p0', 'lab-7:rook.p1' ] as $stem ) {
			$this->assertNull( Core::node( $stem ), $stem );
		}
	}

	public function test_mount_table_raises_a_backend_that_cannot_open_as_table_unavailable(): void {
		$this->write_tsl( 'rook-a', "var num_partitions = 3\nmake_node Table lab-7:rook rook:p{partition} 37 sqlite\n" );
		$this->activate( 'rook-a' );
		$this->write_files( 'lab-7:rook', 0, 1 );
		Bootstrap::mount_request_graph();
		\mkdir( "{$this->base}/tables/lab-7:rook.p2.sqlite", 0700, true );
		$e = $this->caught( static fn () => Bootstrap::mount_table( [ 'lab-7:rook' ] ), 'a partition whose file cannot open was mounted' );
		$this->assertInstanceOf( Table_Unavailable::class, $e, 'the rollback raises the one cause as it was thrown' );
		$this->assertStringStartsWith( 'Table lab-7:rook: sqlite backend could not open ', $e->getMessage() );
	}

	public function test_mount_table_raises_a_failed_teardown_beside_the_backend_that_could_not_open(): void {
		$this->write_tsl( 'rook-a', "var num_partitions = 3\nmake_node Table lab-7:rook rook:p{partition} 37 sqlite\n" );
		$this->activate( 'rook-a' );
		$this->write_files( 'lab-7:rook', 0, 1, 2 );
		Bootstrap::mount_request_graph();
		$refusal = new \LogicException( 'teardown refused-41' );
		$sibling = new class( $refusal ) extends Node {
			public function __construct( private \Throwable $refusal ) {
				parent::__construct();
			}

			public function remove_node(): void {
				parent::remove_node();
				throw $this->refusal;
			}
		};
		// Opening p2: give the built p0 a teardown that refuses, then refuse p2.
		Sqlite_Arm::$available = static function () use ( $sibling ): bool {
			if ( null === Core::node( 'lab-7:rook.p2' ) ) {
				return true;
			}
			\Closure::bind(
				function ( Node $stub ): void {
					$this->publish_sibling( 'rook', $stub );
				},
				Core::node( 'lab-7:rook.p0' ),
				Node::class
			)( $sibling );
			return false;
		};
		try {
			$e = $this->caught(
				static function (): void {
					Bootstrap::mount_table( [ 'lab-7:rook' ] );
				},
				'a partition whose backend cannot open was mounted'
			);
		} finally {
			Sqlite_Arm::$available = null;
		}
		$this->assertInstanceOf( Failures::class, $e );
		$this->assertInstanceOf( Table_Unavailable::class, $e->getPrevious() );
		$this->assertSame( 'Table lab-7:rook: sqlite backend needs the pdo_sqlite extension', $e->getPrevious()->getMessage() );
		$this->assertSame( $refusal, $e->all()[1] );
		$this->assertNull( Core::node( 'lab-7:rook.p0' ) );
	}

	public function test_mount_table_raises_a_declaration_it_refuses_as_no_table_unavailable(): void {
		Bootstrap::mount_request_graph();
		foreach ( [ 'kea' => [ 'kea-a', 'kea-b' ], 'yak' => [ 'yak-a' ] ] as $name => $topologies ) {
			$this->activate( ...$topologies );
			$e = $this->caught( static fn () => Bootstrap::mount_table( [ "lab-7:{$name}" ] ), "lab-7:{$name} was mounted" );
			$this->assertNotInstanceOf( Table_Unavailable::class, $e, $name );
			$this->assertStringStartsWith( "Table lab-7:{$name} ", $e->getMessage() );
		}
	}

	public function test_a_failed_mount_keeps_what_an_earlier_call_mounted(): void {
		$this->write_tsl( 'rook-a', "var num_partitions = 3\nmake_node Table lab-7:rook rook:p{partition} 37 sqlite\n" );
		$this->activate( 'kea-a', 'rook-a' );
		$this->write_files( 'lab-7:kea', 0, 1 );
		Bootstrap::mount_request_graph();
		Bootstrap::mount_table( [ 'lab-7:kea' ] );
		\mkdir( "{$this->base}/tables/lab-7:rook.p1.sqlite", 0700, true );
		try {
			Bootstrap::mount_table( [ 'lab-7:kea', 'lab-7:rook' ] );
			$this->fail( 'a partition whose file cannot open must throw' );
		} catch ( \RuntimeException $e ) {
			$this->assertInstanceOf( Table_Node::class, Core::node( 'lab-7:kea.p1' ), 'a mount this call did not build stays' );
		}
	}

	public function test_a_mounted_table_refuses_a_write_through_the_graph(): void {
		$this->activate( 'kea-a' );
		$this->write_files( 'lab-7:kea', 0, 1 );
		Bootstrap::mount_request_graph();
		Bootstrap::mount_table( [ 'lab-7:kea' ] );
		$asker = new Capture_Sink_Node();
		$asker->name( 'kea-asker' );
		foreach ( [ 'RM sku-41', 'TOUCH 37 sku-41' ] as $write ) {
			$request                   = Message::new_message();
			$request[ Message::TYPE ]  = Message::TM_REQUEST;
			$request[ Message::FROM ]  = 'kea-asker';
			$request[ Message::TO ]    = 'lab-7:kea.p1';
			$request[ Message::VALUE ] = $write;
			Core::node( Node_Names::COMMAND_INTERPRETER )->fill( $request );
		}
		$types = \array_map( static fn ( array $m ): int => Core::num_int( $m[ Message::TYPE ] ) & Message::TM_ERROR, $asker->captured );
		$this->assertSame( [ Message::TM_ERROR, Message::TM_ERROR ], $types );
	}

	public function test_node_tables_resolves_a_name_once_until_the_parsed_topologies_are_dropped(): void {
		$this->activate( 'kea-a' );
		$reads         = 0;
		$this->counter = static function ( array $topologies ) use ( &$reads ): array {
			++$reads;
			return $topologies;
		};
		\add_filter( 'newspack_nodes/topologies', $this->counter );
		Bootstrap::node_tables( 'lab-7:kea' );
		$this->assertSame( 777, Bootstrap::node_tables( 'lab-7:kea' )['lab-7:kea'][1]['ttl'] );
		$this->assertSame( 1, $reads, 'a name resolved in this request is not resolved again' );
		$this->write_tsl( 'kea-a', "var num_partitions = 2\nmake_node Table lab-7:kea kea:p{partition} 555 sqlite\n" );
		Topology_Registry::reset_basename_cache();
		$this->assertSame( 555, Bootstrap::node_tables( 'lab-7:kea' )['lab-7:kea'][1]['ttl'], 'a saved topology drops the memo' );
		$this->activate( 'kea-b' );
		$this->assertSame( [ 0, 1, 2 ], \array_keys( Bootstrap::node_tables( 'lab-7:kea' )['lab-7:kea'] ), 'an activation drops the memo' );
		$this->assertSame( 900, Bootstrap::node_tables( 'lab-7:kea' )['lab-7:kea'][2]['ttl'] );
	}

	public function test_the_active_set_invalidation_every_activation_shares_drops_the_memo(): void {
		$this->activate( 'kea-a' );
		$this->assertSame( 777, Bootstrap::node_tables( 'lab-7:kea' )['lab-7:kea'][1]['ttl'] );
		\update_option( 'newspack_nodes_topologies', [ 'kea-b' ] );
		Topology_Registry::invalidate_config_cache();
		$this->assertSame( 900, Bootstrap::node_tables( 'lab-7:kea' )['lab-7:kea'][2]['ttl'] );
	}

	public function test_node_tables_answers_every_name_it_was_asked_in_order(): void {
		$this->activate( 'kea-a', 'owl-c' );
		Bootstrap::node_tables( 'lab-7:owl' );
		$this->assertSame( [ 'lab-7:kea', 'lab-7:owl' ], \array_keys( Bootstrap::node_tables( 'lab-7:kea', 'lab-7:owl' ) ) );
	}

	public function test_a_partition_no_worker_has_written_mounts_empty_beside_one_that_has(): void {
		$this->activate( 'kea-a' );
		Bootstrap::mount_request_graph();
		$this->write_files( 'lab-7:kea', 0 );
		Bootstrap::mount_table( [ 'lab-7:kea' ] );
		$this->assertSame( 'lab-7:kea.p0', Core::node( 'lab-7:kea.p0' )->lookup( 'sku-0' ) );
		$asker = new Capture_Sink_Node();
		$asker->name( 'kea-asker' );
		$request                   = Message::new_message();
		$request[ Message::TYPE ]  = Message::TM_REQUEST;
		$request[ Message::FROM ]  = 'kea-asker';
		$request[ Message::TO ]    = 'lab-7:kea.p1';
		$request[ Message::VALUE ] = "MGET sku-0 sku-1\n";
		Core::node( Node_Names::COMMAND_INTERPRETER )->fill( $request );
		$this->assertSame( [ [ Message::TM_INFO, "MGET 0\n" ] ], \array_map( static fn ( array $m ): array => [ Core::num_int( $m[ Message::TYPE ] ), $m[ Message::VALUE ] ], $asker->captured ), 'no file is no data, not a failed read' );
		$this->assertFileDoesNotExist( "{$this->base}/tables/lab-7:kea.p1.sqlite" );
	}

	public function test_a_mount_creates_no_tables_directory(): void {
		$this->activate( 'kea-a' );
		Bootstrap::mount_request_graph();
		Bootstrap::mount_table( [ 'lab-7:kea' ] );
		$this->assertNull( Core::node( 'lab-7:kea.p1' )->lookup( 'sku-1' ) );
		$this->assertDirectoryDoesNotExist( "{$this->base}/tables" );
	}

	public function test_a_mount_refuses_a_process_running_as_root(): void {
		$this->activate( 'kea-a' );
		$this->write_files( 'lab-7:kea', 0, 1 );
		Bootstrap::mount_request_graph();
		\Newspack_Nodes\CLI::$uid_provider = static fn (): int => 0;
		$e = $this->caught( static fn () => Bootstrap::mount_table( [ 'lab-7:kea' ] ), 'a root process mounted a Table' );
		$this->assertNotInstanceOf( Table_Unavailable::class, $e, 'running as root is the operator\'s to fix, not a backend to degrade past' );
		$this->assertSame( "Table lab-7:kea: a sqlite mount refuses to run as root: a root reader leaves -wal and -shm files beside {$this->base}/tables/lab-7:kea.p0.sqlite that its worker cannot open", $e->getMessage() );
		$this->assertNull( Core::node( 'lab-7:kea.p0' ) );
	}

	public function test_a_mount_refuses_a_symlinked_tables_directory_even_with_no_file_in_it(): void {
		$this->activate( 'kea-a' );
		$elsewhere = $this->make_temp_dir( 'node-tables-elsewhere-' );
		\symlink( $elsewhere, "{$this->base}/tables" );
		Bootstrap::mount_request_graph();
		try {
			$e = $this->caught( static fn () => Bootstrap::mount_table( [ 'lab-7:kea' ] ), 'a symlinked tables directory was adopted' );
		} finally {
			\unlink( "{$this->base}/tables" );
		}
		$this->assertNotInstanceOf( Table_Unavailable::class, $e, 'an adoption refusal is the operator\'s to fix, not a backend to degrade past' );
		$this->assertStringContainsString( 'symlink or path traversal detected', $e->getMessage() );
	}

	public function test_is_active_reads_the_configured_set(): void {
		$this->activate( 'kea-a' );
		$this->assertTrue( Bootstrap::is_active( 'kea-a' ) );
		$this->assertFalse( Bootstrap::is_active( 'owl-a' ) );
	}

	public function test_mount_table_needs_a_request_graph(): void {
		$this->activate( 'kea-a' );
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'mount_table needs a request graph' );
		Bootstrap::mount_table( [ 'lab-7:kea' ] );
	}

	public function test_mount_table_escapes_a_name_that_cannot_name_a_file_once(): void {
		$this->write_tsl( 'rook-amp', "make_node Table lab&rook rook:p{partition} 37 sqlite\n" );
		$this->activate( 'rook-amp' );
		Bootstrap::mount_request_graph();
		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( 'Table name lab&amp;rook cannot name a file' );
		Bootstrap::mount_table( [ 'lab&rook' ] );
	}
}
