<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
use Newspack_Nodes\Node_Names;
use Newspack_Nodes\Router_Node;
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
		Table_Node::purge_and_checkpoint( 1790004242 );
		$this->assertSame( 1790000000.0, Core::$now, 'a due purge reads the live clock' );
		$this->assertSame( 1, $this->checkpoint_row()['calls'] );
		Core::$now = 1790004243.0;
		Table_Node::purge_and_checkpoint( 1790004243 );
		$this->assertSame( 1790004243.0, Core::$now, 'a tick that only checkpoints' );
		$this->assertSame( 2, $this->checkpoint_row()['calls'] );
	}

	public function test_one_checkpoint_per_table_per_tick(): void {
		$owl = $this->worker_table( 'lab-7:owl', 'owl:p3' );
		$this->table->store_multi( self::rows( 'kea', 40, 900 ) );
		$owl->store_multi( self::rows( 'owl', 70, 900 ) );
		Table_Node::purge_and_checkpoint( 1790000000 );
		$this->assertSame( [ 1, 1 ], [ $this->checkpoint_row()['calls'], $this->checkpoint_row( $owl )['calls'] ] );
	}

	public function test_a_mount_never_checkpoints(): void {
		$this->table->store_multi( self::rows( 'kea', 40, 900 ) );
		$this->table->remove_node();
		$mount = Table_Node::mount( 'lab-7:kea', 3, [ 'namespace' => 'kea:p3', 'ttl' => 777, 'backend' => 'sqlite' ], new Capture_Sink_Node() );
		Table_Node::purge_and_checkpoint( 1790000000 );
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
		Table_Node::purge_and_checkpoint( 1790000000 );
		$this->assertSame( 0, $this->checkpoint_row()['calls'] );
		Core::$clock = static fn (): float => 1790000001.0;
		Table_Node::purge_and_checkpoint( 1790000001 );
		$this->assertSame( 1, $this->checkpoint_row()['calls'] );
	}

	public function test_a_checkpoint_stalled_while_the_wal_grows_warns_after_sixty_ticks(): void {
		$this->assertSame( 60, Table_Node::WAL_STALL_TICKS );
		$this->table->store( 'sku-0', 'kea' );
		$reader = new \PDO( 'sqlite:' . Table_Node::file( 'lab-7:kea', 3 ) );
		$reader->exec( 'BEGIN' );
		$reader->query( 'SELECT count(*) FROM kv' )->fetchAll();
		try {
			for ( $tick = 1; $tick < Table_Node::WAL_STALL_TICKS; ++$tick ) {
				$this->table->store( "sku-{$tick}", \str_repeat( 'o', 5000 ) );
				Table_Node::purge_and_checkpoint( 1790000000 + $tick );
			}
			$this->assertSame( [], $this->warnings(), 'fifty-nine stalled ticks are a slow reader, not a stuck one' );
			$this->table->store( 'sku-60', \str_repeat( 'o', 5000 ) );
			Table_Node::purge_and_checkpoint( 1790000060 );
			$this->assertCount( 1, $this->warnings() );
			$this->assertMatchesRegularExpression( '/lab-7:kea: WARNING: WAL checkpoint has not completed for 60 ticks while the WAL grew from \d+ to \d+ frames/', $this->warnings()[0] );
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
			for ( $tick = 1; $tick <= 2 * Table_Node::WAL_STALL_TICKS; ++$tick ) {
				Table_Node::purge_and_checkpoint( 1790000000 + $tick );
			}
		} finally {
			$reader->exec( 'ROLLBACK' );
		}
		$this->assertSame( [], $this->warnings() );
		$row = $this->checkpoint_row();
		$this->assertLessThan( $row['asked'], $row['answered'], 'every one of those checkpoints was partial' );
	}

	/** @return list<string> The WAL warnings logged. */
	private function warnings(): array {
		return \array_values( \array_filter( $this->logged, static fn ( string $line ): bool => \str_contains( $line, 'WAL checkpoint' ) ) );
	}
}
