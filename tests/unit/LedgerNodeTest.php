<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Config;
use Newspack_Nodes\Core;
use Newspack_Nodes\Ledger_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * A Ledger: one SQLite file per partition, which that partition's worker alone
 * writes, holding write-once rows clustered by their time, appended in one
 * transaction a request and dropped past the lifespan rather than stored.
 */
#[CoversClass( Ledger_Node::class )]
final class LedgerNodeTest extends TestCase {
	private const T = 1790000400;

	/** The kea Ledger's `rows`: qty a sum, NOT NULL; lo and hi nullable. */
	private const ROWS_SQL = 'CREATE TABLE rows ( t INTEGER NOT NULL, k TEXT NOT NULL, x TEXT NOT NULL, s INTEGER NOT NULL, c0 REAL NOT NULL, c1 REAL, c2 REAL, PRIMARY KEY ( t, k, x, s ) ) WITHOUT ROWID';

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

	/** Every row of partition `$partition`'s file, in key order, as raw PDO reads it. */
	private function rows( string $name, int $partition = 3 ): array {
		$db = new \PDO( 'sqlite:' . Ledger_Node::file( $name, $partition ) );
		return $db->query( 'SELECT * FROM rows' )->fetchAll( \PDO::FETCH_NUM );
	}

	/** The `rows` table's declaration as partition `$partition`'s file holds it. */
	private function rows_sql( string $name, int $partition = 3 ): string {
		$db = new \PDO( 'sqlite:' . Ledger_Node::file( $name, $partition ) );
		return (string) $db->query( "SELECT sql FROM sqlite_master WHERE name = 'rows'" )->fetchColumn();
	}

	/** A writer's own connection. */
	private static function db( Ledger_Node $ledger ): \PDO {
		return ( new \ReflectionProperty( Ledger_Node::class, 'db' ) )->getValue( $ledger );
	}

	/** The SUM a writer answers for `$k` over the rows seeded at T. */
	private function sum( Ledger_Node $ledger, string $k ): array {
		$this->sink->captured      = [];
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_REQUEST | Message::TM_STRUCT;
		$message[ Message::FROM ]  = 'flame:stats/sku-47';
		$message[ Message::VALUE ] = [ 'SUM' => [ 'from' => self::T, 'to' => self::T + 1, 'ks' => [ $k ] ] ];
		$ledger->fill( $message );
		return $this->sink->captured[0][ Message::VALUE ]['data'];
	}

	public function test_make_node_creates_its_partitions_file_keyed_without_a_writer_in_wal(): void {
		$this->kea();
		$this->assertSame( "{$this->dir}/ledgers/lab-7:kea.p3.sqlite", Ledger_Node::file( 'lab-7:kea', 3 ) );
		$this->assertFileExists( Ledger_Node::file( 'lab-7:kea', 3 ) );
		$this->assertSame( [ 3 => Ledger_Node::file( 'lab-7:kea', 3 ) ], Ledger_Node::partition_files( 'lab-7:kea' ) );
		$this->assertSame( self::ROWS_SQL, $this->rows_sql( 'lab-7:kea' ), 'the file names its partition, so no row carries it' );
		$db = new \PDO( 'sqlite:' . Ledger_Node::file( 'lab-7:kea', 3 ) );
		$this->assertSame( 'wal', $db->query( 'PRAGMA journal_mode' )->fetchColumn() );
		$this->assertSame( [ 'rows' ], $db->query( "SELECT name FROM sqlite_master WHERE type IN ( 'table', 'index' )" )->fetchAll( \PDO::FETCH_COLUMN ), 'no secondary index' );
	}

