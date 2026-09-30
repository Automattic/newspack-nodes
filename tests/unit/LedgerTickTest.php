<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Ledger_Node;
use Newspack_Nodes\Node;
use Newspack_Nodes\Node_Names;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\Table_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Tick_Housekeeper;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * A checkpoint statement answering each fetch with the next scripted row,
 * or with SQLite's own answer for a null; SQLite answers `[ 1, -1, -1 ]`
 * while another connection holds the checkpoint lock.
 */
final class Scripted_Checkpoint_Fixture extends \PDOStatement {
	/** @var list<list<int>|null> */
	public static array $answers = [];

	protected function __construct() {}

	public function fetchAll( int $mode = \PDO::FETCH_DEFAULT, mixed ...$args ): array {
		$rows   = parent::fetchAll( $mode, ...$args );
		$answer = \array_shift( self::$answers );
		return null === $answer ? $rows : [ $answer ];
	}
}

/**
 * A Ledger on the Router tick: the writer drops each segment the wall clock
 * has carried past the lifespan, a whole segment at a time and never a row
 * inside it, in batches under the one budget the tick gives every store,
 * and writes its WAL back with a PASSIVE checkpoint once an interval.
 */
#[CoversClass( Ledger_Node::class )]
#[CoversClass( Table_Node::class )]
final class LedgerTickTest extends TestCase {
	/** A segment boundary: 1790000400 is a multiple of 600. */
	private const T = 1790000400;

	/** Past the first of the three segments, in the second's first 600 s. */
	private const PAST_FIRST = self::T + 700;

	private string $dir = '';
	private Command_Interpreter_Node $interpreter;
	private Router_Node $router;

	/** Nanoseconds each read of the pinned monotonic clock advances. */
	private int $step = 0;

	/** @var list<string> */
	private array $logged = [];

	protected function setUp(): void {
		parent::setUp();
		$this->dir = $this->make_temp_dir( 'ledger-tick-' );
		$this->use_base_dir( $this->dir );
		Core::$clock         = static fn (): float => (float) self::T;
		Core::$now           = (float) self::T;
		$ns                  = 0;
		$step                = &$this->step;
		Ledger_Node::$hrtime = static function () use ( &$ns, &$step ): int {
			$ns += $step;
			return $ns;
		};
		$this->interpreter = new Command_Interpreter_Node();
		$this->interpreter->name( '_command_interpreter' );
		$this->interpreter->sink( new Capture_Sink_Node() );
		$this->router = new Router_Node();
		$this->router->name( Node_Names::ROUTER );
		$logged = &$this->logged;
		\add_action(
			'newspack_nodes/stderr',
			static function ( string $line ) use ( &$logged ): void {
				$logged[] = $line;
			}
		);
	}

	protected function tearDown(): void {
		Ledger_Node::$hrtime = null;
		Core::$clock         = null;
		unset( Core::$var['partition'] );
		$this->rmdir_recursive( $this->dir );
		parent::tearDown();
	}

	/** The kea Ledger in partition `$partition`'s worker: 600 s segments, three kept. */
	private function kea( string $partition = '3' ): Ledger_Node {
		Core::$var['partition'] = $partition;
		$ledger                 = $this->interpreter->make_node( 'Ledger', 'lab-7:kea', '600', '3', 'qty', 'lo:min', 'hi:max' );
		$this->assertInstanceOf( Ledger_Node::class, $ledger );
		$ledger->sink( new Capture_Sink_Node() );
		return $ledger;
	}

	/** Two rows in the first segment, one in the second, one in the third. */
	private function seed( Ledger_Node $kea ): void {
		$stored = $kea->append(
			[
				[ self::T - 1800, 'sku-41', 'aisle-9', [ 3, 2.5, 7 ] ],
				[ self::T - 1250, 'sku-43', 'aisle-12', [ 4, 1.5, 9 ] ],
				[ self::T - 1150, 'sku-41', 'aisle-12', [ 5, 0.5, 8 ] ],
				[ self::T - 100, 'sku-43', 'aisle-9', [ 6, 3.5, 11 ] ],
			]
		);
		$this->assertSame( [ 'stored' => 4, 'dropped' => 0 ], $stored );
	}

