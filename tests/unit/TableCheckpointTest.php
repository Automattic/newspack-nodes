<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
use Newspack_Nodes\Node_Names;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\Sqlite_Arm;
use Newspack_Nodes\Table_Node;
use Newspack_Nodes\Timer_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * The Router tick's WAL checkpoint: each unmounted SQLite Table, once a tick,
 * after the timers' flushes and the purge, inside the purge's budget, PASSIVE
 * so it never waits on a reader; counted in the Table's CHECKPOINT row, and
 * warned about when it stalls while the WAL grows.
 */
#[CoversClass( Table_Node::class )]
final class TableCheckpointTest extends TestCase {
	private string $dir = '';
	private Table_Node $table;

	/** @var list<string> */
	private array $logged = [];

	protected function setUp(): void {
		parent::setUp();
		$this->dir = $this->make_temp_dir( 'table-checkpoint-' );
		$this->use_base_dir( $this->dir );
		Core::$clock        = static fn (): float => 1790000000.0;
		Core::$now          = 1790000000.0;
		$ns                 = 0;
		Table_Node::$hrtime = static function () use ( &$ns ): int {
			$ns += 2250000;
			return $ns;
		};
		$this->table = $this->worker_table( 'lab-7:kea', 'kea:p3' );
		$logged      = &$this->logged;
		\add_action(
			'newspack_nodes/stderr',
			static function ( string $line ) use ( &$logged ): void {
				$logged[] = $line;
			}
		);
	}

	protected function tearDown(): void {
		Table_Node::$hrtime = null;
		Core::$clock        = null;
		$this->rmdir_recursive( $this->dir );
		parent::tearDown();
	}

	private function worker_table( string $name, string $namespace ): Table_Node {
		Core::$var['partition'] = '3';
		try {
			$table = new Table_Node();
			$table->name( $name );
			$table->arguments( [ $namespace, '777', 'sqlite' ] );
		} finally {
			unset( Core::$var['partition'] );
		}
		$table->sink( new Capture_Sink_Node() );
		return $table;
	}

	private function router(): Router_Node {
		$router = new Router_Node();
		$router->name( Node_Names::ROUTER );
		return $router;
	}

	/** @return array<string,int|float> The Table's CHECKPOINT row. */
	private function checkpoint_row( ?Table_Node $table = null ): array {
		return ( $table ?? $this->table )->stats()['CHECKPOINT'];
	}

	/** `$rows` values of `$bytes` bytes, keyed `{tag}-{i}`. */
	private static function rows( string $tag, int $rows, int $bytes ): array {
		$items = [];
		for ( $i = 0; $i < $rows; ++$i ) {
			$items[ "{$tag}-{$i}" ] = \str_repeat( 'w', $bytes );
		}
		return $items;
	}

	public function test_a_tick_checkpoints_what_its_timers_flushed_and_the_wal_starts_over(): void {
		$router  = $this->router();
		$table   = $this->table;
		$flusher = new class( $table ) extends Timer_Node {
			public function __construct( private readonly Table_Node $into ) {
				parent::__construct();
			}

			public function fire_cb(): void {
				$this->into->store_multi( TableCheckpointTest::flush() );
			}
		};
		$flusher->name( 'flusher' );
		$router->register( 'TIMER', 'flusher' );

		$router->fire_cb();
		$row = $this->checkpoint_row();
		$this->assertSame( 1, $row['calls'] );
		$this->assertGreaterThan( 290, $row['asked'], 'the flush this tick wrote is in the WAL the checkpoint saw' );
		$this->assertSame( $row['asked'], $row['answered'], 'every frame went back' );
		$this->assertSame( 2.25, $row['total_ms'] );
		$first = $row['asked'];

		$router->unregister( 'TIMER', 'flusher' );
		$table->store( 'sku-41', 'kea-41' );
		Core::$now += Table_Node::CHECKPOINT_INTERVAL_S;
		$router->fire_cb();
		$row = $this->checkpoint_row();
		$this->assertSame( 2, $row['calls'] );
		$this->assertLessThan( 10, $row['asked'] - $first, 'the next write restarted the WAL' );
	}

	/** What the flushing timer writes: 300 rows of 3000 bytes. */
	public static function flush(): array {
		return self::rows( 'emu', 300, 3000 );
	}

