<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Consumer;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Partition;
use Newspack_Nodes\Tests\CaptureSink;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Consumer::class )]
class ConsumerTest extends TestCase {
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

	public function test_poll_emits_line_for_each_new_log_entry(): void {
		$source = new Partition( "{$this->tmp}/data", 0, 64*1024, 4, 86400 );
		$source->write( "first\n" );
		$source->write( "second\n" );

		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$capture = new CaptureSink();
		$c->sink( $capture );

		$c->poll();

		$this->assertCount( 2, $capture->captured );
		$this->assertSame( 'first',  trim( $capture->captured[0][ Message::VALUE ] ) );
		$this->assertSame( 'second', trim( $capture->captured[1][ Message::VALUE ] ) );
	}

	public function test_poll_does_not_re_emit_old_lines_on_second_call(): void {
		$source = new Partition( "{$this->tmp}/data", 0, 64*1024, 4, 86400 );
		$source->write( "first\n" );

		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$capture = new CaptureSink();
		$c->sink( $capture );

		$c->poll();
		$this->assertCount( 1, $capture->captured );

		$c->poll();
		$this->assertCount( 1, $capture->captured );

		$source->write( "second\n" );
		$c->poll();
		$this->assertCount( 2, $capture->captured );
	}

	public function test_checkpoint_writes_offsetlog_entry(): void {
		$source = new Partition( "{$this->tmp}/data", 0, 64*1024, 4, 86400 );
		$source->write( "hello\n" );

		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$c->poll();
		$c->checkpoint();

		$offsetlog_path = "{$this->tmp}/offsets/r/p0/p0/0.log";
		$this->assertTrue( file_exists( $offsetlog_path ), 'Offsetlog must exist after checkpoint' );
		$content = file_get_contents( $offsetlog_path );
		$this->assertStringContainsString( '"seg":0', $content );
		$this->assertStringContainsString( '"off":6', $content );
	}

	public function test_restart_resumes_from_last_checkpoint(): void {
		$source = new Partition( "{$this->tmp}/data", 0, 64*1024, 4, 86400 );
		$source->write( "first\n" );

		$c1 = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$cap1 = new CaptureSink();
		$c1->sink( $cap1 );
		$c1->poll();
		$c1->checkpoint();
		unset( $c1 );

		$source->write( "second\n" );

		$c2 = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$cap2 = new CaptureSink();
		$c2->sink( $cap2 );
		$c2->poll();

		$this->assertCount( 1, $cap2->captured );
		$this->assertSame( 'second', trim( $cap2->captured[0][ Message::VALUE ] ) );
	}
}
