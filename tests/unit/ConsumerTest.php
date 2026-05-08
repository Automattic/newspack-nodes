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

	// ============================================================================
	// Hardening: cross-poll partial-line accumulation.
	// ============================================================================

	public function test_partial_line_carries_across_polls(): void {
		// Simulate a writer that writes a line in two halves.
		// Use raw fwrite to bypass write()'s atomic-line semantics.
		mkdir( "{$this->tmp}/data/p0", 0755, true );
		file_put_contents( "{$this->tmp}/data/p0/0.log", "fir" );

		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$cap = new CaptureSink();
		$c->sink( $cap );

		$c->poll();
		// No complete line yet — should emit nothing.
		$this->assertCount( 0, $cap->captured, 'partial line must NOT be emitted on first poll' );

		// Append the rest of the line.
		file_put_contents( "{$this->tmp}/data/p0/0.log", "st\n", FILE_APPEND );
		$c->poll();

		$this->assertCount( 1, $cap->captured, 'completed line must emit on second poll' );
		$this->assertSame( "first\n", $cap->captured[0][ Message::VALUE ] );
		// Cursor should be 6 bytes (length of "first\n").
		$this->assertSame( '0:0', $cap->captured[0][ Message::KEY ] );
	}

	public function test_partial_line_does_not_double_emit_bytes(): void {
		// Writer writes 1 byte at a time across multiple polls.
		mkdir( "{$this->tmp}/data/p0", 0755, true );
		file_put_contents( "{$this->tmp}/data/p0/0.log", '' );

		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$cap = new CaptureSink();
		$c->sink( $cap );

		$letters = [ 'h', 'e', 'l', 'l', 'o', "\n" ];
		foreach ( $letters as $ch ) {
			file_put_contents( "{$this->tmp}/data/p0/0.log", $ch, FILE_APPEND );
			$c->poll();
		}

		$this->assertCount( 1, $cap->captured, 'each byte must accumulate into single emit' );
		$this->assertSame( "hello\n", $cap->captured[0][ Message::VALUE ] );
	}

	// ============================================================================
	// Hardening: MAX_LINE_BUFFER_SIZE DoS guard.
	// ============================================================================

	public function test_MAX_LINE_BUFFER_SIZE_constant_defined(): void {
		$this->assertSame( 20971520, Consumer::MAX_LINE_BUFFER_SIZE );
	}

	public function test_oversized_line_buffer_is_bounded_by_guard(): void {
		// Defensive test: write a multi-MB stream with no newlines and verify line_remainder
		// stays bounded by MAX_LINE_BUFFER_SIZE. Skip on tight memory_limit since this needs
		// ~20MB of resident memory across polls.
		$limit = ini_get( 'memory_limit' );
		if ( $limit && '-1' !== $limit ) {
			$mem_bytes = (int) preg_replace_callback(
				'/(\d+)([KMG]?)/i',
				static function ( $m ) {
					$mult = [ '' => 1, 'K' => 1024, 'M' => 1048576, 'G' => 1073741824 ];
					return (int) $m[1] * $mult[ strtoupper( $m[2] ) ];
				},
				$limit
			);
			if ( $mem_bytes > 0 && $mem_bytes < 192 * 1048576 ) {
				$this->markTestSkipped( 'memory_limit too low for 20MB buffer test (need >= 192M)' );
				return;
			}
		}

		mkdir( "{$this->tmp}/data/p0", 0755, true );
		// Stream 21MB (no newlines) via per-MB chunks to keep per-allocation small.
		$fh    = fopen( "{$this->tmp}/data/p0/0.log", 'wb' );
		$chunk = str_repeat( 'x', 1048576 );
		for ( $i = 0; $i < 21; ++$i ) {
			fwrite( $fh, $chunk );
		}
		fclose( $fh );
		unset( $chunk );

		$c   = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$cap = new CaptureSink();
		$c->sink( $cap );

		// Drive the consumer through several polls. Each poll appends up to MAX_READ_SIZE (10MB)
		// to line_remainder. After enough polls the 20MB cap MUST kick in via the discard branch.
		for ( $i = 0; $i < 5; ++$i ) {
			$c->poll();
		}

		$ref = new \ReflectionClass( $c );
		$rem_prop = $ref->getProperty( 'line_remainder' );
		$rem_prop->setAccessible( true );
		$rem_after = $rem_prop->getValue( $c );
		$this->assertLessThanOrEqual(
			Consumer::MAX_LINE_BUFFER_SIZE,
			\strlen( $rem_after ),
			'line_remainder must never exceed MAX_LINE_BUFFER_SIZE'
		);
		// No newlines means no emission, regardless of how much was discarded.
		$this->assertCount( 0, $cap->captured );
	}

	// ============================================================================
	// Hardening: is_caught_up.
	// ============================================================================

	public function test_is_caught_up_initially_true_with_no_segments(): void {
		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$this->assertTrue( $c->is_caught_up(), 'no segments means trivially caught up' );
	}

	public function test_is_caught_up_false_when_unread_data(): void {
		$source = new Partition( "{$this->tmp}/data", 0, 64*1024, 4, 86400 );
		$source->write( "hello\n" );

		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		// Without polling, we're not caught up (cursor_off=0, segment size=6).
		// at_eof default is true but is_caught_up checks tail position too. After at least one
		// poll we want it to reflect actual state.
		$c->poll();
		$this->assertTrue( $c->is_caught_up(), 'after polling all bytes, must be caught up' );

		$source->write( "more\n" );
		// Drain the cache so is_caught_up sees fresh size.
		\clearstatcache();
		$this->assertFalse( $c->is_caught_up(), 'new bytes appearing must un-catch-up the reader' );
	}

	public function test_is_caught_up_true_after_polling_to_end(): void {
		$source = new Partition( "{$this->tmp}/data", 0, 64*1024, 4, 86400 );
		$source->write( "a\n" );
		$source->write( "b\n" );

		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$c->poll();
		$this->assertTrue( $c->is_caught_up() );
	}

	// ============================================================================
	// Hardening: mark_eof.
	// ============================================================================

	public function test_mark_eof_sets_at_eof(): void {
		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$ref = new \ReflectionClass( $c );
		$prop = $ref->getProperty( 'at_eof' );
		$prop->setAccessible( true );
		$prop->setValue( $c, false );
		$c->mark_eof();
		$this->assertTrue( $prop->getValue( $c ) );
	}

	// ============================================================================
	// Hardening: update_offset.
	// ============================================================================

	public function test_update_offset_advances_cursor(): void {
		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$ref = new \ReflectionClass( $c );
		$prop = $ref->getProperty( 'cursor_off' );
		$prop->setAccessible( true );

		$prop->setValue( $c, 5 );
		$c->update_offset( 10 );
		$this->assertSame( 15, $prop->getValue( $c ) );
	}

	public function test_update_offset_ignores_negative(): void {
		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$ref = new \ReflectionClass( $c );
		$prop = $ref->getProperty( 'cursor_off' );
		$prop->setAccessible( true );
		$prop->setValue( $c, 5 );
		$c->update_offset( -3 );
		$this->assertSame( 5, $prop->getValue( $c ) );
	}

	// ============================================================================
	// Hardening: open() segment-deleted recovery.
	// ============================================================================

	public function test_open_jumps_to_oldest_when_cursor_segment_deleted(): void {
		// Set up a source with multiple segments, position cursor past the oldest, then delete it.
		$source = new Partition( "{$this->tmp}/data", 0, 32, 2, 0 );
		// Force several rotations.
		for ( $i = 0; $i < 6; $i++ ) {
			$source->write( str_repeat( chr( 97 + $i ), 30 ) . "\n" );
		}
		// cleanup_segments may have already pruned the oldest (num_segments=2, max_lifespan=0).

		// Manually nuke whatever segment 0 still exists if it does.
		@unlink( "{$this->tmp}/data/p0/0.log" );
		@unlink( "{$this->tmp}/data/p0/0.idx" );

		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		// Force cursor to a deleted segment id (0).
		$ref = new \ReflectionClass( $c );
		$seg_prop = $ref->getProperty( 'cursor_seg' );
		$seg_prop->setAccessible( true );
		$seg_prop->setValue( $c, 0 );
		$off_prop = $ref->getProperty( 'cursor_off' );
		$off_prop->setAccessible( true );
		$off_prop->setValue( $c, 100 );

		$result = $c->open();
		$this->assertNotNull( $result );
		// Cursor should have moved to oldest available segment (not 0).
		$this->assertNotSame( 0, $seg_prop->getValue( $c ) );
		$this->assertSame( 0, $off_prop->getValue( $c ), 'cursor_off must reset to 0 on jump' );
	}

	// ============================================================================
	// Hardening: next_offset 'end' (tail seek for fresh-tail SSE readers).
	// ============================================================================

	public function test_next_offset_end_seeks_to_tail(): void {
		$source = new Partition( "{$this->tmp}/data", 0, 64*1024, 4, 86400 );
		$source->write( "old1\n" );
		$source->write( "old2\n" );

		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$cap = new CaptureSink();
		$c->sink( $cap );

		$c->next_offset( 'end' ); // Skip past existing data.
		$c->poll();
		$this->assertCount( 0, $cap->captured, 'end-seek must skip pre-existing lines' );

		$source->write( "new1\n" );
		$c->poll();
		$this->assertCount( 1, $cap->captured );
		$this->assertSame( "new1\n", $cap->captured[0][ Message::VALUE ] );
	}

	public function test_next_offset_start_resets_to_zero(): void {
		$source = new Partition( "{$this->tmp}/data", 0, 64*1024, 4, 86400 );
		$source->write( "alpha\n" );

		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$cap = new CaptureSink();
		$c->sink( $cap );

		$c->next_offset( 'end' );
		$c->next_offset( 'start' );
		$c->poll();

		$this->assertCount( 1, $cap->captured );
		$this->assertSame( "alpha\n", $cap->captured[0][ Message::VALUE ] );
	}

	public function test_next_offset_recent_picks_second_to_last_segment(): void {
		// Force several segments.
		$source = new Partition( "{$this->tmp}/data", 0, 32, 4, 86400 );
		$source->write( str_repeat( 'a', 30 ) . "\n" );
		$source->write( str_repeat( 'b', 30 ) . "\n" );
		$source->write( str_repeat( 'c', 30 ) . "\n" );

		$segments = $source->get_segments( true );
		$count = count( $segments );
		$this->assertGreaterThanOrEqual( 2, $count );

		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$c->next_offset( 'recent' );

		$ref = new \ReflectionClass( $c );
		$seg_prop = $ref->getProperty( 'cursor_seg' );
		$seg_prop->setAccessible( true );
		$expected = $segments[ $count - 2 ]['id'];
		$this->assertSame( $expected, $seg_prop->getValue( $c ) );
	}

	public function test_next_offset_explicit_array_position(): void {
		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$c->next_offset( [ 'seg' => 5, 'off' => 100 ] );

		$ref = new \ReflectionClass( $c );
		$seg_prop = $ref->getProperty( 'cursor_seg' );
		$seg_prop->setAccessible( true );
		$off_prop = $ref->getProperty( 'cursor_off' );
		$off_prop->setAccessible( true );
		$this->assertSame( 5, $seg_prop->getValue( $c ) );
		$this->assertSame( 100, $off_prop->getValue( $c ) );
	}
}