	public function test_partition_files_finds_each_partitions_file_by_its_name_alone(): void {
		\mkdir( "{$this->dir}/ledgers", 0755, true );
		foreach ( [ 'lab-7:kea.p12.sqlite', 'lab-7:kea.p4.sqlite', 'lab-7:kea.p4.sqlite-wal', 'lab-7:kea.sqlite', 'lab-7:kea.p04.sqlite', 'lab-7:kea.px.sqlite', 'lab-7:keas.p5.sqlite', 'lab-7:ke.p6.sqlite' ] as $file ) {
			\touch( "{$this->dir}/ledgers/{$file}" );
		}
		$this->assertSame( [ 4 => Ledger_Node::file( 'lab-7:kea', 4 ), 12 => Ledger_Node::file( 'lab-7:kea', 12 ) ], Ledger_Node::partition_files( 'lab-7:kea' ) );
		$this->assertSame( [], Ledger_Node::partition_files( 'lab-7:owl' ) );
		$this->rmdir_recursive( "{$this->dir}/ledgers" );
		$this->assertSame( [], Ledger_Node::partition_files( 'lab-7:kea' ), 'no directory yet holds no file' );
	}

	public function test_an_append_stores_its_row_and_answers_the_count(): void {
		$kea = $this->kea();
		$this->assertSame( self::appended( 1, 0 ), $this->append( $kea, [ [ self::T, 'sku-41', 'aisle-9', [ 3, 2.5, 7 ] ] ] ) );
		$rows = $this->rows( 'lab-7:kea' );
		$this->assertCount( 1, $rows );
		[ $t, $k, $x, , $qty, $lo, $hi ] = $rows[0];
		$this->assertSame( [ self::T, 'sku-41', 'aisle-9', 3.0, 2.5, 7.0 ], [ $t, $k, $x, $qty, $lo, $hi ] );
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
		$this->assertNotSame( $rows[0][3], $rows[1][3], 'each delta carries its own s' );
		$this->assertSame( [ 3.0, 5.0 ], \array_map( static fn ( array $row ): float => $row[4], $rows ) );
	}

	public function test_one_append_may_carry_two_deltas_for_one_key(): void {
		$kea = $this->kea();
		$this->assertSame(
			self::appended( 2, 0 ),
			$this->append( $kea, [ [ self::T, 'sku-41', 'aisle-9', [ 3, 2.5, 7 ] ], [ self::T, 'sku-41', 'aisle-9', [ 5, 1.5, 8 ] ] ] )
		);
		$this->assertCount( 2, $this->rows( 'lab-7:kea' ) );
	}

	public function test_two_partitions_each_write_their_own_file_and_read_both(): void {
		$three = $this->kea( '3' );
		// Each partition's worker is its own process, so each holds the name.
		$this->unregister_worker_node( 'lab-7:kea' );
		$five = $this->kea( '5' );
		$this->assertSame( [ 'stored' => 1, 'dropped' => 0 ], $three->append( [ [ self::T, 'sku-41', 'aisle-9', [ 3, 2.5, 7 ] ] ] ) );
		$this->assertSame( [ 'stored' => 1, 'dropped' => 0 ], $five->append( [ [ self::T, 'sku-41', 'aisle-9', [ 5, 1.5, 8 ] ] ] ) );
		$this->assertSame( [ 'stored' => 1, 'dropped' => 0 ], $three->append( [ [ self::T, 'sku-43', 'aisle-12', [ 4, 0.5, 9 ] ] ] ) );
		$this->assertSame( [ [ 'sku-41', 3.0 ], [ 'sku-43', 4.0 ] ], \array_map( static fn ( array $row ): array => [ $row[1], $row[4] ], $this->rows( 'lab-7:kea', 3 ) ) );
		$this->assertSame( [ [ 'sku-41', 5.0 ] ], \array_map( static fn ( array $row ): array => [ $row[1], $row[4] ], $this->rows( 'lab-7:kea', 5 ) ) );
		foreach ( [ $three, $five ] as $writer ) {
			$this->assertSame( [ [ 'sku-41', 'aisle-9', null, 8.0, 1.5, 8.0 ] ], $this->sum( $writer, 'sku-41' ), 'every writer reads every partition, 3 + 5' );
		}
		$this->assertSame( 5000, Ledger_Node::BUSY_TIMEOUT_MS );
		$this->assertSame( Ledger_Node::BUSY_TIMEOUT_MS, (int) self::db( $three )->query( 'PRAGMA busy_timeout' )->fetchColumn(), 'a flush from the CLI under the hold is the one other writer' );
	}

