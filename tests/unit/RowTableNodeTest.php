<?php
/**
 * Row_Table: a Table whose file holds the row tables a Row_Schema declares,
 * written by the ROWS request and read across partitions by read().
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Config;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Row_Reader;
use Newspack_Nodes\Row_Table_Node;
use Newspack_Nodes\Sqlite_Arm;
use Newspack_Nodes\Table_Node;
use Newspack_Nodes\Table_Unavailable;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\Lab_Row_Schema;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Tests\Wombat_Row_Schema;
use Newspack_Nodes\Topology_Registry;
use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\DataProvider;

require_once \dirname( __DIR__ ) . '/Helpers/fixtures/class-wombat-row-schema.php';
require_once \dirname( __DIR__ ) . '/Helpers/fixtures/class-lab-row-schema.php';
require_once \dirname( __DIR__ ) . '/Helpers/fixtures/class-dingo-row-schema.php';

#[CoversClass( Row_Table_Node::class )]
#[CoversClass( Row_Reader::class )]
final class RowTableNodeTest extends TestCase {
	private string $base = '';
	private Capture_Sink_Node $sink;

	protected function setUp(): void {
		parent::setUp();
		$this->base = $this->make_temp_dir( 'row-table-' );
		$this->use_base_dir( $this->base );
		$this->sink = new Capture_Sink_Node();
		Topology_Registry::reset();
		$this->stock_topology_dir( 'row-table-stock-' );
		$this->write_tsl( 'wombat-fleet', "var num_partitions = 4\nmake_node Row_Table wombats-6620 Wombat\n" );
		Lab_Row_Schema::$tables = Wombat_Row_Schema::tables();
	}

	protected function tearDown(): void {
		Sqlite_Arm::$available = null;
		Row_Table_Node::$fsync = null;
		\delete_option( 'newspack_nodes_topologies' );
		Config::reset();
		Topology_Registry::reset();
		$this->rmdir_recursive( $this->base );
		parent::tearDown();
	}

	/** A Row_Table built as a worker's `make_node Row_Table` builds one. */
	private function row_table( string $name, string $schema, string $partition = '3' ): Row_Table_Node {
		Core::$var['partition'] = $partition;
		try {
			$table = new Row_Table_Node();
			$table->name( $name );
			$table->arguments( [ $schema ] );
		} finally {
			unset( Core::$var['partition'] );
		}
		$table->sink( $this->sink );
		return $table;
	}

	/** @return list<array<int,mixed>> What the Table answered asker-9's request. */
	private function ask( Table_Node $table, mixed $value, int $type = Message::TM_REQUEST | Message::TM_STRUCT ): array {
		$this->sink->captured      = [];
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = $type;
		$message[ Message::FROM ]  = 'asker-9';
		$message[ Message::ID ]    = 'ask-17';
		$message[ Message::VALUE ] = $value;
		$table->fill( $message );
		return $this->sink->captured;
	}

	/** @return list<array{0:mixed,1:mixed,2:mixed}> */
	private static function shape( array $replies ): array {
		return \array_map( static fn ( array $r ): array => [ $r[ Message::TYPE ], $r[ Message::KEY ], $r[ Message::VALUE ] ], $replies );
	}

	/** One visit naming a burrow the batch's first op resolves. */
	private static function visit( string $rid, int $bucket ): array {
		return [
			[ 'ignore', 'burrows', [ null, 'sett-41' ] ],
			[ 'insert', 'visits', [ $rid, $bucket, null, 12.5 ], [], [ 2 => 0 ] ],
		];
	}

	private function activate( string ...$names ): void {
		\update_option( 'newspack_nodes_topologies', $names );
		Config::reset();
	}

	/** Every partition's visit count, through read(). */
	private static function visits(): mixed {
		return Row_Table_Node::read(
			Wombat_Row_Schema::class,
			static fn ( Row_Reader $r ): array => $r->rows( 'SELECT count(*) FROM ( ' . \implode( ' UNION ALL ', \array_map( static fn ( string $a ): string => "SELECT * FROM {$a}.visits", $r->aliases() ) ) . ' )', [] )
		);
	}

	public function test_a_row_table_resolves_its_schema_by_word(): void {
		$this->row_table( 'wombats-6620', 'Wombat' );
		$this->assertFileExists( $this->base . '/tables/wombats-6620.p3.sqlite' );
	}

	public function test_an_unknown_schema_word_is_refused_naming_it(): void {
		$e = $this->caught( fn () => $this->row_table( 'wombats-6620', 'Platypus' ), 'unknown schema' );
		$this->assertStringContainsString( 'Platypus', $e->getMessage() );
		$this->assertStringContainsString( 'wombats-6620', $e->getMessage() );
		$this->assertFileDoesNotExist( $this->base . '/tables/wombats-6620.p3.sqlite' );
	}

	public function test_a_schema_class_that_is_no_row_schema_is_refused(): void {
		$e = $this->caught( fn () => $this->row_table( 'wombats-6620', 'Dingo' ), 'a Dingo_Row_Schema that implements nothing' );
		$this->assertStringContainsString( 'Dingo', $e->getMessage() );
	}

	public function test_a_schema_word_that_could_name_another_namespace_is_refused(): void {
		$e = $this->caught( fn () => $this->row_table( 'wombats-6620', 'Unit\\Wombat' ), 'a word holding a backslash' );
		$this->assertStringContainsString( 'Unit\\Wombat', $e->getMessage() );
	}

	/**
	 * Each schema fault, as a change to the Wombat tables, and the word the
	 * refusal must name beside the schema.
	 *
	 * @return array<string,array{0:\Closure(array<string,mixed>):array<string,mixed>,1:string}>
	 */
	public static function faults(): array {
		return [
			'a table name out of the alphabet' => [ static fn ( array $t ): array => [ 'Burrows' => $t['burrows'] ] + $t, 'Burrows' ],
			'a column name out of the alphabet' => [ static function ( array $t ): array {
				$t['visits']['columns']['bad-col'] = 'TEXT';
				return $t;
			}, 'bad-col' ],
			'a type outside the closed set'    => [ static function ( array $t ): array {
				$t['visits']['columns']['ms'] = 'VARCHAR';
				return $t;
			}, 'VARCHAR' ],
			'a table with no columns'          => [ static function ( array $t ): array {
				$t['moles'] = [ 'columns' => [], 'retain' => [ 'bucket', 60, 1 ] ];
				return $t;
			}, 'moles' ],
			'a key naming no column'           => [ static function ( array $t ): array {
				$t['visits']['key'] = [ 'sid' ];
				return $t;
			}, 'sid' ],
			'an add column inside the key'     => [ static function ( array $t ): array {
				$t['tallies']['add']['kind'] = 'sum';
				return $t;
			}, 'kind' ],
			'an index naming no column'        => [ static function ( array $t ): array {
				$t['visits']['indexes']['visits_den'] = [ 'den' ];
				return $t;
			}, 'den' ],
			'an index name out of the alphabet' => [ static function ( array $t ): array {
				$t['visits']['indexes']['Visits-Ms'] = [ 'ms' ];
				return $t;
			}, 'Visits-Ms' ],
			'an autoincrement column that is no INTEGER' => [ static function ( array $t ): array {
				$t['burrows']['autoincrement'] = 'name';
				$t['burrows']['fts']           = [];
				return $t;
			}, 'name' ],
			'a retain column that leads no index or key' => [ static function ( array $t ): array {
				$t['visits']['retain'] = [ 'ms', 3600, 1 ];
				return $t;
			}, 'ms' ],
			'a retain window below one'        => [ static function ( array $t ): array {
				$t['visits']['retain'] = [ 'bucket', 0, 1 ];
				return $t;
			}, 'bucket' ],
			'a retain unit below one'          => [ static function ( array $t ): array {
				$t['slots']['retain'] = [ 'slot', 24, 0 ];
				return $t;
			}, 'slot' ],
			'a retained_by naming no table'    => [ static function ( array $t ): array {
				$t['burrows']['retained_by'][] = [ 'sightings', 'burrow_id', 'id' ];
				return $t;
			}, 'sightings.burrow_id' ],
			'a retained_by column no index leads there' => [ static function ( array $t ): array {
				unset( $t['visits']['indexes']['visits_burrow'] );
				return $t;
			}, 'visits.burrow_id' ],
			'a second retained_by column no index leads there' => [ static function ( array $t ): array {
				$t['burrows']['retained_by'][] = [ 'tallies', 'kind', 'id' ];
				return $t;
			}, 'tallies.kind' ],
			'a retained_by own column undeclared' => [ static function ( array $t ): array {
				$t['burrows']['retained_by'][] = [ 'tallies', 'bucket', 'den_id' ];
				return $t;
			}, 'tallies.bucket on den_id' ],
			'a retained_by own column no unique key holds' => [ static function ( array $t ): array {
				$t['burrows']['columns']['nick'] = 'TEXT';
				$t['burrows']['retained_by'][]   = [ 'tallies', 'bucket', 'nick' ];
				return $t;
			}, 'burrows is retained_by tallies.bucket on nick, which is neither its autoincrement column nor a one-column key' ],
			'a retained_by own column a two-column key leads' => [ static function ( array $t ): array {
				$t['tallies']['retained_by'] = [ [ 'visits', 'bucket', 'bucket' ] ];
				return $t;
			}, 'tallies is retained_by visits.bucket on bucket, which is neither its autoincrement column nor a one-column key' ],
			'a retained_by cycle'              => [ static function ( array $t ): array {
				$t['visits']['retained_by'] = [ [ 'burrows', 'id', 'rid' ] ];
				return $t;
			}, 'burrows is retained_by a cycle: burrows, visits, burrows' ],
			'a table retained_by itself'       => [ static function ( array $t ): array {
				$t['burrows']['retained_by'][] = [ 'burrows', 'id', 'id' ];
				return $t;
			}, 'burrows is retained_by a cycle: burrows, burrows' ],
			'an fts column that is no TEXT'    => [ static function ( array $t ): array {
				$t['burrows']['fts'] = [ 'id' ];
				return $t;
			}, 'id' ],
			'an fts column an add folds'       => [ static function ( array $t ): array {
				$t['burrows']['columns']['nick'] = 'TEXT';
				$t['burrows']['add']             = [ 'nick' => 'max' ];
				$t['burrows']['fts']             = [ 'nick' ];
				return $t;
			}, 'nick' ],
			'an fts shadow with no autoincrement' => [ static function ( array $t ): array {
				$t['tallies']['fts'] = [ 'kind' ];
				return $t;
			}, 'tallies' ],
			'a table nothing ever purges'      => [ static function ( array $t ): array {
				unset( $t['slots']['retain'] );
				return $t;
			}, 'slots' ],
			'a schema declaring no table'      => [ static fn (): array => [], 'no table' ],
			'an add fold outside sum and max'  => [ static function ( array $t ): array {
				$t['tallies']['add']['n'] = 'avg';
				return $t;
			}, 'avg' ],
			'a table named as the kv store'    => [ static function ( array $t ): array {
				$t['kv'] = $t['slots'];
				return $t;
			}, 'kv' ],
			'a table named as the member sets' => [ static function ( array $t ): array {
				$t['members'] = $t['slots'];
				return $t;
			}, 'members' ],
			'an index named as the kv expiry index' => [ static function ( array $t ): array {
				$t['visits']['indexes']['kv_expires'] = [ 'bucket' ];
				return $t;
			}, 'kv_expires' ],
			'an index named as the member expiry index' => [ static function ( array $t ): array {
				$t['visits']['indexes']['members_expires'] = [ 'bucket' ];
				return $t;
			}, 'members_expires' ],
			'two tables declaring one index name' => [ static function ( array $t ): array {
				$t['tallies']['indexes'] = [ 'visits_bucket' => [ 'bucket' ] ];
				return $t;
			}, 'visits_bucket' ],
			'an index named as a table'        => [ static function ( array $t ): array {
				$t['visits']['indexes']['tallies'] = [ 'bucket' ];
				return $t;
			}, 'tallies' ],
			'a table named as an fts shadow'   => [ static function ( array $t ): array {
				$t['burrows_fts'] = $t['slots'];
				return $t;
			}, 'burrows_fts' ],
			'a table named as an fts shadow\'s own table' => [ static function ( array $t ): array {
				$t['burrows_fts_data'] = $t['slots'];
				return $t;
			}, 'burrows_fts_data' ],
			'a table named as an fts trigger'  => [ static function ( array $t ): array {
				$t['burrows_fts_insert'] = $t['slots'];
				return $t;
			}, 'burrows_fts_insert' ],
			'tables that only release each other' => [ static function ( array $t ): array {
				$visits                = $t['visits'];
				$visits['retained_by'] = [ [ 'burrows', 'id', 'rid' ] ];
				unset( $visits['retain'] );
				return [
					'burrows' => $t['burrows'],
					'visits'  => $visits,
				];
			}, 'retains no table' ],
		];
	}

	#[DataProvider( 'faults' )]
	public function test_a_schema_fault_is_refused_naming_the_schema_and_the_item( \Closure $fault, string $item ): void {
		Lab_Row_Schema::$tables = $fault( Wombat_Row_Schema::tables() );
		$e                      = $this->caught( fn () => $this->row_table( 'labs-3307', 'Lab' ), 'the fault' );
		$this->assertStringContainsString( 'Lab', $e->getMessage() );
		$this->assertStringContainsString( $item, $e->getMessage() );
		$this->assertFileDoesNotExist( $this->base . '/tables/labs-3307.p3.sqlite', 'refused before the arm opens' );
	}

	public function test_the_wombat_tables_pass_as_the_lab_schema(): void {
		$this->row_table( 'labs-3307', 'Lab' );
		$this->assertFileExists( $this->base . '/tables/labs-3307.p3.sqlite' );
	}

	public function test_rows_by_message_answer_their_writer(): void {
		$table   = $this->row_table( 'wombats-6620', 'Wombat' );
		$replies = $this->ask( $table, [ 'ROWS' => self::visit( 'rid-5501', 1790000000 ) ] );
		$this->assertSame(
			[ [ Message::TM_RESPONSE, '', "ROWS 2\n" ] ],
			self::shape( $replies )
		);
		$this->assertSame( 'asker-9', $replies[0][ Message::TO ] );
		$this->assertSame( 'wombats-6620', $replies[0][ Message::FROM ] );
		$this->assertSame( 'ask-17', $replies[0][ Message::ID ] );
	}

	public function test_a_rows_write_is_counted_in_its_verb_row(): void {
		$table = $this->row_table( 'wombats-6620', 'Wombat' );
		$this->ask( $table, [ 'ROWS' => self::visit( 'rid-5501', 1790000000 ) ] );
		$this->ask( $table, [ 'ROWS' => [ [ 'insert', 'moles', [ 1 ] ] ] ] );
		$row = $table->stats()['ROWS'];
		$this->assertSame( [ 2, 3, 2, 1 ], [ $row['calls'], $row['asked'], $row['answered'], $row['errors'] ] );
	}

	public function test_a_failed_rows_answers_tm_error(): void {
		$table   = $this->row_table( 'wombats-6620', 'Wombat' );
		$replies = $this->ask( $table, [ 'ROWS' => [ [ 'insert', 'moles', [ 'sett-41' ] ] ] ] );
		$this->assertSame( [ [ Message::TM_ERROR, '', "ROWS: moles: no such row table\n" ] ], self::shape( $replies ) );
		$this->assertSame( 'asker-9', $replies[0][ Message::TO ] );
	}

	public function test_a_rows_request_with_no_struct_bit_or_no_batch_is_refused(): void {
		$table = $this->row_table( 'wombats-6620', 'Wombat' );
		foreach ( [
			[ [ 'ROWS' => self::visit( 'rid-5501', 1790000000 ) ], Message::TM_REQUEST ],
			[ [ 'ROWS' => 'rid-5501' ], Message::TM_REQUEST | Message::TM_STRUCT ],
			[ [ 'ROWS' => [ 'b' => [ 'insert', 'visits', [] ] ] ], Message::TM_REQUEST | Message::TM_STRUCT ],
			[ [ 'ROWS' => [], 'ADD' => [] ], Message::TM_REQUEST | Message::TM_STRUCT ],
		] as [ $value, $type ] ) {
			$replies = $this->ask( $table, $value, $type );
			$this->assertSame( Message::TM_ERROR, $replies[0][ Message::TYPE ] );
			$this->assertStringStartsWith( 'ROWS: ', Core::as_string( $replies[0][ Message::VALUE ] ) );
		}
	}

	public function test_a_keyed_get_on_a_row_table_is_refused(): void {
		$table = $this->row_table( 'wombats-6620', 'Wombat' );
		$this->assertSame( [ [ Message::TM_ERROR, '', "GET: unknown verb\n" ] ], self::shape( $this->ask( $table, "GET sku-41\n", Message::TM_REQUEST ) ) );
		$this->assertSame(
			[ [ Message::TM_ERROR, '', "ADD: only ROWS takes a structure\n" ] ],
			self::shape( $this->ask( $table, [ 'ADD' => [ 'sku-41' => [ 7 ] ] ] ) )
		);
		$this->assertArrayNotHasKey( 'GET', $table->stats(), 'a Row_Table counts the verbs it declares' );
	}

	public function test_rows_on_a_keyed_table_is_refused_as_any_structure_but_add_and_sadd(): void {
		Core::$var['partition'] = '3';
		try {
			$keyed = new Table_Node();
			$keyed->name( 'lab-7:kea' );
			$keyed->arguments( [ 'kea:p3', '777', 'sqlite' ] );
		} finally {
			unset( Core::$var['partition'] );
		}
		$keyed->sink( $this->sink );
		$replies = $this->ask( $keyed, [ 'ROWS' => self::visit( 'rid-5501', 1790000000 ) ] );
		$this->assertSame( [ [ Message::TM_ERROR, '', "ROWS: only ADD and SADD take a structure\n" ] ], self::shape( $replies ) );
		$this->assertArrayNotHasKey( 'ROWS', $keyed->stats(), 'only a Row_Table counts ROWS' );
	}

	public function test_a_mounted_table_refuses_rows(): void {
		$mount   = Table_Node::mount( 'lab-7:kea', 3, [ 'namespace' => 'kea:p3', 'ttl' => 777, 'backend' => 'sqlite' ], $this->sink );
		$replies = $this->ask( $mount, [ 'ROWS' => self::visit( 'rid-5501', 1790000000 ) ] );
		$this->assertSame( [ [ Message::TM_ERROR, '', "ROWS: a mounted Table serves reads only\n" ] ], self::shape( $replies ) );
	}

	/**
	 * A backlog of rows whose names table halves their share of a batch
	 * keeps the purge looping, and leaves it behind while a share fills.
	 */
	public function test_a_row_table_purge_loops_and_falls_behind_on_its_retained_share(): void {
		Core::$clock = static fn (): float => 1790000000.0;
		$table       = $this->row_table( 'wombats-6633', 'Wombat' );
		$batch       = [];
		for ( $i = 0; $i < 2 * Table_Node::PURGE_BATCH_ROWS + 6; ++$i ) {
			$batch[] = [ 'insert', 'visits', [ "rid-{$i}", 1000, 0, 2.5 ] ];
		}
		$this->ask( $table, [ 'ROWS' => $batch ] );
		$left   = static fn (): int => (int) ( new \PDO( 'sqlite:' . Table_Node::file( 'wombats-6633', 3 ) ) )->query( 'SELECT count(*) FROM visits' )->fetchColumn();
		$reads  = 0;
		Core::$clock = static function () use ( &$reads ): float {
			return 1790000037.0 + 0.03 * $reads++;
		};
		$logged = [];
		\add_action(
			'newspack_nodes/stderr',
			static function ( string $line ) use ( &$logged ): void {
				$logged[] = $line;
			}
		);

		Table_Node::tick( 1790000037 );
		$this->assertSame( Table_Node::PURGE_BATCH_ROWS + 6, $left(), 'two batches, each a half-batch of visits' );
		$this->assertStringContainsString( 'wombats-6633: WARNING: purge is behind', \implode( "\n", $logged ) );

		Table_Node::tick( 1790000097 );
		$this->assertSame( 0, $left(), 'the backlog budget runs until a share comes back short' );
	}

	/**
	 * A names table two tables reference: `names` rows named by `left_rows`
	 * and `right_rows`, each purged by its own window.
	 *
	 * @return array<string,mixed>
	 */
	private static function shared_names(): array {
		$referencing = static fn ( string $side ): array => [
			'columns' => [
				'rid'     => 'TEXT NOT NULL',
				'bucket'  => 'INTEGER NOT NULL',
				'name_id' => 'INTEGER NOT NULL',
			],
			'key'     => [ 'rid' ],
			'indexes' => [
				"{$side}_bucket" => [ 'bucket' ],
				"{$side}_name"   => [ 'name_id' ],
			],
			'retain'  => [ 'bucket', 100, 1 ],
		];
		return [
			'names'      => [
				'columns'       => [
					'id'   => 'INTEGER',
					'name' => 'TEXT NOT NULL',
				],
				'key'           => [ 'name' ],
				'autoincrement' => 'id',
				'retained_by'   => [ [ 'left_rows', 'name_id', 'id' ], [ 'right_rows', 'name_id', 'id' ] ],
			],
			'left_rows'  => $referencing( 'left' ),
			'right_rows' => $referencing( 'right' ),
		];
	}

	/** @return list<list<mixed>> Every row a statement answers on the Table's partition file. */
	private static function lab_rows( string $sql ): array {
		return ( new \PDO( 'sqlite:' . Table_Node::file( 'labs-3307', 3 ) ) )->query( $sql )->fetchAll( \PDO::FETCH_NUM );
	}

	/**
	 * A names row stays while any table it is retained_by still names it,
	 * and goes when the last of them purges the row naming it.
	 */
	public function test_a_name_two_tables_reference_goes_only_when_neither_names_it(): void {
		Lab_Row_Schema::$tables = self::shared_names();
		$table                  = $this->row_table( 'labs-3307', 'Lab' );
		$this->ask(
			$table,
			[
				'ROWS' => [
					[ 'ignore', 'names', [ 7, 'kea-7' ] ],
					[ 'ignore', 'names', [ 8, 'emu-8' ] ],
					[ 'insert', 'left_rows', [ 'rid-l1', 1000, 7 ] ],
					[ 'insert', 'left_rows', [ 'rid-l2', 1001, 7 ] ],
					[ 'insert', 'left_rows', [ 'rid-l3', 1002, 8 ] ],
					[ 'insert', 'right_rows', [ 'rid-r1', 3000, 7 ] ],
				],
			]
		);

		Core::$clock = static fn (): float => 2500.0;
		$this->assertSame( 4, $table->purge( 1000 ), 'three left rows, and emu-8 only they named' );
		$this->assertSame( [ [ 7, 'kea-7' ] ], self::lab_rows( 'SELECT id, name FROM names' ), 'a right row still names kea-7' );

		Core::$clock = static fn (): float => 3500.0;
		$this->assertSame( 2, $table->purge( 1000 ), 'the right row, and kea-7 with it' );
		$this->assertSame( [], self::lab_rows( 'SELECT * FROM names' ) );
	}

	/**
	 * A chain of references: `servers` retained_by `urls.server_id`, and
	 * `urls` retained_by `requests.url_id`, which `requests` purges by bucket.
	 *
	 * @return array<string,mixed>
	 */
	private static function request_chain(): array {
		return [
			'servers'  => [
				'columns'       => [
					'id'   => 'INTEGER',
					'host' => 'TEXT NOT NULL',
				],
				'key'           => [ 'host' ],
				'autoincrement' => 'id',
				'retained_by'   => [ [ 'urls', 'server_id', 'id' ] ],
			],
			'urls'     => [
				'columns'       => [
					'id'        => 'INTEGER',
					'path'      => 'TEXT NOT NULL',
					'server_id' => 'INTEGER NOT NULL',
				],
				'key'           => [ 'path' ],
				'indexes'       => [ 'urls_server' => [ 'server_id' ] ],
				'autoincrement' => 'id',
				'retained_by'   => [ [ 'requests', 'url_id', 'id' ] ],
			],
			'requests' => [
				'columns' => [
					'rid'    => 'TEXT NOT NULL',
					'bucket' => 'INTEGER NOT NULL',
					'url_id' => 'INTEGER NOT NULL',
				],
				'key'     => [ 'rid' ],
				'indexes' => [
					'requests_bucket' => [ 'bucket' ],
					'requests_url'    => [ 'url_id' ],
				],
				'retain'  => [ 'bucket', 100, 1 ],
			],
		];
	}

	/**
	 * A release cascades: `requests` purging releases the `urls` rows only
	 * they named, and those release the `servers` rows only they named.
	 */
	public function test_a_release_cascades_to_the_names_its_released_rows_alone_named(): void {
		Lab_Row_Schema::$tables = self::request_chain();
		$table                  = $this->row_table( 'labs-3307', 'Lab' );
		$this->ask(
			$table,
			[
				'ROWS' => [
					[ 'ignore', 'servers', [ 41, 'kea.example' ] ],
					[ 'ignore', 'servers', [ 42, 'emu.example' ] ],
					[ 'ignore', 'urls', [ 61, '/kea-alone', 41 ] ],
					[ 'ignore', 'urls', [ 62, '/emu-old', 42 ] ],
					[ 'ignore', 'urls', [ 63, '/emu-new', 42 ] ],
					[ 'insert', 'requests', [ 'rid-k1', 1000, 61 ] ],
					[ 'insert', 'requests', [ 'rid-e1', 1001, 62 ] ],
					[ 'insert', 'requests', [ 'rid-e2', 3000, 63 ] ],
				],
			]
		);

		Core::$clock = static fn (): float => 2500.0;
		$this->assertSame( 5, $table->purge( 1000 ), 'two requests, their two urls, and kea.example' );
		$this->assertSame( [ [ 'rid-e2' ] ], self::lab_rows( 'SELECT rid FROM requests' ) );
		$this->assertSame( [ [ 63, '/emu-new' ] ], self::lab_rows( 'SELECT id, path FROM urls' ) );
		$this->assertSame( [ [ 42, 'emu.example' ] ], self::lab_rows( 'SELECT id, host FROM servers' ), '/emu-new still names emu.example' );
	}

	/**
	 * A cascade's releases count against the purge's limit: a table takes
	 * its limit over one plus every release its deletions can reach.
	 */
	public function test_a_cascading_purge_takes_a_share_leaving_room_for_every_release(): void {
		Lab_Row_Schema::$tables = self::request_chain();
		$table                  = $this->row_table( 'labs-3307', 'Lab' );
		$ops                    = [];
		for ( $i = 1; $i <= 7; ++$i ) {
			$ops[] = [ 'ignore', 'servers', [ 40 + $i, "kea-{$i}.example" ] ];
			$ops[] = [ 'ignore', 'urls', [ 60 + $i, "/kea-{$i}", 40 + $i ] ];
			$ops[] = [ 'insert', 'requests', [ "rid-{$i}", 1000 + $i, 60 + $i ] ];
		}
		$this->ask( $table, [ 'ROWS' => $ops ] );

		Core::$clock = static fn (): float => 2500.0;
		$this->assertSame( 6, $table->purge( 7 ), 'two requests of the seven, their urls and their servers' );
		$this->assertSame( [ [ 5, 5, 5 ] ], self::lab_rows( 'SELECT ( SELECT count(*) FROM requests ), ( SELECT count(*) FROM urls ), count(*) FROM servers' ) );
	}

	public function test_a_row_table_dumps_the_line_that_built_it(): void {
		$this->assertStringContainsString( 'make_node Row_Table wombats-6620 Wombat', $this->row_table( 'wombats-6620', 'Wombat' )->dump_config() );
	}

	public function test_read_unions_every_partition_that_has_a_file(): void {
		foreach ( [ '0' => 'rid-5501', '3' => 'rid-5503' ] as $p => $rid ) {
			$table = $this->row_table( 'wombats-6620', 'Wombat', (string) $p );
			$this->assertSame( Message::TM_RESPONSE, $this->ask( $table, [ 'ROWS' => self::visit( $rid, 1790000000 ) ] )[0][ Message::TYPE ] );
			$table->remove_node();
		}
		$this->activate( 'wombat-fleet' );
		$this->assertSame( [ [ 2 ] ], self::visits() );
		$this->assertSame(
			[ 'p0', 'p3' ],
			Row_Table_Node::read( Wombat_Row_Schema::class, static fn ( Row_Reader $r ): array => $r->aliases() )
		);
	}

	public function test_read_binds_integers_as_integers(): void {
		$table = $this->row_table( 'wombats-6620', 'Wombat' );
		$this->ask( $table, [ 'ROWS' => [ ...self::visit( 'rid-5501', 1790000000 ), [ 'insert', 'visits', [ 'rid-5502', 1790000300, 1, 4.25 ] ] ] ] );
		$this->activate( 'wombat-fleet' );
		$this->assertSame(
			[ [ 'rid-5502', 4.25 ] ],
			Row_Table_Node::read( Wombat_Row_Schema::class, static fn ( Row_Reader $r ): array => $r->rows( 'SELECT rid, ms FROM p3.visits WHERE bucket / 300 > ? ORDER BY rid LIMIT ?', [ 5966666, 1 ] ) ),
			'an expression has no affinity, so a TEXT bind would compare above every INTEGER'
		);
	}

	public function test_read_with_no_files_answers_empty_aliases(): void {
		$this->activate( 'wombat-fleet' );
		$this->assertSame( [], Row_Table_Node::read( Wombat_Row_Schema::class, static fn ( Row_Reader $r ): array => $r->aliases() ) );
	}

	public function test_read_of_a_row_table_no_active_topology_declares_is_unavailable(): void {
		$this->activate();
		$this->expectException( Table_Unavailable::class );
		$this->expectExceptionMessage( 'no active topology declares a Row_Table of schema Wombat' );
		Row_Table_Node::read( Wombat_Row_Schema::class, static fn (): null => null );
	}

	public function test_read_without_pdo_sqlite_is_unavailable(): void {
		$this->activate( 'wombat-fleet' );
		Sqlite_Arm::$available = static fn (): bool => false;
		$this->expectException( Table_Unavailable::class );
		$this->expectExceptionMessage( 'Row_Table wombats-6620: sqlite backend needs the pdo_sqlite extension' );
		Row_Table_Node::read( Wombat_Row_Schema::class, static fn (): null => null );
	}

	public function test_read_of_a_file_that_is_no_database_is_unavailable(): void {
		$this->activate( 'wombat-fleet' );
		\mkdir( $this->base . '/tables' );
		\file_put_contents( Table_Node::file( 'wombats-6620', 2 ), \str_repeat( 'not a database ', 512 ) );
		$e = $this->caught( fn () => Row_Table_Node::read( Wombat_Row_Schema::class, static fn (): null => null ), 'a junk file' );
		$this->assertInstanceOf( Table_Unavailable::class, $e );
		$this->assertStringStartsWith( 'Row_Table wombats-6620: ', $e->getMessage() );
	}

	public function test_read_answers_what_its_reader_returns(): void {
		$this->activate( 'wombat-fleet' );
		$this->assertSame( 'kea-4471', Row_Table_Node::read( Wombat_Row_Schema::class, static fn (): string => 'kea-4471' ) );
	}

	/** Seed `rid` visits in partitions 1 and 3. */
	private function seed_partitions( string ...$rids ): void {
		foreach ( [ '1', '3' ] as $i => $p ) {
			$table = $this->row_table( 'wombats-6620', 'Wombat', $p );
			$this->assertSame( Message::TM_RESPONSE, $this->ask( $table, [ 'ROWS' => self::visit( $rids[ $i ], 1790000000 ) ] )[0][ Message::TYPE ] );
			$table->remove_node();
		}
	}

	/** A build of `$name` that writes `heron` from both partitions' rids. */
	private static function build_heron( string $name, mixed $answer = 'kea-7101' ): mixed {
		return Row_Table_Node::build(
			Wombat_Row_Schema::class,
			$name,
			static function ( Row_Reader $r ) use ( $answer ): mixed {
				$r->rows( 'CREATE TABLE heron AS SELECT rid FROM p1.visits UNION ALL SELECT rid FROM p3.visits', [] );
				return $answer;
			}
		);
	}

	/** What the published `heron` holds, read straight off the file. */
	private function heron( string $name ): array {
		return ( new \PDO( "sqlite:{$this->base}/tables/{$name}.sqlite" ) )->query( 'SELECT rid FROM heron ORDER BY rid' )->fetchAll( \PDO::FETCH_NUM );
	}

	/** Every database the tables directory holds, by basename, journals left out. */
	private function tables_dir(): array {
		$files = \array_map( 'basename', \glob( "{$this->base}/tables/*.sqlite" ) ?: [] );
		\sort( $files );
		return $files;
	}

	public function test_build_publishes_its_name_whole_and_answers_what_its_builder_returns(): void {
		$this->seed_partitions( 'rid-5511', 'rid-5513' );
		$this->activate( 'wombat-fleet' );

		$this->assertSame( 'kea-7101', self::build_heron( 'heron-snap-7101' ) );

		$this->assertSame( [ [ 'rid-5511' ], [ 'rid-5513' ] ], $this->heron( 'heron-snap-7101' ) );
		$this->assertSame( [ 'heron-snap-7101.sqlite', 'wombats-6620.p1.sqlite', 'wombats-6620.p3.sqlite' ], $this->tables_dir(), 'the build file is gone' );
	}

	public function test_build_hands_its_builder_every_attached_partition(): void {
		$this->seed_partitions( 'rid-5521', 'rid-5523' );
		$this->activate( 'wombat-fleet' );
		$this->assertSame( [ 'p1', 'p3' ], Row_Table_Node::build( Wombat_Row_Schema::class, 'heron-snap-7102', static fn ( Row_Reader $r ): array => $r->aliases() ) );
	}

	public function test_build_syncs_the_build_file_before_it_publishes(): void {
		$this->seed_partitions( 'rid-5561', 'rid-5563' );
		$this->activate( 'wombat-fleet' );
		$seen = [];
		$base = $this->base;
		Row_Table_Node::$fsync = static function ( string $file ) use ( &$seen, $base ): bool {
			$seen[] = [ $file, \file_exists( "{$base}/tables/heron-snap-7106.sqlite" ), \is_file( $file ) ];
			return true;
		};

		self::build_heron( 'heron-snap-7106' );

		$this->assertCount( 1, $seen );
		$this->assertStringStartsWith( "{$this->base}/tables/heron-snap-7106+", $seen[0][0] );
		$this->assertFalse( $seen[0][1], 'nothing published yet' );
		$this->assertTrue( $seen[0][2], 'the build file stood' );
		$this->assertFileExists( "{$this->base}/tables/heron-snap-7106.sqlite" );
	}

	public function test_a_build_that_will_not_sync_throws_and_publishes_nothing(): void {
		$this->seed_partitions( 'rid-5571', 'rid-5573' );
		$this->activate( 'wombat-fleet' );
		Row_Table_Node::$fsync = static fn ( string $file ): bool => false;

		$e = $this->caught( static fn () => self::build_heron( 'heron-snap-7107' ), 'the sync failed' );

		$this->assertStringContainsString( 'heron-snap-7107 would not sync', $e->getMessage() );
		$this->assertSame( [ 'wombats-6620.p1.sqlite', 'wombats-6620.p3.sqlite' ], $this->tables_dir() );
	}

	public function test_a_build_answering_false_leaves_the_published_file_and_no_build(): void {
		$this->seed_partitions( 'rid-5531', 'rid-5533' );
		$this->activate( 'wombat-fleet' );
		self::build_heron( 'heron-snap-7103' );
		$this->ask( $this->row_table( 'wombats-6620', 'Wombat', '1' ), [ 'ROWS' => self::visit( 'rid-5539', 1790000300 ) ] );

		$this->assertFalse( self::build_heron( 'heron-snap-7103', false ) );

		$this->assertSame( [ [ 'rid-5531' ], [ 'rid-5533' ] ], $this->heron( 'heron-snap-7103' ), 'the last publish stands' );
		$this->assertSame( [ 'heron-snap-7103.sqlite', 'wombats-6620.p1.sqlite', 'wombats-6620.p3.sqlite' ], $this->tables_dir() );
	}

	public function test_a_build_that_throws_leaves_the_published_file_and_no_build(): void {
		$this->seed_partitions( 'rid-5541', 'rid-5543' );
		$this->activate( 'wombat-fleet' );
		self::build_heron( 'heron-snap-7104' );

		$e = $this->caught(
			static fn () => Row_Table_Node::build(
				Wombat_Row_Schema::class,
				'heron-snap-7104',
				static fn (): never => throw new \RuntimeException( 'kestrel-7104' )
			),
			'the builder threw'
		);

		$this->assertSame( 'kestrel-7104', $e->getMessage() );
		$this->assertSame( [ [ 'rid-5541' ], [ 'rid-5543' ] ], $this->heron( 'heron-snap-7104' ) );
		$this->assertSame( [ 'heron-snap-7104.sqlite', 'wombats-6620.p1.sqlite', 'wombats-6620.p3.sqlite' ], $this->tables_dir() );
	}

	public function test_a_build_that_will_not_publish_says_so_and_leaves_no_build(): void {
		$this->seed_partitions( 'rid-5551', 'rid-5553' );
		$this->activate( 'wombat-fleet' );
		\mkdir( "{$this->base}/tables/heron-snap-7105.sqlite" );

		$e = $this->caught( static fn () => self::build_heron( 'heron-snap-7105' ), 'a directory stands where the file publishes' );

		$this->assertStringContainsString( 'heron-snap-7105 would not publish', $e->getMessage() );
		$this->assertSame( [ 'heron-snap-7105.sqlite', 'wombats-6620.p1.sqlite', 'wombats-6620.p3.sqlite' ], $this->tables_dir() );
	}

	public function test_a_fleet_with_no_tables_directory_builds_nothing_and_answers_false(): void {
		$this->activate( 'wombat-fleet' );
		$built = false;
		$this->assertFalse(
			Row_Table_Node::build(
				Wombat_Row_Schema::class,
				'heron-snap-7106',
				static function () use ( &$built ): string {
					$built = true;
					return 'kea-7106';
				}
			)
		);
		$this->assertFalse( $built, 'the builder never ran' );
		$this->assertDirectoryDoesNotExist( "{$this->base}/tables" );
	}

	public function test_a_fleet_with_no_partition_file_builds_nothing_and_answers_false(): void {
		$this->activate( 'wombat-fleet' );
		\mkdir( "{$this->base}/tables" );
		\file_put_contents( "{$this->base}/tables/otter-7107.p0.sqlite", '' );
		$built = false;
		$this->assertFalse(
			Row_Table_Node::build(
				Wombat_Row_Schema::class,
				'heron-snap-7107',
				static function () use ( &$built ): string {
					$built = true;
					return 'kea-7107';
				}
			)
		);
		$this->assertFalse( $built, 'the builder never ran' );
		$this->assertSame( [ 'otter-7107.p0.sqlite' ], $this->tables_dir(), 'no build file is left' );
	}

	public function test_build_of_a_row_table_no_active_topology_declares_is_unavailable(): void {
		$this->activate();
		$this->expectException( Table_Unavailable::class );
		$this->expectExceptionMessage( 'no active topology declares a Row_Table of schema Wombat' );
		self::build_heron( 'heron-snap-7108' );
	}

	public function test_build_without_pdo_sqlite_is_unavailable(): void {
		$this->activate( 'wombat-fleet' );
		\mkdir( "{$this->base}/tables" );
		Sqlite_Arm::$available = static fn (): bool => false;
		$this->expectException( Table_Unavailable::class );
		$this->expectExceptionMessage( 'Row_Table wombats-6620: sqlite backend needs the pdo_sqlite extension' );
		self::build_heron( 'heron-snap-7109' );
	}

	public function test_a_build_file_that_will_not_open_is_unavailable(): void {
		$this->activate( 'wombat-fleet' );
		\mkdir( "{$this->base}/tables", 0555 );
		try {
			$e = $this->caught( static fn () => self::build_heron( 'heron-snap-7110' ), 'a tables directory no build can write' );
		} finally {
			\chmod( "{$this->base}/tables", 0755 );
		}
		$this->assertInstanceOf( Table_Unavailable::class, $e );
		$this->assertStringStartsWith( 'Row_Table wombats-6620: ', $e->getMessage() );
	}

	public function test_open_snapshot_reads_what_build_published(): void {
		$this->seed_partitions( 'rid-5561', 'rid-5563' );
		$this->activate( 'wombat-fleet' );
		self::build_heron( 'heron-snap-7111' );

		$reader = Row_Table_Node::open_snapshot( 'heron-snap-7111' );

		$this->assertInstanceOf( Row_Reader::class, $reader );
		$this->assertSame( [ 'main' ], $reader->aliases() );
		$this->assertSame( [ [ 'rid-5561' ], [ 'rid-5563' ] ], $reader->rows( 'SELECT rid FROM heron ORDER BY rid', [] ) );
		$this->assertSame( [ [ 1 ] ], $reader->rows( 'PRAGMA query_only', [] ) );
	}

	public function test_open_snapshot_of_a_name_never_published_answers_null(): void {
		$this->assertNull( Row_Table_Node::open_snapshot( 'heron-snap-7112' ), 'no tables directory' );
		\mkdir( "{$this->base}/tables" );
		$this->assertNull( Row_Table_Node::open_snapshot( 'heron-snap-7112' ), 'no file in it' );
		$this->assertSame( [], $this->tables_dir(), 'a reader creates nothing' );
	}

	public function test_open_snapshot_of_a_file_that_is_no_database_is_unavailable(): void {
		\mkdir( "{$this->base}/tables" );
		\file_put_contents( "{$this->base}/tables/heron-snap-7113.sqlite", \str_repeat( 'not a database ', 512 ) );
		$e = $this->caught( static fn () => Row_Table_Node::open_snapshot( 'heron-snap-7113' ), 'a junk file' );
		$this->assertInstanceOf( Table_Unavailable::class, $e );
		$this->assertStringStartsWith( 'snapshot heron-snap-7113: ', $e->getMessage() );
	}

	public function test_remove_snapshot_deletes_the_published_file_and_leaves_every_other(): void {
		$this->seed_partitions( 'rid-5571', 'rid-5573' );
		$this->activate( 'wombat-fleet' );
		self::build_heron( 'heron-snap-7114' );
		self::build_heron( 'heron-snap-7114-tern' );

		$this->assertSame( [ "{$this->base}/tables/heron-snap-7114.sqlite" ], Row_Table_Node::remove_snapshot( 'heron-snap-7114' ) );

		$this->assertSame( [ 'heron-snap-7114-tern.sqlite', 'wombats-6620.p1.sqlite', 'wombats-6620.p3.sqlite' ], $this->tables_dir() );
		$this->assertSame( [], Row_Table_Node::remove_snapshot( 'heron-snap-7114' ), 'nothing is left to delete' );
	}

	public function test_remove_snapshot_deletes_a_build_left_behind(): void {
		$this->seed_partitions( 'rid-5581', 'rid-5583' );
		$this->activate( 'wombat-fleet' );
		$removed = [];
		$this->assertFalse(
			Row_Table_Node::build(
				Wombat_Row_Schema::class,
				'heron-snap-7115',
				static function () use ( &$removed ): bool {
					$removed = Row_Table_Node::remove_snapshot( 'heron-snap-7115' );
					return false;
				}
			)
		);

		$this->assertCount( 1, $removed, 'the build in flight is the one file of the name' );
		$this->assertStringStartsWith( "{$this->base}/tables/heron-snap-7115", $removed[0] );
		$this->assertStringEndsWith( '.sqlite', $removed[0] );
		$this->assertNotSame( "{$this->base}/tables/heron-snap-7115.sqlite", $removed[0] );
	}

	/** @return array<string,array{string}> Names a snapshot may not take. */
	public static function refused_snapshot_names(): array {
		return [
			'a Table partition file'  => [ 'wombats-6620.p3' ],
			'a negative partition'    => [ 'wombats-6620.p-1' ],
			'a path separator'        => [ 'tables/heron-7116' ],
			'a parent directory'      => [ 'heron..7116' ],
			'a leading dot'           => [ '.heron-7116' ],
			'nothing'                 => [ '' ],
		];
	}

	#[DataProvider( 'refused_snapshot_names' )]
	public function test_a_name_a_table_file_could_take_or_no_file_could_is_refused( string $name ): void {
		$this->activate( 'wombat-fleet' );
		$entries = [
			'build'  => static fn () => Row_Table_Node::build( Wombat_Row_Schema::class, $name, static fn (): string => 'kea-7116' ),
			'open'   => static fn () => Row_Table_Node::open_snapshot( $name ),
			'remove' => static fn () => Row_Table_Node::remove_snapshot( $name ),
		];
		foreach ( $entries as $entry => $call ) {
			try {
				$call();
				$this->fail( "{$entry} took {$name}" );
			} catch ( \InvalidArgumentException $e ) {
				$this->assertStringContainsString( $name, $e->getMessage(), $entry );
			}
		}
		$this->assertDirectoryDoesNotExist( "{$this->base}/tables" );
	}

	public function test_a_keyed_insert_through_fill_is_refused_and_goes_nowhere(): void {
		$lines = [];
		\add_action(
			'newspack_nodes/stderr',
			static function ( string $line ) use ( &$lines ): void {
				$lines[] = $line;
			}
		);
		$table                     = $this->row_table( 'wombats-6620', 'Wombat' );
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_STRUCT;
		$message[ Message::FROM ]  = 'asker-9';
		$message[ Message::KEY ]   = 'sku-4471';
		$message[ Message::VALUE ] = [ 'usd' => 1250 ];
		$table->fill( $message );
		$this->assertNull( $table->lookup( 'sku-4471' ), 'kv stays empty' );
		$this->assertSame( [], $this->sink->captured, 'nothing forwards' );
		$this->assertSame( 0, $table->stats()['INSERT']['calls'] );
		$this->assertStringContainsString( 'refused an INSERT through Row_Table wombats-6620', \implode( "\n", $lines ) );
	}

	public function test_a_row_table_s_metadata_names_its_schema(): void {
		$meta = $this->row_table( 'wombats-6620', 'Wombat' )->dump_metadata();
		$this->assertSame( 'Wombat', $meta['schema'] );
		$this->assertArrayHasKey( 'ROWS', Core::arr( $meta['verb_stats'] ) );
	}

	public function test_a_row_table_declares_no_target(): void {
		$this->assertFalse( Row_Table_Node::node_schema()['has_target'] );
	}

	public function test_an_op_outside_insert_ignore_and_add_is_refused_naming_it(): void {
		$table = $this->row_table( 'wombats-6620', 'Wombat' );
		$this->assertSame(
			[ [ Message::TM_ERROR, '', "ROWS: burrows: no such row op id\n" ] ],
			self::shape( $this->ask( $table, [ 'ROWS' => [ [ 'id', 'burrows', [ 'sett-41' ] ] ] ] ) )
		);
		$this->assertSame(
			[ [ Message::TM_ERROR, '', "ROWS: burrows: no such row op id\n" ] ],
			self::shape( $this->ask( $table, [ 'ROWS' => [ [ 'ignore', 'burrows', [ null, 'sett-41' ], [ [ 'id', 'burrows', [ 'sett-41' ] ] ] ] ] ] ) ),
			'a then op is held to the same ops'
		);
		$this->assertSame( [ [ 0 ] ], $this->burrow_count( $table ), 'the batch rolled back' );
	}

	/** The burrows the table's own partition file holds. */
	private function burrow_count( Row_Table_Node $table ): array {
		$this->activate( 'wombat-fleet' );
		return Row_Table_Node::read( Wombat_Row_Schema::class, static fn ( Row_Reader $r ): array => $r->rows( 'SELECT count(*) FROM p3.burrows', [] ) );
	}
}
