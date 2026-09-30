<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Cache_Backend;
use Newspack_Nodes\Durable_Arm;
use Newspack_Nodes\Core;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use Newspack_Nodes\Sqlite_Arm;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Sqlite_Arm::class )]
#[CoversClass( Cache_Backend::class )]
#[CoversClass( Durable_Arm::class )]
final class SqliteArmTest extends TestCase {
	private string $dir = '';

	protected function setUp(): void {
		parent::setUp();
		$this->dir = $this->make_temp_dir( 'sqlite-arm-' );
	}

	protected function tearDown(): void {
		Sqlite_Arm::$available = null;
		\chmod( $this->dir, 0700 );
		$this->rmdir_recursive( $this->dir );
		parent::tearDown();
	}

	private function path(): string {
		return "{$this->dir}/tables/lab-7:kea.p3.sqlite";
	}

	public function test_the_file_runs_in_wal_mode(): void {
		( new Sqlite_Arm( $this->path(), 'kea:p3' ) )->set( 'sku-41', 1, 0 );
		$this->assertSame( 'wal', ( new \PDO( 'sqlite:' . $this->path() ) )->query( 'PRAGMA journal_mode' )->fetchColumn() );
	}

	public function test_a_write_blocked_past_busy_timeout_fails_and_a_read_still_answers(): void {
		$arm = new Sqlite_Arm( $this->path(), 'kea:p3', 1 );
		$arm->set( 'sku-41', 'before', 0 );
		$other = new \PDO( 'sqlite:' . $this->path() );
		$other->exec( 'BEGIN IMMEDIATE' );
		try {
			$this->assertFalse( $arm->set( 'sku-41', 'after', 0 ), 'a write held past busy_timeout is a failed call' );
			$this->assertFalse( $arm->write_multi( [ 'sku-42' => 1 ], 0 ) );
			$this->assertStringContainsString( 'locked', $arm->last_failure() );
			$this->assertSame( 'before', $arm->get( 'sku-41' ), 'a WAL reader is not blocked by the held write lock' );
		} finally {
			$other->exec( 'ROLLBACK' );
		}
		$this->assertTrue( $arm->set( 'sku-41', 'after', 0 ) );
	}

	public function test_a_missing_pdo_sqlite_refuses_to_build(): void {
		Sqlite_Arm::$available = static fn (): bool => false;
		$this->expectExceptionMessage( 'sqlite backend needs the pdo_sqlite extension' );
		new Sqlite_Arm( $this->path(), 'kea:p3' );
	}

	public function test_an_unwritable_tables_dir_refuses_to_build(): void {
		\chmod( $this->dir, 0500 );
		$this->expectException( \RuntimeException::class );
		new Sqlite_Arm( $this->path(), 'kea:p3' );
	}

	public function test_vacuum_shrinks_the_file_after_a_purge(): void {
		$arm   = new Sqlite_Arm( $this->path(), 'kea:p3' );
		$items = [];
		for ( $i = 0; $i < 3000; ++$i ) {
			$items[ "sku-{$i}" ] = \str_repeat( 'x', 400 );
		}
		Core::$clock = static fn (): float => 1790000000.0;
		$arm->write_multi( $items, 1 );
		$this->checkpoint();
		$before = $this->footprint();
		Core::$clock = static fn (): float => 1790000002.0;
		$this->assertSame( 3000, $arm->purge( 1790000002, 5000 ) );
		$arm->vacuum();
		$this->assertLessThan( $before, $this->footprint() );
	}

	public function test_every_other_write_verb_fails_while_another_writer_holds_the_lock(): void {
		$arm = new Sqlite_Arm( $this->path(), 'kea:p3', 1 );
		$arm->set( 'sku-41', 5, 0 );
		$other = new \PDO( 'sqlite:' . $this->path() );
		$other->exec( 'BEGIN IMMEDIATE' );
		try {
			$this->assertFalse( $arm->add( 'sku-43', 1, 0 ) );
			$this->assertNull( $arm->delete( 'sku-41' ), 'a delete the store did not answer is unknown, not absent' );
			$this->assertNull( $arm->touch( 'sku-41', 777 ) );
			$this->assertFalse( $arm->increment( 'sku-41' ) );
			$this->assertFalse( $arm->compare_and_swap( 'sku-41', 5, 6 ) );
			$this->assertSame( 0, $arm->purge( \time() + 9999, 10 ) );
			$this->assertStringContainsString( 'locked', $arm->last_failure() );
		} finally {
			$other->exec( 'ROLLBACK' );
		}
		$this->assertSame( 5, $arm->get( 'sku-41' ), 'a failed write leaves the row as it was' );
	}

