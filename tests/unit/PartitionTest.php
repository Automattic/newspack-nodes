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
}
