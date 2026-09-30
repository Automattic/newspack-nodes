<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Ledger_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * A Ledger: one SQLite file every partition declaring it writes, holding
 * write-once rows clustered by their time, appended in one transaction a
 * request and dropped past the lifespan rather than stored.
 */
#[CoversClass( Ledger_Node::class )]
final class LedgerNodeTest extends TestCase {
	private const T = 1790000400;

	private const ROWS_SQL = 'CREATE TABLE rows ( t INTEGER NOT NULL, k TEXT NOT NULL, x TEXT NOT NULL, w INTEGER NOT NULL, s INTEGER NOT NULL, c0 REAL NOT NULL, c1 REAL NOT NULL, c2 REAL NOT NULL, PRIMARY KEY ( t, k, x, w, s ) ) WITHOUT ROWID';

	private string $dir = '';
	private Capture_Sink_Node $sink;
	private Command_Interpreter_Node $interpreter;

	/** Nanoseconds each read of the pinned monotonic clock advances. */
	private int $step = 0;

	protected function setUp(): void {
		parent::setUp();
		$this->dir = $this->make_temp_dir( 'ledger-' );
		$this->use_base_dir( $this->dir );
		Core::$clock         = static fn (): float => (float) self::T;
		$ns                  = 0;
		$step                = &$this->step;
		Ledger_Node::$hrtime = static function () use ( &$ns, &$step ): int {
			$ns += $step;
			return $ns;
		};
		$this->sink        = new Capture_Sink_Node();
		$this->interpreter = new Command_Interpreter_Node();
		$this->interpreter->name( '_command_interpreter' );
		$this->interpreter->sink( new Capture_Sink_Node() );
	}

	protected function tearDown(): void {
		Ledger_Node::$hrtime = null;
		Core::$clock         = null;
		unset( Core::$var['partition'] );
		$this->rmdir_recursive( $this->dir );
		parent::tearDown();
	}

	/** `make_node Ledger <name> <args…>` in partition `$partition`'s worker. */
	private function ledger( string $partition, string $name, string ...$args ): Ledger_Node {
		Core::$var['partition'] = $partition;
		$ledger                 = $this->interpreter->make_node( 'Ledger', $name, ...$args );
		$this->assertInstanceOf( Ledger_Node::class, $ledger );
		$ledger->sink( $this->sink );
		return $ledger;
	}

	/** The kea Ledger: qty summed, lo its minimum, hi its maximum. */
	private function kea( string $partition = '3' ): Ledger_Node {
		return $this->ledger( $partition, 'lab-7:kea', '600', '3', 'qty', 'lo:min', 'hi:max' );
	}

	/**
	 * Fill one APPEND request and answer the reply's TYPE and VALUE.
	 *
	 * @param mixed $rows The APPEND's rows.
	 * @return array{0: int, 1: mixed}
	 */
	private function append( Ledger_Node $ledger, mixed $rows, int $ns = 0 ): array {
		$this->step                = $ns;
		$this->sink->captured      = [];
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_REQUEST | Message::TM_STRUCT;
		$message[ Message::FROM ]  = 'flame:stats/sku-41';
		$message[ Message::ID ]    = 'id-41';
		$message[ Message::VALUE ] = [ 'APPEND' => $rows ];
		$ledger->fill( $message );
		$this->assertCount( 1, $this->sink->captured );
		$reply = $this->sink->captured[0];
		$this->assertSame( [ $ledger->name(), 'flame:stats/sku-41', 'id-41' ], [ $reply[ Message::FROM ], $reply[ Message::TO ], $reply[ Message::ID ] ], 'answered TO its FROM, ID echoed' );
		return [ $reply[ Message::TYPE ], $reply[ Message::VALUE ] ];
	}

	/** @return array{0: int, 1: array{verb: string, data: array{stored: int, dropped: int}}} */
	private static function appended( int $stored, int $dropped ): array {
		return [
			Message::TM_STRUCT | Message::TM_RESPONSE,
			[
				'verb' => 'APPEND',
				'data' => [
					'stored'  => $stored,
					'dropped' => $dropped,
				],
			],
		];
	}

	/** Every row of a Ledger's file, in key order, as raw PDO reads it. */
	private function rows( string $name ): array {
		$db = new \PDO( 'sqlite:' . Ledger_Node::file( $name ) );
		return $db->query( 'SELECT * FROM rows' )->fetchAll( \PDO::FETCH_NUM );
	}

	/** The `rows` table's declaration as the file holds it. */
	private function rows_sql( string $name ): string {
		$db = new \PDO( 'sqlite:' . Ledger_Node::file( $name ) );
		return (string) $db->query( "SELECT sql FROM sqlite_master WHERE name = 'rows'" )->fetchColumn();
	}