	/** One Router tick at `$now`, the live clock pinned there too. */
	private function tick( int $now ): void {
		Core::$clock = static fn (): float => (float) $now;
		Core::$now   = (float) $now;
		$this->router->fire_cb();
	}

	/** @return list<int> Every row's `t` in the Ledger's file, in key order. */
	private function times(): array {
		$db = new \PDO( 'sqlite:' . Ledger_Node::file( 'lab-7:kea' ) );
		return \array_map( 'intval', $db->query( 'SELECT t FROM rows' )->fetchAll( \PDO::FETCH_COLUMN ) );
	}

	/** @return array<string,int|float> One verb's counter row. */
	private static function row( Ledger_Node $ledger, string $verb ): array {
		return $ledger->stats()[ $verb ];
	}

	/** @return list<string> The lines logged that mention `$needle`. */
	private function logged( string $needle ): array {
		return \array_values( \array_filter( $this->logged, static fn ( string $line ): bool => \str_contains( $line, $needle ) ) );
	}

	public function test_one_tick_drops_exactly_the_segment_the_clock_carried_past_the_lifespan(): void {
		$kea = $this->kea();
		$this->seed( $kea );
		$this->tick( self::PAST_FIRST );
		$this->assertSame( [ self::T - 1150, self::T - 100 ], $this->times(), 'T-1150 is past the lifespan but inside a segment that is not' );
		$drop = self::row( $kea, 'DROP' );
		$this->assertSame( [ 1, Ledger_Node::DROP_BATCH_ROWS, 2 ], [ $drop['calls'], $drop['asked'], $drop['answered'] ] );
		$this->assertSame( 20000, Ledger_Node::DROP_BATCH_ROWS );
	}

	public function test_a_second_tick_drops_nothing_and_the_next_segment_goes_when_the_clock_passes_it(): void {
		$kea = $this->kea();
		$this->seed( $kea );
		$this->tick( self::PAST_FIRST );
		$this->tick( self::PAST_FIRST + 1 );
		$this->tick( self::T + 1199 );
		$this->assertSame( [ self::T - 1150, self::T - 100 ], $this->times() );
		$this->assertSame( [ 1, 2 ], [ self::row( $kea, 'DROP' )['calls'], self::row( $kea, 'DROP' )['answered'] ], 'no statement runs until the next segment falls due' );
		$this->tick( self::T + 1200 );
		$this->assertSame( [ self::T - 100 ], $this->times() );
		$this->assertSame( [ 2, 3 ], [ self::row( $kea, 'DROP' )['calls'], self::row( $kea, 'DROP' )['answered'] ] );
	}

	public function test_another_partition_ticking_the_same_file_finds_nothing_left_to_drop(): void {
		$this->seed( $this->kea( '3' ) );
		$this->tick( self::PAST_FIRST );
		// Each partition's worker is its own process, so each holds the name.
		Core::unregister_node( 'lab-7:kea' );
		$five = $this->kea( '5' );
		$this->tick( self::PAST_FIRST + 5 );
		$this->assertSame( [ self::T - 1150, self::T - 100 ], $this->times() );
		$this->assertSame( [ 1, 0 ], [ self::row( $five, 'DROP' )['calls'], self::row( $five, 'DROP' )['answered'] ] );
	}

