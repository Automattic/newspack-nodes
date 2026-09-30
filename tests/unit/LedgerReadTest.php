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
 * A statement that, once its COUNT(*) has run, lets `$between` commit from
 * another connection before the next statement on its connection runs.
 */
final class Commit_Between_Statement_Fixture extends \PDOStatement {
	protected function __construct( private readonly \Closure $between ) {}

	public function execute( ?array $params = null ): bool {
		$done = parent::execute( $params );
		if ( \str_contains( $this->queryString, 'SELECT COUNT(*)' ) ) {
			( $this->between )();
		}
		return $done;
	}
}

/** A statement that records its SQL and its bound values as it runs. */
final class Recording_Statement_Fixture extends \PDOStatement {
	/** @var list<array{0: string, 1: array<int,mixed>}> */
	public static array $ran = [];

	/** @var array<int,mixed> */
	private array $bound = [];

	protected function __construct() {}

	public function bindValue( int|string $param, mixed $value, int $type = \PDO::PARAM_STR ): bool {
		$this->bound[ (int) $param ] = $value;
		return parent::bindValue( $param, $value, $type );
	}

	public function execute( ?array $params = null ): bool {
		self::$ran[] = [ $this->queryString, $this->bound ];
		return parent::execute( $params );
	}
}

/**
 * A Ledger's reads: `SUM` aggregates each ( k, x ) group, or each
 * ( k, x, t ), by the aggregate its column declares; `TOP` ranks the members
 * across keys by one column; `MEMBERS` lists a key's distinct members. Each
 * reads `from ≤ t < to`, across every partition's rows.
 */
#[CoversClass( Ledger_Node::class )]
final class LedgerReadTest extends TestCase {
	private const T = 1790000400;

	/** Past every seeded `t`. */
	private const END = self::T + 1201;

	private string $dir = '';
	private Capture_Sink_Node $sink;
	private Command_Interpreter_Node $interpreter;