	public function test_the_tick_step_leaves_the_tick_clock_as_the_tick_set_it(): void {
		$this->table->store_multi( self::rows( 'kea', 40, 900 ) );
		Core::$clock = static fn (): float => 1790000000.0;
		Core::$now   = 1790004242.0;
		Table_Node::tick( 1790004242 );
		$this->assertSame( 1790000000.0, Core::$now, 'a due purge reads the live clock' );
		$this->assertSame( 1, $this->checkpoint_row()['calls'] );
		Core::$now = 1790004272.0;
		Table_Node::tick( 1790004272 );
		$this->assertSame( 1790004272.0, Core::$now, 'a tick that only checkpoints' );
		$this->assertSame( 2, $this->checkpoint_row()['calls'] );
	}

	public function test_ticks_inside_the_interval_do_not_checkpoint_and_the_one_at_it_does(): void {
		$this->assertSame( 30, Table_Node::CHECKPOINT_INTERVAL_S );
		$this->table->store_multi( self::rows( 'kea', 40, 900 ) );
		Table_Node::tick( 1790000000 );
		$this->assertSame( 1, $this->checkpoint_row()['calls'] );
		$first = $this->checkpoint_row()['asked'];
		for ( $second = 1; $second < 30; ++$second ) {
			$this->table->store_multi( self::rows( "s{$second}", 3, 900 ) );
			Table_Node::tick( 1790000000 + $second );
		}
		$this->assertSame( 1, $this->checkpoint_row()['calls'], 'twenty-nine ticks inside the interval' );
		Table_Node::tick( 1790000030 );
		$row = $this->checkpoint_row();
		$this->assertSame( 2, $row['calls'] );
		$this->assertGreaterThan( 29 * 3, $row['asked'] - $first, 'one checkpoint wrote back every write of the interval' );
		$this->assertSame( $row['asked'], $row['answered'] );
	}

	public function test_the_interval_is_per_table(): void {
		Table_Node::tick( 1790000000 );
		$owl = $this->worker_table( 'lab-7:owl', 'owl:p3' );
		Table_Node::tick( 1790000010 );
		$calls = fn (): array => [ $this->checkpoint_row()['calls'], $this->checkpoint_row( $owl )['calls'] ];
		$this->assertSame( [ 1, 1 ], $calls(), 'owl was due on its first tick; kea was not' );
		Table_Node::tick( 1790000030 );
		$this->assertSame( [ 2, 1 ], $calls() );
		Table_Node::tick( 1790000040 );
		$this->assertSame( [ 2, 2 ], $calls() );
	}

	public function test_one_checkpoint_per_table_per_tick(): void {
		$owl = $this->worker_table( 'lab-7:owl', 'owl:p3' );
		$this->table->store_multi( self::rows( 'kea', 40, 900 ) );
		$owl->store_multi( self::rows( 'owl', 70, 900 ) );
		Table_Node::tick( 1790000000 );
		$this->assertSame( [ 1, 1 ], [ $this->checkpoint_row()['calls'], $this->checkpoint_row( $owl )['calls'] ] );
	}

	public function test_a_mount_never_checkpoints(): void {
		$this->table->store_multi( self::rows( 'kea', 40, 900 ) );
		$this->table->remove_node();
		$mount = Table_Node::mount( 'lab-7:kea', 3, [ 'namespace' => 'kea:p3', 'ttl' => 777, 'backend' => 'sqlite' ], new Capture_Sink_Node() );
		Table_Node::tick( 1790000000 );
		$this->assertSame( 0, $this->checkpoint_row( $mount )['calls'] );
		$db = new \PDO( 'sqlite:' . Table_Node::file( 'lab-7:kea', 3 ) );
		[ , $frames, $written ] = $db->query( 'PRAGMA wal_checkpoint(PASSIVE)' )->fetch( \PDO::FETCH_NUM );
		$this->assertGreaterThan( 0, $frames );
		$this->assertSame( $frames, $written, 'the frames were still waiting for this checkpoint' );
	}