	public function test_a_drop_meeting_another_writers_lock_waits_only_the_budget_left_then_skips_to_the_next_tick(): void {
		$kea = $this->kea();
		$this->seed( $kea );
		$db       = ( new \ReflectionProperty( Ledger_Node::class, 'db' ) )->getValue( $kea );
		$timeouts = [];
		// Each monotonic read inside a verb records the connection's busy_timeout.
		Ledger_Node::$hrtime = static function () use ( $db, &$timeouts ): int {
			$timeouts[] = (int) $db->query( 'PRAGMA busy_timeout' )->fetchColumn();
			return 0;
		};
		$other = new \PDO( 'sqlite:' . Ledger_Node::file( 'lab-7:kea' ) );
		$other->exec( 'BEGIN IMMEDIATE' );
		try {
			foreach ( [ self::PAST_FIRST, self::PAST_FIRST + 1 ] as $now ) {
				$reads       = 0;
				// The deadline read sees $now; the drop starts with 3 ms of 50 left.
				Core::$clock = static function () use ( $now, &$reads ): float {
					return $now + ( 0 === $reads++ ? 0.0 : 0.047 );
				};
				Core::$now   = (float) $now;
				$this->router->fire_cb();
			}
		} finally {
			$other->exec( 'ROLLBACK' );
		}
		$full = Ledger_Node::BUSY_TIMEOUT_MS;
		// Each drop's first read precedes its batch, which sets what is left.
		$this->assertSame( [ $full, 3, $full, $full, $full, 3 ], $timeouts, 'each batch waits what the tick has left; the checkpoint between them is PASSIVE and waits on no lock' );
		$this->assertSame( Ledger_Node::BUSY_TIMEOUT_MS, (int) $db->query( 'PRAGMA busy_timeout' )->fetchColumn(), 'an append waits BUSY_TIMEOUT_MS again' );
		$this->assertSame( 1, self::row( $kea, 'CHECKPOINT' )['calls'], 'the checkpoint ran under the held lock' );
		$this->assertSame( [ self::T - 1800, self::T - 1250, self::T - 1150, self::T - 100 ], $this->times(), 'nothing went while the lock was held' );
		$this->assertSame( [ 2, 0 ], [ self::row( $kea, 'DROP' )['calls'], self::row( $kea, 'DROP' )['answered'] ] );
		$skipped = $this->logged( 'segment drop' );
		$this->assertCount( 1, $skipped, 'rate-limited' );
		$this->assertMatchesRegularExpression( '/lab-7:kea: WARNING: segment drop skipped: .*database is locked/', $skipped[0] );
		$this->tick( self::PAST_FIRST + 2 );
		$this->assertSame( [ self::T - 1150, self::T - 100 ], $this->times(), 'the next tick dropped the segment and nothing inside the lifespan' );
	}

	public function test_each_batch_waits_what_the_tick_has_left_when_it_starts(): void {
		$kea  = $this->kea();
		$rows = \array_fill( 0, Ledger_Node::DROP_BATCH_ROWS + 1, [ self::T - 1800, 'sku-43', 'aisle-12', [ 4, 1.5, 9 ] ] );
		$kea->append( $rows );
		$db       = ( new \ReflectionProperty( Ledger_Node::class, 'db' ) )->getValue( $kea );
		$timeouts = [];
		$reads    = 0;
		// Every clock read 10 ms on, recording the timeout the connection holds.
		Core::$clock = static function () use ( $db, &$timeouts, &$reads ): float {
			$timeouts[] = (int) $db->query( 'PRAGMA busy_timeout' )->fetchColumn();
			return self::PAST_FIRST + 0.01 * $reads++;
		};
		Core::$now = (float) self::PAST_FIRST;
		Table_Node::tick( self::PAST_FIRST );
		$full = Ledger_Node::BUSY_TIMEOUT_MS;
		$this->assertSame( [ $full, $full, 40, 40, 20 ], $timeouts, 'the deadline, then each batch sets what is left before it runs: 40 ms, then 20' );
		$this->assertSame( [ 1, Ledger_Node::DROP_BATCH_ROWS + 1 ], [ self::row( $kea, 'DROP' )['calls'], self::row( $kea, 'DROP' )['answered'] ], 'one drop, two batches' );
		$this->assertSame( $full, (int) $db->query( 'PRAGMA busy_timeout' )->fetchColumn() );
	}

