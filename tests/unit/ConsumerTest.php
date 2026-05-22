<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Consumer;
use Newspack_Nodes\Core;
use Newspack_Nodes\EventFramework;
use Newspack_Nodes\Message;
use Newspack_Nodes\Partition;
use Newspack_Nodes\Tests\CaptureSink;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\PreserveGlobalState;
use PHPUnit\Framework\Attributes\RunInSeparateProcess;

#[CoversClass( Consumer::class )]
class ConsumerTest extends TestCase {
	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		EventFramework::reset();
		$this->tmp = $this->make_temp_dir();
	}

	protected function tearDown(): void {
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	public function test_poll_accumulates_bytes_read_on_consumer(): void {
		// bytes_read on Consumer should reflect total bytes pulled from its
		// source partition via poll(). The Partition itself ALSO tracks
		// its own bytes_read (sourced from read_at calls), but the Consumer
		// is the node operators see in `stats` so it needs to surface the
		// volume too.
		$source = new Partition( "{$this->tmp}/data", 0, 64 * 1024, 4, 86400 );
		$msg_a  = $this->produce( 'first' );
		$source->fill( $msg_a );
		$source->flush();

		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$c->sink( new CaptureSink() );
		$c->poll();

		$packed_size = \strlen( Message::packed( $msg_a ) ) + 1; // trailing \n
		$this->assertSame( $packed_size, $c->bytes_read() );
	}

	public function test_poll_emits_line_for_each_new_log_entry(): void {
		$source = new Partition( "{$this->tmp}/data", 0, 64*1024, 4, 86400 );
		$this->produce_line( $source, 'first' );
		$this->produce_line( $source, 'second' );

		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$capture = new CaptureSink();
		$c->sink( $capture );

		$c->poll();

		$this->assertCount( 2, $capture->captured );
		$this->assertSame( 'first',  $capture->captured[0][ Message::VALUE ] );
		$this->assertSame( 'second', $capture->captured[1][ Message::VALUE ] );
	}

	/**
	 * Build a TM_BYTESTREAM message and fill the Partition. Partition::fill
	 * packs via Message::packed and appends the bytes; Consumer auto-unpacks
	 * on the read side. Tests use this to simulate real producer flow.
	 */
	private function produce_line( Partition $partition, string $value ): void {
		$msg                       = Message::new_message();
		$msg[ Message::TYPE ]      = Message::TM_BYTESTREAM;
		$msg[ Message::TIMESTAMP ] = microtime( true );
		$msg[ Message::VALUE ]     = $value;
		$partition->fill( $msg );
		// Partition::fill batches in memory now — force on-disk visibility
		// so the Consumer's poll() picks up the bytes synchronously.
		$partition->flush();
	}

	public function test_poll_does_not_re_emit_old_lines_on_second_call(): void {
		$source = new Partition( "{$this->tmp}/data", 0, 64*1024, 4, 86400 );
		$this->produce_line( $source, 'first' );

		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$capture = new CaptureSink();
		$c->sink( $capture );

		$c->poll();
		$this->assertCount( 1, $capture->captured );

		$c->poll();
		$this->assertCount( 1, $capture->captured );

		$this->produce_line( $source, 'second' );
		$c->poll();
		$this->assertCount( 2, $capture->captured );
	}

	public function test_checkpoint_records_target_and_worker_type(): void {
		// Dashboard needs per-Consumer metadata so it can render rows
		// like "worker X · consumer Y · target Z" instead of the static
		// hardcoded WORKER_INPUTS map. Worker_type comes from the env
		// var the supervisor sets; target is what Node::target() holds.
		$source = new Partition( "{$this->tmp}/data", 0, 64*1024, 4, 86400 );
		$this->produce_line( $source, 'hello' );

		$_SERVER['NEWSPACK_NODES_WORKER_TYPE'] = 'firehose-workers';

		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$c->name( 'firehose:consumer' );
		$c->target( 'firehose:tee' );
		$c->poll();
		$c->checkpoint();

		$offsetlog_path = "{$this->tmp}/offsets/r/p0/p0/0.log";
		$content = (string) file_get_contents( $offsetlog_path );
		$msg     = Message::unpacked( rtrim( $content, "\n" ) );
		$entry   = $msg[ Message::VALUE ];

		$this->assertSame( 'firehose-workers', $entry['worker_type'] ?? null );
		$this->assertSame( 'firehose:tee',     $entry['target']      ?? null );
		$this->assertSame( 'firehose:consumer', $entry['name']       ?? null );
		// `targets` resolves downstream; with no node registered for
		// firehose:tee, the row surfaces the name with an empty class.
		$this->assertSame(
			[ [ 'name' => 'firehose:tee', 'class' => '' ] ],
			$entry['targets'] ?? null
		);

		unset( $_SERVER['NEWSPACK_NODES_WORKER_TYPE'] );
	}

	public function test_checkpoint_writes_offsetlog_entry(): void {
		$source = new Partition( "{$this->tmp}/data", 0, 64*1024, 4, 86400 );
		$this->produce_line( $source, 'hello' );

		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$c->poll();
		$c->checkpoint();

		// Offsetlog stores packed Tachikoma messages whose VALUE is the
		// {seg, off, ts} struct. The packed line should mention "seg" and "off".
		$offsetlog_path = "{$this->tmp}/offsets/r/p0/p0/0.log";
		$this->assertTrue( file_exists( $offsetlog_path ), 'Offsetlog must exist after checkpoint' );
		$content = (string) file_get_contents( $offsetlog_path );
		$msg     = Message::unpacked( rtrim( $content, "\n" ) );
		$entry   = $msg[ Message::VALUE ];
		$this->assertSame( 0, $entry['seg'] );
		$this->assertGreaterThan( 0, $entry['off'] );
	}

	public function test_restart_resumes_from_last_checkpoint(): void {
		$source = new Partition( "{$this->tmp}/data", 0, 64*1024, 4, 86400 );
		$this->produce_line( $source, 'first' );

		$c1 = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$cap1 = new CaptureSink();
		$c1->sink( $cap1 );
		$c1->poll();
		$c1->checkpoint();
		unset( $c1 );

		$this->produce_line( $source, 'second' );

		$c2 = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$cap2 = new CaptureSink();
		$c2->sink( $cap2 );
		$c2->poll();

		$this->assertCount( 1, $cap2->captured );
		$this->assertSame( 'second', $cap2->captured[0][ Message::VALUE ] );
	}

	// ============================================================================
	// Hardening: cross-poll partial-line accumulation.
	// ============================================================================

	public function test_partial_line_carries_across_polls(): void {
		// Simulate a writer that writes a single packed line in two halves.
		// Use raw fwrite to bypass Partition's atomic-line semantics.
		$msg                       = Message::new_message();
		$msg[ Message::TYPE ]      = Message::TM_BYTESTREAM;
		$msg[ Message::TIMESTAMP ] = 1234567890.0;
		$msg[ Message::VALUE ]     = 'first';
		$packed                    = Message::packed( $msg ) . "\n";
		$mid                       = (int) ( strlen( $packed ) / 2 );
		$half1                     = substr( $packed, 0, $mid );
		$half2                     = substr( $packed, $mid );

		mkdir( "{$this->tmp}/data/p0", 0755, true );
		file_put_contents( "{$this->tmp}/data/p0/0.log", $half1 );

		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$cap = new CaptureSink();
		$c->sink( $cap );

		$c->poll();
		// No complete line yet — should emit nothing.
		$this->assertCount( 0, $cap->captured, 'partial line must NOT be emitted on first poll' );

		// Append the rest of the line.
		file_put_contents( "{$this->tmp}/data/p0/0.log", $half2, FILE_APPEND );
		$c->poll();

		$this->assertCount( 1, $cap->captured, 'completed line must emit on second poll' );
		$this->assertSame( 'first', $cap->captured[0][ Message::VALUE ] );
		// Cursor should be at start of segment 0.
		$this->assertSame( '0:0', $cap->captured[0][ Message::ID ] );
	}

	public function test_partial_line_does_not_double_emit_bytes(): void {
		// Writer writes a packed line 1 byte at a time across multiple polls.
		$msg                       = Message::new_message();
		$msg[ Message::TYPE ]      = Message::TM_BYTESTREAM;
		$msg[ Message::TIMESTAMP ] = 1234567890.0;
		$msg[ Message::VALUE ]     = 'hello';
		$packed                    = Message::packed( $msg ) . "\n";

		mkdir( "{$this->tmp}/data/p0", 0755, true );
		file_put_contents( "{$this->tmp}/data/p0/0.log", '' );

		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$cap = new CaptureSink();
		$c->sink( $cap );

		for ( $i = 0; $i < strlen( $packed ); $i++ ) {
			file_put_contents( "{$this->tmp}/data/p0/0.log", $packed[ $i ], FILE_APPEND );
			$c->poll();
		}

		$this->assertCount( 1, $cap->captured, 'each byte must accumulate into single emit' );
		$this->assertSame( 'hello', $cap->captured[0][ Message::VALUE ] );
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

		// Drive the consumer through several polls. Each poll appends up to MAX_POLL_BYTES (10MB)
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
		$this->produce_line( $source, 'hello' );

		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$c->poll();
		$this->assertTrue( $c->is_caught_up(), 'after polling all bytes, must be caught up' );

		$this->produce_line( $source, 'more' );
		\clearstatcache();
		$this->assertFalse( $c->is_caught_up(), 'new bytes appearing must un-catch-up the reader' );
	}

	public function test_is_caught_up_true_after_polling_to_end(): void {
		$source = new Partition( "{$this->tmp}/data", 0, 64*1024, 4, 86400 );
		$this->produce_line( $source, 'a' );
		$this->produce_line( $source, 'b' );

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
			$this->produce_line( $source, str_repeat( chr( 97 + $i ), 30 ) );
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
		$this->produce_line( $source, 'old1' );
		$this->produce_line( $source, 'old2' );

		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$cap = new CaptureSink();
		$c->sink( $cap );

		$c->next_offset( 'end' ); // Skip past existing data.
		$c->poll();
		$this->assertCount( 0, $cap->captured, 'end-seek must skip pre-existing lines' );

		$this->produce_line( $source, 'new1' );
		$c->poll();
		$this->assertCount( 1, $cap->captured );
		$this->assertSame( 'new1', $cap->captured[0][ Message::VALUE ] );
	}

	public function test_next_offset_start_resets_to_zero(): void {
		$source = new Partition( "{$this->tmp}/data", 0, 64*1024, 4, 86400 );
		$this->produce_line( $source, 'alpha' );

		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$cap = new CaptureSink();
		$c->sink( $cap );

		$c->next_offset( 'end' );
		$c->next_offset( 'start' );
		$c->poll();

		$this->assertCount( 1, $cap->captured );
		$this->assertSame( 'alpha', $cap->captured[0][ Message::VALUE ] );
	}

	public function test_next_offset_recent_picks_second_to_last_segment(): void {
		// Force several segments.
		$source = new Partition( "{$this->tmp}/data", 0, 32, 4, 86400 );
		$this->produce_line( $source, str_repeat( 'a', 30 ) );
		$this->produce_line( $source, str_repeat( 'b', 30 ) );
		$this->produce_line( $source, str_repeat( 'c', 30 ) );

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

	public function test_empty_offsetlog_dir_skips_offsetlog(): void {
		// cli sessions and other ephemeral readers pass '' for offsetlog dir
		// to skip the offsetlog entirely — no per-session directories under
		// offsets/, no checkpoint persistence, just tail.
		$source = new Partition( "{$this->tmp}/data", 0, 64*1024, 4, 86400 );
		$this->produce_line( $source, 'hello' );

		$c   = new Consumer( "{$this->tmp}/data", 0, '' );
		$cap = new CaptureSink();
		$c->sink( $cap );
		$c->poll();

		$this->assertCount( 1, $cap->captured );
		$this->assertSame( 'hello', $cap->captured[0][ Message::VALUE ] );

		// checkpoint() must be a no-op in this mode — no offsetlog directory
		// should appear underneath $this->tmp.
		$c->checkpoint();
		$this->assertFalse( is_dir( "{$this->tmp}/offsets" ), 'no offsetlog dir created with empty offsetlog_base_dir' );
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

	public function test_next_offset_array_clamps_negative_off_to_zero(): void {
		$c   = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$ref = new \ReflectionClass( $c );
		$off = $ref->getProperty( 'cursor_off' );
		$off->setAccessible( true );

		// Spec: negative offsets must be clamped to 0 (max(0, ...)).
		$c->next_offset( [ 'seg' => 2, 'off' => -42 ] );
		$this->assertSame( 0, $off->getValue( $c ), 'negative off must be clamped to 0' );
	}

	// ============================================================================
	// next_segment() — segment rotation logic. Mirrors FirehoseReader::next_segment.
	// ============================================================================

	public function test_next_segment_returns_null_when_no_segments(): void {
		// Empty source — nothing to advance to.
		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$this->assertNull( $c->next_segment() );
	}

	public function test_next_segment_stays_when_current_segment_is_fresh(): void {
		// Writer is still active on the current segment (mtime within
		// STALE_SEGMENT_SECONDS): next_segment must not advance the cursor.
		$source = new Partition( "{$this->tmp}/data", 0, 32, 4, 86400 );
		// 3 writes guaranteed to produce >=2 segments (matches pattern in
		// test_next_offset_recent_picks_second_to_last_segment).
		$this->produce_line( $source, str_repeat( 'a', 30 ) );
		$this->produce_line( $source, str_repeat( 'b', 30 ) );
		$this->produce_line( $source, str_repeat( 'c', 30 ) );

		$segments = $source->get_segments( true );
		$this->assertGreaterThanOrEqual( 2, count( $segments ), 'need >=2 segments' );

		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );

		$ref      = new \ReflectionClass( $c );
		$seg_prop = $ref->getProperty( 'cursor_seg' );
		$seg_prop->setAccessible( true );
		// Position cursor on segment 0 (first written, exists on disk).
		$seg_prop->setValue( $c, $segments[0]['id'] );

		// Touch current segment to "now" so writer-fresh logic kicks in.
		$current_path = "{$source->partition_dir()}/{$segments[0]['id']}.log";
		@touch( $current_path, time() );
		clearstatcache( true, $current_path );

		$result = $c->next_segment();
		$this->assertNull( $result, 'fresh segment must not advance' );
		$this->assertSame( $segments[0]['id'], $seg_prop->getValue( $c ), 'cursor must remain on fresh segment' );
	}

	public function test_next_segment_advances_when_current_is_stale_and_next_exists(): void {
		// Force >=2 segments. Touch the current one to look stale, then verify advance.
		$source = new Partition( "{$this->tmp}/data", 0, 32, 4, 86400 );
		$this->produce_line( $source, str_repeat( 'a', 30 ) );
		$this->produce_line( $source, str_repeat( 'b', 30 ) );
		$this->produce_line( $source, str_repeat( 'c', 30 ) );

		$segments = $source->get_segments( true );
		$this->assertGreaterThanOrEqual( 2, count( $segments ), 'need >=2 segments' );
		// next_segment uses cursor_seg + 1 — we need that successor to exist
		// in the segment list. Pick the oldest and assert its successor exists.
		$older       = $segments[0];
		$has_plus_1  = in_array( $older['id'] + 1, array_column( $segments, 'id' ), true );
		if ( ! $has_plus_1 ) {
			$this->markTestSkipped( 'rotation produced non-contiguous segments; cannot test +1 advance' );
			return;
		}

		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );

		$ref      = new \ReflectionClass( $c );
		$seg_prop = $ref->getProperty( 'cursor_seg' );
		$seg_prop->setAccessible( true );
		$off_prop = $ref->getProperty( 'cursor_off' );
		$off_prop->setAccessible( true );
		$rem_prop = $ref->getProperty( 'line_remainder' );
		$rem_prop->setAccessible( true );

		$seg_prop->setValue( $c, $older['id'] );
		$off_prop->setValue( $c, 100 );        // Non-zero — must be reset on advance.
		$rem_prop->setValue( $c, 'partial' );  // Non-empty — must be cleared on advance.

		// Touch current segment far in the past (>STALE_SEGMENT_SECONDS).
		$current_path = "{$source->partition_dir()}/{$older['id']}.log";
		@touch( $current_path, time() - 60 );
		clearstatcache( true, $current_path );

		$expected_next = $older['id'] + 1;
		$result        = $c->next_segment();

		$this->assertSame( $expected_next, $result );
		$this->assertSame( $expected_next, $seg_prop->getValue( $c ) );
		$this->assertSame( 0, $off_prop->getValue( $c ), 'offset must reset on advance' );
		$this->assertSame( '', $rem_prop->getValue( $c ), 'line_remainder must clear on advance' );
	}

	public function test_next_segment_returns_null_when_current_stale_but_no_next(): void {
		// Single segment, stale. There's no "next id" to advance to → return null.
		// Distinct from the firehose-wiped branch (has_curr=true, has_next=false).
		$source = new Partition( "{$this->tmp}/data", 0, 64*1024, 4, 86400 );
		$this->produce_line( $source, 'only' );

		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );

		// Stale-touch the only segment so we pass the freshness check, then
		// hit the `! $has_next` branch.
		$path = "{$source->partition_dir()}/0.log";
		@touch( $path, time() - 60 );
		clearstatcache( true, $path );

		$ref = new \ReflectionClass( $c );
		$seg = $ref->getProperty( 'cursor_seg' );
		$seg->setAccessible( true );

		$this->assertNull( $c->next_segment(), 'no successor segment → null' );
		// Cursor must remain unchanged when next_segment can't advance.
		$this->assertSame( 0, $seg->getValue( $c ) );
	}

	public function test_next_segment_resets_when_firehose_was_wiped(): void {
		// has_curr=false AND has_next=false → "firehose was reset", jump to oldest.
		$source = new Partition( "{$this->tmp}/data", 0, 64*1024, 4, 86400 );
		$this->produce_line( $source, 'a' );

		$segments = $source->get_segments( true );
		$this->assertNotEmpty( $segments );

		$c   = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$ref = new \ReflectionClass( $c );
		$seg = $ref->getProperty( 'cursor_seg' );
		$seg->setAccessible( true );
		$off = $ref->getProperty( 'cursor_off' );
		$off->setAccessible( true );
		$rem = $ref->getProperty( 'line_remainder' );
		$rem->setAccessible( true );

		// Park the cursor on a segment id that isn't (and can't be the +1 of) any
		// existing segment: pick something far higher than max + 1.
		$max_id = (int) end( $segments )['id'];
		$seg->setValue( $c, $max_id + 100 );
		$off->setValue( $c, 50 );
		$rem->setValue( $c, 'leftover' );

		$result = $c->next_segment();

		// Must have rewound to the oldest available.
		$this->assertSame( $segments[0]['id'], $result );
		$this->assertSame( $segments[0]['id'], $seg->getValue( $c ) );
		$this->assertSame( 0, $off->getValue( $c ) );
		$this->assertSame( '', $rem->getValue( $c ) );
	}

	// ============================================================================
	// poll() — drain branches not yet covered.
	// ============================================================================

	public function test_poll_recovers_when_cursor_segment_was_deleted(): void {
		// Cursor parked on a segment id that no longer exists — poll() must
		// recover by rewinding to the oldest available segment and reading from 0.
		$source = new Partition( "{$this->tmp}/data", 0, 32, 4, 86400 );
		$this->produce_line( $source, str_repeat( 'a', 30 ) );
		$this->produce_line( $source, str_repeat( 'b', 30 ) );
		$this->produce_line( $source, str_repeat( 'c', 30 ) );

		$segments = $source->get_segments( true );
		$this->assertNotEmpty( $segments );

		$c   = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$cap = new CaptureSink();
		$c->sink( $cap );

		$ref = new \ReflectionClass( $c );
		$seg = $ref->getProperty( 'cursor_seg' );
		$seg->setAccessible( true );
		$off = $ref->getProperty( 'cursor_off' );
		$off->setAccessible( true );

		// Force cursor into an id that does NOT appear in the segment list.
		$max_id = (int) end( $segments )['id'];
		$seg->setValue( $c, $max_id + 50 );
		$off->setValue( $c, 999 );

		$c->poll();

		// After rewind + drain, cursor lands on the NEWEST segment (the loop
		// walked from oldest forward through all segments).
		$this->assertSame( $max_id, $seg->getValue( $c ), 'cursor must end on newest segment after full drain' );
		// All lines should have been emitted: 3 produce_line calls = 3 lines.
		$this->assertSame( 3, count( $cap->captured ), 'rewind must let us read all existing data' );
	}

	public function test_poll_advances_across_segment_boundary(): void {
		// Multi-segment drain: a single poll spanning into a new segment must
		// reset cursor_off to 0 when it crosses the boundary.
		$source = new Partition( "{$this->tmp}/data", 0, 32, 4, 86400 );
		$this->produce_line( $source, str_repeat( 'a', 30 ) );
		$this->produce_line( $source, str_repeat( 'b', 30 ) );
		$this->produce_line( $source, str_repeat( 'c', 30 ) );

		$segments = $source->get_segments( true );
		$this->assertGreaterThanOrEqual( 2, count( $segments ), 'need multiple segments' );

		$c   = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$cap = new CaptureSink();
		$c->sink( $cap );
		$c->poll();

		// Should have read every line in every segment.
		$this->assertSame( 3, count( $cap->captured ) );
		$values = array_map( static fn ( $m ) => $m[ Message::VALUE ], $cap->captured );
		$this->assertSame(
			[ str_repeat( 'a', 30 ), str_repeat( 'b', 30 ), str_repeat( 'c', 30 ) ],
			$values,
			'every line across segment boundaries must emit in order'
		);

		// Cursor should be parked on the newest segment.
		$ref = new \ReflectionClass( $c );
		$seg = $ref->getProperty( 'cursor_seg' );
		$seg->setAccessible( true );
		$this->assertSame( (int) end( $segments )['id'], $seg->getValue( $c ) );
	}

	public function test_poll_stamps_message_FROM_with_consumer_name(): void {
		// FROM-stamping is a load-bearing convention — every emitted message must
		// have the Consumer's name stamped onto FROM so downstream nodes can
		// reply via TO=FROM.
		$source = new Partition( "{$this->tmp}/data", 0, 64*1024, 4, 86400 );
		$this->produce_line( $source, 'hi' );

		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$c->name( 'my-consumer' );
		$cap = new CaptureSink();
		$c->sink( $cap );

		$c->poll();

		$this->assertCount( 1, $cap->captured );
		$this->assertSame( 'my-consumer', $cap->captured[0][ Message::FROM ] );
	}

	public function test_poll_stamp_override_replaces_name_in_FROM(): void {
		// set_stamp_as overrides the FROM stamp — used by the worker's IPC
		// input Consumer to stamp as the OUTPUT partition's name (`_repl`).
		$source = new Partition( "{$this->tmp}/data", 0, 64*1024, 4, 86400 );
		$this->produce_line( $source, 'data' );

		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$c->name( 'real-name' );
		$c->set_stamp_as( '_repl' );
		$cap = new CaptureSink();
		$c->sink( $cap );

		$c->poll();

		$this->assertCount( 1, $cap->captured );
		$this->assertSame( '_repl', $cap->captured[0][ Message::FROM ], 'override must replace name in FROM' );
	}

	public function test_poll_emitted_ID_is_seg_colon_offset(): void {
		// Each emitted message's ID = "{seg}:{abs_offset}" — the offsetlog
		// uses this to checkpoint by segment+offset. ID (not KEY) because KEY
		// is the producer's routing key (rid for firehose, handler for
		// jobintake) and Consumer must preserve it for downstream routing.
		$source = new Partition( "{$this->tmp}/data", 0, 64*1024, 4, 86400 );
		$this->produce_line( $source, 'first' );
		$this->produce_line( $source, 'second' );

		$c   = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$cap = new CaptureSink();
		$c->sink( $cap );
		$c->poll();

		$this->assertCount( 2, $cap->captured );
		// First line lands at offset 0 within segment 0.
		$this->assertSame( '0:0', $cap->captured[0][ Message::ID ] );
		// Second line lands AFTER the first packed line + newline.
		[ $seg2, $off2 ] = explode( ':', $cap->captured[1][ Message::ID ] );
		$this->assertSame( '0', $seg2 );
		$this->assertGreaterThan( 0, (int) $off2, 'second line offset must be past first' );
	}

	public function test_poll_preserves_producer_KEY(): void {
		// Consumer MUST NOT overwrite the producer's KEY. KEY is the routing
		// key — rid for firehose entries, handler for jobintake. Overwriting
		// it to seg:offset (as Consumer used to do) breaks RequestBuilder's
		// rid grouping and any multi-partition queue keyed on handler.
		$source = new Partition( "{$this->tmp}/data", 0, 64*1024, 4, 86400 );
		$msg                       = Message::new_message();
		$msg[ Message::TYPE ]      = Message::TM_BYTESTREAM;
		$msg[ Message::TIMESTAMP ] = 1234567890.0;
		$msg[ Message::KEY ]       = 'producer-key-abc123';
		$msg[ Message::VALUE ]     = 'hello';
		$source->fill( $msg );
		$source->flush();

		$c   = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$cap = new CaptureSink();
		$c->sink( $cap );
		$c->poll();

		$this->assertCount( 1, $cap->captured );
		$this->assertSame( 'producer-key-abc123', $cap->captured[0][ Message::KEY ] );
		// Position breadcrumb lands on ID alongside.
		$this->assertSame( '0:0', $cap->captured[0][ Message::ID ] );
	}

	// ============================================================================
	// open() — empty-segments path.
	// ============================================================================

	public function test_open_returns_null_when_no_segments(): void {
		// Empty source: open() must return null without throwing.
		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$this->assertNull( $c->open() );
	}

	// ============================================================================
	// load_offsetlog() — corrupt / malformed checkpoint entries.
	// ============================================================================

	public function test_load_offsetlog_ignores_malformed_value_field(): void {
		// Manually write a packed Message whose VALUE is NOT the expected
		// {seg, off} struct. load_offsetlog must NOT seed the cursor from it
		// (the if-is_array+isset gate at line 153 must reject it).
		mkdir( "{$this->tmp}/offsets/r/p0/p0", 0755, true );

		// Message with VALUE = string "garbage" (not an array with seg/off).
		$msg                       = Message::new_message();
		$msg[ Message::TYPE ]      = Message::TM_STRUCT;
		$msg[ Message::TIMESTAMP ] = 1234567890.0;
		$msg[ Message::VALUE ]     = 'garbage';
		file_put_contents( "{$this->tmp}/offsets/r/p0/p0/0.log", Message::packed( $msg ) . "\n" );

		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );

		// Cursor must remain at the constructor default (0/0) when the offsetlog
		// entry's VALUE doesn't match the expected schema.
		$ref = new \ReflectionClass( $c );
		$seg = $ref->getProperty( 'cursor_seg' );
		$seg->setAccessible( true );
		$off = $ref->getProperty( 'cursor_off' );
		$off->setAccessible( true );

		$this->assertSame( 0, $seg->getValue( $c ) );
		$this->assertSame( 0, $off->getValue( $c ) );
	}

	public function test_load_offsetlog_skips_when_only_blank_lines(): void {
		// A segment that contains only newlines (no JSON-encoded packed message)
		// must be ignored — array_filter strips them and load_offsetlog returns
		// without seeding the cursor.
		mkdir( "{$this->tmp}/offsets/r/p0/p0", 0755, true );
		file_put_contents( "{$this->tmp}/offsets/r/p0/p0/0.log", "\n\n\n" );

		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );

		$ref = new \ReflectionClass( $c );
		$seg = $ref->getProperty( 'cursor_seg' );
		$seg->setAccessible( true );
		$off = $ref->getProperty( 'cursor_off' );
		$off->setAccessible( true );
		$this->assertSame( 0, $seg->getValue( $c ) );
		$this->assertSame( 0, $off->getValue( $c ) );
	}

	// ============================================================================
	// is_caught_up() — cursor strictly behind newest segment.
	// ============================================================================

	public function test_is_caught_up_false_when_cursor_segment_is_older_than_newest(): void {
		// Multiple segments. Park the cursor on an older one — caught up must be
		// false even if at_eof was set on the OLD segment.
		$source = new Partition( "{$this->tmp}/data", 0, 32, 4, 86400 );
		$this->produce_line( $source, str_repeat( 'a', 30 ) );
		$this->produce_line( $source, str_repeat( 'b', 30 ) );
		$this->produce_line( $source, str_repeat( 'c', 30 ) );

		$segments = $source->get_segments( true );
		$this->assertGreaterThanOrEqual( 2, count( $segments ) );

		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );

		$ref = new \ReflectionClass( $c );
		$seg = $ref->getProperty( 'cursor_seg' );
		$seg->setAccessible( true );
		// Park cursor on the OLDEST segment.
		$seg->setValue( $c, $segments[0]['id'] );
		$at_eof = $ref->getProperty( 'at_eof' );
		$at_eof->setAccessible( true );
		$at_eof->setValue( $c, true ); // Even if at_eof is true on the old segment.

		$this->assertFalse( $c->is_caught_up(), 'cursor on older segment cannot be caught up' );
	}

	// ============================================================================
	// checkpoint() — skip-when-unchanged branch.
	// ============================================================================

	public function test_checkpoint_skips_when_cursor_has_not_advanced(): void {
		// Spec: "Skip if cursor hasn't advanced since the last commit — the
		// saved entry is still the truth, no point appending a duplicate every tick."
		$source = new Partition( "{$this->tmp}/data", 0, 64*1024, 4, 86400 );
		$this->produce_line( $source, 'first' );

		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$c->poll();
		$c->checkpoint();

		$path  = "{$this->tmp}/offsets/r/p0/p0/0.log";
		$size1 = filesize( $path );

		// Second checkpoint with no cursor advancement must NOT append.
		$c->checkpoint();
		clearstatcache( true, $path );
		$size2 = filesize( $path );

		$this->assertSame( $size1, $size2, 'duplicate checkpoint must be skipped' );
	}

	public function test_checkpoint_appends_when_cursor_has_advanced(): void {
		// Inverse of the skip test: when cursor advances, a new entry MUST land.
		$source = new Partition( "{$this->tmp}/data", 0, 64*1024, 4, 86400 );
		$this->produce_line( $source, 'first' );

		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$c->poll();
		$c->checkpoint();

		$path  = "{$this->tmp}/offsets/r/p0/p0/0.log";
		$size1 = filesize( $path );

		$this->produce_line( $source, 'second' );
		$c->poll();
		$c->checkpoint();
		clearstatcache( true, $path );
		$size2 = filesize( $path );

		$this->assertGreaterThan( $size1, $size2, 'cursor advancement must add a new offsetlog entry' );
	}

	// ============================================================================
	// fire() — Timer hook (protected). Verifies poll(), publish_position(), and
	// conditional checkpoint() all run; timer is re-armed.
	// ============================================================================

	public function test_fire_polls_source_and_emits_messages(): void {
		// fire() is the Timer hook. It must call poll() so new bytes get drained.
		$source = new Partition( "{$this->tmp}/data", 0, 64*1024, 4, 86400 );
		$this->produce_line( $source, 'fired' );

		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$cap = new CaptureSink();
		$c->sink( $cap );

		// Invoke protected fire() via reflection.
		$ref  = new \ReflectionClass( $c );
		$fire = $ref->getMethod( 'fire' );
		$fire->setAccessible( true );
		$fire->invoke( $c );

		$this->assertCount( 1, $cap->captured, 'fire() must drain via poll()' );
		$this->assertSame( 'fired', $cap->captured[0][ Message::VALUE ] );
	}

	public function test_fire_writes_first_checkpoint_on_initial_call(): void {
		// On the FIRST fire(), last_checkpoint=0 so (now - 0) >= 1 always
		// holds — checkpoint() must run (provided the cursor advanced).
		$source = new Partition( "{$this->tmp}/data", 0, 64*1024, 4, 86400 );
		$this->produce_line( $source, 'cp' );

		$c   = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$ref = new \ReflectionClass( $c );

		Core::$now = \microtime(true); // Ensure now is a real wall-clock value.

		$fire = $ref->getMethod( 'fire' );
		$fire->setAccessible( true );
		$fire->invoke( $c );

		$this->assertFileExists(
			"{$this->tmp}/offsets/r/p0/p0/0.log",
			'fire() with stale last_checkpoint must invoke checkpoint()'
		);

		// last_checkpoint should now be set to the current wall-clock time.
		$last = $ref->getProperty( 'last_checkpoint' );
		$last->setAccessible( true );
		$this->assertGreaterThan( 0.0, $last->getValue( $c ) );
	}

	public function test_fire_skips_checkpoint_when_within_interval(): void {
		// Spec: "Persist cursor every CHECKPOINT_INTERVAL_S so a respawning
		// worker resumes from the last commit." Within that interval, fire()
		// must NOT call checkpoint() — even if data was polled.
		$source = new Partition( "{$this->tmp}/data", 0, 64*1024, 4, 86400 );
		$this->produce_line( $source, 'a' );

		$c   = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$ref = new \ReflectionClass( $c );

		// Pre-set last_checkpoint to "right now" so the interval gate fails.
		Core::$now = \microtime(true);
		$last = $ref->getProperty( 'last_checkpoint' );
		$last->setAccessible( true );
		$last->setValue( $c, Core::$now );

		// Pre-set checkpoint_seg/off to match cursor so checkpoint() would skip
		// even if it WAS called — but more importantly, our test asserts the
		// caller of checkpoint() (fire) is gated by the interval.
		$cp_seg = $ref->getProperty( 'checkpoint_seg' );
		$cp_seg->setAccessible( true );
		$cp_off = $ref->getProperty( 'checkpoint_off' );
		$cp_off->setAccessible( true );
		// Force divergent values so if checkpoint() runs, it WOULD write.
		$cp_seg->setValue( $c, -999 );
		$cp_off->setValue( $c, -999 );

		$fire = $ref->getMethod( 'fire' );
		$fire->setAccessible( true );
		$fire->invoke( $c );

		$this->assertFileDoesNotExist(
			"{$this->tmp}/offsets/r/p0/p0/0.log",
			'within CHECKPOINT_INTERVAL_S, fire must not invoke checkpoint'
		);
	}

	public function test_fire_does_not_invoke_checkpoint_when_offsetlog_disabled(): void {
		// Consumer constructed with empty offsetlog_base_dir → no offsetlog
		// directory ever created, even after fire().
		$source = new Partition( "{$this->tmp}/data", 0, 64*1024, 4, 86400 );
		$this->produce_line( $source, 'a' );

		$c = new Consumer( "{$this->tmp}/data", 0, '' );

		Core::$now = \microtime(true);
		$ref  = new \ReflectionClass( $c );
		$fire = $ref->getMethod( 'fire' );
		$fire->setAccessible( true );
		$fire->invoke( $c );

		$this->assertFalse(
			is_dir( "{$this->tmp}/offsets" ),
			'offsetlog disabled → no directory must appear under offsets/'
		);
	}

	public function test_fire_rearms_timer_with_eof_interval_when_caught_up(): void {
		// After draining all available data, fire() must re-arm with
		// POLL_INTERVAL_EOF_MS (=100) so we back off to 100ms idle ticks.
		$source = new Partition( "{$this->tmp}/data", 0, 64*1024, 4, 86400 );
		$this->produce_line( $source, 'a' );

		$c   = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$cap = new CaptureSink();
		$c->sink( $cap );

		Core::$now = \microtime(true);
		$ref  = new \ReflectionClass( $c );
		$fire = $ref->getMethod( 'fire' );
		$fire->setAccessible( true );
		$fire->invoke( $c );

		// After fire(), poll() reached EOF (all data consumed, no more bytes).
		// EventFramework should have a timer entry for this Consumer with
		// interval_ms = POLL_INTERVAL_EOF_MS.
		$ef         = EventFramework::instance();
		$ef_ref     = new \ReflectionClass( $ef );
		$timers_p   = $ef_ref->getProperty( 'timers' );
		$timers_p->setAccessible( true );
		$timers     = $timers_p->getValue( $ef );
		$id         = \spl_object_id( $c );
		$this->assertArrayHasKey( $id, $timers, 'fire() must register a timer with EventFramework' );
		$this->assertSame(
			Consumer::POLL_INTERVAL_EOF_MS,
			$timers[ $id ]['interval_ms'],
			'caught-up fire must re-arm with EOF interval'
		);
		$this->assertTrue( $timers[ $id ]['oneshot'], 'fire re-arm must be one-shot' );
	}

	public function test_fire_rearms_timer_with_busy_interval_when_more_data_pending(): void {
		// fire() consults $this->at_eof after poll() to decide BUSY vs EOF rearm.
		// To deterministically exercise the busy branch we use a subclass whose
		// poll() flips at_eof back to false after the parent drain — simulating
		// a producer that's still ahead of us.
		$busy_consumer = new class( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" ) extends Consumer {
			public function poll(): void {
				parent::poll();
				// Pretend the writer is still ahead; force the busy branch.
				$ref = new \ReflectionClass( Consumer::class );
				$p   = $ref->getProperty( 'at_eof' );
				$p->setAccessible( true );
				$p->setValue( $this, false );
			}
		};

		Core::$now = \microtime(true);
		$ref  = new \ReflectionClass( $busy_consumer );
		$fire = $ref->getMethod( 'fire' );
		$fire->setAccessible( true );
		$fire->invoke( $busy_consumer );

		// Inspect the EventFramework's timers map — fire() should have re-armed
		// with POLL_INTERVAL_BUSY_MS (=0) so the next tick drains immediately.
		$ef       = EventFramework::instance();
		$ef_ref   = new \ReflectionClass( $ef );
		$timers_p = $ef_ref->getProperty( 'timers' );
		$timers_p->setAccessible( true );
		$timers   = $timers_p->getValue( $ef );
		$id       = \spl_object_id( $busy_consumer );

		$this->assertArrayHasKey( $id, $timers, 'fire() must register a timer' );
		$this->assertSame(
			Consumer::POLL_INTERVAL_BUSY_MS,
			$timers[ $id ]['interval_ms'],
			'busy fire must re-arm with BUSY interval (drain ASAP next tick)'
		);
	}

	// ============================================================================
	// publish_position() — memcache cursor publishing. Verify the no-op early-exit
	// branches; the actual set() call needs a live Memcached server which the
	// test env may not provide. The branches we CAN cover exercise the static
	// `$memd = false` sticky-fail logic and the class_exists() guard.
	// ============================================================================

	#[RunInSeparateProcess]
	#[PreserveGlobalState( false )]
	public function test_publish_position_short_circuits_on_empty_memcache_servers(): void {
		// Spec: with no memcache_servers configured, publish_position must
		// sticky-fail (set static $memd = false) on first call, short-circuit
		// on every subsequent call. No exception, no side effects.
		//
		// Runs in a separate process so the function-static `$memd` is null
		// (other tests in this class call fire() which initializes $memd).
		if ( ! \class_exists( '\\Memcached' ) ) {
			$this->markTestSkipped( 'Memcached extension not loaded.' );
		}

		// Force Config to return memcache_servers=[] by injecting directly via
		// reflection (the disk default is non-empty).
		\Newspack_Nodes\Config::reset();
		$config_ref = new \ReflectionClass( \Newspack_Nodes\Config::class );
		$cf         = $config_ref->getProperty( 'config' );
		$cf->setAccessible( true );
		$cf->setValue( null, [
			'base_directory'   => '/tmp/newspack-nodes',
			'memcache_servers' => [],
		] );

		$c   = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$ref = new \ReflectionClass( $c );
		$pp  = $ref->getMethod( 'publish_position' );
		$pp->setAccessible( true );

		// First call: class_exists OK → $memd null → load config → servers
		// empty → sets $memd=false sticky → return.
		// Second call: $memd is false → early return.
		// Both must complete without throwing.
		$pp->invoke( $c );
		$pp->invoke( $c );

		$this->assertTrue( true, 'empty memcache_servers must produce no error' );
	}

	public function test_publish_position_runs_on_fire_hot_path_without_crashing(): void {
		// Behavioral spec: publish_position is called every fire() tick. It
		// must NEVER throw — even when the configured memcache server isn't
		// reachable. Verifies the no-throw contract through fire()'s caller
		// view (poll continues past publish_position to checkpoint).
		\Newspack_Nodes\Config::reset();

		$source = new Partition( "{$this->tmp}/data", 0, 64*1024, 4, 86400 );
		$this->produce_line( $source, 'a' );

		$c   = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$ref = new \ReflectionClass( $c );

		// Fire twice: first init may construct Memcached + addServer; second
		// must not redo that work (verifying the static-memoization path).
		Core::$now = \microtime(true);
		$fire = $ref->getMethod( 'fire' );
		$fire->setAccessible( true );
		$fire->invoke( $c );
		$fire->invoke( $c );

		// poll() emitted the line on first fire — counter increments via
		// Node::fill on each emit. Verifies fire() reached past
		// publish_position to its tail.
		$this->assertGreaterThanOrEqual( 1, $c->counter(), 'fire() must reach poll() past publish_position' );
	}

	// ============================================================================
	// fill() / handle_request() — TM_REQUEST introspection verbs.
	// ============================================================================

	public function test_fill_routes_TM_REQUEST_to_handle_request(): void {
		// fill() must detect TM_REQUEST (without TM_RESPONSE) and dispatch to
		// handle_request() — NOT forward to sink. This is the introspection
		// path that powers GET_LAG / GET_OFFSET verbs.
		$source = new Partition( "{$this->tmp}/data", 0, 64 * 1024, 4, 86400 );
		$this->produce_line( $source, 'one' );
		$this->produce_line( $source, 'two' );

		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$c->name( 'my-consumer' );
		$cap = new CaptureSink();
		$c->sink( $cap );

		$req                       = Message::new_message();
		$req[ Message::TYPE ]      = Message::TM_REQUEST;
		$req[ Message::FROM ]      = 'asker';
		$req[ Message::ID ]        = 'req-1';
		$req[ Message::KEY ]       = 'k';
		$req[ Message::VALUE ]     = 'GET_OFFSET';
		$c->fill( $req );

		$this->assertCount( 1, $cap->captured, 'request must produce exactly one reply' );
		$reply = $cap->captured[0];
		$this->assertSame(
			Message::TM_STRUCT | Message::TM_RESPONSE,
			$reply[ Message::TYPE ],
			'reply must carry TM_STRUCT|TM_RESPONSE'
		);
		$this->assertSame( 'my-consumer', $reply[ Message::FROM ], 'reply FROM = Consumer name' );
		$this->assertSame( 'asker', $reply[ Message::TO ], 'reply TO walks breadcrumb back via FROM' );
		$this->assertSame( 'req-1', $reply[ Message::ID ], 'reply ID echoes request ID' );
		$this->assertSame( 'k', $reply[ Message::KEY ], 'reply KEY echoes request KEY' );
		$this->assertIsArray( $reply[ Message::VALUE ] );
		$this->assertSame( 'GET_OFFSET', $reply[ Message::VALUE ]['verb'] );
		$this->assertIsArray( $reply[ Message::VALUE ]['data'] );
	}

	public function test_handle_request_GET_OFFSET_returns_cursor_and_checkpoint(): void {
		// Spec: GET_OFFSET reply payload is
		// { cursor_seg, cursor_off, checkpoint_seg, checkpoint_off, last_checkpoint_ts }.
		$source = new Partition( "{$this->tmp}/data", 0, 64 * 1024, 4, 86400 );
		$this->produce_line( $source, 'hello' );

		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$cap = new CaptureSink();
		$c->sink( $cap );
		$c->poll();
		$c->checkpoint();
		// poll() forwarded the produced bytestream line to the sink; clear so
		// captured[0] below is the TM_REQUEST reply we're asserting on.
		$cap->captured = [];

		$req                   = Message::new_message();
		$req[ Message::TYPE ]  = Message::TM_REQUEST;
		$req[ Message::FROM ]  = 'asker';
		$req[ Message::VALUE ] = 'GET_OFFSET';
		$c->fill( $req );

		$data = $cap->captured[0][ Message::VALUE ]['data'];
		$this->assertArrayHasKey( 'cursor_seg', $data );
		$this->assertArrayHasKey( 'cursor_off', $data );
		$this->assertArrayHasKey( 'checkpoint_seg', $data );
		$this->assertArrayHasKey( 'checkpoint_off', $data );
		$this->assertArrayHasKey( 'last_checkpoint_ts', $data );
		$this->assertSame( 0, $data['cursor_seg'] );
		$this->assertGreaterThan( 0, $data['cursor_off'] );
		// checkpoint_seg/off match cursor after checkpoint() committed.
		$this->assertSame( $data['cursor_seg'], $data['checkpoint_seg'] );
		$this->assertSame( $data['cursor_off'], $data['checkpoint_off'] );
	}

	public function test_handle_request_GET_LAG_returns_caught_up_when_empty(): void {
		// Spec: GET_LAG reply payload for an empty source partition has
		// bytes_behind=0, segments_behind=0, caught_up=true.
		$c   = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$cap = new CaptureSink();
		$c->sink( $cap );

		$req                   = Message::new_message();
		$req[ Message::TYPE ]  = Message::TM_REQUEST;
		$req[ Message::FROM ]  = 'asker';
		$req[ Message::VALUE ] = 'GET_LAG';
		$c->fill( $req );

		$data = $cap->captured[0][ Message::VALUE ]['data'];
		$this->assertSame( 0, $data['bytes_behind'] );
		$this->assertSame( 0, $data['segments_behind'] );
		$this->assertTrue( $data['caught_up'] );
	}

	public function test_handle_request_GET_LAG_returns_bytes_behind_when_unread(): void {
		// With pending bytes on the source partition, GET_LAG must report
		// bytes_behind > 0 and caught_up=false. line_remainder bytes don't
		// inflate the count (they're already "fetched", just not emitted yet).
		$source = new Partition( "{$this->tmp}/data", 0, 64 * 1024, 4, 86400 );
		$this->produce_line( $source, 'pending' );

		$c   = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$cap = new CaptureSink();
		$c->sink( $cap );
		// Don't poll — leave the bytes behind so the lag computation has work.

		$req                   = Message::new_message();
		$req[ Message::TYPE ]  = Message::TM_REQUEST;
		$req[ Message::FROM ]  = 'asker';
		$req[ Message::VALUE ] = 'GET_LAG';
		$c->fill( $req );

		$data = $cap->captured[0][ Message::VALUE ]['data'];
		$this->assertGreaterThan( 0, $data['bytes_behind'], 'unread bytes must surface in bytes_behind' );
		$this->assertSame( 0, $data['segments_behind'], 'single-segment lag has 0 segments_behind' );
		$this->assertFalse( $data['caught_up'] );
	}

	public function test_handle_request_GET_LAG_counts_segments_behind(): void {
		// Multi-segment: a consumer parked on segment 0 with newer segments
		// available must report segments_behind > 0.
		$source = new Partition( "{$this->tmp}/data", 0, 32, 4, 86400 );
		$this->produce_line( $source, \str_repeat( 'a', 30 ) );
		$this->produce_line( $source, \str_repeat( 'b', 30 ) );
		$this->produce_line( $source, \str_repeat( 'c', 30 ) );

		$segments = $source->get_segments( true );
		$this->assertGreaterThanOrEqual( 2, \count( $segments ), 'need multi-segment for this test' );

		$c   = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$cap = new CaptureSink();
		$c->sink( $cap );

		// Park cursor at oldest segment, offset 0 — every newer segment is
		// behind.
		$ref = new \ReflectionClass( $c );
		$seg = $ref->getProperty( 'cursor_seg' );
		$seg->setAccessible( true );
		$seg->setValue( $c, (int) $segments[0]['id'] );
		$off = $ref->getProperty( 'cursor_off' );
		$off->setAccessible( true );
		$off->setValue( $c, 0 );

		$req                   = Message::new_message();
		$req[ Message::TYPE ]  = Message::TM_REQUEST;
		$req[ Message::FROM ]  = 'asker';
		$req[ Message::VALUE ] = 'GET_LAG';
		$c->fill( $req );

		$data = $cap->captured[0][ Message::VALUE ]['data'];
		$this->assertGreaterThan( 0, $data['segments_behind'], 'segments_behind must count newer segments' );
		$this->assertGreaterThan( 0, $data['bytes_behind'] );
	}

	public function test_handle_request_GET_LAG_subtracts_line_remainder_from_bytes_behind(): void {
		// `line_remainder` bytes have been READ but not yet emitted — they
		// must subtract from bytes_behind so the report reflects bytes-still-
		// to-fetch, not bytes-still-to-emit. (Without the subtraction, a
		// partial-line accumulator would double-count.)
		$source = new Partition( "{$this->tmp}/data", 0, 64 * 1024, 4, 86400 );
		$this->produce_line( $source, 'hello' );

		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );

		// Pretend we already have 3 bytes in line_remainder (already read).
		$ref = new \ReflectionClass( $c );
		$rem = $ref->getProperty( 'line_remainder' );
		$rem->setAccessible( true );
		$rem->setValue( $c, 'xyz' ); // 3 bytes

		$cap = new CaptureSink();
		$c->sink( $cap );

		$req                   = Message::new_message();
		$req[ Message::TYPE ]  = Message::TM_REQUEST;
		$req[ Message::FROM ]  = 'asker';
		$req[ Message::VALUE ] = 'GET_LAG';
		$c->fill( $req );

		$data           = $cap->captured[0][ Message::VALUE ]['data'];
		$segments       = $source->get_segments( true );
		$total_bytes    = (int) $segments[0]['size'];
		// line_remainder len = 3, so bytes_behind = total - 3.
		$this->assertSame( $total_bytes - 3, $data['bytes_behind'] );
	}

	public function test_handle_request_unknown_verb_returns_error_payload(): void {
		// Spec: unknown verbs reply with `[ 'error' => "unknown request verb: $VERB" ]`.
		$c   = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$cap = new CaptureSink();
		$c->sink( $cap );

		$req                   = Message::new_message();
		$req[ Message::TYPE ]  = Message::TM_REQUEST;
		$req[ Message::FROM ]  = 'asker';
		$req[ Message::VALUE ] = 'WHO_KNOWS';
		$c->fill( $req );

		$this->assertCount( 1, $cap->captured );
		$data = $cap->captured[0][ Message::VALUE ]['data'];
		$this->assertArrayHasKey( 'error', $data );
		$this->assertStringContainsString( 'WHO_KNOWS', $data['error'] );
		$this->assertSame( 'WHO_KNOWS', $cap->captured[0][ Message::VALUE ]['verb'] );
	}

	public function test_handle_request_verb_is_case_insensitive_and_strips_args(): void {
		// Spec: verb extraction is strtoupper(explode(' ', trim($value), 2)[0]).
		// "get_offset extra args" → GET_OFFSET.
		$c   = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$cap = new CaptureSink();
		$c->sink( $cap );

		$req                   = Message::new_message();
		$req[ Message::TYPE ]  = Message::TM_REQUEST;
		$req[ Message::FROM ]  = 'asker';
		$req[ Message::VALUE ] = '  get_offset trailing args ignored  ';
		$c->fill( $req );

		$reply = $cap->captured[0];
		$this->assertSame( 'GET_OFFSET', $reply[ Message::VALUE ]['verb'] );
		$data = $reply[ Message::VALUE ]['data'];
		// GET_OFFSET shape (not the error shape) — verifies the verb was
		// recognized after trim+upper+arg-strip.
		$this->assertArrayHasKey( 'cursor_seg', $data );
	}

	public function test_handle_request_reply_uses_stamp_override_in_FROM(): void {
		// IPC input Consumer (cli/scaffolding case): set_stamp_as('_repl') —
		// the request reply's FROM must use the override, NOT the underlying
		// name. Otherwise replies wouldn't route through the worker's _repl
		// Partition.
		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$c->name( 'real-name' );
		$c->set_stamp_as( '_repl' );

		$cap = new CaptureSink();
		$c->sink( $cap );

		$req                   = Message::new_message();
		$req[ Message::TYPE ]  = Message::TM_REQUEST;
		$req[ Message::FROM ]  = 'cli';
		$req[ Message::VALUE ] = 'GET_OFFSET';
		$c->fill( $req );

		$this->assertSame( '_repl', $cap->captured[0][ Message::FROM ], 'reply FROM uses stamp_override' );
	}

	// ============================================================================
	// resolve_downstream_targets() — Tee target expansion in checkpoint metadata.
	// ============================================================================

	public function test_resolve_downstream_targets_expands_Tee_to_its_targets(): void {
		// When the Consumer's target is a Tee, resolve_downstream_targets
		// expands the Tee's targets so the dashboard sees the actual
		// downstream processors (RequestBuilder, JobRouter, ...), not the
		// plumbing Tee in between.
		$processor_a = new CaptureSink();
		$processor_a->name( 'processor-a' );
		$processor_b = new CaptureSink();
		$processor_b->name( 'processor-b' );

		$tee = new \Newspack_Nodes\Tee();
		$tee->name( 'firehose:tee' );
		$tee->connect_node( 'processor-a' );
		$tee->connect_node( 'processor-b' );

		$source = new Partition( "{$this->tmp}/data", 0, 64 * 1024, 4, 86400 );
		$this->produce_line( $source, 'data' );

		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$c->name( 'firehose:consumer' );
		$c->target( 'firehose:tee' );
		$c->poll();
		$c->checkpoint();

		$offsetlog_path = "{$this->tmp}/offsets/r/p0/p0/0.log";
		$content        = (string) \file_get_contents( $offsetlog_path );
		$msg            = Message::unpacked( \rtrim( $content, "\n" ) );
		$entry          = $msg[ Message::VALUE ];

		$this->assertCount( 2, $entry['targets'], 'Tee must expand to N targets' );
		$names = \array_column( $entry['targets'], 'name' );
		$this->assertContains( 'processor-a', $names );
		$this->assertContains( 'processor-b', $names );
		// Class column is the ShortName of the registered node (CaptureSink here).
		foreach ( $entry['targets'] as $t ) {
			$this->assertSame( 'CaptureSink', $t['class'] );
		}
	}

	public function test_resolve_downstream_targets_handles_Tee_with_missing_inner_node(): void {
		// Tee fans to a name with no registered node — surface the name with
		// an empty class column rather than throwing or dropping the row.
		$tee = new \Newspack_Nodes\Tee();
		$tee->name( 'firehose:tee' );
		$tee->connect_node( 'ghost' ); // no Core::node('ghost') registered.

		$source = new Partition( "{$this->tmp}/data", 0, 64 * 1024, 4, 86400 );
		$this->produce_line( $source, 'data' );

		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$c->name( 'firehose:consumer' );
		$c->target( 'firehose:tee' );
		$c->poll();
		$c->checkpoint();

		$offsetlog_path = "{$this->tmp}/offsets/r/p0/p0/0.log";
		$content        = (string) \file_get_contents( $offsetlog_path );
		$msg            = Message::unpacked( \rtrim( $content, "\n" ) );
		$entry          = $msg[ Message::VALUE ];

		$this->assertCount( 1, $entry['targets'] );
		$this->assertSame( 'ghost', $entry['targets'][0]['name'] );
		$this->assertSame( '', $entry['targets'][0]['class'], 'missing target surfaces empty class' );
	}

	public function test_resolve_downstream_targets_skips_empty_string_in_Tee_targets(): void {
		// Tee's target array shouldn't contain '' in production, but if it
		// does (defensive), resolve_downstream_targets must skip it rather
		// than emit `{name:'', class:''}` rows.
		$tee = new \Newspack_Nodes\Tee();
		$tee->name( 'firehose:tee' );
		// Set target directly to an array with an empty string and a real one.
		$ref = new \ReflectionProperty( $tee, 'target' );
		$ref->setAccessible( true );
		$ref->setValue( $tee, [ '', 'real' ] );

		$real = new CaptureSink();
		$real->name( 'real' );

		$source = new Partition( "{$this->tmp}/data", 0, 64 * 1024, 4, 86400 );
		$this->produce_line( $source, 'data' );

		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$c->name( 'firehose:consumer' );
		$c->target( 'firehose:tee' );
		$c->poll();
		$c->checkpoint();

		$offsetlog_path = "{$this->tmp}/offsets/r/p0/p0/0.log";
		$content        = (string) \file_get_contents( $offsetlog_path );
		$msg            = Message::unpacked( \rtrim( $content, "\n" ) );
		$entry          = $msg[ Message::VALUE ];

		$this->assertCount( 1, $entry['targets'], 'empty-string target must be skipped' );
		$this->assertSame( 'real', $entry['targets'][0]['name'] );
	}

	public function test_resolve_downstream_targets_handles_Tee_with_non_array_target(): void {
		// Defensive branch: Tee object whose target is somehow a string
		// (corrupted state, mid-construction) collapses into a single-row
		// `{name:<consumer-target>, class:'Tee'}` entry.
		$tee = new \Newspack_Nodes\Tee();
		$tee->name( 'firehose:tee' );
		// Force target to a string — bypasses Tee's normal array form.
		$ref = new \ReflectionProperty( $tee, 'target' );
		$ref->setAccessible( true );
		$ref->setValue( $tee, 'unexpected-string' );

		$source = new Partition( "{$this->tmp}/data", 0, 64 * 1024, 4, 86400 );
		$this->produce_line( $source, 'data' );

		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$c->name( 'firehose:consumer' );
		$c->target( 'firehose:tee' );
		// Call resolve_downstream_targets directly via reflection so we test
		// just this branch in isolation.
		$c_ref = new \ReflectionClass( $c );
		$rdt   = $c_ref->getMethod( 'resolve_downstream_targets' );
		$rdt->setAccessible( true );
		$out = $rdt->invoke( $c );

		$this->assertCount( 1, $out );
		$this->assertSame( 'firehose:tee', $out[0]['name'] );
		$this->assertSame( 'Tee', $out[0]['class'] );
	}

	public function test_resolve_downstream_targets_returns_empty_when_no_target(): void {
		// Consumer with no target → returns []. Verified via the direct call
		// since the checkpoint() path always sets `targets` to whatever it
		// returns.
		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );

		$c_ref = new \ReflectionClass( $c );
		$rdt   = $c_ref->getMethod( 'resolve_downstream_targets' );
		$rdt->setAccessible( true );

		$this->assertSame( [], $rdt->invoke( $c ), 'no target → empty list' );
	}

	public function test_resolve_downstream_targets_handles_non_Tee_target_class(): void {
		// Target resolves to a non-Tee node — single-row `{name, class}` with
		// the actual node's ShortName.
		$processor = new CaptureSink();
		$processor->name( 'just-a-processor' );

		$source = new Partition( "{$this->tmp}/data", 0, 64 * 1024, 4, 86400 );
		$this->produce_line( $source, 'data' );

		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$c->name( 'firehose:consumer' );
		$c->target( 'just-a-processor' );
		$c->poll();
		$c->checkpoint();

		$offsetlog_path = "{$this->tmp}/offsets/r/p0/p0/0.log";
		$content        = (string) \file_get_contents( $offsetlog_path );
		$msg            = Message::unpacked( \rtrim( $content, "\n" ) );
		$entry          = $msg[ Message::VALUE ];

		$this->assertCount( 1, $entry['targets'] );
		$this->assertSame( 'just-a-processor', $entry['targets'][0]['name'] );
		$this->assertSame( 'CaptureSink', $entry['targets'][0]['class'] );
	}

	// ============================================================================
	// set_stamp_as — coverage of the standalone setter.
	// ============================================================================

	public function test_set_stamp_as_changes_FROM_stamp_on_emit(): void {
		// Standalone coverage of set_stamp_as(): empty default falls back to
		// $this->name, but once set it replaces it on every poll-emitted msg.
		$source = new Partition( "{$this->tmp}/data", 0, 64 * 1024, 4, 86400 );
		$this->produce_line( $source, 'one' );
		$this->produce_line( $source, 'two' );

		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$c->name( 'real' );
		$c->set_stamp_as( 'override-stamp' );
		$cap = new CaptureSink();
		$c->sink( $cap );
		$c->poll();

		$this->assertCount( 2, $cap->captured );
		$this->assertSame( 'override-stamp', $cap->captured[0][ Message::FROM ] );
		$this->assertSame( 'override-stamp', $cap->captured[1][ Message::FROM ] );

		// Re-set to '' — must fall back to name on the next emit.
		$c->set_stamp_as( '' );
		$this->produce_line( $source, 'three' );
		$c->poll();
		$this->assertSame( 'real', $cap->captured[2][ Message::FROM ] );
	}

	// ============================================================================
	// is_caught_up() — set_state transition emission to subscribers.
	// ============================================================================

	public function test_is_caught_up_emits_CAUGHT_UP_state_only_on_transition(): void {
		// is_caught_up() wraps compute_is_caught_up() with transition tracking
		// — set_state('CAUGHT_UP', $bool) fires ONLY when the boolean flips.
		// Subscribers can register on the event and see false→true→false
		// without per-poll churn.
		$source = new Partition( "{$this->tmp}/data", 0, 64 * 1024, 4, 86400 );

		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );

		// Manually inject a CAUGHT_UP listener via the registrations slot.
		// (set_state caches the payload and notifies all registrants.)
		$ref = new \ReflectionClass( $c );
		$rp  = $ref->getProperty( 'registrations' );
		$rp->setAccessible( true );
		$regs                  = $rp->getValue( $c );
		$regs['CAUGHT_UP']     = [];
		$rp->setValue( $c, $regs );

		$emits = [];
		$c->register( 'CAUGHT_UP', 'observer', static function ( $v ) use ( &$emits ): bool {
			$emits[] = $v;
			return true;
		} );
		// On register, the cached payload (none yet) is NOT replayed
		// because no set_state has fired — verified by emits == [].
		$this->assertSame( [], $emits, 'no prior set_state → register replays nothing' );

		// First is_caught_up() call: trivially true (no segments) → flips
		// from sentinel(-1) to 1 → set_state fires.
		$this->assertTrue( $c->is_caught_up() );
		$this->assertSame( [ true ], $emits, 'first observation must fire' );

		// Second call: same value → must NOT fire again.
		$this->assertTrue( $c->is_caught_up() );
		$this->assertSame( [ true ], $emits, 'duplicate state must NOT fire' );

		// Add bytes, repoll → cursor falls behind → state flips to false.
		$this->produce_line( $source, 'data' );
		\clearstatcache();
		$this->assertFalse( $c->is_caught_up() );
		$this->assertSame( [ true, false ], $emits, 'flip must fire again' );
	}

	// ============================================================================
	// Constructor: arguments() round-trip + ephemeral mode.
	// ============================================================================

	public function test_constructor_sets_arguments_for_dump_config_roundtrip(): void {
		// Constructor stores ctor args in $this->arguments so dump_config can
		// emit a `make_node Consumer NAME <base_dir> <partition> <offsetlog>`
		// line that re-creates this instance.
		$c = new Consumer( "{$this->tmp}/data", 2, "{$this->tmp}/offsets/r/p2" );
		$this->assertSame(
			"{$this->tmp}/data 2 {$this->tmp}/offsets/r/p2",
			$c->arguments()
		);
	}

	public function test_constructor_ephemeral_mode_records_empty_offsetlog_in_arguments(): void {
		// Ephemeral consumer (no offsetlog) — arguments still reflect the
		// trailing empty string so the make_node round-trip is unambiguous.
		$c = new Consumer( "{$this->tmp}/data", 0, '' );
		$this->assertSame( "{$this->tmp}/data 0 ", $c->arguments() );
	}

	// ============================================================================
	// node_schema() — palette manifest for the topology console.
	// ============================================================================

	public function test_node_schema_declares_io_category_and_request_verbs(): void {
		// Topology console reads node_schema() to render the palette entry.
		// Consumer is in the I/O category and declares two request verbs
		// (GET_LAG, GET_OFFSET) — both surfaceable in the topology editor
		// as introspection requests an operator can fire from the canvas.
		$schema = Consumer::node_schema();
		$this->assertIsArray( $schema );
		$this->assertSame( 'I/O', $schema['category'] );
		$this->assertNotSame( '', $schema['description'] );
		$this->assertIsArray( $schema['ctor'] );
		$this->assertIsArray( $schema['verbs'] );
		$this->assertSame( [], $schema['verbs'], 'Consumer has no sibling-CI verbs' );

		// Three ctor params: source_base_dir (required), source_partition
		// (required, default <partition>), offsetlog_base_dir (default '').
		$this->assertCount( 3, $schema['ctor'] );
		$names = \array_column( $schema['ctor'], 'name' );
		$this->assertSame(
			[ 'source_base_dir', 'source_partition', 'offsetlog_base_dir' ],
			$names
		);

		// Two request verbs: GET_LAG + GET_OFFSET with documented reply shapes.
		$this->assertCount( 2, $schema['requests'] );
		$verbs = \array_column( $schema['requests'], 'name' );
		$this->assertContains( 'GET_LAG', $verbs );
		$this->assertContains( 'GET_OFFSET', $verbs );
		foreach ( $schema['requests'] as $req ) {
			$this->assertNotSame( '', $req['description'] );
			$this->assertNotSame( '', $req['reply_shape'] );
		}
	}

	// ============================================================================
	// next_offset() — explicit array with default off when not provided.
	// ============================================================================

	public function test_next_offset_array_defaults_offset_to_zero_when_missing(): void {
		// Explicit-array form: seg=5 with no 'off' key. The off lookup uses
		// `? 0` so absent off lands at 0 — matches the spec "explicit position
		// with seg only".
		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$c->next_offset( [ 'seg' => 7 ] );

		$ref = new \ReflectionClass( $c );
		$seg = $ref->getProperty( 'cursor_seg' );
		$seg->setAccessible( true );
		$off = $ref->getProperty( 'cursor_off' );
		$off->setAccessible( true );

		$this->assertSame( 7, $seg->getValue( $c ) );
		$this->assertSame( 0, $off->getValue( $c ), 'missing off must default to 0' );
	}

	public function test_next_offset_array_defaults_seg_to_zero_when_missing(): void {
		// Explicit-array form: off=42 with no 'seg' key. Defaults to 0.
		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$c->next_offset( [ 'off' => 42 ] );

		$ref = new \ReflectionClass( $c );
		$seg = $ref->getProperty( 'cursor_seg' );
		$seg->setAccessible( true );
		$off = $ref->getProperty( 'cursor_off' );
		$off->setAccessible( true );

		$this->assertSame( 0, $seg->getValue( $c ) );
		$this->assertSame( 42, $off->getValue( $c ) );
	}

	public function test_next_offset_recent_with_single_segment_picks_that_one(): void {
		// 'recent' fallback: when there's only ONE segment, pick the oldest
		// (which is also the newest in that case). Distinct from the
		// already-tested multi-segment 'recent' path.
		$source = new Partition( "{$this->tmp}/data", 0, 64 * 1024, 4, 86400 );
		$this->produce_line( $source, 'only' );

		$segments = $source->get_segments( true );
		$this->assertCount( 1, $segments, 'precondition: single segment' );

		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$c->next_offset( 'recent' );

		$ref      = new \ReflectionClass( $c );
		$seg_prop = $ref->getProperty( 'cursor_seg' );
		$seg_prop->setAccessible( true );
		$off_prop = $ref->getProperty( 'cursor_off' );
		$off_prop->setAccessible( true );

		$this->assertSame( $segments[0]['id'], $seg_prop->getValue( $c ), 'single-segment recent picks that segment' );
		$this->assertSame( 0, $off_prop->getValue( $c ), 'recent always resets off to 0' );
	}

	public function test_next_offset_end_with_no_segments_leaves_cursor_at_default(): void {
		// 'end' on an empty source must NOT crash and must NOT advance the
		// cursor (segments empty → switch case is a no-op).
		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$c->next_offset( 'end' );

		$ref      = new \ReflectionClass( $c );
		$seg_prop = $ref->getProperty( 'cursor_seg' );
		$seg_prop->setAccessible( true );
		$off_prop = $ref->getProperty( 'cursor_off' );
		$off_prop->setAccessible( true );

		$this->assertSame( 0, $seg_prop->getValue( $c ) );
		$this->assertSame( 0, $off_prop->getValue( $c ) );
	}

	public function test_next_offset_recent_with_no_segments_leaves_cursor_at_default(): void {
		// 'recent' on an empty source must early-exit cleanly.
		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$c->next_offset( 'recent' );

		$ref      = new \ReflectionClass( $c );
		$seg_prop = $ref->getProperty( 'cursor_seg' );
		$seg_prop->setAccessible( true );
		$off_prop = $ref->getProperty( 'cursor_off' );
		$off_prop->setAccessible( true );

		$this->assertSame( 0, $seg_prop->getValue( $c ) );
		$this->assertSame( 0, $off_prop->getValue( $c ) );
	}

	// ============================================================================
	// open() — segments empty edge case (returns null).
	// ============================================================================

	public function test_open_returns_segment_metadata_when_cursor_matches_existing(): void {
		// open() with a cursor that matches an existing segment id returns
		// that segment's metadata without resetting cursor_off.
		$source = new Partition( "{$this->tmp}/data", 0, 64 * 1024, 4, 86400 );
		$this->produce_line( $source, 'hello' );

		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		// Cursor is parked on segment 0 by default; segment 0 exists.

		$ref      = new \ReflectionClass( $c );
		$off_prop = $ref->getProperty( 'cursor_off' );
		$off_prop->setAccessible( true );
		$off_prop->setValue( $c, 5 );

		$result = $c->open();
		$this->assertNotNull( $result );
		$this->assertSame( 0, $result['id'] );
		$this->assertGreaterThan( 0, $result['size'] );
		// cursor_off MUST NOT be reset when the segment is found.
		$this->assertSame( 5, $off_prop->getValue( $c ) );
	}

	// ============================================================================
	// load_offsetlog() — early-return when offsetlog disabled.
	// ============================================================================

	public function test_load_offsetlog_null_guard_returns_when_offsetlog_unset(): void {
		// Direct exercise of the null guard inside load_offsetlog: a
		// Consumer constructed with offsetlog_base_dir='' leaves
		// $this->offsetlog at null. Calling load_offsetlog() (via reflection)
		// must return immediately without touching the filesystem.
		$c = new Consumer( "{$this->tmp}/data", 0, '' );

		$ref    = new \ReflectionMethod( Consumer::class, 'load_offsetlog' );
		$ref->setAccessible( true );
		$ref->invoke( $c );

		// Cursor stays at default; no offsets directory appears.
		$rc      = new \ReflectionClass( $c );
		$seg     = $rc->getProperty( 'cursor_seg' );
		$seg->setAccessible( true );
		$off     = $rc->getProperty( 'cursor_off' );
		$off->setAccessible( true );
		$this->assertSame( 0, $seg->getValue( $c ) );
		$this->assertSame( 0, $off->getValue( $c ) );
		$this->assertFalse( \is_dir( "{$this->tmp}/offsets" ) );
	}

	// ============================================================================
	// poll() — empty-source early-exit and read-cap branches.
	// ============================================================================

	public function test_poll_empty_source_sets_at_eof_and_returns(): void {
		// poll() on an empty source (no segments) sets at_eof=true and
		// returns without emitting anything. Different from the cursor-
		// segment-deleted recovery branch since `empty($segments)` is the
		// first early-exit.
		$c   = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$cap = new CaptureSink();
		$c->sink( $cap );

		// Force at_eof to false so we can verify poll() flips it back.
		$ref    = new \ReflectionClass( $c );
		$at_eof = $ref->getProperty( 'at_eof' );
		$at_eof->setAccessible( true );
		$at_eof->setValue( $c, false );

		$c->poll();

		$this->assertCount( 0, $cap->captured );
		$this->assertTrue( $at_eof->getValue( $c ), 'empty source sets at_eof' );
	}

	public function test_poll_skips_segments_older_than_cursor(): void {
		// Cursor parked on a newer segment must skip older segments in the
		// poll loop. The `$s['id'] < $this->cursor_seg → continue` branch.
		$source = new Partition( "{$this->tmp}/data", 0, 32, 4, 86400 );
		$this->produce_line( $source, \str_repeat( 'a', 30 ) );
		$this->produce_line( $source, \str_repeat( 'b', 30 ) );
		$this->produce_line( $source, \str_repeat( 'c', 30 ) );

		$segments = $source->get_segments( true );
		$this->assertGreaterThanOrEqual( 2, \count( $segments ) );

		$c   = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$cap = new CaptureSink();
		$c->sink( $cap );

		// Park cursor at NEWEST segment, off=size so nothing to read.
		$ref      = new \ReflectionClass( $c );
		$seg_prop = $ref->getProperty( 'cursor_seg' );
		$seg_prop->setAccessible( true );
		$off_prop = $ref->getProperty( 'cursor_off' );
		$off_prop->setAccessible( true );

		$newest = \end( $segments );
		$seg_prop->setValue( $c, (int) $newest['id'] );
		$off_prop->setValue( $c, (int) $newest['size'] );

		$c->poll();

		$this->assertCount( 0, $cap->captured, 'no new bytes → no emissions' );
		// at_eof should be true after poll.
		$at_eof_prop = $ref->getProperty( 'at_eof' );
		$at_eof_prop->setAccessible( true );
		$this->assertTrue( $at_eof_prop->getValue( $c ) );
	}

	public function test_poll_skips_line_that_fails_unpacked_and_continues(): void {
		// A genuinely corrupt on-disk line (here a too-few-fields array that
		// Message::unpacked() rejects) followed by a valid packed line. The drain
		// loop must skip the bad line and still emit the following valid one, not
		// abort the poll. Written raw because packed() now slices to 7 fields, so
		// it can no longer be coaxed into emitting a malformed line itself.
		$seg_dir = "{$this->tmp}/data/p0";
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
		@\mkdir( $seg_dir, 0755, true );

		$good                   = Message::new_message();
		$good[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$good[ Message::VALUE ] = 'keepme';
		\file_put_contents( "{$seg_dir}/0.log", "[1,2,3]\n" . Message::packed( $good ) . "\n" );

		$c = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$capture = new CaptureSink();
		$c->sink( $capture );

		$c->poll();

		$values = \array_map( static fn ( $m ) => $m[ Message::VALUE ], $capture->captured );
		$this->assertSame( [ 'keepme' ], $values );
	}

	public function test_construct_ignores_unparseable_offsetlog_entry(): void {
		$source = new Partition( "{$this->tmp}/data", 0, 64 * 1024, 4, 86400 );
		$this->produce_line( $source, 'hello' );

		// Write a real checkpoint, then corrupt that entry in place at the same
		// byte length (segment size unchanged) so it is a complete-but-
		// unparseable offsetlog line. A fresh Consumer must seed past it without
		// throwing, starting from the default cursor (0/0).
		$c1 = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$c1->poll();
		$c1->checkpoint();
		unset( $c1 );

		$offsetlog_path = "{$this->tmp}/offsets/r/p0/p0/0.log";
		$content        = (string) \file_get_contents( $offsetlog_path );
		$nl             = \strpos( $content, "\n" );
		\file_put_contents( $offsetlog_path, \str_repeat( 'x', (int) $nl ) . \substr( $content, (int) $nl ) );
		\clearstatcache();

		$c2  = new Consumer( "{$this->tmp}/data", 0, "{$this->tmp}/offsets/r/p0" );
		$ref = new \ReflectionObject( $c2 );
		$seg = $ref->getProperty( 'cursor_seg' );
		$seg->setAccessible( true );
		$off = $ref->getProperty( 'cursor_off' );
		$off->setAccessible( true );
		$this->assertSame( 0, $seg->getValue( $c2 ) );
		$this->assertSame( 0, $off->getValue( $c2 ) );
	}
}