	public function test_an_append_never_waits_on_another_partitions_open_write(): void {
		$three = $this->kea( '3' );
		$this->unregister_worker_node( 'lab-7:kea' );
		$five = $this->kea( '5' );
		$five->append( [ [ self::T, 'sku-41', 'aisle-9', [ 5, 1.5, 8 ] ] ] );
		$this->assertSame( [ [ 'sku-41', 'aisle-9', null, 5.0, 1.5, 8.0 ] ], $this->sum( $three, 'sku-41' ), 'partition 3 has partition 5 attached' );
		$held = self::db( $five );
		$held->exec( 'BEGIN IMMEDIATE' );
		try {
			$started = \hrtime( true );
			$this->assertSame( [ 'stored' => 1, 'dropped' => 0 ], $three->append( [ [ self::T, 'sku-43', 'aisle-12', [ 4, 0.5, 9 ] ] ] ) );
			$this->assertLessThan( 100e6, \hrtime( true ) - $started, 'the append took no lock partition 5 holds' );
		} finally {
			$held->exec( 'ROLLBACK' );
		}
	}

	public function test_as_many_partition_files_as_sqlite_attaches_read_as_one_and_one_more_refuses(): void {
		$this->assertSame( 10, Ledger_Node::ATTACH_LIMIT );
		for ( $partition = 0; $partition < Ledger_Node::ATTACH_LIMIT; ++$partition ) {
			$writer = $this->kea( (string) $partition );
			$writer->append( [ [ self::T, 'sku-41', 'aisle-9', [ $partition + 1, 2.5, 7 ] ] ] );
			$writer->remove_node();
		}
		$declaration = [
			'segment_seconds' => 600,
			'num_segments'    => 3,
			'columns'         => [ 'qty', 'lo:min', 'hi:max' ],
		];
		$mount       = Ledger_Node::mount( 'lab-7:kea', $declaration, $this->sink );
		$this->assertSame( [ [ 'sku-41', 'aisle-9', null, 55.0, 2.5, 7.0 ] ], $this->sum( $mount, 'sku-41' ), 'a mount attaches all ten, 1 + 2 + … + 10' );
		$mount->remove_node();

		$e = $this->caught( fn () => $this->kea( '10' ), 'an eleventh partition opened' );
		$this->assertSame( 'Ledger lab-7:kea: 11 partition files, more than the 10 SQLite attaches to one connection', $e->getMessage() );
		$this->assertFileDoesNotExist( Ledger_Node::file( 'lab-7:kea', 10 ), 'the refusal comes before the file' );
		\touch( Ledger_Node::file( 'lab-7:kea', 10 ) );
		$e = $this->caught( fn () => Ledger_Node::mount( 'lab-7:kea', $declaration, $this->sink ), 'a mount read a subset of eleven files' );
		$this->assertSame( 'Ledger lab-7:kea: 11 partition files, more than the 10 SQLite attaches to one connection', $e->getMessage() );
	}

	public function test_a_peer_file_attached_through_the_writer_refuses_every_write(): void {
		$three = $this->kea( '3' );
		$this->unregister_worker_node( 'lab-7:kea' );
		$this->kea( '5' )->append( [ [ self::T, 'sku-41', 'aisle-9', [ 5, 1.5, 8 ] ] ] );
		$this->sum( $three, 'sku-41' );
		$e = $this->caught( static fn () => self::db( $three )->exec( "INSERT INTO p5.rows VALUES ( 1790000400, 'sku-43', 'aisle-12', 9, 1, 1, 1 )" ), 'a writer wrote another partition\'s file' );
		$this->assertStringContainsString( 'attempt to write a readonly database', $e->getMessage() );
		$this->assertCount( 1, $this->rows( 'lab-7:kea', 5 ) );
	}

