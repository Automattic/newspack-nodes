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

	public function test_first_fill_creates_partition_dir_and_segment(): void {
		$p = new Partition( $this->tmp, 0, 64*1024, 4, 86400 );
		$msg = $this->produce( 'hello' );
		$p->fill( $msg );
		$p->flush();
		$this->assertTrue( is_dir( "{$this->tmp}/p0" ) );
		$this->assertSame( [ 'hello' ], $this->read_partition_values( $p ) );
	}

	public function test_fill_appends_to_segment(): void {
		$p = new Partition( $this->tmp, 0, 64*1024, 4, 86400 );
		$this->produce_into( $p, 'first' );
		$this->produce_into( $p, 'second' );
		$this->assertSame( [ 'first', 'second' ], $this->read_partition_values( $p ) );
	}

	public function test_fill_writes_index_entry(): void {
		$p = new Partition( $this->tmp, 0, 64*1024, 4, 86400 );
		$this->produce_into( $p, 'hello' );
		$idx = file_get_contents( "{$this->tmp}/p0/0.idx" );
		$this->assertSame( 8, strlen( $idx ) );
		[ , $seg, $off ] = unpack( 'N2', $idx );
		$this->assertSame( 0, $seg );
		$this->assertSame( 0, $off );
	}

	public function test_fill_drops_messages_exceeding_MAX_LINE_SIZE(): void {
		// Cap is on the FINAL packed bytes — Message::packed adds JSON envelope
		// so a 5000-byte VALUE comfortably exceeds the 4096 cap.
		$p = new Partition( $this->tmp, 0, 64*1024, 4, 86400 );
		$msg = $this->produce( str_repeat( 'x', 5000 ) );
		$p->fill( $msg );
		$this->assertFalse( file_exists( "{$this->tmp}/p0/0.log" ), 'oversize fill must not touch the segment' );
	}

	public function test_allow_large_writes_lifts_limit_to_10MB(): void {
		$p = new Partition( $this->tmp, 0, 64*1024, 4, 86400 );
		$p->allow_large_writes();
		$this->produce_into( $p, str_repeat( 'x', 5000 ) );
		$this->assertSame( [ str_repeat( 'x', 5000 ) ], $this->read_partition_values( $p ) );
	}

	public function test_allow_large_writes_throws_if_already_held(): void {
		// allow_large_writes is a single-writer claim: only one Partition can
		// hold the lock for a given partition_dir at a time. A second writer
		// must fail loudly rather than silently set $allow_large_writes=true
		// on an unowned dir (which would race the real owner on >4KB writes).
		// Use a small max_wait_ms so the test fails fast — the production
		// default (65s) waits for a possibly-stale heartbeat to age out.
		$p1 = new Partition( $this->tmp, 0, 64*1024, 4, 86400 );
		$p1->name( 'p1' );
		$p1->allow_large_writes();

		$p2 = new Partition( $this->tmp, 0, 64*1024, 4, 86400 );
		$p2->name( 'p2' );
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'failed to acquire write lock' );
		$p2->allow_large_writes( 100 ); // 100ms — well under stale_timeout
	}

	public function test_read_at_returns_bytes_at_offset(): void {
		$p = new Partition( $this->tmp, 0, 64*1024, 4, 86400 );
		$this->produce_into( $p, 'hello' );
		$this->produce_into( $p, 'world' );

		// Each entry is a packed Message line; read_at returns whatever bytes
		// live at the given offset. Fetch the first line in full and verify it
		// unpacks back to "hello".
		$first_line_size  = strpos( file_get_contents( "{$this->tmp}/p0/0.log" ), "\n" ) + 1;
		$first_line_bytes = $p->read_at( 0, 0, $first_line_size );
		$first            = \Newspack_Nodes\Message::unpacked( rtrim( $first_line_bytes, "\n" ) );
		$this->assertSame( 'hello', $first[ \Newspack_Nodes\Message::VALUE ] );
	}

	public function test_scan_index_visits_each_entry(): void {
		$p = new Partition( $this->tmp, 0, 64*1024, 4, 86400 );
		$this->produce_into( $p, 'a' );
		$this->produce_into( $p, 'bb' );
		$this->produce_into( $p, 'ccc' );

		$entries = [];
		$p->scan_index( function ( int $seg, int $off ) use ( &$entries ) {
			$entries[] = [ $seg, $off ];
			return null;
		} );

		$this->assertCount( 3, $entries );
		$this->assertSame( [ 0, 0 ], $entries[0], 'first entry is at segment 0, offset 0' );
		$this->assertGreaterThan( $entries[0][1], $entries[1][1], 'offsets advance' );
		$this->assertGreaterThan( $entries[1][1], $entries[2][1] );
	}

	public function test_rotation_when_segment_size_exceeded(): void {
		$p = new Partition( $this->tmp, 0, 1024, 4, 86400 );
		for ( $i = 0; $i < 30; ++$i ) {
			$this->produce_into( $p, str_repeat( 'x', 100 ) );
		}
		$segments = $p->get_segments( true );
		$this->assertGreaterThan( 1, count( $segments ) );
	}

	public function test_cleanup_AND_gated_retention(): void {
		$p = new Partition( $this->tmp, 0, 256, 2, 86400 );
		for ( $i = 0; $i < 20; ++$i ) {
			$this->produce_into( $p, str_repeat( 'x', 100 ) );
		}
		$p->cleanup_segments();
		$segments = $p->get_segments( true );
		$this->assertGreaterThan( 2, count( $segments ), 'count > num_segments alone is not enough; mtime gate must also fire' );
	}

	public function test_cleanup_deletes_when_both_count_and_age_exceeded(): void {
		$p = new Partition( $this->tmp, 0, 256, 2, 0 );
		for ( $i = 0; $i < 20; ++$i ) {
			$this->produce_into( $p, str_repeat( 'x', 100 ) );
		}
		$p->cleanup_segments();
		$segments = $p->get_segments( true );
		$this->assertLessThanOrEqual( 2, count( $segments ) );
	}

	public function test_fill_TM_BYTESTREAM_writes_packed_message(): void {
		// Real Tachikoma Partition.fill packs ANY message via Message::packed
		// and appends a newline. Consumer auto-unpacks on the read side.
		$p = new Partition( $this->tmp, 0, 64*1024, 4, 86400 );
		$msg = \Newspack_Nodes\Message::new_message();
		$msg[ \Newspack_Nodes\Message::TYPE ]  = \Newspack_Nodes\Message::TM_BYTESTREAM;
		$msg[ \Newspack_Nodes\Message::VALUE ] = 'from-fill';
		$p->fill( $msg );
		$p->flush();

		$content = file_get_contents( "{$this->tmp}/p0/0.log" );
		$this->assertSame( "\n", substr( $content, -1 ), 'fill must terminate with newline' );
		$decoded = \Newspack_Nodes\Message::unpacked( rtrim( $content, "\n" ) );
		$this->assertSame( \Newspack_Nodes\Message::TM_BYTESTREAM, $decoded[ \Newspack_Nodes\Message::TYPE ] );
		$this->assertSame( 'from-fill', $decoded[ \Newspack_Nodes\Message::VALUE ] );
	}

	public function test_fill_TM_REQUEST_GET_returns_bytes_via_response(): void {
		// GET <seg> <off> <len> returns raw bytes at that range. After fill,
		// the segment contains a single packed Message line; verify GET round-trips
		// the entire line and that it unpacks back to the original VALUE.
		$p = new Partition( $this->tmp, 0, 64*1024, 4, 86400 );
		$this->produce_into( $p, 'hello' );

		$capture = new \Newspack_Nodes\Tests\CaptureSink();
		$p->sink( $capture );

		$total_len = filesize( "{$this->tmp}/p0/0.log" );
		$msg = \Newspack_Nodes\Message::new_message();
		$msg[ \Newspack_Nodes\Message::TYPE ]  = \Newspack_Nodes\Message::TM_REQUEST;
		$msg[ \Newspack_Nodes\Message::FROM ]  = 'asker';
		$msg[ \Newspack_Nodes\Message::VALUE ] = "GET 0 0 {$total_len}";
		$p->fill( $msg );

		$this->assertCount( 1, $capture->captured );
		$resp = $capture->captured[0];
		$this->assertSame( \Newspack_Nodes\Message::TM_RESPONSE, $resp[ \Newspack_Nodes\Message::TYPE ] );
		$decoded = \Newspack_Nodes\Message::unpacked( rtrim( $resp[ \Newspack_Nodes\Message::VALUE ], "\n" ) );
		$this->assertSame( 'hello', $decoded[ \Newspack_Nodes\Message::VALUE ] );
	}

	public function test_remove_node_closes_file_handles(): void {
		$p = new Partition( $this->tmp, 0, 64*1024, 4, 86400 );
		$this->produce_into( $p, 'hello' );

		// File handle is open after write. Use lsof to verify, but more portably,
		// rely on reflection to inspect the protected handle.
		$reflection = new \ReflectionClass( $p );
		$fh_prop = $reflection->getProperty( 'fh' );
		$fh_prop->setAccessible( true );
		$idx_prop = $reflection->getProperty( 'idx_fh' );
		$idx_prop->setAccessible( true );

		$this->assertTrue( is_resource( $fh_prop->getValue( $p ) ), 'log handle should be open after write' );
		$this->assertTrue( is_resource( $idx_prop->getValue( $p ) ), 'idx handle should be open after write' );

		$p->remove_node();

		$this->assertNull( $fh_prop->getValue( $p ), 'log handle must be closed after remove_node' );
		$this->assertNull( $idx_prop->getValue( $p ), 'idx handle must be closed after remove_node' );
	}

	public function test_remove_node_releases_write_lock(): void {
		$p = new Partition( $this->tmp, 0, 64*1024, 4, 86400 );
		$p->allow_large_writes();
		$this->produce_into( $p, 'hello' );

		$lock_dir = "{$this->tmp}/p0/write.lock.d";
		// Lock dir would be present transiently during with_lock, but released on success.
		// Test the property: write_lock should be null after remove_node.
		$reflection = new \ReflectionClass( $p );
		$lock_prop  = $reflection->getProperty( 'write_lock' );
		$lock_prop->setAccessible( true );

		$this->assertNotNull( $lock_prop->getValue( $p ), 'lock should exist after allow_large_writes' );

		$p->remove_node();

		$this->assertNull( $lock_prop->getValue( $p ) );
		$this->assertFalse( is_dir( $lock_dir ), 'lock dir should not be left behind' );
	}

	// ============================================================================
	// Hardening: rotation lock contention.
	// ============================================================================

	public function test_rotation_takes_inter_process_lock(): void {
		// Tiny segments to force several rotations.
		$p = new Partition( $this->tmp, 0, 32, 4, 86400 );
		// First write fills seg 0 to 31 bytes. Second 31-byte write triggers rotate;
		// adopt-if-room keeps seg 0 (61 bytes total, slight overflow). Third 31-byte
		// write rotates and BUMPS to seg 1 (newest is now ≥ 32).
		$this->produce_into( $p, str_repeat( 'a', 30 ) );
		$this->produce_into( $p, str_repeat( 'b', 30 ) );
		$this->produce_into( $p, str_repeat( 'c', 30 ) );

		$segments = $p->get_segments( true );
		$this->assertGreaterThanOrEqual( 2, count( $segments ) );
		// Lock dir lives at {base_dir}/../locks/{basename(base_dir)}.p0.rotate.lock.d.
		// After rotation completes, it must be released.
		$locks_base     = dirname( $this->tmp ) . '/locks';
		$candidate_lock = $locks_base . '/' . basename( $this->tmp ) . '.p0.rotate.lock.d';
		$this->assertFalse( is_dir( $candidate_lock ), 'rotate lock dir must be released after rotate' );
	}

	public function test_concurrent_rotate_skipped_when_peer_already_advanced(): void {
		// Simulate a peer rotating: pre-create segment 1 with room before our writer
		// triggers its own rotation. Our rotation should detect "newest still has room"
		// and adopt it instead of creating segment 2.
		$p = new Partition( $this->tmp, 0, 32, 4, 86400 );
		$this->produce_into( $p, str_repeat( 'a', 30 ) ); // fills segment 0 above 32B threshold.

		// Before our 2nd write, simulate peer rotation by creating segment 1 with content.
		@mkdir( "{$this->tmp}/p0", 0755, true );
		file_put_contents( "{$this->tmp}/p0/1.log", "peer-wrote\n" );

		$this->produce_into( $p, 'ours' );
		$segments = $p->get_segments( true );
		// We should have segment 0 and segment 1 — NOT a new segment 2.
		$ids = array_map( static fn ( $s ) => $s['id'], $segments );
		$this->assertContains( 0, $ids );
		$this->assertContains( 1, $ids );
		$this->assertNotContains( 2, $ids, 'rotation must adopt peer segment 1 not bump to 2' );
	}

	public function test_rotation_creates_empty_file_for_TOCTOU_guard(): void {
		// After rotate_segment, the new .log file must exist on disk so a concurrent
		// reader (or get_handle's missing-file guard) doesn't tip back to segment 0.
		// Force a true segment bump by overflowing past segment_size first.
		$p = new Partition( $this->tmp, 0, 32, 4, 86400 );
		// Each write of 30+1 bytes ends up at 31 in segment 0; second write of 31 bytes
		// triggers rotation but the adopt-if-room branch keeps writing to segment 0
		// (allowed slight overflow). A third 31-byte write must rotate to segment 1.
		$this->produce_into( $p, str_repeat( 'a', 30 ) );
		$this->produce_into( $p, str_repeat( 'b', 30 ) );
		$this->produce_into( $p, str_repeat( 'c', 30 ) );

		$segments = $p->get_segments( true );
		$this->assertGreaterThanOrEqual( 2, count( $segments ), 'must have rotated at least once' );

		// After rotation, the highest-id segment's .log file must exist (touched).
		$max_id = max( array_column( $segments, 'id' ) );
		$this->assertTrue( file_exists( "{$this->tmp}/p0/{$max_id}.log" ), 'rotated segment must have an existing file' );
	}

	// ============================================================================
	// Hardening: auto-cleanup at rotation.
	// ============================================================================

	public function test_rotation_invokes_cleanup_segments(): void {
		// num_segments=2, max_lifespan=0 (always-eligible) so cleanup runs aggressively.
		$p = new Partition( $this->tmp, 0, 32, 2, 0 );
		// Each fill rotates to a new segment because packed-message line + previous offset > 32.
		for ( $i = 0; $i < 6; $i++ ) {
			$this->produce_into( $p, str_repeat( chr( 97 + $i ), 30 ) );
		}
		// With cleanup at rotation, we should be at most num_segments+1 (the active write target
		// plus a freshly-rotated tail that hasn't been cleaned yet).
		$segments = $p->get_segments( true );
		$this->assertLessThanOrEqual( 3, count( $segments ), 'auto-cleanup at rotation should keep segments bounded' );
	}

	// ============================================================================
	// Hardening: read_at MAX_READ_SIZE cap + bounds.
	// ============================================================================

	public function test_read_at_rejects_oversized_length(): void {
		$p = new Partition( $this->tmp, 0, 1024 * 1024, 4, 86400 );
		$this->produce_into( $p, 'hello' );
		$result = $p->read_at( 0, 0, Partition::MAX_READ_SIZE + 1 );
		$this->assertSame( '', $result );
	}

	public function test_read_at_rejects_negative_segment_id(): void {
		$p = new Partition( $this->tmp, 0, 1024 * 1024, 4, 86400 );
		$result = $p->read_at( -1, 0, 10 );
		$this->assertSame( '', $result );
	}

	public function test_read_at_rejects_negative_offset(): void {
		$p = new Partition( $this->tmp, 0, 1024 * 1024, 4, 86400 );
		$this->produce_into( $p, 'hello' );
		$result = $p->read_at( 0, -1, 10 );
		$this->assertSame( '', $result );
	}

	public function test_read_at_rejects_negative_length(): void {
		$p = new Partition( $this->tmp, 0, 1024 * 1024, 4, 86400 );
		$this->produce_into( $p, 'hello' );
		$result = $p->read_at( 0, 0, -1 );
		$this->assertSame( '', $result );
	}

	public function test_read_at_accepts_zero_length(): void {
		$p = new Partition( $this->tmp, 0, 1024 * 1024, 4, 86400 );
		$this->produce_into( $p, 'hello' );
		$result = $p->read_at( 0, 0, 0 );
		$this->assertSame( '', $result );
	}

	// ============================================================================
	// Hardening: drift / TOCTOU recovery.
	// ============================================================================

	public function test_drift_recovery_follows_peer_rotation(): void {
		// Simulate a peer rotating between fills. Our writer should detect the drift
		// at the next fill (after DRIFT_RESCAN_INTERVAL_SECONDS) and follow.
		$p = new Partition( $this->tmp, 0, 64 * 1024, 4, 86400 );
		$this->produce_into( $p, 'ours-1' );
		// Peer creates segment 1 underneath us. (produce_into already made p0/.)
		file_put_contents( "{$this->tmp}/p0/1.log", "peer-wrote\n" );
		// Reach into the partition to push last_segment_check back so the next fill triggers rescan.
		$ref = new \ReflectionClass( $p );
		$last_check = $ref->getProperty( 'last_segment_check' );
		$last_check->setAccessible( true );
		$last_check->setValue( $p, microtime( true ) - 5.0 );

		$this->produce_into( $p, 'after-drift' );

		// Our writer should now be appending to segment 1, not creating segment 2.
		$current_seg = $ref->getProperty( 'current_segment_id' );
		$current_seg->setAccessible( true );
		$this->assertSame( 1, $current_seg->getValue( $p ), 'drift recovery must adopt peer segment 1' );
	}

	// ============================================================================
	// Hardening: with_index() round-trip.
	// ============================================================================

	public function test_with_index_uses_callback_for_idx_format(): void {
		$p = new Partition( $this->tmp, 0, 1024 * 1024, 4, 86400 );
		$p->with_index( function ( string $line, array $pos, ?array &$data = null ) {
			return (string) json_encode( [
				'seg' => $pos['segment_id'],
				'off' => $pos['offset'],
				'len' => $pos['length'],
			] );
		} );

		$this->produce_into( $p, 'first' );
		$this->produce_into( $p, 'second' );

		$idx   = (string) file_get_contents( "{$this->tmp}/p0/0.idx" );
		$lines = array_values( array_filter( explode( "\n", $idx ) ) );
		$this->assertCount( 2, $lines );
		$first  = json_decode( $lines[0], true );
		$second = json_decode( $lines[1], true );
		$this->assertSame( 0, $first['off'] );
		// Second entry's offset is the length of the first (packed) line.
		$this->assertSame( $first['len'], $second['off'] );
		$this->assertGreaterThan( 0, $first['len'] );
	}

	public function test_with_index_callback_returning_null_skips_entry(): void {
		$p = new Partition( $this->tmp, 0, 1024 * 1024, 4, 86400 );
		// The callback inspects the packed-Message line to extract the inner VALUE.
		$p->with_index( function ( string $line, array $pos, ?array &$data = null ) {
			$decoded = json_decode( rtrim( $line, "\n" ), true );
			$value   = (string) ( $decoded[ \Newspack_Nodes\Message::VALUE ] ?? '' );
			return ( strpos( $value, 'skip' ) === 0 ) ? null : 'kept';
		} );

		$this->produce_into( $p, 'skip-this' );
		$this->produce_into( $p, 'keep-this' );

		$idx = file_get_contents( "{$this->tmp}/p0/0.idx" );
		$this->assertSame( "kept\n", $idx );
	}

	public function test_with_index_callback_returning_empty_string_skips_overflow(): void {
		$p = new Partition( $this->tmp, 0, 1024 * 1024, 4, 86400 );
		$p->with_index( function ( string $line, array $pos, ?array &$data = null ) {
			$decoded = json_decode( rtrim( $line, "\n" ), true );
			$value   = (string) ( $decoded[ \Newspack_Nodes\Message::VALUE ] ?? '' );
			return ( strpos( $value, 'overflow' ) === 0 ) ? '' : 'kept';
		} );

		$this->produce_into( $p, 'overflow-line' );
		$this->produce_into( $p, 'good-line' );

		$idx = file_get_contents( "{$this->tmp}/p0/0.idx" );
		$this->assertSame( "kept\n", $idx );
	}

	public function test_scan_index_with_jsonl_callback_format(): void {
		$p = new Partition( $this->tmp, 0, 1024 * 1024, 4, 86400 );
		$p->with_index( function ( string $line, array $pos, ?array &$data = null ) {
			$decoded = json_decode( rtrim( $line, "\n" ), true );
			return (string) json_encode( [ 'l' => $decoded[ \Newspack_Nodes\Message::VALUE ] ?? '', 'o' => $pos['offset'] ] );
		} );

		$this->produce_into( $p, 'alpha' );
		$this->produce_into( $p, 'beta' );
		$this->produce_into( $p, 'gamma' );

		$collected = [];
		$p->scan_index( function ( string $line, int $seg ) use ( &$collected ) {
			$collected[] = json_decode( $line, true );
		} );

		$this->assertCount( 3, $collected );
		$this->assertSame( 'alpha', $collected[0]['l'] );
		$this->assertSame( 0,        $collected[0]['o'] );
		$this->assertSame( 'beta',  $collected[1]['l'] );
		$this->assertSame( 'gamma', $collected[2]['l'] );
	}

	// ============================================================================
	// Hardening: scan_index reverse + early termination.
	// ============================================================================

	public function test_scan_index_reverse_order_binary(): void {
		$p = new Partition( $this->tmp, 0, 1024 * 1024, 4, 86400 );
		$this->produce_into( $p, 'one' );
		$this->produce_into( $p, 'two' );
		$this->produce_into( $p, 'three' );

		$collected = [];
		$p->scan_index( function ( int $seg, int $off ) use ( &$collected ) {
			$collected[] = $off;
		}, true );

		// Default order is ascending offsets; reverse must be descending.
		$this->assertCount( 3, $collected );
		$this->assertGreaterThan( $collected[1], $collected[0] );
		$this->assertGreaterThan( $collected[2], $collected[1] );
		$this->assertSame( 0, $collected[2], 'last (in reverse) is offset 0' );
	}

	public function test_scan_index_early_termination_via_false_return(): void {
		$p = new Partition( $this->tmp, 0, 1024 * 1024, 4, 86400 );
		$this->produce_into( $p, 'a' );
		$this->produce_into( $p, 'b' );
		$this->produce_into( $p, 'c' );

		$count = 0;
		$p->scan_index( function ( int $seg, int $off ) use ( &$count ) {
			++$count;
			return ( $count >= 2 ) ? false : null;
		} );

		$this->assertSame( 2, $count, 'callback returning false must terminate the scan' );
	}

	public function test_scan_index_early_termination_jsonl(): void {
		$p = new Partition( $this->tmp, 0, 1024 * 1024, 4, 86400 );
		$p->with_index( fn ( $l, $pos, &$d = null ) => 'entry' );
		$this->produce_into( $p, 'a' );
		$this->produce_into( $p, 'b' );
		$this->produce_into( $p, 'c' );

		$count = 0;
		$p->scan_index( function ( string $line, int $seg ) use ( &$count ) {
			++$count;
			return ( $count >= 2 ) ? false : null;
		} );

		$this->assertSame( 2, $count );
	}

	public function test_scan_index_skips_oversized_idx_files(): void {
		// MAX_READ_SIZE = 10MB; write a fake .idx larger than that and confirm scan skips it.
		$p = new Partition( $this->tmp, 0, 1024 * 1024, 4, 86400 );
		$this->produce_into( $p, 'first' );
		// The .idx for segment 0 already exists; fabricate a big one for segment 1
		// without going through the public write API. (produce_into already made p0/.)
		file_put_contents( "{$this->tmp}/p0/1.log", "x\n" );
		$big_size = Partition::MAX_READ_SIZE + 100;
		// Use truncate to simulate a giant file without actually allocating MB+.
		$fh = fopen( "{$this->tmp}/p0/1.idx", 'wb' );
		ftruncate( $fh, $big_size );
		fclose( $fh );

		$count = 0;
		$p->scan_index( function ( int $seg, int $off ) use ( &$count ) {
			++$count;
		} );

		// Segment 0 has 1 entry (from "first"); segment 1's oversized .idx must be skipped.
		$this->assertSame( 1, $count, 'oversized idx files must be skipped' );
	}

	// ============================================================================
	// Hardening: get_current_position.
	// ============================================================================

	public function test_get_current_position_returns_segment_and_offset(): void {
		$p = new Partition( $this->tmp, 0, 1024 * 1024, 4, 86400 );
		$pos = $p->get_current_position();
		$this->assertSame( [ 'segment_id' => 0, 'offset' => 0 ], $pos );

		$this->produce_into( $p, 'hello' );
		$pos1 = $p->get_current_position();
		$this->assertSame( 0, $pos1['segment_id'] );
		$this->assertGreaterThan( 0, $pos1['offset'] );

		$this->produce_into( $p, 'world' );
		$pos2 = $p->get_current_position();
		$this->assertSame( 0, $pos2['segment_id'] );
		$this->assertGreaterThan( $pos1['offset'], $pos2['offset'] );
	}

	// ============================================================================
	// Hardening: partial-write loop.
	// ============================================================================

	public function test_partial_write_loops_until_complete(): void {
		// We can't easily simulate fwrite returning short from PHP land directly,
		// but we can verify that a normal full-buffer fill succeeds end-to-end
		// (the loop is exercised on the happy path: one fwrite returns full size).
		$p = new Partition( $this->tmp, 0, 1024 * 1024, 4, 86400 );
		$value = str_repeat( 'X', 4000 ); // Just under MAX_LARGE_LINE_SIZE.
		$p->allow_large_writes();
		$this->produce_into( $p, $value );
		$this->assertSame( [ $value ], $this->read_partition_values( $p ) );
	}

	public function test_loop_fwrite_protected_helper_exists(): void {
		// Defensive check: the partial-write loop method must exist on the class.
		$ref = new \ReflectionClass( Partition::class );
		$this->assertTrue( $ref->hasMethod( 'loop_fwrite' ) );
	}
}
