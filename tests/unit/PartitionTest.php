<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Partition;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Partition::class )]
class PartitionTest extends TestCase {
	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		$this->tmp = $this->make_temp_dir();
	}

	protected function tearDown(): void {
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	private function rmdir_recursive( string $dir ): void {
		if ( ! is_dir( $dir ) ) return;
		foreach ( scandir( $dir ) as $f ) {
			if ( $f === '.' || $f === '..' ) continue;
			$path = "$dir/$f";
			is_dir( $path ) ? $this->rmdir_recursive( $path ) : @unlink( $path );
		}
		@rmdir( $dir );
	}

	public function test_constructor_does_not_create_partition_dir(): void {
		new Partition( $this->tmp, 0, 64*1024, 4, 86400 );
		$this->assertFalse( is_dir( "{$this->tmp}/p0" ), 'Constructor must not eager-create partition dir' );
	}

	public function test_constructor_does_not_open_files(): void {
		new Partition( $this->tmp, 0, 64*1024, 4, 86400 );
		$this->assertFalse( file_exists( "{$this->tmp}/p0/0.log" ) );
	}

	public function test_partition_index_zero_in_path(): void {
		$p = new Partition( $this->tmp, 0, 64*1024, 4, 86400 );
		$this->assertSame( "{$this->tmp}/p0", $p->partition_dir() );
	}

	public function test_partition_index_nonzero_in_path(): void {
		$p = new Partition( $this->tmp, 3, 64*1024, 4, 86400 );
		$this->assertSame( "{$this->tmp}/p3", $p->partition_dir() );
	}

	public function test_get_segment_path_throws_on_negative(): void {
		$p = new Partition( $this->tmp, 0, 64*1024, 4, 86400 );
		$this->expectException( \InvalidArgumentException::class );
		$p->get_segment_path( -1 );
	}

	public function test_hash_to_partition_uses_crc32_with_query_strip(): void {
		$h1 = Partition::hash_to_partition( '/foo', 4 );
		$h2 = Partition::hash_to_partition( '/foo?bar=1', 4 );
		$this->assertSame( $h1, $h2 );
		$this->assertGreaterThanOrEqual( 0, $h1 );
		$this->assertLessThan( 4, $h1 );
	}

	public function test_first_write_creates_partition_dir_and_segment(): void {
		$p = new Partition( $this->tmp, 0, 64*1024, 4, 86400 );
		$result = $p->write( "hello\n" );
		$this->assertTrue( $result );
		$this->assertTrue( is_dir( "{$this->tmp}/p0" ) );
		$this->assertSame( "hello\n", file_get_contents( "{$this->tmp}/p0/0.log" ) );
	}

	public function test_write_appends_to_segment(): void {
		$p = new Partition( $this->tmp, 0, 64*1024, 4, 86400 );
		$p->write( "first\n" );
		$p->write( "second\n" );
		$this->assertSame( "first\nsecond\n", file_get_contents( "{$this->tmp}/p0/0.log" ) );
	}

	public function test_write_writes_index_entry(): void {
		$p = new Partition( $this->tmp, 0, 64*1024, 4, 86400 );
		$p->write( "hello\n" );
		$idx = file_get_contents( "{$this->tmp}/p0/0.idx" );
		$this->assertSame( 8, strlen( $idx ) );
		[ , $seg, $off ] = unpack( 'N2', $idx );
		$this->assertSame( 0, $seg );
		$this->assertSame( 0, $off );
	}

	public function test_write_drops_lines_exceeding_MAX_LINE_SIZE(): void {
		$p = new Partition( $this->tmp, 0, 64*1024, 4, 86400 );
		$big = str_repeat( 'x', 5000 ) . "\n";
		$result = $p->write( $big );
		$this->assertFalse( $result );
		$this->assertFalse( file_exists( "{$this->tmp}/p0/0.log" ) );
	}

	public function test_allow_large_writes_lifts_limit_to_10MB(): void {
		$p = new Partition( $this->tmp, 0, 64*1024, 4, 86400 );
		$p->allow_large_writes();
		$big = str_repeat( 'x', 5000 ) . "\n";
		$result = $p->write( $big );
		$this->assertTrue( $result );
	}

	public function test_read_at_returns_bytes_at_offset(): void {
		$p = new Partition( $this->tmp, 0, 64*1024, 4, 86400 );
		$p->write( "hello\n" );
		$p->write( "world\n" );

		$bytes = $p->read_at( 0, 0, 6 );
		$this->assertSame( "hello\n", $bytes );

		$bytes = $p->read_at( 0, 6, 6 );
		$this->assertSame( "world\n", $bytes );
	}

	public function test_scan_index_visits_each_entry(): void {
		$p = new Partition( $this->tmp, 0, 64*1024, 4, 86400 );
		$p->write( "a\n" );
		$p->write( "bb\n" );
		$p->write( "ccc\n" );

		$entries = [];
		$p->scan_index( function ( int $seg, int $off ) use ( &$entries ) {
			$entries[] = [ $seg, $off ];
			return null;
		} );

		$this->assertSame( [ [ 0, 0 ], [ 0, 2 ], [ 0, 5 ] ], $entries );
	}

	public function test_rotation_when_segment_size_exceeded(): void {
		$p = new Partition( $this->tmp, 0, 1024, 4, 86400 );
		$line = str_repeat( 'x', 100 ) . "\n";
		for ( $i = 0; $i < 15; ++$i ) {
			$p->write( $line );
		}
		$segments = $p->get_segments( true );
		$this->assertGreaterThan( 1, count( $segments ) );
	}

	public function test_cleanup_AND_gated_retention(): void {
		$p = new Partition( $this->tmp, 0, 256, 2, 86400 );
		$line = str_repeat( 'x', 100 ) . "\n";
		for ( $i = 0; $i < 10; ++$i ) {
			$p->write( $line );
		}
		$p->cleanup_segments();
		$segments = $p->get_segments( true );
		$this->assertGreaterThan( 2, count( $segments ), 'count > num_segments alone is not enough; mtime gate must also fire' );
	}

	public function test_cleanup_deletes_when_both_count_and_age_exceeded(): void {
		$p = new Partition( $this->tmp, 0, 256, 2, 0 );
		$line = str_repeat( 'x', 100 ) . "\n";
		for ( $i = 0; $i < 10; ++$i ) {
			$p->write( $line );
		}
		$p->cleanup_segments();
		$segments = $p->get_segments( true );
		$this->assertLessThanOrEqual( 2, count( $segments ) );
	}
}