	public function test_stats_answers_this_writers_counters_on_its_config_interpreter(): void {
		$kea = $this->kea();
		$this->append( $kea, [ [ self::T, 'sku-41', 'aisle-9', [ 3, 2.5, 7 ] ] ], 1750000 );
		$stats = Core::node( 'lab-7:kea:config' )->dispatch( 'stats', [] );
		$this->assertSame( [ 'calls' => 1, 'asked' => 1, 'answered' => 1, 'bytes' => 0, 'total_ms' => 1.75, 'max_ms' => 1.75 ], $stats['APPEND'] );
		$this->assertSame( $kea->stats(), $stats );
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
		$this->assertSame( [ Message::TM_ERROR, "APPEND: row 1: needs [ t, k, x, [ columns… ] ], t whole seconds and each column a number or null\n" ], $this->append( $kea, [ $good, [ (string) self::T, 'sku-41', 'aisle-9', [ 3, 2.5, 7 ] ] ] ) );
		$this->assertSame( [ Message::TM_ERROR, "APPEND: row 0: needs [ t, k, x, [ columns… ] ], t whole seconds and each column a number or null\n" ], $this->append( $kea, [ [ self::T, 'sku-41', 'aisle-9', [ 3, 'lots', 7 ] ] ] ) );
		$this->assertSame( [ Message::TM_ERROR, "APPEND: needs a list of [ t, k, x, [ columns… ] ] rows\n" ], $this->append( $kea, 'sku-41' ) );
		$this->assertSame( [ Message::TM_ERROR, "APPEND: row 1: qty is a sum column, which takes a number; null is for a min or max not measured\n" ], $this->append( $kea, [ $good, [ self::T, 'sku-41', 'aisle-9', [ null, 2.5, 7 ] ] ] ) );
		$this->assertSame( [], $this->rows( 'lab-7:kea' ), 'a refused append stores none of its rows' );
	}

	public function test_a_min_or_max_column_stores_null_for_not_measured(): void {
		$kea = $this->kea();
		$this->assertSame( self::appended( 2, 0 ), $this->append( $kea, [ [ self::T, 'sku-41', 'aisle-9', [ 3, null, 7 ] ], [ self::T, 'sku-43', 'aisle-9', [ 0, 1.5, null ] ] ] ) );
		$this->assertSame( [ [ null, 7.0 ], [ 1.5, null ] ], \array_map( static fn ( array $row ): array => [ $row[5], $row[6] ], $this->rows( 'lab-7:kea' ) ) );
	}

	public function test_a_file_declaring_its_min_and_max_not_null_refuses_to_open_naming_the_flush(): void {
		Config::ensure_path( \dirname( Ledger_Node::file( 'lab-7:kea', 3 ) ) );
		$old = 'CREATE TABLE rows ( t INTEGER NOT NULL, k TEXT NOT NULL, x TEXT NOT NULL, s INTEGER NOT NULL, c0 REAL NOT NULL, c1 REAL NOT NULL, c2 REAL NOT NULL, PRIMARY KEY ( t, k, x, s ) ) WITHOUT ROWID';
		( new \PDO( 'sqlite:' . Ledger_Node::file( 'lab-7:kea', 3 ) ) )->exec( $old );
		$e = $this->caught( fn () => $this->kea(), 'a Ledger opened a file whose min and max refuse null' );
		$this->assertSame( 'Ledger lab-7:kea: ' . Ledger_Node::file( 'lab-7:kea', 3 ) . ' holds a rows table another declaration made; `wp nodes tables flush` drops the rows written under it and declares this one', $e->getMessage() );
		$this->assertSame( $old, $this->rows_sql( 'lab-7:kea' ), 'the file is left as it was' );
	}