	public function test_make_node_creates_the_one_file_with_its_rows_table_in_wal(): void {
		$this->kea();
		$this->assertSame( "{$this->dir}/ledgers/lab-7:kea.sqlite", Ledger_Node::file( 'lab-7:kea' ) );
		$this->assertFileExists( Ledger_Node::file( 'lab-7:kea' ) );
		$this->assertSame( self::ROWS_SQL, $this->rows_sql( 'lab-7:kea' ) );
		$db = new \PDO( 'sqlite:' . Ledger_Node::file( 'lab-7:kea' ) );
		$this->assertSame( 'wal', $db->query( 'PRAGMA journal_mode' )->fetchColumn() );
		$this->assertSame( [ 'rows' ], $db->query( "SELECT name FROM sqlite_master WHERE type IN ( 'table', 'index' )" )->fetchAll( \PDO::FETCH_COLUMN ), 'no secondary index' );
	}

	public function test_an_append_stores_its_row_and_answers_the_count(): void {
		$kea = $this->kea();
		$this->assertSame( self::appended( 1, 0 ), $this->append( $kea, [ [ self::T, 'sku-41', 'aisle-9', [ 3, 2.5, 7 ] ] ] ) );
		$rows = $this->rows( 'lab-7:kea' );
		$this->assertCount( 1, $rows );
		[ $t, $k, $x, $w, , $qty, $lo, $hi ] = $rows[0];
		$this->assertSame( [ self::T, 'sku-41', 'aisle-9', 3, 3.0, 2.5, 7.0 ], [ $t, $k, $x, $w, $qty, $lo, $hi ] );
	}

	public function test_a_row_past_the_lifespan_is_dropped_and_counted_and_one_on_its_edge_is_stored(): void {
		$kea         = $this->kea();
		Core::$clock = static fn (): float => (float) ( self::T + 3 * 600 + 1 );
		$this->assertSame(
			self::appended( 1, 1 ),
			$this->append( $kea, [ [ self::T, 'sku-41', 'aisle-9', [ 3, 2.5, 7 ] ], [ self::T + 1, 'sku-43', 'aisle-12', [ 4, 1.5, 9 ] ] ] )
		);
		$this->assertSame( [ [ self::T + 1, 'sku-43' ] ], \array_map( static fn ( array $row ): array => [ $row[0], $row[1] ], $this->rows( 'lab-7:kea' ) ) );
	}

	public function test_a_late_row_inside_the_lifespan_lands_in_its_own_time(): void {
		$kea         = $this->kea();
		Core::$clock = static fn (): float => (float) ( self::T + 3 * 600 - 1 );
		$this->assertSame( self::appended( 1, 0 ), $this->append( $kea, [ [ self::T, 'sku-41', 'aisle-9', [ 3, 2.5, 7 ] ] ] ) );
		$this->assertSame( self::T, $this->rows( 'lab-7:kea' )[0][0] );
	}

	public function test_two_appends_to_one_key_both_store_under_different_sequences(): void {
		$kea = $this->kea();
		$this->append( $kea, [ [ self::T, 'sku-41', 'aisle-9', [ 3, 2.5, 7 ] ] ] );
		$this->assertSame( self::appended( 1, 0 ), $this->append( $kea, [ [ self::T, 'sku-41', 'aisle-9', [ 5, 1.5, 8 ] ] ] ) );
		$rows = $this->rows( 'lab-7:kea' );
		$this->assertCount( 2, $rows );
		$this->assertNotSame( $rows[0][4], $rows[1][4], 'each delta carries its own s' );
		$this->assertSame( [ 3.0, 5.0 ], \array_map( static fn ( array $row ): float => $row[5], $rows ) );
	}

	public function test_one_append_may_carry_two_deltas_for_one_key(): void {
		$kea = $this->kea();
		$this->assertSame(
			self::appended( 2, 0 ),
			$this->append( $kea, [ [ self::T, 'sku-41', 'aisle-9', [ 3, 2.5, 7 ] ], [ self::T, 'sku-41', 'aisle-9', [ 5, 1.5, 8 ] ] ] )
		);
		$this->assertCount( 2, $this->rows( 'lab-7:kea' ) );
	}