	public function test_a_checkpoint_sqlite_answers_busy_counts_but_neither_ends_nor_extends_a_stall(): void {
		$kea = $this->kea();
		$this->seed( $kea );
		$db = ( new \ReflectionProperty( Ledger_Node::class, 'db' ) )->getValue( $kea );
		( new \ReflectionProperty( Ledger_Node::class, 'checkpoint' ) )->setValue( $kea, $db->prepare( 'PRAGMA wal_checkpoint(PASSIVE)', [ \PDO::ATTR_STATEMENT_CLASS => [ Scripted_Checkpoint_Fixture::class, [] ] ] ) );
		$busy                                = [ 1, -1, -1 ];
		Scripted_Checkpoint_Fixture::$answers = [ null, null, $busy, $busy, null, null ];
		$reader                              = new \PDO( 'sqlite:' . Ledger_Node::file( 'lab-7:kea' ) );
		$reader->exec( 'BEGIN' );
		$reader->query( 'SELECT count(*) FROM rows' )->fetchAll();
		$interval = Ledger_Node::CHECKPOINT_INTERVAL_S;
		try {
			for ( $n = 0; $n < 5; ++$n ) {
				$kea->append( [ [ self::T + $n, 'sku-41', 'aisle-9', [ 3, 2.5, 7 ] ] ] );
				Core::$now = (float) ( self::T + $n * $interval );
				Table_Node::tick( self::T + $n * $interval );
			}
			$this->assertSame( [], $this->logged( 'WAL checkpoint' ), 'two busy answers did not count toward the stall' );
			$kea->append( [ [ self::T + 5, 'sku-41', 'aisle-9', [ 3, 2.5, 7 ] ] ] );
			Core::$now = (float) ( self::T + 5 * $interval );
			Table_Node::tick( self::T + 5 * $interval );
		} finally {
			$reader->exec( 'ROLLBACK' );
		}
		$this->assertSame( 6, self::row( $kea, 'CHECKPOINT' )['calls'] );
		$stalled = $this->logged( 'WAL checkpoint' );
		$this->assertCount( 1, $stalled, 'the fourth partial checkpoint warns: the busy answers did not end the stall' );
		$this->assertStringContainsString( 'lab-7:kea: WARNING: WAL checkpoint has not completed for 4 checkpoints', $stalled[0] );
	}

	public function test_the_tick_runs_any_named_housekeeper(): void {
		$ran   = [];
		$chore = new class( $ran ) extends Node implements Tick_Housekeeper {
			/** @param list<int> $ran */
			public function __construct( private array &$ran ) {
				parent::__construct();
			}

			public function tick_steps( int $now ): array {
				return [
					'purge'      => null,
					'behind'     => false,
					'checkpoint' => null,
					'trace'      => function () use ( $now ): void {
						$this->ran[] = $now;
					},
				];
			}
		};
		$chore->name( 'lab-7:owl' );
		Table_Node::tick( 1790000043 );
		$this->assertSame( [ 1790000043 ], $ran );
		$this->assertInstanceOf( Tick_Housekeeper::class, $this->kea() );
	}

	public function test_the_checkpoint_writes_the_wal_back_once_an_interval(): void {
		$kea = $this->kea();
		$this->seed( $kea );
		$this->tick( self::T );
		$checkpoint = self::row( $kea, 'CHECKPOINT' );
		$this->assertSame( 1, $checkpoint['calls'] );
		$this->assertGreaterThan( 0, $checkpoint['asked'], 'the append was in the WAL' );
		$this->assertSame( $checkpoint['asked'], $checkpoint['answered'], 'every frame went back' );
		for ( $second = 1; $second < Ledger_Node::CHECKPOINT_INTERVAL_S; ++$second ) {
			$kea->append( [ [ self::T + $second, 'sku-43', 'aisle-12', [ 1, 1, 1 ] ] ] );
			$this->tick( self::T + $second );
		}
		$this->assertSame( 1, self::row( $kea, 'CHECKPOINT' )['calls'], 'ticks inside the interval' );
		$this->tick( self::T + Ledger_Node::CHECKPOINT_INTERVAL_S );
		$checkpoint = self::row( $kea, 'CHECKPOINT' );
		$this->assertSame( 2, $checkpoint['calls'] );
		$this->assertSame( $checkpoint['asked'], $checkpoint['answered'] );
		$this->assertSame( Table_Node::CHECKPOINT_INTERVAL_S, Ledger_Node::CHECKPOINT_INTERVAL_S, 'one interval for every store' );
	}