	protected function setUp(): void {
		parent::setUp();
		$this->dir = $this->make_temp_dir( 'ledger-read-' );
		$this->use_base_dir( $this->dir );
		Core::$clock       = static fn (): float => (float) ( self::T + 1200 );
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

	/**
	 * The kea Ledger, written by partitions 3 and 5 at three `t`; the one
	 * partition 3 built answers the reads. Groups, qty / lo / hi:
	 * sku-41 aisle-9 13 / 0.5 / 11 (9 at T, 4 at T+600), sku-41 aisle-12
	 * 2 / 4 / 6, sku-43 aisle-12 5 / 3 / 8, sku-43 aisle-9 0 / 1 / 2.
	 */
	private function kea(): Ledger_Node {
		$three = $this->ledger( '3', 'lab-7:kea', '600', '3', 'qty', 'lo:min', 'hi:max' );
		Core::unregister_node( 'lab-7:kea' );
		$five = $this->ledger( '5', 'lab-7:kea', '600', '3', 'qty', 'lo:min', 'hi:max' );
		$three->append(
			[
				[ self::T, 'sku-41', 'aisle-9', [ 3, 2.5, 7 ] ],
				[ self::T + 600, 'sku-41', 'aisle-9', [ 4, 1.5, 9 ] ],
				[ self::T, 'sku-41', 'aisle-12', [ 2, 4, 6 ] ],
				[ self::T + 1200, 'sku-43', 'aisle-12', [ 5, 3, 8 ] ],
			]
		);
		$five->append(
			[
				[ self::T, 'sku-41', 'aisle-9', [ 6, 0.5, 11 ] ],
				[ self::T + 1200, 'sku-43', 'aisle-9', [ 0, 1, 2 ] ],
			]
		);
		return $three;
	}

	/**
	 * Fill one read request and answer the reply's TYPE and VALUE.
	 *
	 * @return array{0: int, 1: mixed}
	 */
	private function read( Ledger_Node $ledger, string $verb, mixed $query ): array {
		$this->sink->captured      = [];
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_REQUEST | Message::TM_STRUCT;
		$message[ Message::FROM ]  = 'flame:stats/sku-43';
		$message[ Message::ID ]    = 'id-43';
		$message[ Message::VALUE ] = [ $verb => $query ];
		$ledger->fill( $message );
		$this->assertCount( 1, $this->sink->captured );
		$reply = $this->sink->captured[0];
		$this->assertSame( [ $ledger->name(), 'flame:stats/sku-43', 'id-43' ], [ $reply[ Message::FROM ], $reply[ Message::TO ], $reply[ Message::ID ] ], 'answered TO its FROM, ID echoed' );
		return [ $reply[ Message::TYPE ], $reply[ Message::VALUE ] ];
	}

	/** The reply a read answers with `$data`. */
	private static function answered( string $verb, array $data ): array {
		return [
			Message::TM_STRUCT | Message::TM_RESPONSE,
			[
				'verb' => $verb,
				'data' => $data,
			],
		];
	}

	public function test_sum_aggregates_each_group_by_its_declared_aggregate_across_partitions(): void {
		$this->assertSame(
			self::answered(
				'SUM',
				[
					[ 'sku-41', 'aisle-12', null, 2.0, 4.0, 6.0 ],
					[ 'sku-41', 'aisle-9', null, 13.0, 0.5, 11.0 ],
					[ 'sku-43', 'aisle-12', null, 5.0, 3.0, 8.0 ],
					[ 'sku-43', 'aisle-9', null, 0.0, 1.0, 2.0 ],
				]
			),
			$this->read( $this->kea(), 'SUM', [ 'from' => self::T, 'to' => self::END, 'ks' => [ 'sku-41', 'sku-43' ] ] )
		);
	}

	public function test_sum_by_t_splits_each_group_per_t(): void {
		$this->assertSame(
			self::answered(
				'SUM',
				[
					[ 'sku-41', 'aisle-9', self::T, 9.0, 0.5, 11.0 ],
					[ 'sku-41', 'aisle-9', self::T + 600, 4.0, 1.5, 9.0 ],
				]
			),
			$this->read( $this->kea(), 'SUM', [ 'from' => self::T, 'to' => self::END, 'ks' => [ 'sku-41' ], 'xs' => [ 'aisle-9' ], 'by_t' => true ] )
		);
	}

	public function test_sum_xs_narrows_the_members(): void {
		$this->assertSame(
			self::answered(
				'SUM',
				[
					[ 'sku-41', 'aisle-12', null, 2.0, 4.0, 6.0 ],
					[ 'sku-43', 'aisle-12', null, 5.0, 3.0, 8.0 ],
				]
			),
			$this->read( $this->kea(), 'SUM', [ 'from' => self::T, 'to' => self::END, 'ks' => [ 'sku-41', 'sku-43' ], 'xs' => [ 'aisle-12' ] ] )
		);
	}

	public function test_the_range_takes_from_and_stops_short_of_to(): void {
		$this->assertSame(
			self::answered( 'SUM', [ [ 'sku-41', 'aisle-9', null, 4.0, 1.5, 9.0 ] ] ),
			$this->read( $this->kea(), 'SUM', [ 'from' => self::T + 600, 'to' => self::T + 1200, 'ks' => [ 'sku-41', 'sku-43' ] ] )
		);
	}

	public function test_sum_reads_every_chunk_of_a_long_member_list(): void {
		$xs   = \array_map( static fn ( int $i ): string => "aisle-x{$i}", \range( 1, 1203 ) );
		$xs[] = 'aisle-9';
		$this->assertSame(
			self::answered( 'SUM', [ [ 'sku-43', 'aisle-9', null, 0.0, 1.0, 2.0 ] ] ),
			$this->read( $this->kea(), 'SUM', [ 'from' => self::T, 'to' => self::END, 'ks' => [ 'sku-43' ], 'xs' => $xs ] )
		);
	}

	public function test_top_ranks_members_across_keys_and_pages_past_the_offset(): void {
		$kea = $this->kea();
		$this->assertSame(
			self::answered(
				'TOP',
				[
					'total' => 2,
					'rows'  => [ [ 'aisle-12', 7.0, 3.0, 8.0 ] ],
				]
			),
			$this->read( $kea, 'TOP', [ 'from' => self::T, 'to' => self::END, 'ks' => [ 'sku-41', 'sku-43' ], 'column' => 'qty', 'order' => 'desc', 'limit' => 1, 'offset' => 1 ] )
		);
		$this->assertSame(
			self::answered(
				'TOP',
				[
					'total' => 2,
					'rows'  => [ [ 'aisle-12', 7.0, 3.0, 8.0 ], [ 'aisle-9', 13.0, 0.5, 11.0 ] ],
				]
			),
			$this->read( $kea, 'TOP', [ 'from' => self::T, 'to' => self::END, 'ks' => [ 'sku-41', 'sku-43' ], 'column' => 'lo', 'order' => 'desc', 'limit' => 5, 'offset' => 0 ] ),
			'ranked by the minimum lo declares'
		);
	}

	public function test_top_positive_keeps_only_members_whose_column_is_above_zero(): void {
		$this->assertSame(
			self::answered(
				'TOP',
				[
					'total' => 1,
					'rows'  => [ [ 'aisle-12', 5.0, 3.0, 8.0 ] ],
				]
			),
			$this->read( $this->kea(), 'TOP', [ 'from' => self::T, 'to' => self::END, 'ks' => [ 'sku-43' ], 'column' => 'hi', 'order' => 'asc', 'limit' => 9, 'offset' => 0, 'positive' => 'qty' ] )
		);
	}

	public function test_top_counts_and_pages_one_snapshot_while_another_partition_commits(): void {
		$kea   = $this->kea();
		$other = new \PDO( 'sqlite:' . Ledger_Node::file( 'lab-7:kea' ), null, null, [ \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION ] );
		$other->exec( 'PRAGMA busy_timeout = ' . Ledger_Node::BUSY_TIMEOUT_MS );
		$late = static function () use ( $other ): void {
			$other->exec( "INSERT INTO rows VALUES ( 1790000400, 'sku-43', 'aisle-15', 5, 7, 20, 1, 1 )" );
		};
		$db = ( new \ReflectionProperty( Ledger_Node::class, 'db' ) )->getValue( $kea );
		$db->setAttribute( \PDO::ATTR_STATEMENT_CLASS, [ Commit_Between_Statement_Fixture::class, [ $late ] ] );
		[ , $reply ] = $this->read( $kea, 'TOP', [ 'from' => self::T, 'to' => self::END, 'ks' => [ 'sku-41', 'sku-43' ], 'column' => 'qty', 'order' => 'desc', 'limit' => 9, 'offset' => 0 ] );
		$this->assertSame( [ 'aisle-9', 'aisle-12' ], \array_column( $reply['data']['rows'], 0 ), 'the page reads the snapshot the count read' );
		$this->assertSame( 2, $reply['data']['total'] );
		$this->assertFalse( $db->inTransaction(), 'the read transaction ended' );
		$this->assertSame( 'aisle-15', $other->query( "SELECT x FROM rows WHERE x = 'aisle-15'" )->fetchColumn(), 'the other partition committed' );
	}

	public function test_each_read_seeks_its_keys_at_each_distinct_t_rather_than_scanning_the_range(): void {
		$kea = $this->kea();
		$db  = ( new \ReflectionProperty( Ledger_Node::class, 'db' ) )->getValue( $kea );
		$db->setAttribute( \PDO::ATTR_STATEMENT_CLASS, [ Recording_Statement_Fixture::class, [] ] );
		Recording_Statement_Fixture::$ran = [];
		$range                            = [ 'from' => self::T, 'to' => self::END ];
		$this->read( $kea, 'SUM', $range + [ 'ks' => [ 'sku-41', 'sku-43' ] ] );
		$this->read( $kea, 'SUM', $range + [ 'ks' => [ 'sku-41' ], 'xs' => [ 'aisle-9' ], 'by_t' => true ] );
		$this->read( $kea, 'TOP', $range + [ 'ks' => [ 'sku-41', 'sku-43' ], 'column' => 'qty', 'order' => 'desc', 'limit' => 9, 'offset' => 0 ] );
		$ran   = Recording_Statement_Fixture::$ran;
		$ran[] = [ ( new \ReflectionClassConstant( Ledger_Node::class, 'MEMBERS_READ' ) )->getValue(), [ 1 => self::T, 2 => self::END, 3 => self::END, 4 => 'sku-41' ] ];
		$this->assertCount( 5, $ran, 'two SUMs, the TOP count and page, and MEMBERS' );
		$plain = new \PDO( 'sqlite:' . Ledger_Node::file( 'lab-7:kea' ) );
		foreach ( $ran as [ $sql, $bound ] ) {
			$explain = $plain->prepare( "EXPLAIN QUERY PLAN {$sql}" );
			foreach ( $bound as $i => $value ) {
				$explain->bindValue( $i, $value );
			}
			$explain->execute();
			$plan = \array_column( $explain->fetchAll( \PDO::FETCH_NUM ), 3 );
			$this->assertNotEmpty( \preg_grep( '/^SEARCH rows USING PRIMARY KEY \(t=\? AND k=\?/', $plan ), "each t seeks its keys:\n{$sql}\n" . \implode( "\n", $plan ) );
			$this->assertCount( 2, \preg_grep( '/\(t>\? AND t<\?\)/', $plan ), "a range seek finds only the next distinct t:\n" . \implode( "\n", $plan ) );
			$this->assertSame( [], \preg_grep( '/^SCAN rows/', $plan ), 'no scan of rows' );
		}
	}

	public function test_a_key_or_member_repeated_across_chunks_answers_its_group_once(): void {
		$kea     = $this->kea();
		$range   = [ 'from' => self::T, 'to' => self::END ];
		$fillers = \array_map( static fn ( int $i ): string => "sku-x{$i}", \range( 1, 600 ) );
		$this->assertSame(
			self::answered( 'SUM', [ [ 'sku-41', 'aisle-12', null, 2.0, 4.0, 6.0 ], [ 'sku-41', 'aisle-9', null, 13.0, 0.5, 11.0 ] ] ),
			$this->read( $kea, 'SUM', $range + [ 'ks' => [ 'sku-41', ...$fillers, 'sku-41' ] ] ),
			'a key 600 apart, past one chunk of keys'
		);
		$this->assertSame(
			self::answered( 'SUM', [ [ 'sku-41', 'aisle-9', null, 13.0, 0.5, 11.0 ] ] ),
			$this->read( $kea, 'SUM', $range + [ 'ks' => [ 'sku-41', ...\array_slice( $fillers, 0, 300 ), 'sku-41' ], 'xs' => [ 'aisle-9', ...\array_slice( $fillers, 0, 300 ), 'aisle-9' ] ] ),
			'a key and a member 300 apart, past one paired chunk'
		);
	}

	public function test_members_lists_each_distinct_member_once_in_order(): void {
		$this->assertSame(
			self::answered( 'MEMBERS', [ 'aisle-12', 'aisle-9' ] ),
			$this->read( $this->kea(), 'MEMBERS', [ 'from' => self::T, 'to' => self::END, 'k' => 'sku-41' ] )
		);
	}

	public function test_a_range_outside_the_data_answers_empty(): void {
		$kea   = $this->kea();
		$range = [ 'from' => self::T - 1800, 'to' => self::T ];
		$this->assertSame( self::answered( 'SUM', [] ), $this->read( $kea, 'SUM', $range + [ 'ks' => [ 'sku-41' ] ] ) );
		$this->assertSame( self::answered( 'TOP', [ 'total' => 0, 'rows' => [] ] ), $this->read( $kea, 'TOP', $range + [ 'ks' => [ 'sku-41' ], 'column' => 'qty', 'order' => 'desc', 'limit' => 9, 'offset' => 0 ] ) );
		$this->assertSame( self::answered( 'MEMBERS', [] ), $this->read( $kea, 'MEMBERS', $range + [ 'k' => 'sku-41' ] ) );
	}

	public function test_no_keys_answer_empty(): void {
		$kea   = $this->kea();
		$range = [ 'from' => self::T, 'to' => self::END ];
		$this->assertSame( self::answered( 'SUM', [] ), $this->read( $kea, 'SUM', $range + [ 'ks' => [] ] ) );
		$this->assertSame( self::answered( 'SUM', [] ), $this->read( $kea, 'SUM', $range + [ 'ks' => [ 'sku-41' ], 'xs' => [] ] ) );
		$this->assertSame( self::answered( 'TOP', [ 'total' => 0, 'rows' => [] ] ), $this->read( $kea, 'TOP', $range + [ 'ks' => [], 'column' => 'qty', 'order' => 'desc', 'limit' => 9, 'offset' => 0 ] ) );
	}

	public function test_a_set_sums_its_groups_with_no_columns_lists_members_and_ranks_nothing(): void {
		$wren = $this->ledger( '3', 'lab-7:wren', '600', '3' );
		$wren->append( [ [ self::T, 'sku-41', 'aisle-9', [] ], [ self::T + 600, 'sku-41', 'aisle-9', [] ], [ self::T, 'sku-41', 'aisle-12', [] ] ] );
		$this->assertSame(
			self::answered( 'SUM', [ [ 'sku-41', 'aisle-12', null ], [ 'sku-41', 'aisle-9', null ] ] ),
			$this->read( $wren, 'SUM', [ 'from' => self::T, 'to' => self::END, 'ks' => [ 'sku-41' ] ] )
		);
		$this->assertSame( self::answered( 'MEMBERS', [ 'aisle-12', 'aisle-9' ] ), $this->read( $wren, 'MEMBERS', [ 'from' => self::T, 'to' => self::END, 'k' => 'sku-41' ] ) );
		$this->assertSame(
			[ Message::TM_ERROR, "TOP: a Ledger declaring no columns has none to rank by\n" ],
			$this->read( $wren, 'TOP', [ 'from' => self::T, 'to' => self::END, 'ks' => [ 'sku-41' ], 'column' => 'qty', 'order' => 'desc', 'limit' => 9, 'offset' => 0 ] )
		);
	}

	public function test_a_read_it_cannot_answer_is_refused_on_the_error_plane(): void {
		$kea = $this->kea();
		$top = [ 'from' => self::T, 'to' => self::END, 'ks' => [ 'sku-41' ], 'column' => 'qty', 'order' => 'desc', 'limit' => 9, 'offset' => 0 ];
		foreach (
			[
				[ 'TOP', [ 'column' => 'price' ] + $top, 'column is one of qty, lo, hi' ],
				[ 'TOP', [ 'column' => "qty) --\nTOP: forged" ] + $top, 'column is one of qty, lo, hi' ],
				[ 'TOP', [ 'positive' => 'price' ] + $top, 'positive is one of qty, lo, hi' ],
				[ 'TOP', [ 'ks' => \array_map( static fn ( int $i ): string => "sku-x{$i}", \range( 1, 501 ) ) ] + $top, 'ks names at most 500 keys' ],
				[ 'TOP', [ 'order' => 'up' ] + $top, 'order is asc or desc' ],
				[ 'TOP', [ 'limit' => 0 ] + $top, 'limit is a whole number from 1 to ' . Ledger_Node::TOP_LIMIT_MAX ],
				[ 'TOP', [ 'limit' => Ledger_Node::TOP_LIMIT_MAX + 1 ] + $top, 'limit is a whole number from 1 to ' . Ledger_Node::TOP_LIMIT_MAX ],
				[ 'TOP', [ 'offset' => -1 ] + $top, 'offset is a whole number of at least 0' ],
				[ 'SUM', [ 'from' => self::T, 'ks' => [ 'sku-41' ] ], 'to is a whole number' ],
				[ 'SUM', [ 'from' => (string) self::T, 'to' => self::END, 'ks' => [ 'sku-41' ] ], 'from is a whole number' ],
				[ 'SUM', [ 'from' => self::T, 'to' => self::END, 'ks' => 'sku-41' ], 'ks is a list of strings' ],
				[ 'SUM', [ 'from' => self::T, 'to' => self::END, 'ks' => [ 'sku-41' ], 'xs' => [ 9 ] ], 'xs is a list of strings' ],
				[ 'SUM', [ 'from' => self::T, 'to' => self::END, 'ks' => [ 'sku-41' ], 'by_t' => 'yes' ], 'by_t is true or false' ],
				[ 'SUM', [ 'from' => self::T, 'to' => self::END, 'ks' => [ 'sku-41' ], "bt_t\nSUM: forged" => true ], 'takes the fields from, to, ks, xs and by_t alone' ],
				[ 'MEMBERS', [ 'from' => self::T, 'to' => self::END, 'k' => [ 'sku-41' ] ], 'k is a string' ],
				[ 'MEMBERS', 'sku-41', 'needs a map of its fields' ],
			] as [ $verb, $query, $why ]
		) {
			$this->assertSame( [ Message::TM_ERROR, "{$verb}: {$why}\n" ], $this->read( $kea, $verb, $query ), $why );
		}
	}

	public function test_a_read_before_the_file_opens_throws_naming_the_ledger(): void {
		$ledger = new Ledger_Node();
		$ledger->name( 'lab-7:kea' );
		$ledger->sink( $this->sink );
		foreach ( [ 'SUM' => [ 'ks' => [ 'sku-41' ] ], 'MEMBERS' => [ 'k' => 'sku-41' ] ] as $verb => $fields ) {
			try {
				$this->read( $ledger, $verb, [ 'from' => self::T, 'to' => self::END ] + $fields );
				$this->fail( "{$verb} read a Ledger with no file" );
			} catch ( \LogicException $e ) {
				$this->assertSame( 'Ledger lab-7:kea has opened no file', $e->getMessage() );
			}
		}
	}

	public function test_the_counters_tally_each_read_by_keys_asked_and_rows_answered(): void {
		$kea                 = $this->kea();
		$ns                  = 0;
		Ledger_Node::$hrtime = static function () use ( &$ns ): int {
			$ns += 1500000;
			return $ns;
		};
		$this->read( $kea, 'SUM', [ 'from' => self::T, 'to' => self::END, 'ks' => [ 'sku-41', 'sku-43', 'sku-47' ] ] );
		$this->read( $kea, 'TOP', [ 'from' => self::T, 'to' => self::END, 'ks' => [ 'sku-41', 'sku-43' ], 'column' => 'qty', 'order' => 'desc', 'limit' => 1, 'offset' => 0 ] );
		$this->read( $kea, 'MEMBERS', [ 'from' => self::T, 'to' => self::END, 'k' => 'sku-41' ] );
		$stats = $kea->stats();
		$this->assertSame( [ 'calls' => 1, 'asked' => 3, 'answered' => 4, 'bytes' => 0, 'total_ms' => 1.5, 'max_ms' => 1.5 ], $stats['SUM'] );
		$this->assertSame( [ 'calls' => 1, 'asked' => 2, 'answered' => 1, 'bytes' => 0, 'total_ms' => 1.5, 'max_ms' => 1.5 ], $stats['TOP'] );
		$this->assertSame( [ 'calls' => 1, 'asked' => 1, 'answered' => 2, 'bytes' => 0, 'total_ms' => 1.5, 'max_ms' => 1.5 ], $stats['MEMBERS'] );
	}
}