	public function test_two_partitions_write_the_one_file_each_under_its_own_w(): void {
		$three = $this->kea( '3' );
		// Each partition's worker is its own process, so each holds the name.
		Core::unregister_node( 'lab-7:kea' );
		$five = $this->kea( '5' );
		$this->assertSame( [ 'stored' => 1, 'dropped' => 0 ], $three->append( [ [ self::T, 'sku-41', 'aisle-9', [ 3, 2.5, 7 ] ] ] ) );
		$this->assertSame( [ 'stored' => 1, 'dropped' => 0 ], $five->append( [ [ self::T, 'sku-41', 'aisle-9', [ 5, 1.5, 8 ] ] ] ) );
		$this->assertSame( [ 'stored' => 1, 'dropped' => 0 ], $three->append( [ [ self::T, 'sku-43', 'aisle-12', [ 4, 0.5, 9 ] ] ] ), 'each connection writes after the other committed' );
		$this->assertSame(
			[ [ 'sku-41', 3 ], [ 'sku-41', 5 ], [ 'sku-43', 3 ] ],
			\array_map( static fn ( array $row ): array => [ $row[1], $row[3] ], $this->rows( 'lab-7:kea' ) )
		);
		$this->assertSame( 5000, Ledger_Node::BUSY_TIMEOUT_MS );
		foreach ( [ $three, $five ] as $writer ) {
			$db = ( new \ReflectionProperty( Ledger_Node::class, 'db' ) )->getValue( $writer );
			$this->assertSame( Ledger_Node::BUSY_TIMEOUT_MS, (int) $db->query( 'PRAGMA busy_timeout' )->fetchColumn(), 'a writer finding the lock held waits rather than failing' );
		}
	}

	public function test_a_ledger_declaring_no_columns_is_a_set_that_stores_a_member_once(): void {
		$wren = $this->ledger( '3', 'lab-7:wren', '600', '3' );
		$this->assertSame( 'CREATE TABLE rows ( t INTEGER NOT NULL, k TEXT NOT NULL, x TEXT NOT NULL, PRIMARY KEY ( t, k, x ) ) WITHOUT ROWID', $this->rows_sql( 'lab-7:wren' ) );
		$this->assertSame( self::appended( 1, 0 ), $this->append( $wren, [ [ self::T, 'sku-41', 'aisle-9', [] ] ] ) );
		$this->assertSame( self::appended( 0, 0 ), $this->append( $wren, [ [ self::T, 'sku-41', 'aisle-9', [] ] ] ) );
		$this->assertSame( [ [ self::T, 'sku-41', 'aisle-9' ] ], $this->rows( 'lab-7:wren' ) );
	}

	public function test_a_bad_row_refuses_the_whole_append_on_the_error_plane(): void {
		$kea  = $this->kea();
		$good = [ self::T, 'sku-41', 'aisle-9', [ 3, 2.5, 7 ] ];
		$this->assertSame( [ Message::TM_ERROR, "APPEND: row 1: key is empty or holds whitespace\n" ], $this->append( $kea, [ $good, [ self::T, 'sku 43', 'aisle-9', [ 3, 2.5, 7 ] ] ] ) );
		$this->assertSame( [ Message::TM_ERROR, "APPEND: row 2: key is empty or holds whitespace\n" ], $this->append( $kea, [ $good, $good, [ self::T, "sku-41\nAPPEND: row 0: forged", 'aisle-9', [ 3, 2.5, 7 ] ] ] ), 'a key never reaches the reply, so it stays one line' );
		$this->assertSame( [ Message::TM_ERROR, "APPEND: row 0: 2 columns, the Ledger declares 3\n" ], $this->append( $kea, [ [ self::T, 'sku-41', 'aisle-9', [ 3, 2.5 ] ] ] ) );
		$this->assertSame( [ Message::TM_ERROR, "APPEND: row 1: needs [ t, k, x, [ columns… ] ], t whole seconds and each column a number\n" ], $this->append( $kea, [ $good, [ (string) self::T, 'sku-41', 'aisle-9', [ 3, 2.5, 7 ] ] ] ) );
		$this->assertSame( [ Message::TM_ERROR, "APPEND: row 0: needs [ t, k, x, [ columns… ] ], t whole seconds and each column a number\n" ], $this->append( $kea, [ [ self::T, 'sku-41', 'aisle-9', [ 3, 'lots', 7 ] ] ] ) );
		$this->assertSame( [ Message::TM_ERROR, "APPEND: needs a list of [ t, k, x, [ columns… ] ] rows\n" ], $this->append( $kea, 'sku-41' ) );
		$this->assertSame( [], $this->rows( 'lab-7:kea' ), 'a refused append stores none of its rows' );
	}

