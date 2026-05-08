<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Partition;
use Newspack_Nodes\Tests\CaptureSink;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Topic;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Topic::class )]
class TopicTest extends TestCase {
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

	public function test_constructor_does_not_create_partitions(): void {
		new Topic( "{$this->tmp}/firehose.log", 4, 64*1024, 4, 86400 );
		$this->assertFalse( is_dir( "{$this->tmp}/firehose.log/p0" ) );
	}

	public function test_class_api_write_routes_by_key(): void {
		$t = new Topic( "{$this->tmp}/firehose.log", 4, 64*1024, 4, 86400 );
		$t->write( '/url1', "data\n" );

		// Key routing is deterministic; whichever partition got it must contain the data.
		$found = false;
		for ( $i = 0; $i < 4; ++$i ) {
			$path = "{$this->tmp}/firehose.log/p{$i}/0.log";
			if ( file_exists( $path ) && file_get_contents( $path ) === "data\n" ) {
				$found = true;
				break;
			}
		}
		$this->assertTrue( $found );
	}

	public function test_same_key_routes_to_same_partition(): void {
		$t = new Topic( "{$this->tmp}/firehose.log", 4, 64*1024, 4, 86400 );
		$t->write( '/url1', "first\n" );
		$t->write( '/url1', "second\n" );

		// Find the partition that has data; it must contain both lines.
		for ( $i = 0; $i < 4; ++$i ) {
			$path = "{$this->tmp}/firehose.log/p{$i}/0.log";
			if ( file_exists( $path ) ) {
				$this->assertSame( "first\nsecond\n", file_get_contents( $path ) );
				return;
			}
		}
		$this->fail( 'No data written to any partition' );
	}

	public function test_node_fill_TM_BYTESTREAM_routes_by_KEY(): void {
		$t = new Topic( "{$this->tmp}/firehose.log", 4, 64*1024, 4, 86400 );

		$msg = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$msg[ Message::KEY ]   = '/some/url';
		$msg[ Message::VALUE ] = "fill-data\n";
		$t->fill( $msg );

		$expected_partition = Partition::hash_to_partition( '/some/url', 4 );
		$path = "{$this->tmp}/firehose.log/p{$expected_partition}/0.log";
		$this->assertSame( "fill-data\n", file_get_contents( $path ) );
	}

	public function test_pre_declares_READY_event(): void {
		$t = new Topic( "{$this->tmp}/firehose.log", 4, 64*1024, 4, 86400 );
		$t->name( 'firehose' );
		// Should not throw — event is pre-declared.
		$t->register( 'READY', 'cb', function () {} );
		$this->assertTrue( true );
	}
}
