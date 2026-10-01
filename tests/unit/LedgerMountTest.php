<?php
/**
 * `Bootstrap::node_ledgers()`: each declared Ledger resolved once across the
 * active topologies; `Bootstrap::mount_ledger()`: every partition's file of
 * that Ledger mounted read-only into the request graph, under its own name.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\CLI;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Config;
use Newspack_Nodes\Core;
use Newspack_Nodes\Ledger_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Node_Names;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Topology_Registry;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Bootstrap::class )]
#[CoversClass( Ledger_Node::class )]
final class LedgerMountTest extends TestCase {
	private const T = 1790000400;

	private const KEA = [
		'segment_seconds' => 600,
		'num_segments'    => 3,
		'columns'         => [ 'qty:sum', 'lo:min', 'hi:max' ],
	];

	private string $base  = '';
	private string $stock = '';

	protected function setUp(): void {
		parent::setUp();
		$this->base = $this->make_temp_dir( 'ledger-mount-' );
		$this->use_base_dir( $this->base );
		Core::$clock = static fn (): float => (float) self::T;
		Topology_Registry::reset();
		Core::register_config_namespace( 'lab', static fn ( string $key ): ?string => [ 'span' => '600' ][ $key ] ?? null );
		$this->stock = $this->stock_topology_dir( 'ledger-mount-stock-' );
		$this->write_tsl( 'kea-a', "var num_partitions = 2\nmake_node Ledger lab-7:kea 600 3 qty lo:min hi:max\n" );
		$this->write_tsl( 'kea-b', "var num_partitions = 6\nmake_node Ledger lab-7:kea <lab:span> 3 qty lo:min hi:max\n" );
		$this->write_tsl( 'kea-c', "make_node Ledger lab-7:kea 600 3 qty\n" );
		$this->write_tsl( 'kea-d', "var num_partitions = 4\nmake_node Ledger lab-7:kea 600 3 qty:sum lo:min hi:max\n" );
		$this->write_tsl( 'yak-a', "make_node Ledger lab-7:yak 600 0 qty\n" );
		$this->write_tsl( 'owl-a', "make_node Ledger lab-7:owl 600 3 qty lo:min hi:max\nmake_node Table lab-7:emu emu:p<partition> 37 wpdb\n" );
	}

	protected function tearDown(): void {
		unset( Core::$config_resolvers['lab'], Core::$var['partition'] );
		Core::$clock = null;
		\delete_option( 'newspack_nodes_topologies' );
		Config::reset();
		Topology_Registry::reset();
		$this->rmdir_recursive( $this->stock );
		$this->rmdir_recursive( $this->base );
		parent::tearDown();
	}

	private function activate( string ...$names ): void {
		\update_option( 'newspack_nodes_topologies', $names );
		Config::reset();
	}

	/**
	 * Rows written by partition `$partition`'s worker, whose Ledger then leaves
	 * the graph, as a worker's does when its process ends.
	 *
	 * @param list<array{0: int, 1: string, 2: string, 3: list<int>}> $rows
	 */
	private function written( string $partition, string $name, array $rows, string ...$columns ): void {
		Core::$var['partition'] = $partition;
		$interpreter            = new Command_Interpreter_Node();
		$writer                 = $interpreter->make_node( 'Ledger', $name, '600', '3', ...( [] === $columns ? [ 'qty', 'lo:min', 'hi:max' ] : $columns ) );
		unset( Core::$var['partition'] );
		$this->assertInstanceOf( Ledger_Node::class, $writer );
		$writer->append( $rows );
		$writer->remove_node();
	}

	/**
	 * One request TO `$to`, filled into the request graph's interpreter, and
	 * the one reply routed back TO the asker.
	 *
	 * @return array{0: int, 1: mixed} The reply's TYPE and VALUE.
	 */
	private function ask( string $to, array $value ): array {
		$asker = Core::node( 'kea-asker' ) ?? new Capture_Sink_Node();
		$asker->name( 'kea-asker' );
		$asker->captured           = [];
		$request                   = Message::new_message();
		$request[ Message::TYPE ]  = Message::TM_REQUEST | Message::TM_STRUCT;
		$request[ Message::FROM ]  = 'kea-asker';
		$request[ Message::TO ]    = $to;
		$request[ Message::VALUE ] = $value;
		Core::node( Node_Names::COMMAND_INTERPRETER )->fill( $request );
		$this->assertCount( 1, $asker->captured );
		return [ Core::num_int( $asker->captured[0][ Message::TYPE ] ), $asker->captured[0][ Message::VALUE ] ];
	}

	public function test_a_declared_ledger_resolves_once_across_the_topologies_declaring_it_alike(): void {
		$this->activate( 'kea-a', 'kea-b' );
		$this->assertSame( [ 'lab-7:kea' => self::KEA ], Bootstrap::node_ledgers( 'lab-7:kea' ) );
	}

	public function test_a_column_spelled_with_or_without_its_default_aggregate_is_one_declaration(): void {
		$this->activate( 'kea-a', 'kea-d' );
		$this->assertSame( [ 'lab-7:kea' => self::KEA ], Bootstrap::node_ledgers( 'lab-7:kea' ) );
	}

	public function test_an_undeclared_ledger_resolves_to_null_and_a_table_is_no_ledger(): void {
		$this->activate( 'owl-a' );
		$this->assertSame( [ 'lab-7:gone' => null, 'lab-7:emu' => null ], Bootstrap::node_ledgers( 'lab-7:gone', 'lab-7:emu' ) );
	}

	public function test_two_topologies_declaring_a_ledger_differently_is_refused(): void {
		$this->activate( 'kea-a', 'kea-c' );
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'Ledger lab-7:kea is declared differently by kea-a and kea-c' );
		Bootstrap::node_ledgers( 'lab-7:kea' );
	}

	public function test_a_segment_count_below_one_is_refused(): void {
		$this->activate( 'yak-a' );
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'Ledger lab-7:yak declares a num_segments that is not a whole number of at least 1: 0' );
		Bootstrap::node_ledgers( 'lab-7:yak' );
	}

	public function test_a_saved_topology_drops_the_resolved_ledgers(): void {
		$this->activate( 'kea-a' );
		$this->assertSame( self::KEA, Bootstrap::node_ledgers( 'lab-7:kea' )['lab-7:kea'] );
		$this->write_tsl( 'kea-a', "var num_partitions = 2\nmake_node Ledger lab-7:kea 900 3 qty\n" );
		Topology_Registry::reset_basename_cache();
		$this->assertSame( [ 'segment_seconds' => 900, 'num_segments' => 3, 'columns' => [ 'qty:sum' ] ], Bootstrap::node_ledgers( 'lab-7:kea' )['lab-7:kea'] );
	}

	public function test_the_mount_answers_every_partitions_rows_under_the_ledgers_own_name(): void {
		$this->activate( 'kea-a' );
		$this->written( '3', 'lab-7:kea', [ [ self::T - 600, 'sku-41', 'aisle-9', [ 3, 7, 7 ] ] ] );
		$this->written( '5', 'lab-7:kea', [ [ self::T - 600, 'sku-41', 'aisle-9', [ 4, 2, 9 ] ], [ self::T, 'sku-41', 'aisle-12', [ 1, 5, 5 ] ] ] );
		Bootstrap::mount_request_graph();

		$this->assertSame( [ 'lab-7:kea' => 'lab-7:kea' ], Bootstrap::mount_ledger( [ 'lab-7:kea', 'lab-7:gone' ] ) );

		[ $type, $value ] = $this->ask( 'lab-7:kea', [ 'SUM' => [ 'from' => self::T - 1800, 'to' => self::T + 1, 'ks' => [ 'sku-41' ] ] ] );
		$this->assertSame( Message::TM_STRUCT | Message::TM_RESPONSE, $type );
		$this->assertEquals( [ [ 'sku-41', 'aisle-12', null, 1, 5, 5 ], [ 'sku-41', 'aisle-9', null, 7, 2, 9 ] ], $value['data'] );
		[ , $value ] = $this->ask( 'lab-7:kea', [ 'MEMBERS' => [ 'from' => self::T - 1800, 'to' => self::T + 1, 'k' => 'sku-41', 'limit' => 7 ] ] );
		$this->assertSame( [ 'aisle-12', 'aisle-9' ], $value['data'], 'the mount prepares every statement a read runs' );
		$this->assertSame( Core::node( Node_Names::COMMAND_INTERPRETER ), Core::node( 'lab-7:kea' )->sink() );
	}

	public function test_the_mount_refuses_an_append_and_stores_nothing(): void {
		$this->activate( 'kea-a' );
		$this->written( '3', 'lab-7:kea', [ [ self::T, 'sku-41', 'aisle-9', [ 3, 7, 7 ] ] ] );
		Bootstrap::mount_request_graph();
		Bootstrap::mount_ledger( [ 'lab-7:kea' ] );

		$this->assertSame(
			[ Message::TM_ERROR, "APPEND: a mounted Ledger serves reads only\n" ],
			$this->ask( 'lab-7:kea', [ 'APPEND' => [ [ self::T, 'sku-43', 'aisle-12', [ 1, 1, 1 ] ] ] ] )
		);
		$db = new \PDO( 'sqlite:' . Ledger_Node::file( 'lab-7:kea', 3 ) );
		$this->assertSame( 1, (int) $db->query( 'SELECT COUNT(*) FROM rows' )->fetchColumn() );
	}

	public function test_the_mount_refuses_a_flush(): void {
		$this->activate( 'kea-a' );
		$this->written( '3', 'lab-7:kea', [ [ self::T, 'sku-41', 'aisle-9', [ 3, 7, 7 ] ] ] );
		Bootstrap::mount_request_graph();
		Bootstrap::mount_ledger( [ 'lab-7:kea' ] );
		$e = $this->caught( static fn () => Core::node( 'lab-7:kea' )->flush( self::KEA['columns'] ), 'a mount flushed the file' );
		$this->assertSame( 'flush: lab-7:kea is a mounted Ledger, which serves reads only', $e->getMessage() );
	}

	public function test_the_mount_is_kept_for_the_rest_of_the_request(): void {
		$this->activate( 'kea-a' );
		$this->written( '3', 'lab-7:kea', [ [ self::T, 'sku-41', 'aisle-9', [ 3, 7, 7 ] ] ] );
		Bootstrap::mount_request_graph();
		Bootstrap::mount_ledger( [ 'lab-7:kea' ] );
		$mounted = Core::node( 'lab-7:kea' );
		Bootstrap::mount_ledger( [ 'lab-7:kea' ] );
		$this->assertSame( $mounted, Core::node( 'lab-7:kea' ), 'the second call builds nothing' );
	}

	public function test_the_mount_waits_on_a_busy_file_as_a_writer_does(): void {
		$this->activate( 'kea-a' );
		Bootstrap::mount_request_graph();
		Bootstrap::mount_ledger( [ 'lab-7:kea' ] );
		$db = ( new \ReflectionProperty( Ledger_Node::class, 'db' ) )->getValue( Core::node( 'lab-7:kea' ) );
		$this->assertSame( Ledger_Node::BUSY_TIMEOUT_MS, (int) $db->query( 'PRAGMA busy_timeout' )->fetchColumn() );
	}

	public function test_a_ledger_no_worker_has_written_mounts_empty_and_creates_nothing(): void {
		$this->activate( 'kea-a' );
		Bootstrap::mount_request_graph();
		Bootstrap::mount_ledger( [ 'lab-7:kea' ] );

		$this->assertSame( [ Message::TM_STRUCT | Message::TM_RESPONSE, [ 'verb' => 'SUM', 'data' => [] ] ], $this->ask( 'lab-7:kea', [ 'SUM' => [ 'from' => self::T - 1800, 'to' => self::T + 1, 'ks' => [ 'sku-41' ] ] ] ) );
		$this->assertSame( [ 'verb' => 'TOP', 'data' => [ 'total' => 0, 'rows' => [] ] ], $this->ask( 'lab-7:kea', [ 'TOP' => [ 'from' => self::T - 1800, 'to' => self::T + 1, 'ks' => [ 'sku-41' ], 'order_by' => 'qty', 'order' => 'desc', 'limit' => 7, 'offset' => 0 ] ] )[1] );
		$this->assertDirectoryDoesNotExist( "{$this->base}/ledgers" );
	}

	public function test_a_mount_refuses_a_file_another_declaration_made(): void {
		$this->activate( 'kea-a' );
		$this->written( '3', 'lab-7:kea', [ [ self::T, 'sku-41', 'aisle-9', [ 3 ] ] ], 'qty' );
		Bootstrap::mount_request_graph();
		$e = $this->caught( static fn () => Bootstrap::mount_ledger( [ 'lab-7:kea' ] ), 'a file of another shape was mounted' );
		$this->assertStringContainsString( 'Ledger lab-7:kea: ', $e->getMessage() );
		$this->assertStringContainsString( '`wp nodes tables flush`', $e->getMessage() );
		$this->assertNull( Core::node( 'lab-7:kea' ) );
	}

	public function test_a_failed_mount_unmounts_what_the_call_built(): void {
		$this->activate( 'kea-a', 'owl-a' );
		$this->written( '3', 'lab-7:kea', [ [ self::T, 'sku-41', 'aisle-9', [ 3, 7, 7 ] ] ] );
		$this->written( '3', 'lab-7:owl', [ [ self::T, 'sku-43', 'aisle-12', [ 2 ] ] ], 'qty' );
		Bootstrap::mount_request_graph();
		$this->caught( static fn () => Bootstrap::mount_ledger( [ 'lab-7:kea', 'lab-7:owl' ] ), 'a file of another shape was mounted' );
		$this->assertNull( Core::node( 'lab-7:kea' ), 'all or nothing' );
	}

	public function test_a_mount_refuses_a_process_running_as_root(): void {
		$this->activate( 'kea-a' );
		Bootstrap::mount_request_graph();
		CLI::$uid_provider = static fn (): int => 0;
		$e                 = $this->caught( static fn () => Bootstrap::mount_ledger( [ 'lab-7:kea' ] ), 'a root process mounted a Ledger' );
		$this->assertSame( "Ledger lab-7:kea: a sqlite mount refuses to run as root: a root reader leaves -wal and -shm files beside {$this->base}/ledgers/lab-7:kea.p*.sqlite that its worker cannot open", $e->getMessage() );
	}

	public function test_mount_ledger_needs_a_request_graph(): void {
		$this->activate( 'kea-a' );
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'mount_ledger needs a request graph' );
		Bootstrap::mount_ledger( [ 'lab-7:kea' ] );
	}

	public function test_mount_ledger_refuses_a_name_that_cannot_name_a_file_once_escaped(): void {
		$this->activate( 'kea-a' );
		Bootstrap::mount_request_graph();
		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( 'Ledger name lab&amp;kea cannot name a file' );
		Bootstrap::mount_ledger( [ 'lab&kea' ] );
	}
}
