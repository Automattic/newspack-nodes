<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\CLI;
use Newspack_Nodes\Core;
use Newspack_Nodes\Sqlite_Arm;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Tests\Wombat_Row_Schema;
use PHPUnit\Framework\Attributes\CoversClass;

require_once \dirname( __DIR__ ) . '/Helpers/fixtures/class-wombat-row-schema.php';

/**
 * Declared-schema row tables beside `kv`: one transaction per batch of
 * `insert`, `ignore` and `add` ops, an `ignore`'s id handed to later ops, a
 * file at another schema version discarded at open, `purge()` reclaiming
 * rows past their window and names nothing references, and a reader
 * attaching every partition's file read-only into one connection.
 */
#[CoversClass( Sqlite_Arm::class )]
final class SqliteArmRowsTest extends TestCase {
	private string $dir = '';

	protected function setUp(): void {
		parent::setUp();
		$this->dir = $this->make_temp_dir( 'sqlite-arm-rows-' );
	}

	protected function tearDown(): void {
		Sqlite_Arm::$available = null;
		$this->rmdir_recursive( $this->dir );
		parent::tearDown();
	}

	private function path( int $partition = 3 ): string {
		return "{$this->dir}/tables/lab-7:wombat.p{$partition}.sqlite";
	}

	private function rows_arm( int $partition = 3, int $version = 7 ): Sqlite_Arm {
		return new Sqlite_Arm(
			$this->path( $partition ),
			"wombat:p{$partition}",
			rows: [
				'version' => $version,
				'tables'  => Wombat_Row_Schema::tables(),
			]
		);
	}

	/**
	 * Every row a statement answers on a fresh connection to the file.
	 *
	 * @return list<list<mixed>>
	 */
	private function all( string $sql, int $partition = 3 ): array {
		return ( new \PDO( 'sqlite:' . $this->path( $partition ) ) )->query( $sql )->fetchAll( \PDO::FETCH_NUM );
	}

	private function caught_pdo( \Closure $call ): \PDOException {
		try {
			$call();
		} catch ( \PDOException $e ) {
			return $e;
		}
		$this->fail( 'the write was refused' );
	}

	public function test_an_add_sums_and_maxes_onto_its_key(): void {
		$arm = $this->rows_arm();
		$out = $arm->write_rows(
			[
				[ 'add', 'tallies', [ 7341, 'heron', 3, 41.5 ] ],
				[ 'add', 'tallies', [ 7341, 'heron', 4, 39.0 ] ],
				[ 'add', 'tallies', [ 7342, 'heron', 9, 12.25 ] ],
			]
		);
		$this->assertSame( 3, $out['written'] );
		$this->assertSame( [], $out['ids'], 'only an ignore resolves an id' );
		$this->assertSame(
			[ [ 7341, 'heron', 7, 41.5 ], [ 7342, 'heron', 9, 12.25 ] ],
			$this->all( 'SELECT bucket, kind, n, peak FROM tallies ORDER BY bucket' )
		);
	}

	public function test_an_add_fold_outside_sum_and_max_folds_nothing(): void {
		$tables                           = Wombat_Row_Schema::tables();
		$tables['tallies']['add']['peak'] = 'avg';
		$arm                              = new Sqlite_Arm( $this->path(), 'wombat:p3', rows: [ 'version' => 7, 'tables' => $tables ] );
		$this->expectException( \UnhandledMatchError::class );
		$arm->write_rows( [ [ 'add', 'tallies', [ 7341, 'heron', 3, 41.5 ] ] ] );
	}

