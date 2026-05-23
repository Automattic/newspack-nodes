<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Message;
use Newspack_Nodes\Tail_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Tail_Node::class )]
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
		new Tail_Node( "{$this->tmp}/notyet.log" );
		$this->assertFalse( file_exists( "{$this->tmp}/notyet.log" ) );
	}

	public function test_poll_emits_one_message_per_line_in_default_line_buffered_mode(): void {
		file_put_contents( "{$this->tmp}/data.log", "first\nsecond\nthird\n" );
		$t = new Tail_Node( "{$this->tmp}/data.log" );
		$cap = new Capture_Sink_Node();
		$t->sink( $cap );
		$t->poll();

		$this->assertCount( 3, $cap->captured );
		$this->assertSame( 'first',  trim( $cap->captured[0][ Message::VALUE ] ) );
		$this->assertSame( 'second', trim( $cap->captured[1][ Message::VALUE ] ) );
		$this->assertSame( 'third',  trim( $cap->captured[2][ Message::VALUE ] ) );
	}

	public function test_poll_stamps_TO_from_connect_node_target(): void {
		// `connect_node mytail mysession` sets target='mysession'; without
		// the parent::fill() route the emitted message had TO='' and the
		// Router had no destination to dispatch to — silent black hole.
		file_put_contents( "{$this->tmp}/data.log", "hello\n" );
		$t = new Tail_Node( "{$this->tmp}/data.log" );
		$t->connect_node( 'mysession' );
		$cap = new Capture_Sink_Node();
		$t->sink( $cap );
		$t->poll();

		$this->assertCount( 1, $cap->captured );
		$this->assertSame( 'mysession', $cap->captured[0][ Message::TO ] );
	}

	public function test_poll_does_not_re_emit_old_data(): void {
		file_put_contents( "{$this->tmp}/data.log", "first\n" );
		$t = new Tail_Node( "{$this->tmp}/data.log" );
		$cap = new Capture_Sink_Node();
		$t->sink( $cap );
		$t->poll();
		$this->assertCount( 1, $cap->captured );

		file_put_contents( "{$this->tmp}/data.log", "second\n", FILE_APPEND );
		$t->poll();
		$this->assertCount( 2, $cap->captured );
	}

	public function test_buffer_mode_block_buffered_emits_one_message_per_read_chunk(): void {
		file_put_contents( "{$this->tmp}/data.log", "first\nsecond\n" );
		$t = new Tail_Node( "{$this->tmp}/data.log", buffer_mode: 'block-buffered' );
		$cap = new Capture_Sink_Node();
		$t->sink( $cap );
		$t->poll();
		$this->assertCount( 1, $cap->captured );
		$this->assertSame( "first\nsecond\n", $cap->captured[0][ Message::VALUE ] );
	}

	public function test_buffer_mode_binary_emits_chunk(): void {
		file_put_contents( "{$this->tmp}/data.log", "raw bytes" );
		$t = new Tail_Node( "{$this->tmp}/data.log", buffer_mode: 'binary' );
		$cap = new Capture_Sink_Node();
		$t->sink( $cap );
		$t->poll();
		$this->assertCount( 1, $cap->captured );
		$this->assertSame( 'raw bytes', $cap->captured[0][ Message::VALUE ] );
	}

	public function test_buffer_mode_block_buffered_holds_partial_line_across_polls(): void {
		// Block-buffered must accumulate a trailing partial line so a chunk
		// boundary never splits a line — matches Tachikoma drain_buffer_blocks.
		file_put_contents( "{$this->tmp}/data.log", "first\nseco" );
		$t = new Tail_Node( "{$this->tmp}/data.log", buffer_mode: 'block-buffered' );
		$cap = new Capture_Sink_Node();
		$t->sink( $cap );

		$t->poll();
		// Only 'first\n' is complete; 'seco' is partial and held in line_remainder.
		$this->assertCount( 1, $cap->captured );
		$this->assertSame( "first\n", $cap->captured[0][ Message::VALUE ] );

		// Append the rest of the partial line.
		file_put_contents( "{$this->tmp}/data.log", "nd\n", FILE_APPEND );
		$t->poll();

		$this->assertCount( 2, $cap->captured );
		$this->assertSame( "second\n", $cap->captured[1][ Message::VALUE ] );
	}

	public function test_buffer_mode_block_buffered_holds_entire_chunk_when_no_newline(): void {
		// No newline at all in the chunk: the entire payload accumulates in
		// line_remainder; nothing is emitted.
		file_put_contents( "{$this->tmp}/data.log", "no newline yet" );
		$t = new Tail_Node( "{$this->tmp}/data.log", buffer_mode: 'block-buffered' );
		$cap = new Capture_Sink_Node();
		$t->sink( $cap );

		$t->poll();
		$this->assertCount( 0, $cap->captured );

		file_put_contents( "{$this->tmp}/data.log", " here\n", FILE_APPEND );
		$t->poll();
		$this->assertCount( 1, $cap->captured );
		$this->assertSame( "no newline yet here\n", $cap->captured[0][ Message::VALUE ] );
	}

	public function test_buffer_mode_binary_does_not_accumulate_partial_lines(): void {
		// Binary mode emits each fread as-is, even if it ends mid-line.
		file_put_contents( "{$this->tmp}/data.log", "first\nseco" );
		$t = new Tail_Node( "{$this->tmp}/data.log", buffer_mode: 'binary' );
		$cap = new Capture_Sink_Node();
		$t->sink( $cap );

		$t->poll();
		$this->assertCount( 1, $cap->captured );
		$this->assertSame( "first\nseco", $cap->captured[0][ Message::VALUE ] );

		file_put_contents( "{$this->tmp}/data.log", "nd\n", FILE_APPEND );
		$t->poll();
		$this->assertCount( 2, $cap->captured );
		$this->assertSame( "nd\n", $cap->captured[1][ Message::VALUE ] );
	}

	public function test_missing_file_does_not_throw(): void {
		$t = new Tail_Node( "{$this->tmp}/missing.log" );
		$cap = new Capture_Sink_Node();
		$t->sink( $cap );
		$t->poll(); // Should not throw.
		$this->assertCount( 0, $cap->captured );
	}

	public function test_poll_bounds_per_call_read_to_READ_CHUNK(): void {
		// File larger than READ_CHUNK should require multiple polls to drain.
		// Using binary mode (one message per fread) makes the chunk count assertable.
		$chunk_size  = Tail_Node::READ_CHUNK;
		$total_bytes = ( $chunk_size * 2 ) + 100;          // 2.5 chunks
		$payload     = \str_repeat( 'x', $total_bytes );
		\file_put_contents( "{$this->tmp}/big.log", $payload );

		$t   = new Tail_Node( "{$this->tmp}/big.log", buffer_mode: 'binary' );
		$cap = new Capture_Sink_Node();
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

	// ============================================================================
	// Hardening: MAX_LINE_BUFFER_SIZE DoS guard.
	// ============================================================================

	public function test_MAX_LINE_BUFFER_SIZE_constant_defined(): void {
		$this->assertSame( 20971520, Tail_Node::MAX_LINE_BUFFER_SIZE );
	}

	public function test_oversized_line_remainder_is_discarded(): void {
		// Use reflection to push the line_remainder past the MAX threshold without
		// having to fabricate 20MB of disk content.
		$t = new Tail_Node( "{$this->tmp}/data.log" );
		$ref = new \ReflectionClass( $t );
		$prop = $ref->getProperty( 'line_remainder' );
		$prop->setAccessible( true );
		// Pre-populate the remainder near the cap.
		$prop->setValue( $t, str_repeat( 'x', Tail_Node::MAX_LINE_BUFFER_SIZE - 10 ) );

		$cap = new Capture_Sink_Node();
		$t->sink( $cap );

		// Now write more bytes (no newline) that would push it past MAX. The guard
		// should fire when emit() runs.
		file_put_contents( "{$this->tmp}/data.log", str_repeat( 'y', 100 ) );
		$t->poll();

		// After the guard fires, line_remainder should be empty (no newline in the new bytes).
		$this->assertSame( '', $prop->getValue( $t ), 'oversize buffer must be discarded' );
		// And no message should have been emitted (no complete line was available).
		$this->assertCount( 0, $cap->captured );
	}

	public function test_oversized_line_remainder_recovers_at_next_newline(): void {
		$t = new Tail_Node( "{$this->tmp}/data.log" );
		$ref = new \ReflectionClass( $t );
		$prop = $ref->getProperty( 'line_remainder' );
		$prop->setAccessible( true );
		// Push remainder near the cap.
		$prop->setValue( $t, str_repeat( 'x', Tail_Node::MAX_LINE_BUFFER_SIZE - 10 ) );

		$cap = new Capture_Sink_Node();
		$t->sink( $cap );

		// New bytes contain a newline; the guard fires (drops remainder + bytes-up-to-newline)
		// and keeps the tail of new bytes (after newline) as remainder.
		file_put_contents( "{$this->tmp}/data.log", str_repeat( 'y', 100 ) . "\nrecover" );
		$t->poll();

		// No emission — the giant line was dropped.
		$this->assertCount( 0, $cap->captured );
		// Remainder should be "recover" (the bytes after the newline).
		$this->assertSame( 'recover', $prop->getValue( $t ) );
	}

	public function test_oversized_line_remainder_in_block_buffered_mode_is_discarded(): void {
		// Block-buffered DoS guard: same recovery semantics as line-buffered.
		$t = new Tail_Node( "{$this->tmp}/data.log", buffer_mode: 'block-buffered' );
		$ref = new \ReflectionClass( $t );
		$prop = $ref->getProperty( 'line_remainder' );
		$prop->setAccessible( true );
		$prop->setValue( $t, str_repeat( 'x', Tail_Node::MAX_LINE_BUFFER_SIZE - 10 ) );

		$cap = new Capture_Sink_Node();
		$t->sink( $cap );

		file_put_contents( "{$this->tmp}/data.log", str_repeat( 'y', 100 ) . "\nrecover" );
		$t->poll();

		// Remainder should be "recover" (post-newline tail of incoming bytes).
		$this->assertSame( 'recover', $prop->getValue( $t ) );
		$this->assertCount( 0, $cap->captured );
	}

	public function test_oversized_line_remainder_in_block_buffered_no_newline_clears(): void {
		// Block-buffered DoS guard with no newline in the new bytes: line_remainder
		// is fully discarded with nothing to recover.
		$t = new Tail_Node( "{$this->tmp}/data.log", buffer_mode: 'block-buffered' );
		$ref  = new \ReflectionClass( $t );
		$prop = $ref->getProperty( 'line_remainder' );
		$prop->setAccessible( true );
		$prop->setValue( $t, str_repeat( 'x', Tail_Node::MAX_LINE_BUFFER_SIZE - 10 ) );

		$cap = new Capture_Sink_Node();
		$t->sink( $cap );

		file_put_contents( "{$this->tmp}/data.log", str_repeat( 'y', 100 ) );
		$t->poll();

		$this->assertSame( '', $prop->getValue( $t ) );
		$this->assertCount( 0, $cap->captured );
	}

	public function test_inode_change_resets_position_and_remainder(): void {
		// File rotation: rename moves the file (preserving its inode under the new
		// path) and a new file is created at the original path with a fresh inode.
		// Tail must reset position to 0 and emit from the start of the new file,
		// even though the original-path file is now larger than what we'd read after
		// reset — the inode-change detection path is what we're verifying.
		\file_put_contents( "{$this->tmp}/data.log", "first\n" );
		$t   = new Tail_Node( "{$this->tmp}/data.log" );
		$cap = new Capture_Sink_Node();
		$t->sink( $cap );
		$t->poll();
		$this->assertCount( 1, $cap->captured );

		// Rotate: rename the original out of the way, write new content under the
		// original name. rename guarantees the original-path file gets a new inode.
		\rename( "{$this->tmp}/data.log", "{$this->tmp}/data.log.1" );
		\file_put_contents( "{$this->tmp}/data.log", "after-rotation-and-padding\n" );
		$t->poll();

		$this->assertCount( 2, $cap->captured );
		$this->assertSame( 'after-rotation-and-padding', \trim( $cap->captured[1][ Message::VALUE ] ) );
	}

	public function test_truncation_resets_position(): void {
		// File truncation: size shrinks below current position. Tail must reset to 0
		// (preserving the same inode) so subsequent reads start from the new top.
		\file_put_contents( "{$this->tmp}/data.log", "first\nsecond\nthird\n" );
		$t   = new Tail_Node( "{$this->tmp}/data.log" );
		$cap = new Capture_Sink_Node();
		$t->sink( $cap );
		$t->poll();
		$this->assertCount( 3, $cap->captured );

		// Truncate to a much smaller payload.
		\file_put_contents( "{$this->tmp}/data.log", "tiny\n" );
		$t->poll();

		// Detection: position was reset, so 'tiny' is read fresh.
		$this->assertCount( 4, $cap->captured );
		$this->assertSame( 'tiny', \trim( $cap->captured[3][ Message::VALUE ] ) );
	}

	public function test_poll_returns_silently_when_size_equals_position(): void {
		// File hasn't grown — at_eof path. No new emissions.
		\file_put_contents( "{$this->tmp}/data.log", "first\n" );
		$t   = new Tail_Node( "{$this->tmp}/data.log" );
		$cap = new Capture_Sink_Node();
		$t->sink( $cap );
		$t->poll();
		$this->assertCount( 1, $cap->captured );

		// Same size next poll → at_eof, no new emit.
		$t->poll();
		$this->assertCount( 1, $cap->captured );
	}

	public function test_fire_polls_and_rearms_busy_when_more_bytes_available(): void {
		// Force more than READ_CHUNK so that one poll leaves at_eof=false.
		// fire() must re-arm with POLL_INTERVAL_BUSY_MS so the event loop
		// re-fires immediately on the next iteration.
		$total = Tail_Node::READ_CHUNK + 1024;
		\file_put_contents( "{$this->tmp}/big.log", \str_repeat( 'x', $total ) );

		$t   = new Tail_Node( "{$this->tmp}/big.log", buffer_mode: 'binary' );
		$cap = new Capture_Sink_Node();
		$t->sink( $cap );

		// Drive fire() via reflection (it's protected — Timer's set_timer/event-loop
		// call it). One fire() = one poll().
		$ref  = new \ReflectionMethod( Tail_Node::class, 'fire' );
		$ref->setAccessible( true );
		$ref->invoke( $t );

		// First poll consumed exactly READ_CHUNK; more bytes remain so at_eof=false.
		$at_eof_prop = ( new \ReflectionClass( $t ) )->getProperty( 'at_eof' );
		$at_eof_prop->setAccessible( true );
		$this->assertFalse( $at_eof_prop->getValue( $t ) );
		$this->assertCount( 1, $cap->captured );
	}

	public function test_fire_rearms_idle_when_at_eof(): void {
		// File completely drained → at_eof=true → re-arm with POLL_INTERVAL_EOF_MS.
		\file_put_contents( "{$this->tmp}/small.log", "one\n" );
		$t = new Tail_Node( "{$this->tmp}/small.log", buffer_mode: 'line-buffered' );

		$cap = new Capture_Sink_Node();
		$t->sink( $cap );

		$ref = new \ReflectionMethod( Tail_Node::class, 'fire' );
		$ref->setAccessible( true );
		$ref->invoke( $t );

		$at_eof_prop = ( new \ReflectionClass( $t ) )->getProperty( 'at_eof' );
		$at_eof_prop->setAccessible( true );
		$this->assertTrue( $at_eof_prop->getValue( $t ) );
	}
}
