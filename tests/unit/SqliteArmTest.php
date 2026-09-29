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
		( new Sqlite_Arm( $this->path() ) )->set( 'sku-41', 1, 0 );
		$this->assertSame( 'wal', ( new \PDO( 'sqlite:' . $this->path() ) )->query( 'PRAGMA journal_mode' )->fetchColumn() );
	}

	public function test_a_write_blocked_past_busy_timeout_fails_and_a_read_still_answers(): void {
		$arm = new Sqlite_Arm( $this->path(), 1 );
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
		new Sqlite_Arm( $this->path() );
	}

	public function test_an_unwritable_tables_dir_refuses_to_build(): void {
		\chmod( $this->dir, 0500 );
		$this->expectException( \RuntimeException::class );
		new Sqlite_Arm( $this->path() );
	}

	public function test_vacuum_shrinks_the_file_after_a_purge(): void {
		$arm   = new Sqlite_Arm( $this->path() );
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
		$arm = new Sqlite_Arm( $this->path(), 1 );
		$arm->set( 'sku-41', 5, 0 );
		$other = new \PDO( 'sqlite:' . $this->path() );
		$other->exec( 'BEGIN IMMEDIATE' );
		try {
			$this->assertFalse( $arm->add( 'sku-43', 1, 0 ) );
			$this->assertFalse( $arm->delete( 'sku-41' ) );
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
		$arm = new Sqlite_Arm( $this->path() );
		$arm->set( 'sku-41', 1, 0 );
		( new \PDO( 'sqlite:' . $this->path() ) )->exec( "INSERT INTO kv ( \"key\", \"value\", expires ) VALUES ( 'sku-99', 'zjunk', 0 )" );
		$this->assertSame( \Newspack_Nodes\Cache_Backend::READ_ERROR, $arm->read( 'sku-99' )['status'] );
		$this->assertSame( [], $arm->read_multi( [ 'sku-41', 'sku-99' ], $failed ) );
		$this->assertTrue( $failed, 'a batch holding one undecodable row fails whole' );
		$this->assertStringContainsString( 'undecodable row', $arm->last_failure() );
		$this->assertSame( [ 'sqlite_error' => 'undecodable row' ], $arm->diagnostic_metadata() );
	}

	public function test_a_failure_inside_a_write_ends_its_transaction(): void {
		$arm = new Sqlite_Arm( $this->path(), 1 );
		( new \PDO( 'sqlite:' . $this->path() ) )->exec( "INSERT INTO kv ( \"key\", \"value\", expires ) VALUES ( 'sku-99', 'zjunk', 0 )" );
		$this->assertFalse( $arm->increment( 'sku-99' ) );
		$this->assertStringContainsString( 'undecodable row', $arm->last_failure() );
		$other = new \PDO( 'sqlite:' . $this->path() );
		$other->exec( 'BEGIN IMMEDIATE' );
		$other->exec( 'ROLLBACK' );
		$this->assertTrue( $arm->set( 'sku-41', 41, 0 ), 'the write lock was released and a new write opens' );
	}

	public function test_the_arm_names_itself_and_an_empty_batch_is_a_write(): void {
		$arm = new Sqlite_Arm( $this->path() );
		$this->assertSame( 'sqlite', $arm->backend_name() );
		$this->assertTrue( $arm->write_multi( [], 777 ) );
	}

	public function test_a_path_that_is_a_directory_refuses_to_build(): void {
		\mkdir( $this->path(), 0700, true );
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'sqlite backend could not open' );
		new Sqlite_Arm( $this->path() );
	}

	public function test_a_row_reads_back_under_whichever_serializer_wrote_it(): void {
		$arm = new Sqlite_Arm( $this->path() );
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
		$arm = new Sqlite_Arm( $this->path(), 1 );
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
		$arm = new Sqlite_Arm( $this->path() );
		Core::$clock = static fn (): float => 1790000000.0;
		$arm->set( 'sku-41', 7, 777 );
		$this->assertSame( 8, $arm->increment( 'sku-41' ) );
		$row = ( new \PDO( 'sqlite:' . $this->path() ) )->query( 'SELECT typeof( "value" ), expires FROM kv' )->fetch( \PDO::FETCH_NUM );
		$this->assertSame( [ 'blob', 1790000777 ], $row );
	}

	private function checkpoint(): void {
		( new \PDO( 'sqlite:' . $this->path() ) )->query( 'PRAGMA wal_checkpoint(TRUNCATE)' )->fetchAll();
	}

	private function footprint(): int {
		\clearstatcache();
		return \filesize( $this->path() ) + ( \is_file( $this->path() . '-wal' ) ? \filesize( $this->path() . '-wal' ) : 0 );
	}
}
