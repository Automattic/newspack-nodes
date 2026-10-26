<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\CLI;
use Newspack_Nodes\Config;
use Newspack_Nodes\Core;
use Newspack_Nodes\Row_Reader;
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

	/** A temporary directory a test made read-only, restored before the sweep. */
	private string $locked = '';

	protected function setUp(): void {
		parent::setUp();
		$this->dir = $this->make_temp_dir( 'sqlite-arm-rows-' );
		$this->use_base_dir( $this->dir );
	}

	protected function tearDown(): void {
		if ( '' !== $this->locked ) {
			\chmod( $this->locked, 0700 );
		}
		Config::reset();
		Sqlite_Arm::$available = null;
		$this->rmdir_recursive( $this->dir );
		// SQLite holds the temporary directory process-wide.
		( new \PDO( 'sqlite::memory:' ) )->exec( "PRAGMA temp_store_directory = ''" );
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
		$this->assertSame( 3, $out );
		$this->assertSame(
			[ [ 7341, 'heron', 7, 41.5 ], [ 7342, 'heron', 9, 12.25 ] ],
			$this->all( 'SELECT bucket, kind, n, peak FROM tallies ORDER BY bucket' )
		);
	}

	public function test_an_undeclared_fold_folds_nothing(): void {
		$tables                           = Wombat_Row_Schema::tables();
		$tables['tallies']['add']['peak'] = 'avg';
		$arm                              = new Sqlite_Arm( $this->path(), 'wombat:p3', rows: [ 'version' => 7, 'tables' => $tables ] );
		$this->expectException( \UnhandledMatchError::class );
		$arm->write_rows( [ [ 'add', 'tallies', [ 7341, 'heron', 3, 41.5 ] ] ] );
	}

	/**
	 * An arm over the wombat tables plus `floors`, a keyed table whose `low`
	 * column folds by `min` and `mark` by `sum`; `peaks`, whose `high` folds by
	 * `max`; `bare`, all key; and `loose`, a keyless one.
	 */
	private function floors_arm(): Sqlite_Arm {
		$tables           = Wombat_Row_Schema::tables();
		$tables['floors'] = [
			'columns' => [
				'bucket' => 'INTEGER NOT NULL',
				'low'    => 'REAL',
				'mark'   => 'INTEGER',
				'note'   => 'TEXT',
			],
			'key'     => [ 'bucket' ],
			'add'     => [
				'low'  => 'min',
				'mark' => 'sum',
			],
		];
		$tables['peaks']  = [
			'columns' => [
				'bucket' => 'INTEGER NOT NULL',
				'high'   => 'REAL',
			],
			'key'     => [ 'bucket' ],
			'add'     => [ 'high' => 'max' ],
		];
		$tables['bare']   = [
			'columns' => [ 'bucket' => 'INTEGER NOT NULL' ],
			'key'     => [ 'bucket' ],
		];
		$tables['loose']  = [ 'columns' => [ 'n' => 'INTEGER' ] ];
		return new Sqlite_Arm( $this->path(), 'wombat:p3', rows: [ 'version' => 7, 'tables' => $tables ] );
	}

	public function test_the_min_fold_keeps_the_smaller(): void {
		$this->floors_arm()->write_rows(
			[
				[ 'add', 'floors', [ 7341, 413.25, 1, 'a' ] ],
				[ 'add', 'floors', [ 7341, 97.5, 1, 'b' ] ],
				[ 'add', 'floors', [ 7341, 201.75, 1, 'c' ] ],
			]
		);
		$this->assertSame( [ [ 97.5, 3 ] ], $this->all( 'SELECT low, mark FROM floors' ) );
	}

	public function test_the_min_fold_ignores_a_null(): void {
		$this->floors_arm()->write_rows(
			[
				[ 'add', 'floors', [ 7341, 97.5, 1, null ] ],
				[ 'add', 'floors', [ 7341, null, 1, null ] ],
				[ 'add', 'floors', [ 7342, null, 1, null ] ],
				[ 'add', 'floors', [ 7342, 97.5, 1, null ] ],
			]
		);
		$this->assertSame( [ [ 7341, 97.5 ], [ 7342, 97.5 ] ], $this->all( 'SELECT bucket, low FROM floors ORDER BY bucket' ) );
	}

	public function test_the_max_fold_keeps_the_larger(): void {
		$this->floors_arm()->write_rows(
			[
				[ 'add', 'peaks', [ 7341, 413.25 ] ],
				[ 'add', 'peaks', [ 7341, 97.5 ] ],
			]
		);
		$this->assertSame( [ [ 413.25 ] ], $this->all( 'SELECT high FROM peaks' ) );
	}

	public function test_the_max_fold_ignores_a_null(): void {
		$this->floors_arm()->write_rows(
			[
				[ 'add', 'peaks', [ 7341, 97.5 ] ],
				[ 'add', 'peaks', [ 7341, null ] ],
				[ 'add', 'peaks', [ 7342, null ] ],
				[ 'add', 'peaks', [ 7342, 97.5 ] ],
			]
		);
		$this->assertSame( [ [ 7341, 97.5 ], [ 7342, 97.5 ] ], $this->all( 'SELECT bucket, high FROM peaks ORDER BY bucket' ) );
	}

	public function test_set_on_a_table_of_key_columns_alone_is_refused_naming_it(): void {
		$arm = $this->floors_arm();
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'bare: no column to set' );
		$arm->write_rows( [ [ 'set', 'bare', [ 7341 ] ] ] );
	}

	public function test_set_replaces_every_non_key_column(): void {
		$this->floors_arm()->write_rows(
			[
				[ 'add', 'floors', [ 7341, 413.25, 6, 'first' ] ],
				[ 'add', 'floors', [ 7341, 97.5, 5, 'second' ] ],
				[ 'set', 'floors', [ 7341, 61.125, 17, null ] ],
			]
		);
		$this->assertSame( [ [ 7341, 61.125, 17, null ] ], $this->all( 'SELECT bucket, low, mark, note FROM floors' ) );
	}

	/** A `set` on a lookup row keeps its id, so the rows naming it still join. */
	public function test_set_keeps_a_lookup_rows_autoincrement_id(): void {
		$arm = new Sqlite_Arm(
			$this->path(),
			'wombat:p3',
			rows: [
				'version' => 7,
				'tables'  => [
					'perches'  => [
						'columns'       => [
							'id'    => 'INTEGER',
							'perch' => 'TEXT NOT NULL',
							'tree'  => 'TEXT',
						],
						'key'           => [ 'perch' ],
						'autoincrement' => 'id',
					],
					'landings' => [
						'columns' => [
							'rid'      => 'TEXT NOT NULL',
							'perch_id' => 'INTEGER NOT NULL',
						],
						'key'     => [ 'rid' ],
					],
				],
			]
		);
		$arm->write_rows(
			[
				[ 'ignore', 'perches', [ null, 'limb-4471', 'kauri-12' ] ],
				[ 'insert', 'landings', [ 'land-7', null ], [], [ 1 => 0 ] ],
			]
		);
		$arm->write_rows( [ [ 'set', 'perches', [ null, 'limb-4471', 'rimu-38' ] ] ] );

		$this->assertSame( [ [ 'land-7', 'limb-4471', 'rimu-38' ] ], $this->all( 'SELECT l.rid, p.perch, p.tree FROM landings l JOIN perches p ON p.id = l.perch_id' ) );
	}

	public function test_set_on_a_table_of_its_key_and_autoincrement_column_is_refused_naming_it(): void {
		$arm = $this->rows_arm();
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'burrows: no column to set' );
		$arm->write_rows( [ [ 'set', 'burrows', [ null, 'kea-4471' ] ] ] );
	}

	public function test_set_inserts_a_missing_row(): void {
		$out = $this->floors_arm()->write_rows( [ [ 'set', 'floors', [ 7343, 8.5, 4, 'new' ] ] ] );
		$this->assertSame( 1, $out );
		$this->assertSame( [ [ 7343, 8.5, 4, 'new' ] ], $this->all( 'SELECT bucket, low, mark, note FROM floors' ) );
	}

	public function test_set_runs_as_a_then_op(): void {
		$this->floors_arm()->write_rows(
			[
				[ 'ignore', 'visits', [ 'r-1', 7344, 1, 3.5 ], [ [ 'set', 'floors', [ 7344, 2.25, 9, 'then' ] ] ] ],
				[ 'ignore', 'visits', [ 'r-1', 7344, 1, 3.5 ], [ [ 'set', 'floors', [ 7344, 99.0, 99, 'dup' ] ] ] ],
			]
		);
		$this->assertSame( [ [ 7344, 2.25, 9, 'then' ] ], $this->all( 'SELECT bucket, low, mark, note FROM floors' ) );
	}

	public function test_set_on_a_table_with_no_key_is_refused_naming_it(): void {
		$arm = $this->floors_arm();
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'loose: no key to set by' );
		$arm->write_rows( [ [ 'set', 'loose', [ 5 ] ] ] );
	}

	public function test_an_undeclared_op_is_refused_naming_it(): void {
		$arm = $this->rows_arm();
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'burrows: no such row op id' );
		$arm->write_rows( [ [ 'id', 'burrows', [ 'kea-4471' ] ] ] );
	}

	public function test_an_ignored_duplicate_skips_its_then_ops(): void {
		$arm  = $this->rows_arm();
		$then = [ [ 'add', 'tallies', [ 7341, 'egret', 1, 2.5 ] ] ];
		$this->assertSame( 2, $arm->write_rows( [ [ 'ignore', 'visits', [ 'rid-5520', 7341, 1, 80.25 ], $then ] ] ) );
		$this->assertSame( 0, $arm->write_rows( [ [ 'ignore', 'visits', [ 'rid-5520', 7341, 1, 80.25 ], $then ] ] ) );
		$this->assertSame( [ [ 1 ] ], $this->all( 'SELECT n FROM tallies' ) );
	}

	public function test_an_ignore_hands_back_the_rows_id_inserted_or_found(): void {
		$arm = $this->rows_arm();
		$arm->write_rows(
			[
				[ 'ignore', 'burrows', [ null, 'kea-4471' ] ],
				[ 'insert', 'visits', [ 'rid-a', 7341, null, 1.5 ], [], [ 2 => 0 ] ],
			]
		);
		$arm->write_rows(
			[
				[ 'ignore', 'burrows', [ null, 'emu-9' ] ],
				[ 'ignore', 'burrows', [ null, 'kea-4471' ] ],
				[ 'insert', 'visits', [ 'rid-b0', 7341, null, 2.5 ], [], [ 2 => 0 ] ],
				[ 'insert', 'visits', [ 'rid-b1', 7341, null, 3.5 ], [], [ 2 => 1 ] ],
			]
		);
		$this->assertSame(
			[ [ 'rid-a', 'kea-4471' ], [ 'rid-b0', 'emu-9' ], [ 'rid-b1', 'kea-4471' ] ],
			$this->all( 'SELECT v.rid, b.name FROM visits v JOIN burrows b ON b.id = v.burrow_id ORDER BY v.rid' ),
			'an existing row hands back its own id'
		);
		$this->assertSame( [ [ 2 ] ], $this->all( 'SELECT count(*) FROM burrows' ) );
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
					'landings' => [
						'columns' => [
							'rid'      => 'TEXT NOT NULL',
							'perch_id' => 'INTEGER NOT NULL',
						],
						'key'     => [ 'rid' ],
					],
				],
			]
		);
		foreach ( [ 'land-1', 'land-2' ] as $rid ) {
			$arm->write_rows(
				[
					[ 'ignore', 'perches', [ null, 'kauri-12', 'limb-4471' ] ],
					[ 'insert', 'landings', [ $rid, null ], [], [ 1 => 0 ] ],
				]
			);
		}
		$this->assertSame(
			[ [ 'land-1', 'limb-4471' ], [ 'land-2', 'limb-4471' ] ],
			$this->all( 'SELECT l.rid, p.perch FROM landings l JOIN perches p ON p.id = l.perch_id ORDER BY l.rid' )
		);
		$this->assertSame( [ [ 1 ] ], $this->all( 'SELECT count(*) FROM perches' ) );
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
		$this->assertStringStartsWith( 'visits: [23000] SQLSTATE[23000]: Integrity constraint violation: 19 NOT NULL constraint failed: visits.', $e->getMessage() );
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
		$this->assertSame( 3, $arm->purge( 9100, 100 )['rows'] );
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
		$this->assertSame( 4, $arm->purge( 9100, 4 )['rows'] );
		$this->assertSame( [], $this->all( 'SELECT * FROM kv' ) );
		$this->assertSame( [ [ 'rid-1001' ] ], $this->all( 'SELECT rid FROM visits' ) );
		$this->assertSame( [ [ 'emu-9' ] ], $this->all( 'SELECT name FROM burrows' ) );
		$this->assertSame( [], $this->all( 'SELECT * FROM tallies' ) );
	}

	/**
	 * A purge says when a retained table filled its share of the limit, so
	 * a backlog its names tables hold under the limit reads as one.
	 */
	public function test_purge_says_a_retained_table_filled_its_take(): void {
		$arm = $this->rows_arm();
		$arm->write_rows(
			[
				[ 'insert', 'visits', [ 'rid-6630', 1000, 0, 1.5 ] ],
				[ 'insert', 'visits', [ 'rid-6631', 1001, 0, 1.5 ] ],
				[ 'insert', 'visits', [ 'rid-6632', 1002, 0, 1.5 ] ],
			]
		);

		$this->assertSame( [ 'rows' => 2, 'full' => true ], $arm->purge( 9100, 4 ), 'two of the limit\'s four are the visits\' take' );
		$this->assertSame( [ 'rows' => 1, 'full' => false ], $arm->purge( 9100, 4 ) );
	}

	/** A retained table's purge the driver refuses logs the driver's shaped text. */
	public function test_a_refused_retained_purge_logs_the_drivers_text_shaped(): void {
		$arm = $this->rows_arm();
		$arm->write_rows( [ [ 'insert', 'visits', [ 'rid-6640', 1000, 0, 1.5 ] ] ] );
		( new \PDO( 'sqlite:' . $this->path() ) )->exec( 'DROP TABLE visits' );
		$logged = $this->capture_stderr();

		$arm->purge( 9100, 4 );

		$this->assertStringContainsString( 'Table purge failed: sqlite ' . $this->path() . ': [HY000] SQLSTATE[HY000]: General error: 1 no such table', \implode( '', (array) $logged ) );
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
		$this->assertSame( 1, $arm->purge( 9100, 100 )['rows'] );
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
		$this->assertSame( 0, $arm->purge( 9100, 100 )['rows'] );
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
		$this->assertSame( 1, $arm->purge( $now, 100 )['rows'] );
		$this->assertSame( [ [ $floor ] ], $this->all( 'SELECT slot FROM slots' ) );
	}

	/**
	 * A retained row expires the moment its column falls below the floor,
	 * at `( column + window + 1 ) × unit`, so its lag counts from there in
	 * seconds; the arm's lag is the largest over kv and every retained table.
	 */
	public function test_purge_lag_counts_a_retained_row_from_the_moment_it_left_its_window(): void {
		$arm   = $this->rows_arm();
		$now   = 1790000250;
		$floor = \intdiv( $now, 300 ) - 24;
		$arm->write_rows(
			[
				[ 'insert', 'slots', [ $floor - 3, 'heron', 1 ] ],
				[ 'insert', 'slots', [ $floor, 'heron', 2 ] ],
			]
		);
		$this->assertSame( 750, $arm->purge_lag( $now ), 'two whole slots and the 150 s into the current one' );

		$arm->write_rows( [ [ 'insert', 'visits', [ 'rid-5101', $now - 3601 - 5101, 0, 1.5 ] ] ] );
		$this->assertSame( 5101, $arm->purge_lag( $now ), 'the visit left its window first' );

		Core::$clock = static fn (): float => 1789991250.0;
		$arm->set( 'kea-old', 1, 1 );
		$this->assertSame( 8999, $arm->purge_lag( $now ), 'a keyed row counts beside the row tables' );

		$arm->purge( $now, 100 );
		$this->assertSame( 0, $arm->purge_lag( $now ), 'a store holding only live rows has no lag' );
	}

	public function test_a_lag_the_store_cannot_read_is_logged_and_answers_none(): void {
		$arm = $this->rows_arm();
		$now = 1790000250;
		$arm->write_rows( [ [ 'insert', 'visits', [ 'rid-5101', $now - 3601 - 5101, 0, 1.5 ] ] ] );
		$this->assertSame( 5101, $arm->purge_lag( $now ) );
		( new \PDO( 'sqlite:' . $this->path() ) )->exec( 'DROP TABLE tallies' );
		$logged = [];
		\add_action(
			'newspack_nodes/stderr',
			static function ( string $line ) use ( &$logged ): void {
				$logged[] = $line;
			}
		);
		$this->assertSame( 0, $arm->purge_lag( $now ), 'a failed read answers no lag' );
		$this->assertCount( 1, $logged );
		$this->assertStringContainsString( 'Table purge lag read failed: sqlite ' . $this->path() . ': ', $logged[0] );
		$this->assertStringContainsString( 'tallies', $logged[0] );
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
		$this->assertSame( 2, $arm->purge( 9100, 100 )['rows'], 'the visit and its released name' );
		$this->assertSame( [], $this->all( 'SELECT * FROM visits' ) );
		$this->assertStringContainsString( 'tallies', $arm->last_failure() );
	}

	public function test_the_fts_shadow_follows_inserts_and_purges(): void {
		$arm = $this->rows_arm();
		$arm->write_rows(
			[
				[ 'ignore', 'burrows', [ null, 'kea-4471' ] ],
				[ 'insert', 'visits', [ 'rid-1000', 1000, null, 4.5 ], [], [ 2 => 0 ] ],
				[ 'ignore', 'burrows', [ null, 'emu-9' ] ],
				[ 'insert', 'visits', [ 'rid-9000', 9000, null, 6.5 ], [], [ 2 => 2 ] ],
			]
		);
		$kea   = $this->all( "SELECT id FROM burrows WHERE name = 'kea-4471'" );
		$emu   = $this->all( "SELECT id FROM burrows WHERE name = 'emu-9'" );
		$match = "SELECT rowid FROM burrows_fts WHERE burrows_fts MATCH '%s'";
		$this->assertSame( $kea, $this->all( \sprintf( $match, 'kea' ) ) );
		$this->assertSame( $emu, $this->all( \sprintf( $match, 'emu' ) ) );

		$arm->purge( 9100, 100 );
		$this->assertSame( [], $this->all( \sprintf( $match, 'kea' ) ), 'a purged name leaves the index' );
		$this->assertSame( $emu, $this->all( \sprintf( $match, 'emu' ) ) );
	}

	/** An arm over a `notes` table whose `body` an FTS5 shadow indexes, on partition 4. */
	private function notes_arm(): Sqlite_Arm {
		return new Sqlite_Arm(
			$this->path( 4 ),
			'wombat:p4',
			rows: [
				'version' => 7,
				'tables'  => [
					'notes' => [
						'columns'       => [
							'id'    => 'INTEGER',
							'slug'  => 'TEXT NOT NULL',
							'body'  => 'TEXT NOT NULL',
							'stamp' => 'INTEGER NOT NULL',
						],
						'key'           => [ 'slug' ],
						'autoincrement' => 'id',
						'indexes'       => [ 'notes_stamp' => [ 'stamp' ] ],
						'retain'        => [ 'stamp', 50, 1 ],
						'fts'           => [ 'body' ],
					],
				],
			]
		);
	}

	public function test_a_file_built_without_the_update_trigger_gains_it_at_open(): void {
		$this->notes_arm()->write_rows( [ [ 'set', 'notes', [ null, 'slug-8', 'ibis marsh', 1000 ] ] ] );
		( new \PDO( 'sqlite:' . $this->path( 4 ) ) )->exec( 'DROP TRIGGER notes_fts_update' );
		$this->assertSame( [], $this->all( "SELECT name FROM sqlite_master WHERE name = 'notes_fts_update'", 4 ) );

		$arm = $this->notes_arm();
		$arm->write_rows( [ [ 'set', 'notes', [ null, 'slug-8', 'quokka scrub', 1000 ] ] ] );

		$this->assertSame( [ [ 'notes_fts_update' ] ], $this->all( "SELECT name FROM sqlite_master WHERE name = 'notes_fts_update'", 4 ) );
		$id = $this->all( "SELECT id FROM notes WHERE slug = 'slug-8'", 4 );
		$this->assertSame( $id, $this->all( "SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'quokka'", 4 ) );
		$this->assertSame( [], $this->all( "SELECT rowid FROM notes_fts WHERE notes_fts MATCH 'ibis'", 4 ) );
	}

	public function test_the_fts_shadow_follows_a_set_and_survives_the_purge_after_it(): void {
		$arm   = $this->notes_arm();
		$match = "SELECT rowid FROM notes_fts WHERE notes_fts MATCH '%s'";
		$arm->write_rows( [ [ 'set', 'notes', [ null, 'slug-3', 'ibis marsh', 1000 ] ] ] );
		$arm->write_rows( [ [ 'set', 'notes', [ null, 'slug-3', 'quokka scrub', 1000 ] ] ] );

		$id = $this->all( "SELECT id FROM notes WHERE slug = 'slug-3'", 4 );
		$this->assertSame( $id, $this->all( \sprintf( $match, 'quokka' ), 4 ), 'the new text is found' );
		$this->assertSame( [], $this->all( \sprintf( $match, 'ibis' ), 4 ), 'the old text is gone' );

		$arm->purge( 9000, 100 );
		$this->assertSame( [], $this->all( 'SELECT * FROM notes', 4 ) );
		$this->all( "INSERT INTO notes_fts ( notes_fts ) VALUES ( 'integrity-check' )", 4 );
		$this->assertSame( [], $this->all( \sprintf( $match, 'quokka' ), 4 ) );
	}

	public function test_open_rows_attaches_present_files_read_only_and_skips_absent_ones(): void {
		$this->rows_arm( 0 )->write_rows( [ [ 'insert', 'visits', [ 'rid-p0', 7341, 1, 1.5 ] ] ] );
		$this->rows_arm( 5 )->write_rows( [ [ 'insert', 'visits', [ 'rid-p5', 7341, 1, 2.5 ] ] ] );
		$this->rows_arm( 6, 9 )->write_rows( [ [ 'insert', 'visits', [ 'rid-p6', 7341, 1, 3.5 ] ] ] );

		$reader = Sqlite_Arm::open_rows(
			[
				0 => $this->path( 0 ),
				2 => $this->path( 2 ),
				5 => $this->path( 5 ),
				6 => $this->path( 6 ),
			],
			7
		);

		$this->assertInstanceOf( Row_Reader::class, $reader );
		$this->assertSame( [ 'p0', 'p5' ], $reader->aliases(), 'an absent file and one at another version are not attached' );
		$this->assertSame(
			[ 'main', 'p0', 'p5' ],
			\array_column( $reader->rows( 'PRAGMA database_list', [] ), 1 ),
			'a detached file leaves no schema behind'
		);
		$this->assertSame(
			[ [ 'rid-p0' ], [ 'rid-p5' ] ],
			$reader->rows( 'SELECT rid FROM p0.visits UNION ALL SELECT rid FROM p5.visits ORDER BY rid', [] )
		);
		$this->assertSame( [ [ -8192 ] ], $reader->rows( 'PRAGMA p5.cache_size', [] ) );
		$this->assertFileDoesNotExist( $this->path( 2 ), 'a reader creates no file' );
	}

	public function test_an_open_rows_reader_maps_nothing_and_sorts_on_disk(): void {
		$this->rows_arm( 0 )->write_rows( [ [ 'insert', 'visits', [ 'rid-p0', 7341, 1, 1.5 ] ] ] );
		$this->rows_arm( 3 )->write_rows( [ [ 'insert', 'visits', [ 'rid-p3', 7341, 1, 2.5 ] ] ] );

		$reader = Sqlite_Arm::open_rows( [ 0 => $this->path( 0 ), 3 => $this->path( 3 ) ], 7 );

		$this->assertSame( [ [ 1 ] ], $reader->rows( 'PRAGMA temp_store', [] ), 'temporary B-trees are files' );
		$this->assertSame( [ [ $this->temp_store() ] ], $reader->rows( 'PRAGMA temp_store_directory', [] ) );
		$this->assertSame( [ [ 0 ] ], $reader->rows( 'PRAGMA p0.mmap_size', [] ) );
		$this->assertSame( [ [ 0 ] ], $reader->rows( 'PRAGMA p3.mmap_size', [] ) );
	}

	public function test_an_open_rows_reader_spills_its_temporary_b_trees_into_its_temp_directory(): void {
		$this->rows_arm( 0 )->write_rows( [ [ 'insert', 'visits', [ 'rid-p0', 7341, 1, 1.5 ] ] ] );
		$temp = $this->temp_store();
		$this->assert_spills_into( Sqlite_Arm::open_rows( [ 0 => $this->path( 0 ) ], 7 ), $temp );
	}

	public function test_open_rows_refuses_a_temp_directory_it_cannot_write(): void {
		$this->rows_arm( 0 );
		$this->unwritable_temp_store();
		$e = $this->caught_pdo( fn () => Sqlite_Arm::open_rows( [ 0 => $this->path( 0 ) ], 7 ) );
		$this->assertStringContainsString( 'not a writable directory', $e->getMessage() );
	}

	public function test_an_open_rows_reader_is_query_only(): void {
		$reader = Sqlite_Arm::open_rows( [ 0 => $this->path( 0 ) ], 7 );
		$this->assertSame( [ [ 1 ] ], $reader->rows( 'PRAGMA query_only', [] ) );
		$this->expectException( \PDOException::class );
		$reader->rows( 'CREATE TABLE heron ( n INTEGER )', [] );
	}

	public function test_an_open_rows_reader_attaches_each_file_read_only(): void {
		$this->rows_arm( 0 )->write_rows( [ [ 'insert', 'visits', [ 'rid-p0', 7341, 1, 1.5 ] ] ] );
		$reader = Sqlite_Arm::open_rows( [ 0 => $this->path( 0 ) ], 7 );
		$reader->rows( 'PRAGMA query_only = OFF', [] );
		$e = $this->caught_pdo( static fn () => $reader->rows( "INSERT INTO p0.visits VALUES ( 'rid-x', 1, 1, 1.0 )", [] ) );
		$this->assertStringContainsString( 'readonly', $e->getMessage() );
		$this->assertSame( [ [ 'rid-p0' ] ], $this->all( 'SELECT rid FROM visits', 0 ) );
	}

	public function test_open_rows_refuses_a_root_reader(): void {
		$this->rows_arm( 0 );
		CLI::$uid_provider = static fn (): int => 0;
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'refuses to run as root' );
		Sqlite_Arm::open_rows( [ 0 => $this->path( 0 ) ], 7 );
	}

	public function test_build_rows_writes_its_own_file_from_the_attached_partitions(): void {
		$this->rows_arm( 0 )->write_rows( [ [ 'insert', 'visits', [ 'rid-p0', 7341, 1, 1.5 ] ] ] );
		$this->rows_arm( 4 )->write_rows( [ [ 'insert', 'visits', [ 'rid-p4', 7341, 1, 2.5 ] ] ] );
		$built = "{$this->dir}/tables/kea-snapshot-6107.sqlite";

		$reader = Sqlite_Arm::build_rows( $built, [ 0 => $this->path( 0 ), 4 => $this->path( 4 ) ], 7 );
		$this->assertSame( [ 'p0', 'p4' ], $reader->aliases() );
		$reader->rows( 'CREATE TABLE heron AS SELECT rid FROM p0.visits UNION ALL SELECT rid FROM p4.visits', [] );
		unset( $reader );

		$this->assertSame( [ [ 'rid-p0' ], [ 'rid-p4' ] ], ( new \PDO( "sqlite:{$built}" ) )->query( 'SELECT rid FROM heron ORDER BY rid' )->fetchAll( \PDO::FETCH_NUM ) );
	}

	/** The directory every connection's temporary files go in, under the base. */
	private function temp_store(): string {
		return "{$this->dir}/tmp/sqlite";
	}

	/** Make the temporary directory read-only once resolved, as a stray chmod would. */
	private function unwritable_temp_store(): void {
		$this->locked = Config::get_sqlite_temp_directory();
		\chmod( $this->locked, 0500 );
	}

	public function test_build_rows_maps_nothing_and_sorts_on_disk_with_the_partitions_read_only(): void {
		$this->rows_arm( 0 )->write_rows( [ [ 'insert', 'visits', [ 'rid-p0', 7341, 1, 1.5 ] ] ] );
		$reader = Sqlite_Arm::build_rows( "{$this->dir}/tables/kea-snapshot-6108.sqlite", [ 0 => $this->path( 0 ) ], 7 );

		$this->assertSame( [ [ 0 ] ], $reader->rows( 'PRAGMA query_only', [] ) );
		$this->assertSame( [ [ 1 ] ], $reader->rows( 'PRAGMA temp_store', [] ), 'temporary B-trees are files' );
		$this->assertSame( [ [ $this->temp_store() ] ], $reader->rows( 'PRAGMA temp_store_directory', [] ) );
		$this->assertSame( [ [ 0 ] ], $reader->rows( 'PRAGMA main.mmap_size', [] ) );
		$this->assertSame( [ [ 'off' ] ], $reader->rows( 'PRAGMA main.journal_mode', [] ) );
		$this->assertSame( [ [ -262144 ] ], $reader->rows( 'PRAGMA main.cache_size', [] ) );
		$this->assertSame( [ [ 0 ] ], $reader->rows( 'PRAGMA p0.mmap_size', [] ) );
		$this->assertSame( [ [ -8192 ] ], $reader->rows( 'PRAGMA p0.cache_size', [] ) );
		$this->assertStringContainsString( 'readonly', $this->caught_pdo( static fn () => $reader->rows( "INSERT INTO p0.visits VALUES ( 'rid-x', 7341, 1, 0.5 )", [] ) )->getMessage() );
	}

	public function test_a_build_spills_its_temporary_b_trees_into_its_temp_directory(): void {
		$this->rows_arm( 0 )->write_rows( [ [ 'insert', 'visits', [ 'rid-p0', 7341, 1, 1.5 ] ] ] );
		$temp = $this->temp_store();
		$this->assert_spills_into( Sqlite_Arm::build_rows( "{$this->dir}/tables/kea-snapshot-6121.sqlite", [ 0 => $this->path( 0 ) ], 7 ), $temp );
	}

	/**
	 * A temporary B-tree outgrowing its cache spills to a file SQLite opens
	 * and unlinks at once, so only the process's open descriptors show it.
	 */
	private function assert_spills_into( Row_Reader $reader, string $temp ): void {
		$db    = ( new \ReflectionProperty( Row_Reader::class, 'db' ) )->getValue( $reader );
		$seen  = [];
		$calls = 0;
		$db->sqliteCreateFunction(
			'kea_probe',
			static function ( string $key ) use ( &$seen, &$calls ): string {
				if ( 0 === ++$calls % 1000 ) {
					foreach ( \glob( '/proc/self/fd/*' ) ?: [] as $fd ) {
						$link = (string) @\readlink( $fd );
						if ( \str_contains( $link, '/etilqs_' ) ) {
							$seen[ \dirname( $link ) ] = true;
						}
					}
				}
				return $key;
			},
			1
		);

		$reader->rows( 'SELECT COUNT( * ) FROM ( SELECT DISTINCT kea_probe( hex( randomblob( 16 ) ) ) FROM ( WITH RECURSIVE c ( n ) AS ( SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 120000 ) SELECT n FROM c ) )', [] );

		$this->assertSame( [ $temp ], \array_keys( $seen ), 'every temporary file sat in the temp directory' );
	}

	public function test_build_rows_refuses_a_temp_directory_it_cannot_write(): void {
		$this->rows_arm( 0 );
		$this->unwritable_temp_store();
		$e = $this->caught_pdo( fn () => Sqlite_Arm::build_rows( "{$this->dir}/tables/kea-snapshot-6122.sqlite", [ 0 => $this->path( 0 ) ], 7 ) );
		$this->assertStringContainsString( 'not a writable directory', $e->getMessage() );
	}

	public function test_build_rows_refuses_a_root_builder_naming_every_file_it_would_touch(): void {
		$built             = "{$this->dir}/tables/kea-snapshot-6109.sqlite";
		CLI::$uid_provider = static fn (): int => 0;
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( "sqlite refuses to run as root: a root process leaves files beside {$built}, {$this->path( 2 )}, {$this->path( 6 )} that its worker cannot open" );
		Sqlite_Arm::build_rows( $built, [ 2 => $this->path( 2 ), 6 => $this->path( 6 ) ], 7 );
	}

	/**
	 * A WAL file read through a plain read-only connection takes its `-shm`
	 * lock and opens a `-wal`; read immutably it takes neither.
	 */
	public function test_open_immutable_reads_a_published_file_immutably(): void {
		$file = "{$this->dir}/tables/kea-snapshot-6110.sqlite";
		@\mkdir( \dirname( $file ), 0777, true );
		$writer = new \PDO( "sqlite:{$file}" );
		$this->assertSame( 'wal', $writer->query( 'PRAGMA journal_mode = WAL' )->fetchColumn() );
		$writer->exec( 'CREATE TABLE heron ( n INTEGER ); INSERT INTO heron VALUES ( 6110 )' );
		$writer = null;
		$this->assertFileDoesNotExist( "{$file}-shm", 'the writer closed its lock' );
		$this->assertFileDoesNotExist( "{$file}-wal", 'the writer checkpointed its log' );

		$reader = Sqlite_Arm::open_immutable( $file );

		$this->assertSame( [ 'main' ], $reader->aliases() );
		$this->assertSame( [ [ 6110 ] ], $reader->rows( 'SELECT n FROM heron', [] ) );
		$this->assertSame( [ [ 1 ] ], $reader->rows( 'PRAGMA query_only', [] ) );
		$this->assertSame( [ [ 2147418112 ] ], $reader->rows( 'PRAGMA main.mmap_size', [] ) );
		$this->assertFileDoesNotExist( "{$file}-shm", 'an immutable reader takes no lock' );
		$this->assertFileDoesNotExist( "{$file}-wal", 'an immutable reader opens no log' );
	}

	public function test_open_immutable_of_no_file_throws(): void {
		$absent = "{$this->dir}/tables/kea-snapshot-absent-6111.sqlite";
		@\mkdir( \dirname( $absent ), 0777, true );
		try {
			Sqlite_Arm::open_immutable( $absent );
			$this->fail( 'an absent snapshot opened' );
		} catch ( \PDOException ) {
			$this->assertFileDoesNotExist( $absent, 'a snapshot reader creates no file' );
		}
	}

	public function test_remove_database_unlinks_the_file_with_its_log_and_index_and_answers_them(): void {
		$file = "{$this->dir}/tables/kea-remove-6112.sqlite";
		@\mkdir( \dirname( $file ), 0777, true );
		foreach ( [ $file, "{$file}-wal", "{$file}-shm", "{$file}-journal" ] as $f ) {
			\file_put_contents( $f, 'x' );
		}
		$this->assertSame( [ $file, "{$file}-wal", "{$file}-shm" ], Sqlite_Arm::remove_database( $file ) );
		$this->assertFileDoesNotExist( $file );
		$this->assertFileDoesNotExist( "{$file}-wal" );
		$this->assertFileDoesNotExist( "{$file}-shm" );
		$this->assertFileExists( "{$file}-journal", 'only the database, its -wal and its -shm go' );
		$this->assertSame( [], Sqlite_Arm::remove_database( $file ), 'an absent database removes nothing' );
	}
}