	public function test_a_mounted_ledger_never_drops_or_checkpoints(): void {
		$kea = $this->kea();
		$this->seed( $kea );
		( new \ReflectionProperty( Ledger_Node::class, 'mounted' ) )->setValue( $kea, true );
		$this->tick( self::PAST_FIRST );
		$this->assertSame( [ 0, 0 ], [ self::row( $kea, 'DROP' )['calls'], self::row( $kea, 'CHECKPOINT' )['calls'] ] );
		$this->assertCount( 4, $this->times() );
	}

	public function test_a_traced_ledger_writes_its_line_on_the_tick(): void {
		$kea = $this->kea();
		$kea->debug_state( 1 );
		$this->step = 1250000;
		$this->seed( $kea );
		$this->tick( self::PAST_FIRST );
		$traced = $this->logged( 'DEBUG:' );
		$this->assertCount( 1, $traced );
		$this->assertStringEndsWith( 'lab-7:kea: DEBUG: APPEND 1 1.25ms, DROP 1 1.25ms, CHECKPOINT 1 1.25ms', \trim( $traced[0] ) );
	}

	public function test_tables_and_ledgers_spend_one_budget_and_a_full_last_batch_leaves_the_drop_behind(): void {
		Core::$var['partition'] = '3';
		$owl                    = new Table_Node();
		$owl->name( 'lab-7:owl' );
		$owl->arguments( [ 'owl:p3', '777', 'sqlite' ] );
		$owl->sink( new Capture_Sink_Node() );
		$kea  = $this->kea();
		$rows = \array_fill( 0, Ledger_Node::DROP_BATCH_ROWS + 1, [ self::T - 1800, 'sku-41', 'aisle-9', [ 3, 2.5, 7 ] ] );
		$this->assertSame( Ledger_Node::DROP_BATCH_ROWS + 1, $kea->append( $rows )['stored'] );
		$reads       = 0;
		Core::$clock = static function () use ( &$reads ): float {
			return self::PAST_FIRST + 0.03 * $reads++;
		};
		Core::$now = (float) self::PAST_FIRST;
		Table_Node::tick( self::PAST_FIRST );
		$this->assertSame( 1, $owl->stats()['PURGE']['calls'], "the Table's purge spent 0.03 s of the 0.05 s" );
		$this->assertSame( [ 1, Ledger_Node::DROP_BATCH_ROWS ], [ self::row( $kea, 'DROP' )['calls'], self::row( $kea, 'DROP' )['answered'] ], 'the drop ran one batch in what was left' );
		$this->assertCount( 1, $this->times() );
		$behind = $this->logged( 'segment drop' );
		$this->assertCount( 1, $behind );
		$this->assertStringContainsString( 'lab-7:kea: WARNING: segment drop is behind: its last batch came back full after 1 batches, 20000 rows', $behind[0] );
		$this->tick( self::PAST_FIRST + 1 );
		$this->assertSame( [], $this->times(), 'a drop left behind runs on the next tick' );
		$this->assertSame( [ 2, Ledger_Node::DROP_BATCH_ROWS + 1 ], [ self::row( $kea, 'DROP' )['calls'], self::row( $kea, 'DROP' )['answered'] ] );
	}
}