	public function test_a_declaration_it_cannot_keep_throws_naming_it(): void {
		foreach (
			[
				[ [ '600', '3', 'qty:avg' ], 'qty:avg' ],
				[ [ '600', '3', 'qty', 'qty:max' ], 'qty' ],
				[ [ '600', '3', 'q ty' ], 'q ty' ],
				[ [ '600' ], 'num_segments' ],
				[ [ '0', '3', 'qty' ], 'segment_seconds' ],
			] as [ $args, $named ]
		) {
			try {
				$this->ledger( '3', 'lab-7:owl', ...$args );
				$this->fail( 'make_node Ledger lab-7:owl ' . \implode( ' ', $args ) . ' built' );
			} catch ( \InvalidArgumentException $e ) {
				$this->assertStringContainsString( \esc_html( $named ), $e->getMessage() );
			}
			$this->assertNull( Core::node( 'lab-7:owl' ), 'a refused Ledger stays unregistered' );
		}
	}

	public function test_a_writer_needs_a_bound_partition_and_a_name_that_names_a_file(): void {
		$ledger = new Ledger_Node();
		$ledger->name( 'lab-7:kea' );
		try {
			$ledger->arguments( [ '600', '3', 'qty' ] );
			$this->fail( 'a Ledger opened with no partition bound' );
		} catch ( \RuntimeException $e ) {
			$this->assertSame( 'Ledger lab-7:kea: a writer needs a bound partition', $e->getMessage() );
		}
		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( 'Ledger name ../kea cannot name a file' );
		Ledger_Node::file( '../kea' );
	}

	public function test_a_file_another_declaration_made_refuses_to_open(): void {
		$this->kea();
		Core::unregister_node( 'lab-7:kea' );
		try {
			$this->ledger( '5', 'lab-7:kea', '600', '3', 'qty', 'lo:min' );
			$this->fail( 'a two-column Ledger opened a three-column file' );
		} catch ( \RuntimeException $e ) {
			$this->assertSame( 'Ledger lab-7:kea: ' . Ledger_Node::file( 'lab-7:kea' ) . ' holds a rows table another declaration made; `wp nodes tables flush` drops the rows written under it and declares this one', $e->getMessage() );
		}
		$this->assertSame( self::ROWS_SQL, $this->rows_sql( 'lab-7:kea' ), 'the file is as its first writer declared it' );
	}

	public function test_traffic_other_than_a_request_is_refused_and_goes_nowhere(): void {
		$kea                       = $this->kea();
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_STRUCT;
		$message[ Message::FROM ]  = 'flame:stats';
		$message[ Message::VALUE ] = [ self::T, 'sku-41', 'aisle-9', [ 3, 2.5, 7 ] ];
		$logged                    = [];
		$hook                      = static function ( string $line ) use ( &$logged ): void {
			$logged[] = $line;
		};
		\add_action( 'newspack_nodes/stderr', $hook );
		try {
			$kea->fill( $message );
		} finally {
			\remove_action( 'newspack_nodes/stderr', $hook );
		}
		$this->assertSame( [], $this->sink->captured );
		$this->assertSame( [], $this->rows( 'lab-7:kea' ) );
		$this->assertCount( 1, $logged );
		$this->assertStringContainsString( 'lab-7:kea: ERROR: a Ledger answers requests only - from: flame:stats', $logged[0] );
	}

	public function test_the_counters_tally_calls_rows_asked_and_rows_stored(): void {
		$kea = $this->kea();
		$zero = [ 'calls' => 0, 'asked' => 0, 'answered' => 0, 'bytes' => 0, 'total_ms' => 0.0, 'max_ms' => 0.0 ];
		$this->assertSame( \array_fill_keys( [ 'APPEND', 'SUM', 'TOP', 'MEMBERS' ], $zero ), $kea->stats() );
		Core::$clock = static fn (): float => (float) ( self::T + 3 * 600 + 1 );
		$this->append( $kea, [ [ self::T, 'sku-41', 'aisle-9', [ 3, 2.5, 7 ] ], [ self::T + 900, 'sku-43', 'aisle-12', [ 4, 1.5, 9 ] ] ], 1250000 );
		$this->append( $kea, [ [ self::T + 900, 'sku-41', 'aisle-9', [ 5, 0.5, 8 ] ] ], 2500000 );
		$this->assertSame( [ 'calls' => 2, 'asked' => 3, 'answered' => 2, 'bytes' => 0, 'total_ms' => 3.75, 'max_ms' => 2.5 ], $kea->stats()['APPEND'] );
		$this->assertSame( $kea->stats(), $kea->dump_node()['verb_stats'] );
		$this->assertSame( [ 'verb_stats' => $kea->stats() ], $kea->dump_metadata() );
	}
}