	public function test_a_row_no_serializer_wrote_reads_as_an_error_not_a_miss(): void {
		$arm = new Sqlite_Arm( $this->path(), 'kea:p3' );
		$arm->set( 'sku-41', 1, 0 );
		( new \PDO( 'sqlite:' . $this->path() ) )->exec( "INSERT INTO kv ( \"key\", \"value\", expires ) VALUES ( 'sku-99', 'zjunk', 0 )" );
		$this->assertSame( \Newspack_Nodes\Cache_Backend::READ_ERROR, $arm->read( 'sku-99' )['status'] );
		$this->assertSame( [], $arm->read_multi( [ 'sku-41', 'sku-99' ], $failed ) );
		$this->assertTrue( $failed, 'a batch holding one undecodable row fails whole' );
		$this->assertStringContainsString( 'undecodable row', $arm->last_failure() );
		$this->assertSame( [ 'sqlite_error' => 'undecodable row' ], $arm->diagnostic_metadata() );
	}

	public function test_a_failure_inside_a_write_ends_its_transaction(): void {
		$arm = new Sqlite_Arm( $this->path(), 'kea:p3', 1 );
		( new \PDO( 'sqlite:' . $this->path() ) )->exec( "INSERT INTO kv ( \"key\", \"value\", expires ) VALUES ( 'sku-99', 'zjunk', 0 )" );
		$this->assertFalse( $arm->increment( 'sku-99' ) );
		$this->assertStringContainsString( 'undecodable row', $arm->last_failure() );
		$other = new \PDO( 'sqlite:' . $this->path() );
		$other->exec( 'BEGIN IMMEDIATE' );
		$other->exec( 'ROLLBACK' );
		$this->assertTrue( $arm->set( 'sku-41', 41, 0 ), 'the write lock was released and a new write opens' );
	}

	public function test_the_arm_names_itself_and_an_empty_batch_is_a_write(): void {
		$arm = new Sqlite_Arm( $this->path(), 'kea:p3' );
		$this->assertSame( 'sqlite', $arm->backend_name() );
		$this->assertTrue( $arm->write_multi( [], 777 ) );
	}

