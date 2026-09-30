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

	/** How a TOP refuses an order_by the kea Ledger, one sum column, cannot rank by. */
	private const KEA_ORDER_BY = 'order_by is x or one of qty, lo, hi';

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
		$this->unregister_worker_node( 'lab-7:kea' );
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
	 * The ibis Ledger, written by partition 4, with two sum columns a ratio
	 * divides. Across srv-2 and srv-7, ms / hits / errors / peak: /a 1300 /
	 * 5 / 1 / 40, /b 450 / 10 / 2 / 90, /c 70 / 0 / 0 / 5 (no hits), /d 30 /
	 * 2 / 0 / 15. Errors fall only in ( T, /a ) and ( T+600, /b ).
	 */
	private function ibis(): Ledger_Node {
		$ibis = $this->ledger( '4', 'lab-7:ibis', '600', '3', 'ms', 'hits', 'errors', 'peak:max' );
		$ibis->append(
			[
				[ self::T, 'srv-2', '/a', [ 900, 3, 1, 40 ] ],
				[ self::T + 600, 'srv-2', '/a', [ 100, 1, 0, 20 ] ],
				[ self::T, 'srv-2', '/b', [ 400, 8, 0, 30 ] ],
				[ self::T + 600, 'srv-2', '/b', [ 50, 2, 2, 90 ] ],
				[ self::T, 'srv-7', '/a', [ 300, 1, 0, 10 ] ],
				[ self::T + 1200, 'srv-7', '/c', [ 70, 0, 0, 5 ] ],
				[ self::T + 1200, 'srv-7', '/d', [ 30, 2, 0, 15 ] ],
			]
		);
		return $ibis;
	}

	/**
	 * The heron Ledger, written by partition 6: qty summed, lo its minimum.
	 * ( T, dock-3, /p ) 5 / -1, ( T+600, dock-3, /p ) 3 / 2, and
	 * ( T, dock-3, /q ) 7 / 4, so dock-3's window minimum is -1 while its
	 * minimum at T+600 is 2.
	 */
	private function heron(): Ledger_Node {
		$heron = $this->ledger( '6', 'lab-7:heron', '600', '3', 'qty', 'lo:min' );
		$heron->append(
			[
				[ self::T, 'dock-3', '/p', [ 5, -1 ] ],
				[ self::T + 600, 'dock-3', '/p', [ 3, 2 ] ],
				[ self::T, 'dock-3', '/q', [ 7, 4 ] ],
			]
		);
		return $heron;
	}

	/**
	 * The crane Ledger, written by partition 2, whose min and max columns
	 * take null for "not measured": /a 10 / 3 / 8 at T and 1 / - / - at
	 * T+600, /b 20 / - / - (never measured), /c 5 / 1.5 / 12.
	 */
	private function crane(): Ledger_Node {
		$crane = $this->ledger( '2', 'lab-7:crane', '600', '3', 'ms', 'fast:min', 'slow:max' );
		$crane->append(
			[
				[ self::T, 'rack-4', '/a', [ 10, 3, 8 ] ],
				[ self::T + 600, 'rack-4', '/a', [ 1, null, null ] ],
				[ self::T, 'rack-4', '/b', [ 20, null, null ] ],
				[ self::T, 'rack-4', '/c', [ 5, 1.5, 12 ] ],
			]
		);
		return $crane;
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
			$this->read( $kea, 'TOP', [ 'from' => self::T, 'to' => self::END, 'ks' => [ 'sku-41', 'sku-43' ], 'order_by' => 'qty', 'order' => 'desc', 'limit' => 1, 'offset' => 1 ] )
		);
		$this->assertSame(
			self::answered(
				'TOP',
				[
					'total' => 2,
					'rows'  => [ [ 'aisle-12', 7.0, 3.0, 8.0 ], [ 'aisle-9', 13.0, 0.5, 11.0 ] ],
				]
			),
			$this->read( $kea, 'TOP', [ 'from' => self::T, 'to' => self::END, 'ks' => [ 'sku-41', 'sku-43' ], 'order_by' => 'lo', 'order' => 'desc', 'limit' => 5, 'offset' => 0 ] ),
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
			$this->read( $this->kea(), 'TOP', [ 'from' => self::T, 'to' => self::END, 'ks' => [ 'sku-43' ], 'order_by' => 'hi', 'order' => 'asc', 'limit' => 9, 'offset' => 0, 'positive' => 'qty' ] )
		);
	}

	public function test_top_orders_by_a_ratio_of_two_sum_columns_with_a_zero_denominator_last(): void {
		$ibis = $this->ibis();
		$top  = [ 'from' => self::T, 'to' => self::END, 'ks' => [ 'srv-2', 'srv-7' ], 'order_by' => [ 'ms', 'hits' ], 'limit' => 9, 'offset' => 0 ];
		$rows = [
			'/a' => [ '/a', 1300.0, 5.0, 1.0, 40.0 ],
			'/b' => [ '/b', 450.0, 10.0, 2.0, 90.0 ],
			'/c' => [ '/c', 70.0, 0.0, 0.0, 5.0 ],
			'/d' => [ '/d', 30.0, 2.0, 0.0, 15.0 ],
		];
		$this->assertSame(
			self::answered( 'TOP', [ 'total' => 4, 'rows' => [ $rows['/a'], $rows['/b'], $rows['/d'], $rows['/c'] ] ] ),
			$this->read( $ibis, 'TOP', $top + [ 'order' => 'desc' ] ),
			'260, 45, 15 ms a hit, and /c with no hits last'
		);
		$this->assertSame(
			self::answered( 'TOP', [ 'total' => 4, 'rows' => [ $rows['/d'], $rows['/b'], $rows['/a'], $rows['/c'] ] ] ),
			$this->read( $ibis, 'TOP', $top + [ 'order' => 'asc' ] ),
			'/c with no hits last ascending too'
		);
		$this->assertSame(
			[ Message::TM_ERROR, "TOP: order_by is x, one of ms, hits, errors, peak, or [ numerator, denominator ] naming two sum columns of ms, hits, errors\n" ],
			$this->read( $ibis, 'TOP', [ 'order' => 'desc', 'order_by' => [ 'ms', 'peak' ] ] + $top ),
			'a ratio over a max column is refused, naming the sum columns'
		);
	}

	public function test_top_orders_by_x_itself(): void {
		$this->assertSame(
			self::answered( 'TOP', [ 'total' => 4, 'rows' => [ [ '/d', 30.0, 2.0, 0.0, 15.0 ], [ '/c', 70.0, 0.0, 0.0, 5.0 ] ] ] ),
			$this->read( $this->ibis(), 'TOP', [ 'from' => self::T, 'to' => self::END, 'ks' => [ 'srv-2', 'srv-7' ], 'order_by' => 'x', 'order' => 'desc', 'limit' => 2, 'offset' => 0 ] )
		);
	}

	public function test_top_positive_each_t_sums_only_the_rows_in_which_the_member_was_positive(): void {
		$ibis = $this->ibis();
		$top  = [ 'from' => self::T, 'to' => self::END, 'ks' => [ 'srv-2', 'srv-7' ], 'order_by' => 'ms', 'order' => 'desc', 'limit' => 9, 'offset' => 0, 'positive' => 'errors' ];
		$this->assertSame(
			self::answered( 'TOP', [ 'total' => 2, 'rows' => [ [ '/a', 1300.0, 5.0, 1.0, 40.0 ], [ '/b', 450.0, 10.0, 2.0, 90.0 ] ] ] ),
			$this->read( $ibis, 'TOP', $top ),
			'positive alone filters on the window aggregate'
		);
		$this->assertSame(
			self::answered( 'TOP', [ 'total' => 2, 'rows' => [ [ '/a', 900.0, 3.0, 1.0, 40.0 ], [ '/b', 50.0, 2.0, 2.0, 90.0 ] ] ] ),
			$this->read( $ibis, 'TOP', $top + [ 'positive_each_t' => true ] ),
			'( T, srv-2, /a ) and ( T+600, srv-2, /b ) alone; ( T, srv-7, /a ) had no errors'
		);
		$this->assertSame(
			self::answered( 'TOP', [ 'total' => 2, 'rows' => [ [ '/b', 50.0, 2.0, 2.0, 90.0 ] ] ] ),
			$this->read( $ibis, 'TOP', [ 'order_by' => [ 'errors', 'hits' ], 'limit' => 1 ] + $top + [ 'positive_each_t' => true ] ),
			'a ratio over the rows that passed alone: /b 1 a hit, /a 1 in 3'
		);
	}

	public function test_positive_each_t_admits_a_member_the_window_aggregate_excludes(): void {
		$heron = $this->heron();
		$top   = [ 'from' => self::T, 'to' => self::END, 'ks' => [ 'dock-3' ], 'order_by' => 'qty', 'order' => 'desc', 'limit' => 9, 'offset' => 0, 'positive' => 'lo' ];
		$this->assertSame(
			self::answered( 'TOP', [ 'total' => 1, 'rows' => [ [ '/q', 7.0, 4.0 ] ] ] ),
			$this->read( $heron, 'TOP', $top ),
			'/p\'s window minimum is -1, so the window filter drops it'
		);
		$this->assertSame(
			self::answered( 'TOP', [ 'total' => 2, 'rows' => [ [ '/q', 7.0, 4.0 ], [ '/p', 3.0, 2.0 ] ] ] ),
			$this->read( $heron, 'TOP', $top + [ 'positive_each_t' => true ] ),
			'/p counts at T+600, where its minimum is 2, and the total counts it'
		);
	}

	public function test_sum_group_k_totals_every_member_of_each_key(): void {
		$ibis  = $this->ibis();
		$range = [ 'from' => self::T, 'to' => self::END, 'ks' => [ 'srv-2', 'srv-7' ], 'group' => 'k' ];
		$this->assertSame(
			self::answered( 'SUM', [ [ 'srv-2', null, null, 1450.0, 14.0, 3.0, 90.0 ], [ 'srv-7', null, null, 400.0, 3.0, 0.0, 15.0 ] ] ),
			$this->read( $ibis, 'SUM', $range )
		);
		$this->assertSame(
			self::answered(
				'SUM',
				[
					[ 'srv-2', null, self::T, 1300.0, 11.0, 1.0, 40.0 ],
					[ 'srv-2', null, self::T + 600, 150.0, 3.0, 2.0, 90.0 ],
					[ 'srv-7', null, self::T, 300.0, 1.0, 0.0, 10.0 ],
					[ 'srv-7', null, self::T + 1200, 100.0, 2.0, 0.0, 15.0 ],
				]
			),
			$this->read( $ibis, 'SUM', $range + [ 'by_t' => true ] ),
			'per t with by_t'
		);
		$this->assertSame(
			self::answered( 'SUM', [ [ 'srv-2', null, null, 1000.0, 4.0, 1.0, 40.0 ], [ 'srv-7', null, null, 300.0, 1.0, 0.0, 10.0 ] ] ),
			$this->read( $ibis, 'SUM', $range + [ 'xs' => [ '/a' ] ] ),
			'xs narrows the members totalled'
		);
		$this->assertSame(
			self::answered( 'SUM', [ [ 'srv-2', '/a', null, 1000.0, 4.0, 1.0, 40.0 ] ] ),
			$this->read( $ibis, 'SUM', [ 'group' => 'x', 'ks' => [ 'srv-2' ], 'xs' => [ '/a' ] ] + $range ),
			'group x is the ( k, x ) grouping'
		);
	}

	public function test_sum_positive_keeps_groups_whose_window_aggregate_is_above_zero(): void {
		$ibis  = $this->ibis();
		$range = [ 'from' => self::T, 'to' => self::END, 'ks' => [ 'srv-2', 'srv-7' ], 'positive' => 'errors' ];
		$this->assertSame(
			self::answered( 'SUM', [ [ 'srv-2', '/a', null, 1000.0, 4.0, 1.0, 40.0 ], [ 'srv-2', '/b', null, 450.0, 10.0, 2.0, 90.0 ] ] ),
			$this->read( $ibis, 'SUM', $range ),
			'srv-7 and every member of it with no errors drops'
		);
		$this->assertSame(
			self::answered(
				'SUM',
				[
					[ 'srv-2', '/a', self::T, 900.0, 3.0, 1.0, 40.0 ],
					[ 'srv-2', '/a', self::T + 600, 100.0, 1.0, 0.0, 20.0 ],
					[ 'srv-2', '/b', self::T, 400.0, 8.0, 0.0, 30.0 ],
					[ 'srv-2', '/b', self::T + 600, 50.0, 2.0, 2.0, 90.0 ],
				]
			),
			$this->read( $ibis, 'SUM', $range + [ 'by_t' => true ] ),
			'with by_t a kept group answers every t, those with no errors too'
		);
		$this->assertSame(
			self::answered( 'SUM', [ [ 'srv-2', null, null, 1450.0, 14.0, 3.0, 90.0 ] ] ),
			$this->read( $ibis, 'SUM', $range + [ 'group' => 'k' ] ),
			'group k keeps the keys with errors'
		);
		$this->assertSame(
			self::answered( 'SUM', [ [ 'srv-2', null, self::T, 1300.0, 11.0, 1.0, 40.0 ], [ 'srv-2', null, self::T + 600, 150.0, 3.0, 2.0, 90.0 ] ] ),
			$this->read( $ibis, 'SUM', $range + [ 'group' => 'k', 'by_t' => true ] ),
			'group k with by_t answers each t of the kept key'
		);
		$this->assertSame( self::answered( 'SUM', [] ), $this->read( $this->heron(), 'SUM', [ 'from' => self::T, 'to' => self::END, 'ks' => [ 'dock-3' ], 'group' => 'k', 'positive' => 'lo', 'by_t' => true ] ), 'dock-3\'s window minimum is -1, so no t of it answers' );
	}

	public function test_sum_positive_each_t_totals_only_the_rows_that_passed(): void {
		$ibis  = $this->ibis();
		$range = [ 'from' => self::T, 'to' => self::END, 'ks' => [ 'srv-2', 'srv-7' ], 'positive' => 'errors', 'positive_each_t' => true ];
		$this->assertSame(
			self::answered( 'SUM', [ [ 'srv-2', '/a', null, 900.0, 3.0, 1.0, 40.0 ], [ 'srv-2', '/b', null, 50.0, 2.0, 2.0, 90.0 ] ] ),
			$this->read( $ibis, 'SUM', $range ),
			'( T, srv-2, /a ) and ( T+600, srv-2, /b ) alone'
		);
		$this->assertSame(
			self::answered( 'SUM', [ [ 'srv-2', '/a', self::T, 900.0, 3.0, 1.0, 40.0 ], [ 'srv-2', '/b', self::T + 600, 50.0, 2.0, 2.0, 90.0 ] ] ),
			$this->read( $ibis, 'SUM', $range + [ 'by_t' => true ] ),
			'with by_t each positive t answers alone'
		);
		$heron = $this->heron();
		$dock  = [ 'from' => self::T, 'to' => self::END, 'ks' => [ 'dock-3' ], 'group' => 'k', 'positive' => 'lo' ];
		$this->assertSame( self::answered( 'SUM', [] ), $this->read( $heron, 'SUM', $dock ), 'the window minimum is -1' );
		$this->assertSame(
			self::answered( 'SUM', [ [ 'dock-3', null, null, 10.0, 2.0 ] ] ),
			$this->read( $heron, 'SUM', $dock + [ 'positive_each_t' => true ] ),
			'group k: ( T, dock-3, /q ) passes on its own minimum 4 though /p beside it is -1, and ( T+600, dock-3, /p ) on 2'
		);
		$this->assertSame(
			self::answered( 'SUM', [ [ 'dock-3', null, self::T, 7.0, 4.0 ], [ 'dock-3', null, self::T + 600, 3.0, 2.0 ] ] ),
			$this->read( $heron, 'SUM', $dock + [ 'positive_each_t' => true, 'by_t' => true ] )
		);
	}

	public function test_positive_each_t_filters_each_stored_row_before_any_grouping(): void {
		$ibis = $this->ibis();
		$each = [ 'from' => self::T, 'to' => self::END, 'ks' => [ 'srv-2', 'srv-7' ], 'positive' => 'errors', 'positive_each_t' => true ];
		$this->assertSame(
			self::answered( 'SUM', [ [ 'srv-2', null, null, 950.0, 5.0, 3.0, 90.0 ] ] ),
			$this->read( $ibis, 'SUM', $each + [ 'group' => 'k' ] ),
			'srv-2 counts /a at T, which errored, and never /b at T beside it, which did not'
		);
		$this->assertSame(
			self::answered( 'SUM', [ [ 'srv-2', null, self::T, 900.0, 3.0, 1.0, 40.0 ], [ 'srv-2', null, self::T + 600, 50.0, 2.0, 2.0, 90.0 ] ] ),
			$this->read( $ibis, 'SUM', $each + [ 'group' => 'k', 'by_t' => true ] )
		);
		$this->assertSame(
			self::answered( 'TOP', [ 'total' => 1, 'rows' => [ [ '/a', 900.0, 3.0, 1.0, 40.0 ] ] ] ),
			$this->read( $ibis, 'TOP', [ 'to' => self::T + 600, 'order_by' => 'ms', 'order' => 'desc', 'limit' => 9, 'offset' => 0 ] + $each ),
			'/a counts under srv-2, where it errored at T, and not under srv-7 at the same T'
		);
	}

	public function test_a_min_or_max_column_skips_what_was_never_measured(): void {
		$this->assertSame(
			self::answered(
				'SUM',
				[
					[ 'rack-4', '/a', null, 11.0, 3.0, 8.0 ],
					[ 'rack-4', '/b', null, 20.0, null, null ],
					[ 'rack-4', '/c', null, 5.0, 1.5, 12.0 ],
				]
			),
			$this->read( $this->crane(), 'SUM', [ 'from' => self::T, 'to' => self::END, 'ks' => [ 'rack-4' ] ] )
		);
	}

	public function test_top_ranks_a_member_never_measured_last_in_either_order(): void {
		$crane = $this->crane();
		$top   = [ 'from' => self::T, 'to' => self::END, 'ks' => [ 'rack-4' ], 'limit' => 9, 'offset' => 0 ];
		foreach (
			[
				[ 'fast', 'asc', [ '/c', '/a', '/b' ] ],
				[ 'fast', 'desc', [ '/a', '/c', '/b' ] ],
				[ 'slow', 'asc', [ '/a', '/c', '/b' ] ],
				[ 'slow', 'desc', [ '/c', '/a', '/b' ] ],
			] as [ $order_by, $order, $ranked ]
		) {
			[ , $reply ] = $this->read( $crane, 'TOP', $top + [ 'order_by' => $order_by, 'order' => $order ] );
			$this->assertSame( $ranked, \array_column( $reply['data']['rows'], 0 ), "{$order_by} {$order}" );
		}
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
		[ , $reply ] = $this->read( $kea, 'TOP', [ 'from' => self::T, 'to' => self::END, 'ks' => [ 'sku-41', 'sku-43' ], 'order_by' => 'qty', 'order' => 'desc', 'limit' => 9, 'offset' => 0 ] );
		$this->assertSame( [ 'aisle-9', 'aisle-12' ], \array_column( $reply['data']['rows'], 0 ), 'the page reads the snapshot the count read' );
		$this->assertSame( 2, $reply['data']['total'] );
		$this->assertFalse( $db->inTransaction(), 'the read transaction ended' );
		$this->assertSame( 'aisle-15', $other->query( "SELECT x FROM rows WHERE x = 'aisle-15'" )->fetchColumn(), 'the other partition committed' );
	}

	public function test_each_read_seeks_its_keys_at_each_distinct_t_rather_than_scanning_the_range(): void {
		$range = [ 'from' => self::T, 'to' => self::END ];
		$top   = $range + [ 'order' => 'desc', 'limit' => 9, 'offset' => 0 ];
		$reads = [
			'lab-7:kea'  => [
				[ 'SUM', $range + [ 'ks' => [ 'sku-41', 'sku-43' ] ] ],
				[ 'SUM', $range + [ 'ks' => [ 'sku-41' ], 'xs' => [ 'aisle-9' ], 'by_t' => true ] ],
				[ 'SUM', $range + [ 'ks' => [ 'sku-41', 'sku-43' ], 'group' => 'k' ] ],
				[ 'SUM', $range + [ 'ks' => [ 'sku-41' ], 'xs' => [ 'aisle-9' ], 'by_t' => true, 'group' => 'k' ] ],
				[ 'TOP', $top + [ 'ks' => [ 'sku-41', 'sku-43' ], 'order_by' => 'qty' ] ],
				[ 'TOP', $top + [ 'ks' => [ 'sku-41', 'sku-43' ], 'order_by' => 'x', 'positive' => 'qty', 'positive_each_t' => true ] ],
			],
			'lab-7:ibis' => [
				[ 'TOP', $top + [ 'ks' => [ 'srv-2', 'srv-7' ], 'order_by' => [ 'ms', 'hits' ] ] ],
				[ 'SUM', $range + [ 'ks' => [ 'srv-2', 'srv-7' ], 'positive' => 'errors', 'positive_each_t' => true ] ],
				[ 'SUM', $range + [ 'ks' => [ 'srv-2', 'srv-7' ], 'group' => 'k', 'by_t' => true, 'positive' => 'errors', 'positive_each_t' => true ] ],
				[ 'SUM', $range + [ 'ks' => [ 'srv-2', 'srv-7' ], 'by_t' => true, 'positive' => 'errors' ] ],
				[ 'SUM', $range + [ 'ks' => [ 'srv-2', 'srv-7' ], 'group' => 'k', 'positive' => 'errors' ] ],
			],
		];
		$ledgers = [
			'lab-7:kea'  => $this->kea(),
			'lab-7:ibis' => $this->ibis(),
		];
		$ran     = [];
		foreach ( $reads as $name => $asked ) {
			$db = ( new \ReflectionProperty( Ledger_Node::class, 'db' ) )->getValue( $ledgers[ $name ] );
			$db->setAttribute( \PDO::ATTR_STATEMENT_CLASS, [ Recording_Statement_Fixture::class, [] ] );
			Recording_Statement_Fixture::$ran = [];
			foreach ( $asked as [ $verb, $query ] ) {
				$this->read( $ledgers[ $name ], $verb, $query );
			}
			foreach ( Recording_Statement_Fixture::$ran as [ $sql, $bound ] ) {
				$ran[] = [ $name, $sql, $bound ];
			}
		}
		$ran[] = [ 'lab-7:kea', ( new \ReflectionClassConstant( Ledger_Node::class, 'MEMBERS_READ' ) )->getValue(), [ 1 => self::T, 2 => self::END, 3 => self::END, 4 => 'sku-41' ] ];
		$this->assertCount( 15, $ran, 'eight SUMs, three TOPs of a count and a page each, and MEMBERS' );
		foreach ( $ran as [ $name, $sql, $bound ] ) {
			$explain = ( new \PDO( 'sqlite:' . Ledger_Node::file( $name ) ) )->prepare( "EXPLAIN QUERY PLAN {$sql}" );
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
		$this->assertSame( self::answered( 'TOP', [ 'total' => 0, 'rows' => [] ] ), $this->read( $kea, 'TOP', $range + [ 'ks' => [ 'sku-41' ], 'order_by' => 'qty', 'order' => 'desc', 'limit' => 9, 'offset' => 0 ] ) );
		$this->assertSame( self::answered( 'MEMBERS', [] ), $this->read( $kea, 'MEMBERS', $range + [ 'k' => 'sku-41' ] ) );
	}

	public function test_no_keys_answer_empty(): void {
		$kea   = $this->kea();
		$range = [ 'from' => self::T, 'to' => self::END ];
		$this->assertSame( self::answered( 'SUM', [] ), $this->read( $kea, 'SUM', $range + [ 'ks' => [] ] ) );
		$this->assertSame( self::answered( 'SUM', [] ), $this->read( $kea, 'SUM', $range + [ 'ks' => [ 'sku-41' ], 'xs' => [] ] ) );
		$this->assertSame( self::answered( 'TOP', [ 'total' => 0, 'rows' => [] ] ), $this->read( $kea, 'TOP', $range + [ 'ks' => [], 'order_by' => 'qty', 'order' => 'desc', 'limit' => 9, 'offset' => 0 ] ) );
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
			[ Message::TM_ERROR, "SUM: positive names a column, and a Ledger declaring no columns has none\n" ],
			$this->read( $wren, 'SUM', [ 'from' => self::T, 'to' => self::END, 'ks' => [ 'sku-41' ], 'positive' => 'qty' ] )
		);
		$top = [ 'from' => self::T, 'to' => self::END, 'ks' => [ 'sku-41' ], 'order' => 'desc', 'limit' => 9, 'offset' => 0 ];
		$this->assertSame(
			self::answered( 'TOP', [ 'total' => 2, 'rows' => [ [ 'aisle-9' ], [ 'aisle-12' ] ] ] ),
			$this->read( $wren, 'TOP', $top + [ 'order_by' => 'x' ] ),
			'a set ranks its members by x'
		);
		foreach ( [ [ 'order_by' => 'qty' ], [ 'order_by' => 'x', 'positive' => 'qty' ] ] as $fields ) {
			$this->assertSame(
				[ Message::TM_ERROR, "TOP: a Ledger declaring no columns ranks by x alone, with no positive\n" ],
				$this->read( $wren, 'TOP', $top + $fields )
			);
		}
	}

	public function test_a_read_it_cannot_answer_is_refused_on_the_error_plane(): void {
		$kea = $this->kea();
		$top = [ 'from' => self::T, 'to' => self::END, 'ks' => [ 'sku-41' ], 'order_by' => 'qty', 'order' => 'desc', 'limit' => 9, 'offset' => 0 ];
		foreach (
			[
				[ 'TOP', [ 'order_by' => 'price' ] + $top, self::KEA_ORDER_BY ],
				[ 'TOP', [ 'order_by' => "qty) --\nTOP: forged" ] + $top, self::KEA_ORDER_BY ],
				[ 'TOP', [ 'order_by' => [ 'qty', 'lo' ] ] + $top, self::KEA_ORDER_BY ],
				[ 'TOP', [ 'order_by' => [ 'qty', 'qty' ] ] + $top, self::KEA_ORDER_BY ],
				[ 'TOP', [ 'order_by' => [ 'qty' ] ] + $top, self::KEA_ORDER_BY ],
				[ 'TOP', [ 'order_by' => [ 'qty', [ 'qty' ] ] ] + $top, self::KEA_ORDER_BY ],
				[ 'TOP', [ 'column' => 'qty' ] + $top, 'takes the fields from, to, ks, order_by, order, limit, offset, positive and positive_each_t alone' ],
				[ 'TOP', [ 'positive_each_t' => true ] + $top, 'positive_each_t needs positive' ],
				[ 'TOP', [ 'positive' => 'qty', 'positive_each_t' => 'yes' ] + $top, 'positive_each_t is true or false' ],
				[ 'SUM', [ 'from' => self::T, 'to' => self::END, 'ks' => [ 'sku-41' ], 'group' => 't' ], 'group is x or k' ],
				[ 'SUM', [ 'from' => self::T, 'to' => self::END, 'ks' => [ 'sku-41' ], 'group' => 'k', 'xs' => \array_map( static fn ( int $i ): string => "aisle-x{$i}", \range( 1, 251 ) ) ], 'xs names at most 250 members with group k' ],
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
				[ 'SUM', [ 'from' => self::T, 'to' => self::END, 'ks' => [ 'sku-41' ], "bt_t\nSUM: forged" => true ], 'takes the fields from, to, ks, xs, by_t, group, positive and positive_each_t alone' ],
				[ 'SUM', [ 'from' => self::T, 'to' => self::END, 'ks' => [ 'sku-41' ], 'positive_each_t' => true ], 'positive_each_t needs positive' ],
				[ 'SUM', [ 'from' => self::T, 'to' => self::END, 'ks' => [ 'sku-41' ], 'positive' => 'price' ], 'positive is one of qty, lo, hi' ],
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
		$this->read( $kea, 'TOP', [ 'from' => self::T, 'to' => self::END, 'ks' => [ 'sku-41', 'sku-43' ], 'order_by' => 'qty', 'order' => 'desc', 'limit' => 1, 'offset' => 0 ] );
		$this->read( $kea, 'MEMBERS', [ 'from' => self::T, 'to' => self::END, 'k' => 'sku-41' ] );
		$stats = $kea->stats();
		$this->assertSame( [ 'calls' => 1, 'asked' => 3, 'answered' => 4, 'bytes' => 0, 'total_ms' => 1.5, 'max_ms' => 1.5 ], $stats['SUM'] );
		$this->assertSame( [ 'calls' => 1, 'asked' => 2, 'answered' => 1, 'bytes' => 0, 'total_ms' => 1.5, 'max_ms' => 1.5 ], $stats['TOP'] );
		$this->assertSame( [ 'calls' => 1, 'asked' => 1, 'answered' => 2, 'bytes' => 0, 'total_ms' => 1.5, 'max_ms' => 1.5 ], $stats['MEMBERS'] );
	}
}