	public function test_an_op_outside_insert_ignore_and_add_is_refused_naming_it(): void {
		$arm = $this->rows_arm();
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'burrows: no such row op id' );
		$arm->write_rows( [ [ 'id', 'burrows', [ 'kea-4471' ] ] ] );
	}

	public function test_an_ignored_duplicate_skips_its_then_ops(): void {
		$arm  = $this->rows_arm();
		$then = [ [ 'add', 'tallies', [ 7341, 'egret', 1, 2.5 ] ] ];
		$this->assertSame( 2, $arm->write_rows( [ [ 'ignore', 'visits', [ 'rid-5520', 7341, 1, 80.25 ], $then ] ] )['written'] );
		$this->assertSame( 0, $arm->write_rows( [ [ 'ignore', 'visits', [ 'rid-5520', 7341, 1, 80.25 ], $then ] ] )['written'] );
		$this->assertSame( [ [ 1 ] ], $this->all( 'SELECT n FROM tallies' ) );
	}

	public function test_an_ignore_hands_back_the_rows_id_inserted_or_found(): void {
		$arm = $this->rows_arm();
		$a   = $arm->write_rows( [ [ 'ignore', 'burrows', [ null, 'kea-4471' ] ] ] );
		$b   = $arm->write_rows(
			[
				[ 'ignore', 'burrows', [ null, 'emu-9' ] ],
				[ 'ignore', 'burrows', [ null, 'kea-4471' ] ],
			]
		);
		$this->assertIsInt( $a['ids'][0] );
		$this->assertSame( $a['ids'][0], $b['ids'][1], 'an existing row hands back its own id' );
		$this->assertNotSame( $a['ids'][0], $b['ids'][0] );
		$this->assertSame( [ [ $b['ids'][0] ] ], $this->all( "SELECT id FROM burrows WHERE name = 'emu-9'" ) );
	}

	public function test_an_ignore_finds_an_existing_id_whose_key_runs_against_column_order(): void {
		$arm = new Sqlite_Arm(
			$this->path(),
			'wombat:p3',
			rows: [
				'version' => 7,
				'tables'  => [
					'perches' => [
						'columns'       => [
							'id'    => 'INTEGER',
							'tree'  => 'TEXT NOT NULL',
							'perch' => 'TEXT NOT NULL',
						],
						'key'           => [ 'perch', 'tree' ],
						'autoincrement' => 'id',
					],
				],
			]
		);
		$a = $arm->write_rows( [ [ 'ignore', 'perches', [ null, 'kauri-12', 'limb-4471' ] ] ] );
		$b = $arm->write_rows( [ [ 'ignore', 'perches', [ null, 'kauri-12', 'limb-4471' ] ] ] );
		$this->assertSame( $a['ids'][0], $b['ids'][0] );
	}

	public function test_a_row_position_takes_an_earlier_ignores_id(): void {
		$arm = $this->rows_arm();
		$arm->write_rows( [ [ 'ignore', 'burrows', [ null, 'tui-12' ] ] ] );
		$arm->write_rows(
			[
				[ 'ignore', 'burrows', [ null, 'kea-4471' ] ],
				[ 'ignore', 'visits', [ 'rid-6617', 7341, null, 12.5 ], [], [ 2 => 0 ] ],
			]
		);
		$this->assertSame(
			[ [ 'kea-4471', 'rid-6617' ] ],
			$this->all( 'SELECT b.name, v.rid FROM visits v JOIN burrows b ON b.id = v.burrow_id' )
		);
	}

	public function test_a_then_op_takes_its_batchs_ids_too(): void {
		$arm = $this->rows_arm();
		$arm->write_rows( [ [ 'ignore', 'burrows', [ null, 'tui-12' ] ] ] );
		$arm->write_rows(
			[
				[ 'ignore', 'burrows', [ null, 'kea-4471' ] ],
				[ 'add', 'tallies', [ 7341, 'heron', 1, 1.0 ], [ [ 'insert', 'visits', [ 'rid-88', 7341, null, 3.5 ], [], [ 2 => 0 ] ] ] ],
			]
		);
		$this->assertSame( [ [ 'kea-4471' ] ], $this->all( 'SELECT b.name FROM visits v JOIN burrows b ON b.id = v.burrow_id' ) );
	}

	public function test_a_failed_write_rolls_back_the_whole_batch_and_raises(): void {
		$arm = $this->rows_arm();
		$e   = $this->caught(
			fn () => $arm->write_rows(
				[
					[ 'add', 'tallies', [ 7341, 'heron', 3, 41.5 ] ],
					[ 'insert', 'visits', [ 'rid-1', null, 1, 2.0 ] ],
				]
			),
			'NOT NULL refused'
		);
		$this->assertStringContainsString( 'visits', $e->getMessage() );
		$this->assertStringContainsString( 'NOT NULL', $e->getMessage() );
		$this->assertSame( [], $this->all( 'SELECT * FROM tallies' ) );
		$arm->write_rows( [ [ 'add', 'tallies', [ 7341, 'heron', 3, 41.5 ] ] ] );
		$this->assertSame( [ [ 3 ] ], $this->all( 'SELECT n FROM tallies' ), 'the transaction ended and the next one commits' );
	}

	public function test_an_id_from_an_index_that_resolved_none_raises(): void {
		$arm = $this->rows_arm();
		$e   = $this->caught(
			fn () => $arm->write_rows(
				[
					[ 'add', 'tallies', [ 7341, 'heron', 3, 41.5 ] ],
					[ 'insert', 'visits', [ 'rid-1', 7341, null, 2.0 ], [], [ 2 => 0 ] ],
				]
			),
			'an id nothing resolved refused'
		);
		$this->assertStringContainsString( 'visits', $e->getMessage() );
		$this->assertSame( [], $this->all( 'SELECT * FROM tallies' ) );
	}

	public function test_an_undeclared_table_raises(): void {
		$arm = $this->rows_arm();
		$e   = $this->caught( fn () => $arm->write_rows( [ [ 'insert', 'quolls', [ 1 ] ] ] ), 'an undeclared table refused' );
		$this->assertStringContainsString( 'quolls', $e->getMessage() );
	}

	public function test_a_file_at_another_version_is_discarded_at_open(): void {
		$this->rows_arm()->write_rows( [ [ 'add', 'tallies', [ 7341, 'heron', 3, 41.5 ] ] ] );
		$this->rows_arm();
		$this->assertSame( [ [ 3 ] ], $this->all( 'SELECT n FROM tallies' ), 'the same version keeps its rows' );

		$this->rows_arm( 3, 8 );
		$this->assertSame( [], $this->all( 'SELECT * FROM tallies' ) );
		$this->assertSame( [ [ 8 ] ], $this->all( 'PRAGMA user_version' ) );
	}

	public function test_a_version_bump_that_renames_every_table_discards_the_old_ones(): void {
		$this->rows_arm()->write_rows( [ [ 'add', 'tallies', [ 7341, 'heron', 3, 41.5 ] ] ] );
		new Sqlite_Arm(
			$this->path(),
			'wombat:p3',
			rows: [
				'version' => 8,
				'tables'  => [ 'tallies_v8' => Wombat_Row_Schema::tables()['tallies'] ],
			]
		);
		$this->assertSame(
			[ [ 'tallies_v8' ] ],
			$this->all( "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'tallies%'" ),
			'a file at another version is discarded whatever tables it holds'
		);
	}

	public function test_a_file_with_no_declared_table_keeps_its_rows_at_open(): void {
		( new Sqlite_Arm( $this->path(), 'wombat:p3' ) )->set( 'sku-41', 'kea-41', 0 );
		$this->assertSame( 'kea-41', $this->rows_arm()->get( 'sku-41' ) );
		$this->assertSame( [ [ 7 ] ], $this->all( 'PRAGMA user_version' ) );
	}

	public function test_purge_drops_rows_past_their_window_and_orphaned_names(): void {
		$arm = $this->rows_arm();
		$arm->write_rows(
			[
				[ 'ignore', 'burrows', [ null, 'kea-4471' ] ],
				[ 'insert', 'visits', [ 'rid-1000', 1000, null, 4.5 ], [], [ 2 => 0 ] ],
				[ 'ignore', 'burrows', [ null, 'emu-9' ] ],
				[ 'insert', 'visits', [ 'rid-9000', 9000, null, 6.5 ], [], [ 2 => 2 ] ],
				[ 'add', 'tallies', [ 1000, 'heron', 1, 1.0 ] ],
				[ 'add', 'tallies', [ 9000, 'heron', 2, 2.0 ] ],
			]
		);
		$this->assertSame( 3, $arm->purge( 9100, 100 ) );
		$this->assertSame( [ [ 'rid-9000' ] ], $this->all( 'SELECT rid FROM visits' ) );
		$this->assertSame( [ [ 9000 ] ], $this->all( 'SELECT bucket FROM tallies' ) );
		$this->assertSame( [ [ 'emu-9' ] ], $this->all( 'SELECT name FROM burrows' ) );
	}

	/**
	 * Keyed rows go first; a table whose purge releases names takes half of
	 * what remains, so the names it releases fit inside the limit too.
	 */
	public function test_purge_stops_at_its_limit_counting_keyed_rows_first(): void {
		$arm = $this->rows_arm();
		Core::$clock = static fn (): float => 9000.0;
		$arm->set( 'sku-41', 'kea-41', 1 );
		$arm->write_rows(
			[
				[ 'ignore', 'burrows', [ null, 'kea-4471' ] ],
				[ 'insert', 'visits', [ 'rid-1000', 1000, null, 4.5 ], [], [ 2 => 0 ] ],
				[ 'ignore', 'burrows', [ null, 'emu-9' ] ],
				[ 'insert', 'visits', [ 'rid-1001', 1001, null, 4.5 ], [], [ 2 => 2 ] ],
				[ 'add', 'tallies', [ 1000, 'heron', 1, 1.0 ] ],
			]
		);
		$this->assertSame( 4, $arm->purge( 9100, 4 ) );
		$this->assertSame( [], $this->all( 'SELECT * FROM kv' ) );
		$this->assertSame( [ [ 'rid-1001' ] ], $this->all( 'SELECT rid FROM visits' ) );
		$this->assertSame( [ [ 'emu-9' ] ], $this->all( 'SELECT name FROM burrows' ) );
		$this->assertSame( [], $this->all( 'SELECT * FROM tallies' ) );
	}

	public function test_a_released_name_still_named_by_a_surviving_row_stays(): void {
		$arm = $this->rows_arm();
		$arm->write_rows(
			[
				[ 'ignore', 'burrows', [ null, 'kea-4471' ] ],
				[ 'insert', 'visits', [ 'rid-1000', 1000, null, 4.5 ], [], [ 2 => 0 ] ],
				[ 'insert', 'visits', [ 'rid-9000', 9000, null, 6.5 ], [], [ 2 => 0 ] ],
			]
		);
		$this->assertSame( 1, $arm->purge( 9100, 100 ) );
		$this->assertSame( [ [ 'kea-4471' ] ], $this->all( 'SELECT name FROM burrows' ) );
	}

	/**
	 * The contract: a names row goes only when retention purges the rows that
	 * name it. Every names row is written in the batch of a row naming it, so
	 * retention is the only way one is orphaned; a row orphaned any other way
	 * is never examined, and stays.
	 */
	public function test_a_name_retention_did_not_release_is_not_examined(): void {
		$arm = $this->rows_arm();
		$arm->write_rows(
			[
				[ 'ignore', 'burrows', [ null, 'kea-4471' ] ],
				[ 'insert', 'visits', [ 'rid-9000', 9000, null, 6.5 ], [], [ 2 => 0 ] ],
				[ 'ignore', 'burrows', [ null, 'emu-9' ] ],
				[ 'insert', 'visits', [ 'rid-9001', 9001, null, 6.5 ], [], [ 2 => 2 ] ],
			]
		);
		( new \PDO( 'sqlite:' . $this->path() ) )->exec( "DELETE FROM visits WHERE rid = 'rid-9001'" );
		$this->assertSame( 0, $arm->purge( 9100, 100 ) );
		$this->assertSame( [ [ 'emu-9' ], [ 'kea-4471' ] ], $this->all( 'SELECT name FROM burrows ORDER BY name' ) );
	}

	public function test_a_retain_window_counts_in_its_columns_unit(): void {
		$arm   = $this->rows_arm();
		$now   = 1790000100;
		$floor = \intdiv( $now, 300 ) - 24;
		$arm->write_rows(
			[
				[ 'insert', 'slots', [ $floor - 1, 'heron', 1 ] ],
				[ 'insert', 'slots', [ $floor, 'heron', 2 ] ],
			]
		);
		$this->assertSame( 1, $arm->purge( $now, 100 ) );
		$this->assertSame( [ [ $floor ] ], $this->all( 'SELECT slot FROM slots' ) );
	}

	public function test_a_failed_purge_still_counts_the_rows_its_earlier_tables_gave_up(): void {
		$arm = $this->rows_arm();
		$arm->write_rows(
			[
				[ 'ignore', 'burrows', [ null, 'kea-4471' ] ],
				[ 'insert', 'visits', [ 'rid-1000', 1000, null, 4.5 ], [], [ 2 => 0 ] ],
			]
		);
		( new \PDO( 'sqlite:' . $this->path() ) )->exec( 'DROP TABLE tallies' );
		$this->assertSame( 2, $arm->purge( 9100, 100 ), 'the visit and its released name' );
		$this->assertSame( [], $this->all( 'SELECT * FROM visits' ) );
		$this->assertStringContainsString( 'tallies', $arm->last_failure() );
	}

	public function test_the_fts_shadow_follows_inserts_and_purges(): void {
		$arm = $this->rows_arm();
		$ids = $arm->write_rows(
			[
				[ 'ignore', 'burrows', [ null, 'kea-4471' ] ],
				[ 'insert', 'visits', [ 'rid-1000', 1000, null, 4.5 ], [], [ 2 => 0 ] ],
				[ 'ignore', 'burrows', [ null, 'emu-9' ] ],
				[ 'insert', 'visits', [ 'rid-9000', 9000, null, 6.5 ], [], [ 2 => 2 ] ],
			]
		)['ids'];
		$match = "SELECT rowid FROM burrows_fts WHERE burrows_fts MATCH '%s'";
		$this->assertSame( [ [ $ids[0] ] ], $this->all( \sprintf( $match, 'kea' ) ) );
		$this->assertSame( [ [ $ids[2] ] ], $this->all( \sprintf( $match, 'emu' ) ) );

		$arm->purge( 9100, 100 );
		$this->assertSame( [], $this->all( \sprintf( $match, 'kea' ) ), 'a purged name leaves the index' );
		$this->assertSame( [ [ $ids[2] ] ], $this->all( \sprintf( $match, 'emu' ) ) );
	}

	public function test_open_rows_attaches_present_files_read_only_and_skips_absent_ones(): void {
		$this->rows_arm( 0 )->write_rows( [ [ 'insert', 'visits', [ 'rid-p0', 7341, 1, 1.5 ] ] ] );
		$this->rows_arm( 5 )->write_rows( [ [ 'insert', 'visits', [ 'rid-p5', 7341, 1, 2.5 ] ] ] );
		$this->rows_arm( 6, 9 )->write_rows( [ [ 'insert', 'visits', [ 'rid-p6', 7341, 1, 3.5 ] ] ] );

		$db = Sqlite_Arm::open_rows(
			[
				0 => $this->path( 0 ),
				2 => $this->path( 2 ),
				5 => $this->path( 5 ),
				6 => $this->path( 6 ),
			],
			7
		);

		$aliases = \array_values( \array_diff( \array_column( $db->query( 'PRAGMA database_list' )->fetchAll( \PDO::FETCH_ASSOC ), 'name' ), [ 'main', 'temp' ] ) );
		$this->assertSame( [ 'p0', 'p5' ], $aliases, 'an absent file and one at another version are not attached' );
		$this->assertSame(
			[ [ 'rid-p0' ], [ 'rid-p5' ] ],
			$db->query( 'SELECT rid FROM p0.visits UNION ALL SELECT rid FROM p5.visits ORDER BY rid' )->fetchAll( \PDO::FETCH_NUM )
		);
		$this->assertSame( -8192, (int) $db->query( 'PRAGMA p5.cache_size' )->fetchColumn() );
		$this->assertFileDoesNotExist( $this->path( 2 ), 'a reader creates no file' );
	}

	public function test_an_open_rows_reader_is_query_only(): void {
		$db = Sqlite_Arm::open_rows( [ 0 => $this->path( 0 ) ], 7 );
		$this->assertSame( 1, (int) $db->query( 'PRAGMA query_only' )->fetchColumn() );
		$this->expectException( \PDOException::class );
		$db->exec( 'CREATE TABLE heron ( n INTEGER )' );
	}

	public function test_an_open_rows_reader_attaches_each_file_read_only(): void {
		$this->rows_arm( 0 )->write_rows( [ [ 'insert', 'visits', [ 'rid-p0', 7341, 1, 1.5 ] ] ] );
		$db = Sqlite_Arm::open_rows( [ 0 => $this->path( 0 ) ], 7 );
		$db->exec( 'PRAGMA query_only = OFF' );
		$e = $this->caught_pdo( static fn () => $db->exec( "INSERT INTO p0.visits VALUES ( 'rid-x', 1, 1, 1.0 )" ) );
		$this->assertStringContainsString( 'readonly', $e->getMessage() );
		$this->assertSame( [ [ 'rid-p0' ] ], $this->all( 'SELECT rid FROM visits', 0 ) );
	}

	public function test_open_rows_refuses_a_partition_that_is_no_integer(): void {
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'partition' );
		Sqlite_Arm::open_rows( [ 'p0 AS x; --' => $this->path( 0 ) ], 7 );
	}

	public function test_open_rows_refuses_more_than_eight_files(): void {
		$files = [];
		for ( $p = 0; $p < 9; ++$p ) {
			$files[ $p ] = $this->path( $p );
		}
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( '9 partition files' );
		Sqlite_Arm::open_rows( $files, 7 );
	}

	public function test_open_rows_refuses_a_root_reader(): void {
		$this->rows_arm( 0 );
		CLI::$uid_provider = static fn (): int => 0;
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'refuses to run as root' );
		Sqlite_Arm::open_rows( [ 0 => $this->path( 0 ) ], 7 );
	}
}
