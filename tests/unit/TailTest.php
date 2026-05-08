<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Message;
use Newspack_Nodes\Tail;
use Newspack_Nodes\Tests\CaptureSink;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Tail::class )]
class TailTest extends TestCase {
	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		$this->tmp = $this->make_temp_dir();
	}

	protected function tearDown(): void {
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	public function test_constructor_does_not_open_file(): void {
		new Tail( "{$this->tmp}/notyet.log" );
		$this->assertFalse( file_exists( "{$this->tmp}/notyet.log" ) );
	}

	public function test_poll_emits_one_message_per_line_in_default_line_buffered_mode(): void {
		file_put_contents( "{$this->tmp}/data.log", "first\nsecond\nthird\n" );
		$t = new Tail( "{$this->tmp}/data.log" );
		$cap = new CaptureSink();
		$t->sink( $cap );
		$t->poll();

		$this->assertCount( 3, $cap->captured );
		$this->assertSame( 'first',  trim( $cap->captured[0][ Message::VALUE ] ) );
		$this->assertSame( 'second', trim( $cap->captured[1][ Message::VALUE ] ) );
		$this->assertSame( 'third',  trim( $cap->captured[2][ Message::VALUE ] ) );
	}

	public function test_poll_does_not_re_emit_old_data(): void {
		file_put_contents( "{$this->tmp}/data.log", "first\n" );
		$t = new Tail( "{$this->tmp}/data.log" );
		$cap = new CaptureSink();
		$t->sink( $cap );
		$t->poll();
		$this->assertCount( 1, $cap->captured );

		file_put_contents( "{$this->tmp}/data.log", "second\n", FILE_APPEND );
		$t->poll();
		$this->assertCount( 2, $cap->captured );
	}

	public function test_buffer_mode_block_buffered_emits_one_message_per_read_chunk(): void {
		file_put_contents( "{$this->tmp}/data.log", "first\nsecond\n" );
		$t = new Tail( "{$this->tmp}/data.log", buffer_mode: 'block-buffered' );
		$cap = new CaptureSink();
		$t->sink( $cap );
		$t->poll();
		$this->assertCount( 1, $cap->captured );
		$this->assertSame( "first\nsecond\n", $cap->captured[0][ Message::VALUE ] );
	}

	public function test_buffer_mode_binary_emits_chunk(): void {
		file_put_contents( "{$this->tmp}/data.log", "raw bytes" );
		$t = new Tail( "{$this->tmp}/data.log", buffer_mode: 'binary' );
		$cap = new CaptureSink();
		$t->sink( $cap );
		$t->poll();
		$this->assertCount( 1, $cap->captured );
		$this->assertSame( 'raw bytes', $cap->captured[0][ Message::VALUE ] );
	}

	public function test_missing_file_does_not_throw(): void {
		$t = new Tail( "{$this->tmp}/missing.log" );
		$cap = new CaptureSink();
		$t->sink( $cap );
		$t->poll(); // Should not throw.
		$this->assertCount( 0, $cap->captured );
	}

	public function test_poll_bounds_per_call_read_to_READ_CHUNK(): void {
		// File larger than READ_CHUNK should require multiple polls to drain.
		// Using binary mode (one message per fread) makes the chunk count assertable.
		$chunk_size  = Tail::READ_CHUNK;
		$total_bytes = ( $chunk_size * 2 ) + 100;          // 2.5 chunks
		$payload     = \str_repeat( 'x', $total_bytes );
		\file_put_contents( "{$this->tmp}/big.log", $payload );

		$t   = new Tail( "{$this->tmp}/big.log", buffer_mode: 'binary' );
		$cap = new CaptureSink();
		$t->sink( $cap );

		// First poll: exactly READ_CHUNK bytes.
		$t->poll();
		$this->assertCount( 1, $cap->captured );
		$this->assertSame( $chunk_size, \strlen( $cap->captured[0][ Message::VALUE ] ) );

		// Second poll: another READ_CHUNK.
		$t->poll();
		$this->assertCount( 2, $cap->captured );
		$this->assertSame( $chunk_size, \strlen( $cap->captured[1][ Message::VALUE ] ) );

		// Third poll: only the trailing 100 bytes remain.
		$t->poll();
		$this->assertCount( 3, $cap->captured );
		$this->assertSame( 100, \strlen( $cap->captured[2][ Message::VALUE ] ) );

		// Fourth poll: nothing new.
		$t->poll();
		$this->assertCount( 3, $cap->captured );
	}
}