	public function test_a_declaration_it_cannot_keep_throws_naming_it(): void {
		foreach (
			[
				[ [ '600', '3', 'qty:avg' ], 'qty:avg' ],
				[ [ '600', '3', 'qty', 'qty:max' ], 'qty' ],
				[ [ '600', '3', 'q ty' ], 'q ty' ],
				[ [ '600', '3', 'qty', 'x:max' ], 'column x:max: a name in [A-Za-z_][A-Za-z0-9_]* other than x, which TOP orders by as the member' ],
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
		Ledger_Node::file( '../kea', 3 );
	}

	public function test_another_partitions_file_of_another_declaration_refuses_to_open(): void {
		$this->kea();
		$this->unregister_worker_node( 'lab-7:kea' );
		try {
			$this->ledger( '5', 'lab-7:kea', '600', '3', 'qty', 'lo:min' );
			$this->fail( 'a two-column Ledger attached a three-column file' );
		} catch ( \RuntimeException $e ) {
			$this->assertSame( 'Ledger lab-7:kea: ' . Ledger_Node::file( 'lab-7:kea', 3 ) . ' holds a rows table another declaration made; `wp nodes tables flush` drops the rows written under it and declares this one', $e->getMessage() );
		}
		$this->assertSame( self::ROWS_SQL, $this->rows_sql( 'lab-7:kea' ), 'the file is as its first writer declared it' );
	}

	public function test_a_flush_empties_its_own_file_in_place_and_every_partition_reads_it_on(): void {
		$three = $this->kea( '3' );
		// Each partition's worker is its own process, so each holds the name.
		$this->unregister_worker_node( 'lab-7:kea' );
		$five = $this->kea( '5' );
		$three->append( [ [ self::T, 'sku-41', 'aisle-9', [ 3, 2.5, 7 ] ], [ self::T + 1, 'sku-43', 'aisle-12', [ 4, 1.5, 9 ] ] ] );
		$five->append( [ [ self::T, 'sku-41', 'aisle-9', [ 5, 1.5, 8 ] ] ] );
		$this->assertSame( [ [ 'sku-41', 'aisle-9', null, 8.0, 1.5, 8.0 ] ], $this->sum( $five, 'sku-41' ) );
		$inode = \fileinode( Ledger_Node::file( 'lab-7:kea', 3 ) );

		$this->assertSame( [ 'rows' => 2 ], $three->flush( [ 'qty:sum', 'lo:min', 'hi:max' ] ), 'qty and qty:sum are one column' );

		\clearstatcache();
		$this->assertSame( $inode, \fileinode( Ledger_Node::file( 'lab-7:kea', 3 ) ), 'the file other partitions attached stays' );
		$this->assertSame( [], $this->rows( 'lab-7:kea', 3 ) );
		$this->assertSame( self::ROWS_SQL, $this->rows_sql( 'lab-7:kea', 3 ) );
		$this->assertCount( 1, $this->rows( 'lab-7:kea', 5 ), 'another partition\'s file is its own writer\'s to flush' );
		$this->assertSame( [ [ 'sku-41', 'aisle-9', null, 5.0, 1.5, 8.0 ] ], $this->sum( $five, 'sku-41' ), 'partition 5 reads the flushed file on' );
		$this->assertSame( [ 'stored' => 1, 'dropped' => 0 ], $three->append( [ [ self::T, 'sku-41', 'aisle-12', [ 2, 0.5, 4 ] ] ] ) );
		$this->assertSame( [ [ 'sku-41', 'aisle-12', null, 2.0, 0.5, 4.0 ], [ 'sku-41', 'aisle-9', null, 5.0, 1.5, 8.0 ] ], $this->sum( $five, 'sku-41' ) );
	}

	public function test_a_refresh_refused_midway_keeps_what_it_attached_and_reads_on_once_fixed(): void {
		$three = $this->kea( '3' );
		$this->unregister_worker_node( 'lab-7:kea' );
		$this->kea( '5' )->append( [ [ self::T, 'sku-41', 'aisle-9', [ 5, 1.5, 8 ] ] ] );
		$this->unregister_worker_node( 'lab-7:kea' );
		$this->caught( fn () => $this->ledger( '6', 'lab-7:kea', '600', '3', 'qty' ), 'a one-column Ledger attached a three-column file' );

		$this->caught( fn () => $this->sum( $three, 'sku-41' ), 'partition 3 attached a one-column file' );

		Ledger_Node::flush_file( 'lab-7:kea', 6, [ 'segment_seconds' => 600, 'num_segments' => 3, 'columns' => [ 'qty', 'lo:min', 'hi:max' ] ] );
		$this->assertSame( [ [ 'sku-41', 'aisle-9', null, 5.0, 1.5, 8.0 ] ], $this->sum( $three, 'sku-41' ), 'partition 5 stays attached, and 6 attaches once flushed' );
	}

	public function test_a_flush_naming_other_columns_refuses_and_keeps_every_row(): void {
		$kea = $this->kea();
		$kea->append( [ [ self::T, 'sku-41', 'aisle-9', [ 3, 2.5, 7 ] ] ] );
		$e = $this->caught( static fn () => $kea->flush( [ 'qty', 'lo:min' ] ), 'a writer running other columns flushed' );
		$this->assertSame( 'flush: lab-7:kea runs qty:sum lo:min hi:max where its topology declares qty:sum lo:min; restart this worker (`wp nodes restart`), or hold the fleet (`wp nodes stop`), and flush again', $e->getMessage() );
		$this->assertCount( 1, $this->rows( 'lab-7:kea' ) );
	}

	public function test_a_flush_with_no_writer_declares_the_current_columns_over_another_declaration(): void {
		$this->ledger( '3', 'lab-7:kea', '600', '3', 'qty' )->append( [ [ self::T, 'sku-41', 'aisle-9', [ 3 ] ] ] );
		Core::node( 'lab-7:kea' )->remove_node();
		$inode = \fileinode( Ledger_Node::file( 'lab-7:kea', 3 ) );
		$this->caught( fn () => $this->kea( '5' ), 'a three-column Ledger attached a one-column file' );

		$this->assertSame(
			[ 'rows' => 1 ],
			Ledger_Node::flush_file(
				'lab-7:kea',
				3,
				[
					'segment_seconds' => 600,
					'num_segments'    => 3,
					'columns'         => [ 'qty', 'lo:min', 'hi:max' ],
				]
			)
		);

		$kea = $this->kea( '5' );
		$this->assertSame( [ 'stored' => 1, 'dropped' => 0 ], $kea->append( [ [ self::T, 'sku-43', 'aisle-12', [ 4, 1.5, 9 ] ] ] ), 'the Ledger re-declared with its new columns opens' );
		\clearstatcache();
		$this->assertSame( $inode, \fileinode( Ledger_Node::file( 'lab-7:kea', 3 ) ) );
		$this->assertSame( self::ROWS_SQL, $this->rows_sql( 'lab-7:kea', 3 ) );
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
		$this->assertSame( \array_fill_keys( [ 'APPEND', 'SUM', 'TOP', 'MEMBERS', 'DROP', 'CHECKPOINT' ], $zero ), $kea->stats() );
		Core::$clock = static fn (): float => (float) ( self::T + 3 * 600 + 1 );
		$this->append( $kea, [ [ self::T, 'sku-41', 'aisle-9', [ 3, 2.5, 7 ] ], [ self::T + 900, 'sku-43', 'aisle-12', [ 4, 1.5, 9 ] ] ], 1250000 );
		$this->append( $kea, [ [ self::T + 900, 'sku-41', 'aisle-9', [ 5, 0.5, 8 ] ] ], 2500000 );
		$this->assertSame( [ 'calls' => 2, 'asked' => 3, 'answered' => 2, 'bytes' => 0, 'total_ms' => 3.75, 'max_ms' => 2.5 ], $kea->stats()['APPEND'] );
		$this->assertSame( $kea->stats(), $kea->dump_node()['verb_stats'] );
		$this->assertSame( [ 'verb_stats' => $kea->stats() ], $kea->dump_metadata() );
	}
}