	public function test_a_tick_whose_purge_spent_the_budget_leaves_the_checkpoint_to_the_next(): void {
		$this->table->store_multi( self::rows( 'kea', 40, 900 ) );
		$reads       = 0;
		Core::$clock = static function () use ( &$reads ): float {
			return 1790000000.0 + 0.06 * $reads++;
		};
		Table_Node::tick( 1790000000 );
		$this->assertSame( 0, $this->checkpoint_row()['calls'] );
		Core::$clock = static fn (): float => 1790000001.0;
		Table_Node::tick( 1790000001 );
		$this->assertSame( 1, $this->checkpoint_row()['calls'] );
	}

	public function test_a_checkpoint_stalled_while_the_wal_grows_warns_after_four_in_a_row(): void {
		$this->assertSame( 4, Table_Node::WAL_STALL_CHECKPOINTS );
		$interval = Table_Node::CHECKPOINT_INTERVAL_S;
		$this->table->store( 'sku-0', 'kea' );
		$reader = new \PDO( 'sqlite:' . Table_Node::file( 'lab-7:kea', 3 ) );
		$reader->exec( 'BEGIN' );
		$reader->query( 'SELECT count(*) FROM kv' )->fetchAll();
		try {
			for ( $n = 1; $n < Table_Node::WAL_STALL_CHECKPOINTS; ++$n ) {
				$this->table->store( "sku-{$n}", \str_repeat( 'o', 5000 ) );
				Table_Node::tick( 1790000000 + $n * $interval - 15 );
				Table_Node::tick( 1790000000 + $n * $interval );
			}
			$this->assertSame( [], $this->warnings(), 'three stalled checkpoints, and the ticks between them, are a slow reader' );
			$this->table->store( 'sku-4', \str_repeat( 'o', 5000 ) );
			Table_Node::tick( 1790000000 + 4 * $interval );
			$this->assertSame( 4, $this->checkpoint_row()['calls'], 'a tick inside the interval ran none' );
			$this->assertCount( 1, $this->warnings() );
			$this->assertMatchesRegularExpression( '/lab-7:kea: WARNING: WAL checkpoint has not completed for 4 checkpoints while the WAL grew from \d+ to \d+ frames/', $this->warnings()[0] );
		} finally {
			$reader->exec( 'ROLLBACK' );
		}
	}

	public function test_a_stall_the_wal_does_not_grow_through_never_warns(): void {
		$this->table->store( 'sku-0', 'kea' );
		$reader = new \PDO( 'sqlite:' . Table_Node::file( 'lab-7:kea', 3 ) );
		$reader->exec( 'BEGIN' );
		$reader->query( 'SELECT count(*) FROM kv' )->fetchAll();
		try {
			$this->table->store( 'sku-1', \str_repeat( 'o', 5000 ) );
			for ( $n = 1; $n <= 2 * Table_Node::WAL_STALL_CHECKPOINTS; ++$n ) {
				Table_Node::tick( 1790000000 + $n * Table_Node::CHECKPOINT_INTERVAL_S );
			}
		} finally {
			$reader->exec( 'ROLLBACK' );
		}
		$this->assertSame( [], $this->warnings() );
		$row = $this->checkpoint_row();
		$this->assertSame( 2 * Table_Node::WAL_STALL_CHECKPOINTS, $row['calls'] );
		$this->assertLessThan( $row['asked'], $row['answered'], 'every one of those checkpoints was partial' );
	}

	public function test_a_checkpoint_that_fails_is_counted_and_warned_about_rate_limited(): void {
		$missing = "{$this->dir}/tables/lab-7:owl.p5.sqlite";
		( new \ReflectionProperty( Table_Node::class, 'arm' ) )->setValue( $this->table, new Sqlite_Arm( $missing, 'owl:p5', read_only: true ) );
		Table_Node::tick( 1790000000 );
		Table_Node::tick( 1790000000 + Table_Node::CHECKPOINT_INTERVAL_S );
		$row = $this->checkpoint_row();
		$this->assertSame( [ 2, 0, 0 ], [ $row['calls'], $row['asked'], $row['answered'] ] );
		$this->assertCount( 1, $this->warnings() );
		$this->assertStringContainsString( "lab-7:kea: WARNING: WAL checkpoint failed: no file at {$missing}", $this->warnings()[0] );
	}

	/** @return list<string> The WAL warnings logged. */
	private function warnings(): array {
		return \array_values( \array_filter( $this->logged, static fn ( string $line ): bool => \str_contains( $line, 'WAL checkpoint' ) ) );
	}
}