	public function test_a_path_that_is_a_directory_refuses_to_build(): void {
		\mkdir( $this->path(), 0700, true );
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'sqlite backend could not open' );
		new Sqlite_Arm( $this->path(), 'kea:p3' );
	}

	public function test_a_row_reads_back_under_whichever_serializer_wrote_it(): void {
		$arm = new Sqlite_Arm( $this->path(), 'kea:p3' );
		$arm->set( 'sku-41', [ 'n' => 41 ], 0 );
		$memd = new InMemoryMemcached();
		$memd->setOption( \Memcached::OPT_SERIALIZER, \Memcached::SERIALIZER_IGBINARY );
		Core::$memd = $memd;
		$arm->set( 'sku-42', [ 'n' => 42 ], 0 );
		$tags = ( new \PDO( 'sqlite:' . $this->path() ) )->query( 'SELECT "key", substr( "value", 1, 1 ) FROM kv' )->fetchAll( \PDO::FETCH_KEY_PAIR );
		$this->assertSame( [ 'sku-41' => 's', 'sku-42' => 'i' ], $tags );
		$this->assertSame( [ 'sku-41' => [ 'n' => 41 ], 'sku-42' => [ 'n' => 42 ] ], $arm->read_multi( [ 'sku-41', 'sku-42' ] ) );
	}

	public function test_the_serializer_is_the_shared_memcached_handles_own(): void {
		Core::$memd = null;
		$this->assertSame( 'php', Durable_Arm::serializer(), 'no handle stores with PHP\'s' );
		$memd = new InMemoryMemcached();
		$memd->setOption( \Memcached::OPT_SERIALIZER, \Memcached::SERIALIZER_IGBINARY );
		Core::$memd = $memd;
		$this->assertSame( 'igbinary', Durable_Arm::serializer() );
		$memd->setOption( \Memcached::OPT_SERIALIZER, \Memcached::SERIALIZER_PHP );
		$this->assertSame( 'php', Durable_Arm::serializer() );
	}

	public function test_vacuum_throws_when_a_reader_keeps_the_wal_from_truncating(): void {
		$arm = new Sqlite_Arm( $this->path(), 'kea:p3', 1 );
		$arm->set( 'sku-41', 1, 0 );
		$reader = new \PDO( 'sqlite:' . $this->path() );
		$reader->exec( 'BEGIN' );
		$reader->query( 'SELECT count(*) FROM kv' )->fetchAll();
		$arm->set( 'sku-42', 2, 0 );
		try {
			$this->expectException( \RuntimeException::class );
			$this->expectExceptionMessage( 'database is locked' );
			$arm->vacuum();
		} finally {
			$reader->exec( 'ROLLBACK' );
		}
	}

	public function test_a_counter_swap_keeps_its_expiry_and_stores_a_blob(): void {
		$arm = new Sqlite_Arm( $this->path(), 'kea:p3' );
		Core::$clock = static fn (): float => 1790000000.0;
		$arm->set( 'sku-41', 7, 777 );
		$this->assertSame( 8, $arm->increment( 'sku-41' ) );
		$row = ( new \PDO( 'sqlite:' . $this->path() ) )->query( 'SELECT typeof( "value" ), expires FROM kv' )->fetch( \PDO::FETCH_NUM );
		$this->assertSame( [ 'blob', 1790000777 ], $row );
	}

	public function test_a_flush_replaces_the_file_and_answers_the_bytes_the_old_one_held(): void {
		$writer = new Sqlite_Arm( $this->path(), 'kea:p3' );
		$writer->set( 'sku-4471', \str_repeat( 'kea', 4471 ), 600 );
		( new \PDO( 'sqlite:' . $this->path() ) )->exec( 'PRAGMA user_version = 4471' );
		\clearstatcache();
		$held = 0;
		foreach ( [ '', '-wal', '-shm' ] as $suffix ) {
			$held += \is_file( $this->path() . $suffix ) ? (int) \filesize( $this->path() . $suffix ) : 0;
		}

		$this->assertSame( [ 'bytes' => $held ], $writer->flush() );

		$this->assertGreaterThan( 0, $held );
		$fresh = new \PDO( 'sqlite:' . $this->path() );
		$this->assertSame( 0, (int) $fresh->query( 'PRAGMA user_version' )->fetchColumn(), 'a new file, not the old one emptied' );
		$this->assertSame( 'wal', $fresh->query( 'PRAGMA journal_mode' )->fetchColumn() );
		$this->assertFalse( $writer->get( 'sku-4471' ) );
		$this->assertTrue( $writer->set( 'sku-4473', 'weka-4473', 600 ), 'the arm writes on after' );
		$this->assertSame( 'weka-4473', ( new Sqlite_Arm( $this->path(), 'kea:p3', read_only: true ) )->get( 'sku-4473' ) );
	}

	/** A database is its file, `-wal` and `-shm`: each on disk, with its bytes. */
	public function test_file_sizes_names_each_file_of_the_database_on_disk(): void {
		\mkdir( \dirname( $this->path() ), 0755, true );
		\file_put_contents( $this->path(), \str_repeat( 'k', 4471 ) );
		\file_put_contents( $this->path() . '-shm', \str_repeat( 's', 3301 ) );
		\file_put_contents( "{$this->dir}/tables/lab-7:kea.p4.sqlite-wal", 'another partition' );

		$this->assertSame( [ $this->path() => 4471, $this->path() . '-shm' => 3301 ], Sqlite_Arm::file_sizes( $this->path() ) );

		\file_put_contents( $this->path() . '-wal', \str_repeat( 'w', 997 ) );
		$this->assertSame( 997, Sqlite_Arm::file_sizes( $this->path() )[ $this->path() . '-wal' ], 'a file written since is sized, not a stat cached' );
	}

	public function test_a_reader_cannot_flush_and_answers_null(): void {
		( new Sqlite_Arm( $this->path(), 'kea:p3' ) )->set( 'sku-4471', 'kea', 600 );
		$reader = new Sqlite_Arm( $this->path(), 'kea:p3', read_only: true );
		$this->assertNull( $reader->flush() );
		$this->assertStringContainsString( 'a reader cannot flush', $reader->last_failure() );
		$this->assertSame( 'kea', ( new Sqlite_Arm( $this->path(), 'kea:p3' ) )->get( 'sku-4471' ), 'nothing was deleted' );
	}

	public function test_a_reader_of_a_file_not_there_reads_nothing_and_creates_nothing(): void {
		$reader = new Sqlite_Arm( $this->path(), 'kea:p3', read_only: true );
		$this->assertSame( [], $reader->read_multi( [ 'sku-41', 'sku-42' ], $failed ) );
		$this->assertFalse( $failed, 'no file is no data, not a failed read' );
		$this->assertSame( Cache_Backend::READ_MISS, $reader->read( 'sku-41' )['status'] );
		$this->assertFalse( $reader->set( 'sku-43', 'kea-43', 0 ), 'a reader writes nothing' );
		$this->assertDirectoryDoesNotExist( "{$this->dir}/tables", 'a reader creates no directory' );
	}

	public function test_a_reader_opened_before_its_file_reads_the_file_once_it_appears(): void {
		$reader = new Sqlite_Arm( $this->path(), 'kea:p3', read_only: true );
		$this->assertFalse( $reader->get( 'sku-41' ) );
		( new Sqlite_Arm( $this->path(), 'kea:p3' ) )->set( 'sku-41', 'kea-41', 0 );
		$this->assertSame( 'kea-41', $reader->get( 'sku-41' ), 'an absence is not remembered' );
	}

	public function test_a_path_that_exists_but_will_not_open_refuses_a_reader(): void {
		\mkdir( $this->path(), 0700, true );
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'sqlite backend could not open' );
		new Sqlite_Arm( $this->path(), 'kea:p3', read_only: true );
	}

	public function test_a_reader_refuses_a_host_without_pdo_sqlite(): void {
		Sqlite_Arm::$available = static fn (): bool => false;
		$this->expectException( \LogicException::class );
		$this->expectExceptionMessage( 'sqlite backend needs the pdo_sqlite extension' );
		new Sqlite_Arm( $this->path(), 'kea:p3', read_only: true );
	}

	public function test_a_reader_sees_what_its_writer_commits_and_writes_nothing(): void {
		$writer = new Sqlite_Arm( $this->path(), 'kea:p3' );
		$writer->set( 'sku-41', 'kea-41', 0 );
		$reader = new Sqlite_Arm( $this->path(), 'kea:p3', read_only: true );
		$writer->set( 'sku-42', 'kea-42', 0 );
		$this->assertSame( [ 'sku-41' => 'kea-41', 'sku-42' => 'kea-42' ], $reader->read_multi( [ 'sku-41', 'sku-42' ] ) );
		$this->assertFalse( $reader->set( 'sku-43', 'kea-43', 0 ) );
		$this->assertStringContainsString( 'readonly database', $reader->last_failure() );
		$this->assertFalse( $writer->get( 'sku-43' ) );
	}

	public function test_a_reader_switches_no_journal_mode_and_declares_no_table(): void {
		\mkdir( \dirname( $this->path() ), 0700, true );
		( new \PDO( 'sqlite:' . $this->path() ) )->exec( 'CREATE TABLE lab_7 ( kea INTEGER )' );
		$reader = new Sqlite_Arm( $this->path(), 'kea:p3', read_only: true );
		$this->assertSame( Cache_Backend::READ_ERROR, $reader->read( 'sku-41' )['status'], 'a file with no kv table is a failed read, not a miss' );
		$probe = new \PDO( 'sqlite:' . $this->path() );
		$this->assertSame( 'delete', $probe->query( 'PRAGMA journal_mode' )->fetchColumn() );
		$this->assertSame( [ 'lab_7' ], $probe->query( "SELECT name FROM sqlite_master WHERE type = 'table'" )->fetchAll( \PDO::FETCH_COLUMN ) );
	}

	private function checkpoint(): void {
		( new \PDO( 'sqlite:' . $this->path() ) )->query( 'PRAGMA wal_checkpoint(TRUNCATE)' )->fetchAll();
	}

	private function footprint(): int {
		\clearstatcache();
		return \filesize( $this->path() ) + ( \is_file( $this->path() . '-wal' ) ? \filesize( $this->path() . '-wal' ) : 0 );
	}

	public function test_a_member_read_seeks_one_set_through_the_primary_key(): void {
		$arm = new Sqlite_Arm( $this->path(), 'kea:p3' );
		for ( $set = 0; $set < 40; ++$set ) {
			$members = [];
			for ( $m = 0; $m < 250; ++$m ) {
				$members[ "https://kea.example/{$set}/{$m}" ] = [ 'hits' => $m ];
			}
			$this->assertTrue( $arm->add_members( [ "word:w{$set}" => [ $members, 777 ] ] ) );
		}
		$this->assertSame( [ 'word:w17' => null ], $arm->members( [ 'word:w17' ], 7 ), 'past its limit the set reads null' );
		$read = $arm->members( [ 'word:w17' ], 250 );
		$this->assertCount( 250, $read['word:w17'] );
		foreach ( \array_keys( $read['word:w17'] ) as $member ) {
			$this->assertStringStartsWith( 'https://kea.example/17/', (string) $member );
		}
		$sql  = ( new \ReflectionClassConstant( Sqlite_Arm::class, 'MEMBERS_READ' ) )->getValue();
		$plan = ( new \PDO( 'sqlite:' . $this->path() ) )->prepare( "EXPLAIN QUERY PLAN {$sql}" );
		$plan->execute( [ 'word:w17', 1, 7 ] );
		$detail = \implode( "\n", \array_column( $plan->fetchAll( \PDO::FETCH_ASSOC ), 'detail' ) );
		$this->assertStringContainsString( 'SEARCH members USING PRIMARY KEY (set_key=?)', $detail );
		$this->assertStringNotContainsString( 'SCAN', $detail );
		$this->assertStringContainsString( 'ORDER BY member', $sql );
		$this->assertStringNotContainsString( 'TEMP B-TREE', $detail, 'the key order serves ORDER BY member for free' );
	}

	public function test_the_member_purge_seeks_expired_rows_through_the_expires_index(): void {
		$arm = new Sqlite_Arm( $this->path(), 'kea:p3' );
		$arm->add_members( [ 'word:w1' => [ [ 'u-1' => 1 ], 777 ] ] );
		$sql  = ( new \ReflectionClassConstant( Sqlite_Arm::class, 'MEMBERS_PURGE' ) )->getValue();
		$plan = ( new \PDO( 'sqlite:' . $this->path() ) )->prepare( "EXPLAIN QUERY PLAN {$sql}" );
		$plan->execute( [ 1790000037, 5000 ] );
		$detail = \array_column( $plan->fetchAll( \PDO::FETCH_ASSOC ), 'detail' );
		$this->assertSame(
			[ 'SEARCH members USING PRIMARY KEY (set_key=? AND member=?)', 'SEARCH members USING COVERING INDEX members_expires (expires<?)' ],
			\array_values( \array_filter( $detail, static fn ( string $line ): bool => \str_starts_with( $line, 'SEARCH' ) ) )
		);
		$this->assertStringNotContainsString( 'SCAN', \implode( "\n", $detail ) );
	}

	public function test_a_member_add_lands_whole_or_not_at_all(): void {
		$arm = new Sqlite_Arm( $this->path(), 'kea:p3' );
		$arm->set( 'sku-41', 1, 0 );
		( new \PDO( 'sqlite:' . $this->path() ) )->exec( "CREATE TRIGGER no_weka BEFORE INSERT ON members WHEN NEW.member = 'm-weka' BEGIN SELECT RAISE( ABORT, 'no weka' ); END" );
		$this->assertFalse( $arm->add_members( [ 'owl:set-7' => [ [ 'm-kea' => 1 ], 777 ], 'owl:set-9' => [ [ 'm-weka' => 2 ], 777 ] ] ) );
		$this->assertSame( [], $arm->members( [ 'owl:set-7', 'owl:set-9' ], 9 ), 'the set before the refusal rolled back with it' );
		$this->assertStringContainsString( 'no weka', $arm->last_failure() );
	}

	public function test_a_file_holding_no_members_table_fails_a_member_read(): void {
		$arm = new Sqlite_Arm( $this->path(), 'kea:p3' );
		( new \PDO( 'sqlite:' . $this->path() ) )->exec( 'DROP TABLE members' );
		$this->assertFalse( $arm->members( [ 'owl:set-7' ], 9 ), 'a failure never reads as an empty set' );
		$this->assertStringContainsString( 'no such table: members', $arm->last_failure() );
	}

	public function test_a_reader_of_a_file_not_there_reads_no_members(): void {
		$reader = new Sqlite_Arm( $this->path(), 'kea:p3', read_only: true );
		$this->assertSame( [], $reader->members( [ 'owl:set-7' ], 9 ) );
		$this->assertFileDoesNotExist( $this->path() );
	}

	/** A file its writer declared before members existed: a `kv` table alone. */
	private function kv_only_file(): void {
		\mkdir( \dirname( $this->path() ), 0700, true );
		$db = new \PDO( 'sqlite:' . $this->path() );
		$db->exec( 'PRAGMA journal_mode = WAL' );
		$db->exec( 'CREATE TABLE kv ( "key" TEXT PRIMARY KEY, "value" BLOB NOT NULL, expires INTEGER NOT NULL )' );
	}

	public function test_a_reader_of_a_file_with_no_members_table_reads_no_members(): void {
		$this->kv_only_file();
		$reader = new Sqlite_Arm( $this->path(), 'kea:p3', read_only: true );
		$this->assertSame( [], $reader->members( [ 'owl:set-7' ], 9 ), 'no members table is an empty set, not a failed read' );
		$this->assertSame( Cache_Backend::READ_MISS, $reader->read( 'sku-41' )['status'], 'the kv table still answers' );
	}

	public function test_a_reader_looks_for_the_members_table_once_per_open(): void {
		$this->kv_only_file();
		$reader = new Sqlite_Arm( $this->path(), 'kea:p3', read_only: true );
		$this->assertSame( [], $reader->members( [ 'owl:set-7' ], 9 ) );
		( new Sqlite_Arm( $this->path(), 'kea:p3' ) )->add_members( [ 'owl:set-7' => [ [ 'm-41' => 'kea' ], 777 ] ] );
		$this->assertSame( [], $reader->members( [ 'owl:set-7' ], 9 ), 'the open reader keeps what it found at open' );
		$fresh = new Sqlite_Arm( $this->path(), 'kea:p3', read_only: true );
		$this->assertSame( [ 'owl:set-7' => [ 'm-41' => 'kea' ] ], $fresh->members( [ 'owl:set-7' ], 9 ) );
	}

	public function test_a_reader_of_a_file_that_is_no_database_opens_and_fails_each_read(): void {
		\mkdir( \dirname( $this->path() ), 0700, true );
		\file_put_contents( $this->path(), \str_repeat( 'kea-not-sqlite ', 300 ) );
		$reader = new Sqlite_Arm( $this->path(), 'kea:p3', read_only: true );
		$this->assertSame( Cache_Backend::READ_ERROR, $reader->read( 'sku-41' )['status'] );
		$this->assertFalse( $reader->members( [ 'owl:set-7' ], 9 ), 'a file that is no database fails the member read too' );
	}

	public function test_a_reader_opened_before_its_file_reads_members_once_it_appears(): void {
		$reader = new Sqlite_Arm( $this->path(), 'kea:p3', read_only: true );
		$this->assertSame( [], $reader->members( [ 'owl:set-7' ], 9 ) );
		( new Sqlite_Arm( $this->path(), 'kea:p3' ) )->add_members( [ 'owl:set-7' => [ [ 'm-43' => 'weka' ], 777 ] ] );
		$this->assertSame( [ 'owl:set-7' => [ 'm-43' => 'weka' ] ], $reader->members( [ 'owl:set-7' ], 9 ) );
	}

	public function test_a_member_read_holds_one_over_limit_set_at_a_time(): void {
		$arm   = new Sqlite_Arm( $this->path(), 'kea:p3' );
		$bytes = \str_repeat( 'k', 2048 );
		for ( $set = 0; $set < 20; ++$set ) {
			$members = [];
			for ( $m = 0; $m < 1001; ++$m ) {
				$members[ "u-{$m}" ] = $bytes;
			}
			$arm->add_members( [ "word:w{$set}" => [ $members, 777 ] ] );
		}
		$keys = \array_map( static fn ( int $set ): string => "word:w{$set}", \range( 0, 19 ) );
		\gc_collect_cycles();
		$before = \memory_get_usage();
		\memory_reset_peak_usage();
		$read = $arm->members( $keys, 1000 );
		$this->assertSame( \array_fill_keys( $keys, null ), $read );
		$this->assertLessThan( 8 * 1024 * 1024, \memory_get_peak_usage() - $before, 'twenty over-limit sets of 2 MB never sit in memory together' );
	}

	public function test_a_member_row_no_serializer_wrote_fails_the_read(): void {
		$arm = new Sqlite_Arm( $this->path(), 'kea:p3' );
		$arm->add_members( [ 'owl:set-7' => [ [ 'm-41' => 'kea' ], 777 ] ] );
		( new \PDO( 'sqlite:' . $this->path() ) )->exec( "INSERT INTO members VALUES ( 'owl:set-7', 'm-43', 'zz-not-tagged', 1999999999 )" );
		$this->assertFalse( $arm->members( [ 'owl:set-7' ], 9 ), 'a corrupt member is a failed read, as a corrupt kv row is' );
		$this->assertStringContainsString( 'undecodable row', $arm->last_failure() );
	}

	public function test_the_purge_takes_keyed_rows_before_members(): void {
		Core::$clock = static fn (): float => 1790000000.0;
		$arm         = new Sqlite_Arm( $this->path(), 'kea:p3' );
		$arm->write_multi( [ 'kea-1' => 1, 'kea-2' => 2, 'kea-3' => 3, 'kea-4' => 4, 'kea-5' => 5 ], 37 );
		$arm->add_members( [ 'owl:set-7' => [ [ 'm-1' => 1, 'm-2' => 2, 'm-3' => 3 ], 37 ] ] );
		$count = fn ( string $table ): int => (int) ( new \PDO( 'sqlite:' . $this->path() ) )->query( "SELECT COUNT(*) FROM {$table}" )->fetchColumn();
		$this->assertSame( 4, $arm->purge( 1790000037, 4 ) );
		$this->assertSame( [ 1, 3 ], [ $count( 'kv' ), $count( 'members' ) ], 'a limit the keyed rows fill leaves every member' );
	}

	/** A pragma as the arm's own connection answers it. */
	private static function pragma( Sqlite_Arm $arm, string $name ): mixed {
		$db = ( new \ReflectionProperty( Sqlite_Arm::class, 'db' ) )->getValue( $arm );
		return $db->query( "PRAGMA {$name}" )->fetchColumn();
	}

	public function test_a_writer_leaves_the_checkpoint_to_the_tick_and_takes_the_page_cache(): void {
		$writer = new Sqlite_Arm( $this->path(), 'kea:p3' );
		$this->assertSame( 0, (int) self::pragma( $writer, 'wal_autocheckpoint' ), 'no COMMIT runs a checkpoint' );
		$this->assertSame( -Sqlite_Arm::CACHE_KIB, (int) self::pragma( $writer, 'cache_size' ) );
		$this->assertSame( 65536, Sqlite_Arm::CACHE_KIB );
	}

	public function test_a_writer_caps_the_wal_file_it_rewinds(): void {
		$writer = new Sqlite_Arm( $this->path(), 'kea:p3' );
		$this->assertSame( 67108864, Sqlite_Arm::WAL_LIMIT_BYTES );
		$this->assertSame( Sqlite_Arm::WAL_LIMIT_BYTES, (int) self::pragma( $writer, 'journal_size_limit' ) );
	}

	public function test_a_reader_takes_the_same_page_cache(): void {
		( new Sqlite_Arm( $this->path(), 'kea:p3' ) )->set( 'sku-41', 'kea-41', 0 );
		$reader = new Sqlite_Arm( $this->path(), 'kea:p3', read_only: true );
		$this->assertSame( -Sqlite_Arm::CACHE_KIB, (int) self::pragma( $reader, 'cache_size' ) );
	}

	public function test_commits_past_the_default_threshold_leave_every_frame_in_the_wal(): void {
		$arm = new Sqlite_Arm( $this->path(), 'kea:p3' );
		for ( $batch = 0; $batch < 3; ++$batch ) {
			$items = [];
			for ( $i = 0; $i < 600; ++$i ) {
				$items[ "sku-{$batch}-{$i}" ] = \str_repeat( 'k', 3000 );
			}
			$this->assertTrue( $arm->write_multi( $items, 0 ) );
		}
		\clearstatcache();
		$this->assertGreaterThan( 1500 * 4120, \filesize( $this->path() . '-wal' ), 'SQLite\'s default checkpoints at 1000 frames and restarts the WAL' );
	}

	public function test_a_checkpoint_writes_every_frame_back_and_the_next_write_restarts_the_wal(): void {
		$arm   = new Sqlite_Arm( $this->path(), 'kea:p3' );
		$items = [];
		for ( $i = 0; $i < 400; ++$i ) {
			$items[ "sku-{$i}" ] = \str_repeat( 'o', 2000 );
		}
		$arm->write_multi( $items, 0 );
		[ $frames, $written ] = $arm->checkpoint();
		$this->assertGreaterThan( 190, $frames );
		$this->assertSame( $frames, $written );
		$arm->set( 'sku-401', 'owl', 0 );
		[ $after ] = $arm->checkpoint();
		$this->assertLessThan( 10, $after, 'the WAL starts over once every frame is back' );
	}

	public function test_a_checkpoint_behind_an_open_reader_is_partial_not_a_failure(): void {
		$arm = new Sqlite_Arm( $this->path(), 'kea:p3' );
		$arm->set( 'sku-41', 'kea-41', 0 );
		$reader = new \PDO( 'sqlite:' . $this->path() );
		$reader->exec( 'BEGIN' );
		$reader->query( 'SELECT count(*) FROM kv' )->fetchAll();
		try {
			$arm->set( 'sku-42', \str_repeat( 'e', 9000 ), 0 );
			[ $frames, $written ] = $arm->checkpoint();
			$this->assertLessThan( $frames, $written, 'frames past the reader\'s snapshot wait for the next tick' );
		} finally {
			$reader->exec( 'ROLLBACK' );
		}
		[ $frames, $written ] = $arm->checkpoint();
		$this->assertSame( $frames, $written );
	}

	public function test_a_checkpoint_of_a_file_not_there_answers_null(): void {
		$logged = [];
		\add_action(
			'newspack_nodes/stderr',
			static function ( string $line ) use ( &$logged ): void {
				$logged[] = $line;
			}
		);
		$this->assertNull( ( new Sqlite_Arm( $this->path(), 'kea:p3', read_only: true ) )->checkpoint() );
		$this->assertStringContainsString( 'Table checkpoint failed: sqlite ' . $this->path() . ': no file at', \implode( "\n", $logged ) );
	}

	// ── In-place writes: a rewrite updates its row rather than replacing it ──

	/** An UPDATE trigger on `$table` logging each row it fires for. */
	private function log_updates( string $table ): \PDO {
		$db = new \PDO( 'sqlite:' . $this->path() );
		$db->exec( 'CREATE TABLE updated ( what TEXT )' );
		$db->exec( "CREATE TRIGGER log_{$table} AFTER UPDATE ON {$table} BEGIN INSERT INTO updated VALUES ( 'row' ); END" );
		return $db;
	}

	public function test_a_rewritten_key_updates_its_row_in_place(): void {
		$arm = new Sqlite_Arm( $this->path(), 'kea:p3' );
		Core::$clock = static fn (): float => 1790000000.0;
		$arm->write_multi( [ 'sku-41' => 'kea-41', 'sku-43' => 'kea-43' ], 37 );
		$db    = $this->log_updates( 'kv' );
		$rowid = $db->query( "SELECT rowid FROM kv WHERE \"key\" = 'sku-41'" )->fetchColumn();
		$this->assertTrue( $arm->write_multi( [ 'sku-41' => 'owl-41' ], 4471 ) );
		$this->assertSame( [ [ $rowid, 1790004471 ] ], $db->query( "SELECT rowid, expires FROM kv WHERE \"key\" = 'sku-41'" )->fetchAll( \PDO::FETCH_NUM ), 'the row kept its rowid and took the new expiry' );
		$this->assertSame( 'owl-41', $arm->get( 'sku-41' ) );
		$this->assertSame( '1', (string) $db->query( 'SELECT count(*) FROM updated' )->fetchColumn(), 'one UPDATE, no delete and reinsert' );
	}

	public function test_a_re_added_member_updates_its_row_in_place(): void {
		$arm = new Sqlite_Arm( $this->path(), 'kea:p3' );
		Core::$clock = static fn (): float => 1790000000.0;
		$arm->add_members( [ 'word:kea' => [ [ 'u-41' => 1, 'u-43' => 3 ], 37 ] ] );
		$db = $this->log_updates( 'members' );
		$this->assertTrue( $arm->add_members( [ 'word:kea' => [ [ 'u-41' => 'owl' ], 4471 ] ] ) );
		$this->assertSame( [ 'word:kea' => [ 'u-41' => 'owl', 'u-43' => 3 ] ], $arm->members( [ 'word:kea' ], 9 ) );
		$this->assertSame( '1790004471', (string) $db->query( "SELECT expires FROM members WHERE member = 'u-41'" )->fetchColumn() );
		$this->assertSame( '1', (string) $db->query( 'SELECT count(*) FROM updated' )->fetchColumn(), 'one UPDATE, no delete and reinsert' );
	}

	public function test_a_write_after_a_flush_lands_in_the_new_file(): void {
		$arm = new Sqlite_Arm( $this->path(), 'kea:p3' );
		$arm->set( 'sku-41', 'kea-41', 0 );
		$arm->add_members( [ 'word:kea' => [ [ 'u-41' => 1 ], 777 ] ] );
		$arm->add( 'sku-42', 'kea-42', 0 );
		$arm->flush();
		$arm->set( 'sku-43', 'kea-43', 0 );
		$arm->add( 'sku-47', 'kea-47', 0 );
		$arm->add_members( [ 'word:owl' => [ [ 'u-43' => 3 ], 777 ] ] );
		$db = new \PDO( 'sqlite:' . $this->path() );
		$this->assertSame( [ 'sku-43', 'sku-47' ], $db->query( 'SELECT "key" FROM kv ORDER BY "key"' )->fetchAll( \PDO::FETCH_COLUMN ), 'no statement wrote into the unlinked file' );
		$this->assertSame( [ 'word:owl' ], $db->query( 'SELECT set_key FROM members' )->fetchAll( \PDO::FETCH_COLUMN ) );
	}

	// ── Batched deletes and touches: one write scope for the whole batch ──

	/** WAL frames `$op` writes: the log is written back first and restarts under it. */
	private function frames_written_by( Sqlite_Arm $arm, \Closure $op ): int {
		$arm->checkpoint();
		$op();
		return $arm->checkpoint()[0];
	}

	public function test_a_batched_touch_runs_one_write_scope(): void {
		$arm = new Sqlite_Arm( $this->path(), 'kea:p3' );
		Core::$clock = static fn (): float => 1790000000.0;
		$arm->write_multi( [ 'sku-41' => 'kea-41', 'sku-43' => 'kea-43', 'sku-47' => 'kea-47' ], 37 );
		$two = $this->frames_written_by( $arm, fn () => $this->assertSame( [ 'sku-41', 'sku-43' ], $arm->touch_multi( [ 'sku-41', 'sku-49', 'sku-43' ], 777 ) ) );
		$one = $this->frames_written_by( $arm, fn () => $arm->touch_multi( [ 'sku-47' ], 778 ) );
		$this->assertGreaterThan( 0, $one );
		$this->assertSame( $one, $two, 'two keys dirty their pages once, in one BEGIN IMMEDIATE' );
		$db = new \PDO( 'sqlite:' . $this->path() );
		$this->assertSame( [ 1790000777, 1790000777, 1790000778 ], $db->query( 'SELECT expires FROM kv ORDER BY "key"' )->fetchAll( \PDO::FETCH_COLUMN ) );
	}

	public function test_a_batched_delete_runs_one_write_scope(): void {
		$arm = new Sqlite_Arm( $this->path(), 'kea:p3' );
		$arm->write_multi( [ 'sku-41' => 'kea-41', 'sku-43' => 'kea-43', 'sku-47' => 'kea-47', 'sku-53' => 'kea-53' ], 0 );
		$two = $this->frames_written_by( $arm, fn () => $this->assertSame( [ 'sku-41', 'sku-43' ], $arm->delete_multi( [ 'sku-41', 'sku-49', 'sku-43' ] ) ) );
		$one = $this->frames_written_by( $arm, fn () => $arm->delete_multi( [ 'sku-47' ] ) );
		$this->assertGreaterThan( 0, $one );
		$this->assertSame( $one, $two, 'two keys dirty their pages once, in one BEGIN IMMEDIATE' );
		$this->assertSame( [ 'sku-53' ], ( new \PDO( 'sqlite:' . $this->path() ) )->query( 'SELECT "key" FROM kv' )->fetchAll( \PDO::FETCH_COLUMN ) );
	}

	public function test_an_empty_batch_takes_no_write_lock(): void {
		$file = $this->path();
		$arm  = new Sqlite_Arm( $file, 'kea:p3', 1 );
		$arm->set( 'sku-41', 'kea-41', 0 );
		$other = new \PDO( 'sqlite:' . $file );
		$other->exec( 'BEGIN IMMEDIATE' );
		try {
			$this->assertSame( [], $arm->delete_multi( [] ) );
			$this->assertSame( [], $arm->touch_multi( [], 777 ) );
			$this->assertSame( 'sqlite ' . $file . ': ', $arm->last_failure(), 'no lock was asked for' );
			$this->assertSame( [], $arm->delete_multi( [ 'sku-41' ] ), 'a real batch waits on the held lock and fails' );
			$this->assertStringContainsString( 'locked', $arm->last_failure() );
		} finally {
			$other->exec( 'ROLLBACK' );
		}
	}

	public function test_a_batch_that_fails_lands_no_key_and_answers_none(): void {
		$arm = new Sqlite_Arm( $this->path(), 'kea:p3' );
		$arm->write_multi( [ 'sku-41' => 'kea-41', 'sku-43' => 'kea-43' ], 0 );
		( new \PDO( 'sqlite:' . $this->path() ) )->exec( "CREATE TRIGGER no_43 BEFORE DELETE ON kv WHEN OLD.\"key\" = 'sku-43' BEGIN SELECT RAISE( ABORT, 'no 43' ); END" );
		$this->assertSame( [], $arm->delete_multi( [ 'sku-41', 'sku-43' ] ) );
		$this->assertMatchesRegularExpression( '/no 43$/', $arm->last_failure() );
		$this->assertSame( [ 'sku-41', 'sku-43' ], ( new \PDO( 'sqlite:' . $this->path() ) )->query( 'SELECT "key" FROM kv ORDER BY "key"' )->fetchAll( \PDO::FETCH_COLUMN ), 'sku-41 rolled back with the batch' );
	}
}
