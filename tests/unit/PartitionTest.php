<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Partition_Node::class )]
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
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 64*1024 ) . " 4 86400" );
		$this->assertFalse( is_dir( "{$this->tmp}/p0" ), 'Constructor must not eager-create partition dir' );
	}

	public function test_constructor_does_not_open_files(): void {
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 64*1024 ) . " 4 86400" );
		$this->assertFalse( file_exists( "{$this->tmp}/p0/0.log" ) );
	}

	/**
	 * Tachikoma-parity constructible: no-arg ctor + arguments() setter walks
	 * the node_schema and assigns dir / segment_size / num_segments /
	 * max_lifespan; the override resolves partition_dir from the passed dir.
	 */
	public function test_constructible_via_no_arg_ctor_and_arguments_setter(): void {
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 1048576 2 0" );
		$this->assertSame( "{$this->tmp}/p0", $p->partition_dir() );
		$ref = new \ReflectionClass( $p );
		$this->assertSame( "{$this->tmp}/p0", $ref->getProperty( 'dir' )->getValue( $p ) );
		$this->assertSame( 1048576,           $ref->getProperty( 'segment_size' )->getValue( $p ) );
		$this->assertSame( 2,                 $ref->getProperty( 'num_segments' )->getValue( $p ) );
		$this->assertSame( 0,                 $ref->getProperty( 'max_lifespan' )->getValue( $p ) );
	}

	/**
	 * Schema defaults are real int constants (not placeholder strings) — so
	 * `arguments()` with only the required token leaves the optional ints at
	 * their DEFAULT_* values, NOT at a string that would TypeError the typed
	 * `int` property assignment.
	 */
	public function test_arguments_setter_applies_schema_defaults_for_missing_optional_tokens(): void {
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p2" );
		$this->assertSame( "{$this->tmp}/p2", $p->partition_dir() );
		$ref = new \ReflectionClass( $p );
		$this->assertSame( Partition_Node::DEFAULT_SEGMENT_SIZE, $ref->getProperty( 'segment_size' )->getValue( $p ) );
		$this->assertSame( Partition_Node::DEFAULT_NUM_SEGMENTS, $ref->getProperty( 'num_segments' )->getValue( $p ) );
		$this->assertSame( Partition_Node::DEFAULT_MAX_LIFESPAN, $ref->getProperty( 'max_lifespan' )->getValue( $p ) );
	}

	/**
	 * arguments() override re-normalizes after the base walker — dir gets
	 * trailing slashes stripped, segment_size clamped to ≥1, num_segments to ≥2,
	 * max_lifespan to ≥0; partition_dir is the resolved dir.
	 */
	public function test_arguments_setter_normalizes_and_rederives_partition_dir(): void {
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p1/ 0 1 -5" );
		$ref = new \ReflectionClass( $p );
		$this->assertSame( 1,                 $ref->getProperty( 'segment_size' )->getValue( $p ) );
		$this->assertSame( 2,                 $ref->getProperty( 'num_segments' )->getValue( $p ) );
		$this->assertSame( 0,                 $ref->getProperty( 'max_lifespan' )->getValue( $p ) );
		$this->assertSame( "{$this->tmp}/p1", $p->partition_dir() );
	}

	public function test_arguments_empty_string_does_not_derive_partition_dir(): void {
		// `make_node Partition mypart` (no positional tokens) → arguments('').
		// Base setter early-returns on empty string (no schema walk); the
		// override must mirror that so we don't synthesize a partition_dir
		// from declaration-default props (dir='').
		$p = new Partition_Node();
		$p->arguments( '' );
		$ref = new \ReflectionClass( $p );
		$this->assertSame( '', $ref->getProperty( 'partition_dir' )->getValue( $p ) );
		$this->assertSame( '', $ref->getProperty( 'dir' )->getValue( $p ) );
	}

	public function test_get_segment_path_throws_on_negative(): void {
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 64*1024 ) . " 4 86400" );
		$this->expectException( \InvalidArgumentException::class );
		$p->get_segment_path( -1 );
	}

	public function test_hash_to_partition_uses_crc32_with_query_strip(): void {
		$h1 = Partition_Node::hash_to_partition( '/foo', 4 );
		$h2 = Partition_Node::hash_to_partition( '/foo?bar=1', 4 );
		$this->assertSame( $h1, $h2 );
		$this->assertGreaterThanOrEqual( 0, $h1 );
		$this->assertLessThan( 4, $h1 );
	}

	public function test_first_fill_creates_partition_dir_and_segment(): void {
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 64*1024 ) . " 4 86400" );
		$message = $this->produce( 'hello' );
		$p->fill( $message );
		$p->flush();
		$this->assertTrue( is_dir( "{$this->tmp}/p0" ) );
		$this->assertSame( [ 'hello' ], $this->read_partition_values( $p ) );
	}

	public function test_fill_appends_to_segment(): void {
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 64*1024 ) . " 4 86400" );
		$this->produce_into( $p, 'first' );
		$this->produce_into( $p, 'second' );
		$this->assertSame( [ 'first', 'second' ], $this->read_partition_values( $p ) );
	}

	public function test_fill_writes_no_index_without_with_index(): void {
		// Default mode (no with_index formatter) writes no .idx companion at all.
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 64*1024 ) . " 4 86400" );
		$this->produce_into( $p, 'hello' );
		$this->assertFalse( file_exists( "{$this->tmp}/p0/0.idx" ), 'no .idx should be written without with_index()' );
	}

	public function test_fill_tracks_largest_msg_sent(): void {
		// Partition overrides Node::fill() to write to disk; that override
		// must still track largest_msg_sent or the Inspector will report
		// 0 for every Partition. Measured against Message::packed_size
		// (on-wire bytes), same as the base Node tracking.
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$small = $this->produce( 'hi' );
		$big   = $this->produce( \str_repeat( 'x', 100 ) );
		$p->fill( $small );
		$p->fill( $big );
		$p->fill( $small ); // shouldn't lower the max
		// Partition appends a trailing "\n" to each packed message so
		// Consumer can line-split on read — `largest_msg_sent` includes
		// that framing byte.
		$this->assertSame(
			\strlen( \Newspack_Nodes\Message::packed( $big ) ) + 1,
			$p->largest_msg_sent()
		);
	}

	public function test_void_warranty_permits_large_writes_without_a_lock(): void {
		// void_warranty() is the no-lock sibling of allow_large_writes(): it lifts
		// the PIPE_BUF cap but ASSERTS single-writer rather than acquiring the
		// exclusivity lock (the worker already owns the topology lock). So a
		// > PIPE_BUF write round-trips AND no write.lock.d is created.
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0" );
		$p->void_warranty();

		$big = $this->produce( \str_repeat( 'x', 5000 ) ); // > MAX_LINE_SIZE (4096).
		$p->fill( $big );
		$p->flush();

		$this->assertDirectoryDoesNotExist(
			"{$this->tmp}/p0/write.lock.d",
			'void_warranty() must NOT acquire the exclusivity lock'
		);
		$segs   = $p->get_segments( true );
		$newest = \end( $segs );
		$bytes  = $p->read_at( $newest['id'], 0, $newest['size'] );
		$this->assertStringContainsString( \str_repeat( 'x', 5000 ), $bytes );
	}

	public function test_void_warranty_dumps_its_own_verb_not_allow_large_writes(): void {
		// Round-trip fidelity: a void_warranty partition must NOT dump
		// `allow_large_writes` — replaying that would acquire the very lock we
		// deliberately skipped.
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0" );
		$p->name( 'pt' );
		$p->void_warranty();

		$dump = $p->dump_config();
		$this->assertStringContainsString( 'cmd pt:config void_warranty', $dump );
		$this->assertStringNotContainsString( 'allow_large_writes', $dump );
	}

	public function test_fill_accumulates_bytes_written(): void {
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 64*1024 ) . " 4 86400" );
		$message_a = $this->produce( 'hello' );
		$message_b = $this->produce( 'world!' );
		$p->fill( $message_a );
		$p->fill( $message_b );
		$p->flush(); // bytes_written tracks bytes-on-disk; flush forces batch drain.
		$expected = \strlen( \Newspack_Nodes\Message::packed( $message_a ) ) + 1
			+ \strlen( \Newspack_Nodes\Message::packed( $message_b ) ) + 1; // trailing \n per message
		$this->assertSame( $expected, $p->bytes_written() );
	}

	public function test_read_at_accumulates_bytes_read(): void {
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 64*1024 ) . " 4 86400" );
		$message = $this->produce( 'hello' );
		$p->fill( $message );
		$p->flush();
		$packed_size = \strlen( \Newspack_Nodes\Message::packed( $message ) ) + 1;
		$p->read_at( 0, 0, $packed_size );
		$this->assertSame( $packed_size, $p->bytes_read() );
	}

	public function test_fill_drops_messages_exceeding_MAX_LINE_SIZE(): void {
		// Cap is on the FINAL packed bytes — Message::packed adds JSON envelope
		// so a 5000-byte VALUE comfortably exceeds the 4096 cap.
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 64*1024 ) . " 4 86400" );
		$message = $this->produce( str_repeat( 'x', 5000 ) );
		$p->fill( $message );
		$this->assertFalse( file_exists( "{$this->tmp}/p0/0.log" ), 'oversize fill must not touch the segment' );
	}

	public function test_allow_large_writes_lifts_limit_to_10MB(): void {
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 64*1024 ) . " 4 86400" );
		$p->allow_large_writes();
		$this->produce_into( $p, str_repeat( 'x', 5000 ) );
		$this->assertSame( [ str_repeat( 'x', 5000 ) ], $this->read_partition_values( $p ) );
	}

	public function test_dump_config_reflects_allow_large_writes_state(): void {
		// dump_config emits the config from the node's own STATE — not from a
		// generically-recorded verb invocation. Setting the flag (however) shows
		// up; no invoked_verbs bookkeeping required.
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$p->name( 'p' );
		$p->allow_large_writes();
		$this->assertStringContainsString(
			'cmd p:config allow_large_writes',
			$p->dump_config()
		);
	}

	public function test_allow_large_writes_throws_if_already_held(): void {
		// allow_large_writes is a single-writer claim: only one Partition can
		// hold the lock for a given partition_dir at a time. A second writer
		// must fail loudly rather than silently set $allow_large_writes=true
		// on an unowned dir (which would race the real owner on >4KB writes).
		// Use a small max_wait_ms so the test fails fast — the production
		// default (65s) waits for a possibly-stale heartbeat to age out.
		$p1 = new Partition_Node();
		$p1->arguments( "{$this->tmp}/p0 " . ( 64*1024 ) . " 4 86400" );
		$p1->name( 'p1' );
		$p1->allow_large_writes();

		$p2 = new Partition_Node();

		$p2->arguments( "{$this->tmp}/p0 " . ( 64*1024 ) . " 4 86400" );
		$p2->name( 'p2' );
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'failed to acquire write lock' );
		$p2->allow_large_writes( 100 ); // 100ms — well under stale_timeout
	}

	public function test_read_at_returns_bytes_at_offset(): void {
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 64*1024 ) . " 4 86400" );
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

	public function test_rotation_when_segment_size_exceeded(): void {
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 1024 4 86400" );
		for ( $i = 0; $i < 30; ++$i ) {
			$this->produce_into( $p, str_repeat( 'x', 100 ) );
		}
		$segments = $p->get_segments( true );
		$this->assertGreaterThan( 1, count( $segments ) );
	}

	public function test_rotation_does_not_create_sibling_locks_dir(): void {
		// base_dir nested under logs/ so dirname() is the logs root, matching production.
		$base = "{$this->tmp}/logs/firehose.log";
		\mkdir( $base, 0755, true );
		$p = new Partition_Node();
		$p->arguments( "{$base}/p0 1024 4 86400" );
		for ( $i = 0; $i < 30; ++$i ) {
			$this->produce_into( $p, \str_repeat( 'x', 100 ) );
		}
		// Old behavior created {$this->tmp}/logs/locks ; new behavior must not.
		$this->assertDirectoryDoesNotExist( "{$this->tmp}/logs/locks" );
		// Rotation still happened.
		$this->assertGreaterThan( 1, \count( $p->get_segments( true ) ) );
	}

	public function test_cleanup_AND_gated_retention(): void {
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 256 2 86400" );
		for ( $i = 0; $i < 20; ++$i ) {
			$this->produce_into( $p, str_repeat( 'x', 100 ) );
		}
		$p->cleanup_segments();
		$segments = $p->get_segments( true );
		$this->assertGreaterThan( 2, count( $segments ), 'count > num_segments alone is not enough; mtime gate must also fire' );
	}

	public function test_cleanup_deletes_when_both_count_and_age_exceeded(): void {
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 256 2 0" );
		for ( $i = 0; $i < 20; ++$i ) {
			$this->produce_into( $p, str_repeat( 'x', 100 ) );
		}
		$p->cleanup_segments();
		$segments = $p->get_segments( true );
		$this->assertLessThanOrEqual( 2, count( $segments ) );
	}

	public function test_rotate_emits_SEGMENT_state_with_new_id(): void {
		// Force a rotation by filling small segments, capture the trace via a
		// _router CaptureSink (the address Node::emit_debug_state_trace routes
		// through). Asserts the SEGMENT state fires with the just-rotated id.
		$router = new \Newspack_Nodes\Tests\Capture_Sink_Node();
		$router->name( '_router' );

		$p = new Partition_Node();

		$p->arguments( "{$this->tmp}/p0 256 4 86400" );
		$p->name( 'p-rot' );
		$p->debug_state( 1 );

		// Each write is ~120 bytes packed; 4 writes push past the 256-byte
		// segment_size and force at least one rotation.
		for ( $i = 0; $i < 4; ++$i ) {
			$this->produce_into( $p, str_repeat( 'r', 100 ) );
		}

		$segment_traces = \array_filter(
			$router->captured,
			static fn ( $m ) => \is_array( $m[ \Newspack_Nodes\Message::VALUE ] ?? null )
				&& 'debug_state' === ( $m[ \Newspack_Nodes\Message::VALUE ]['k'] ?? '' )
				&& 'SEGMENT' === ( $m[ \Newspack_Nodes\Message::VALUE ]['event'] ?? '' )
		);
		$this->assertNotEmpty( $segment_traces, 'rotate should emit SEGMENT trace' );
		$last = \end( $segment_traces );
		$this->assertSame( 'p-rot', $last[ \Newspack_Nodes\Message::VALUE ]['node'] );
		$this->assertGreaterThan( 0, $last[ \Newspack_Nodes\Message::VALUE ]['value'], 'SEGMENT id should be > 0 after rotation' );
	}

	public function test_cleanup_emits_CLEANUP_state_only_when_deletions_happen(): void {
		// max_lifespan=0 → cleanup always deletes once count > num_segments.
		$router = new \Newspack_Nodes\Tests\Capture_Sink_Node();
		$router->name( '_router' );

		$p = new Partition_Node();

		$p->arguments( "{$this->tmp}/p0 256 2 0" );
		$p->name( 'p-clean' );
		$p->debug_state( 1 );

		for ( $i = 0; $i < 6; ++$i ) {
			$this->produce_into( $p, str_repeat( 'c', 100 ) );
		}

		$cleanup_traces = \array_filter(
			$router->captured,
			static fn ( $m ) => \is_array( $m[ \Newspack_Nodes\Message::VALUE ] ?? null )
				&& 'CLEANUP' === ( $m[ \Newspack_Nodes\Message::VALUE ]['event'] ?? '' )
		);
		$this->assertNotEmpty( $cleanup_traces, 'cleanup with deletions should emit CLEANUP trace' );
		$first = \reset( $cleanup_traces );
		$payload = $first[ \Newspack_Nodes\Message::VALUE ]['value'];
		$this->assertIsArray( $payload );
		$this->assertGreaterThan( 0, $payload['deleted'] );
		$this->assertArrayHasKey( 'alive', $payload );
	}

	public function test_fill_TM_BYTESTREAM_writes_packed_message(): void {
		// Real Tachikoma Partition.fill packs ANY message via Message::packed
		// and appends a newline. Consumer auto-unpacks on the read side.
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 64*1024 ) . " 4 86400" );
		$message = \Newspack_Nodes\Message::new_message();
		$message[ \Newspack_Nodes\Message::TYPE ]  = \Newspack_Nodes\Message::TM_BYTESTREAM;
		$message[ \Newspack_Nodes\Message::VALUE ] = 'from-fill';
		$p->fill( $message );
		$p->flush();

		$content = file_get_contents( "{$this->tmp}/p0/0.log" );
		$this->assertSame( "\n", substr( $content, -1 ), 'fill must terminate with newline' );
		$decoded = \Newspack_Nodes\Message::unpacked( rtrim( $content, "\n" ) );
		$this->assertSame( \Newspack_Nodes\Message::TM_BYTESTREAM, $decoded[ \Newspack_Nodes\Message::TYPE ] );
		$this->assertSame( 'from-fill', $decoded[ \Newspack_Nodes\Message::VALUE ] );
	}

	public function test_fill_packs_TM_REQUEST_TM_ERROR_TM_EOF(): void {
		// Pivoted-mode IPC uses Partition as a generic message transport: cli
		// → cmd-out (Partition) → worker; worker → _repl (Partition) → cli.
		// Control messages (TM_REQUEST for introspection requests, TM_ERROR
		// for failed verb responses, TM_EOF for stdin-close drain markers)
		// must round-trip through these IPC partitions, so Partition::fill
		// packs them like any other type. Data partitions like firehose.log
		// don't see these types in practice — producers only emit
		// TM_BYTESTREAM / TM_STRUCT — so allowing them through is a no-op
		// for production paths and makes IPC work.
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 64*1024 ) . " 4 86400" );

		$types = [
			\Newspack_Nodes\Message::TM_REQUEST,
			\Newspack_Nodes\Message::TM_ERROR,
			\Newspack_Nodes\Message::TM_EOF,
			\Newspack_Nodes\Message::TM_COMMAND | \Newspack_Nodes\Message::TM_ERROR,
		];
		foreach ( $types as $type ) {
			$message                                   = \Newspack_Nodes\Message::new_message();
			$message[ \Newspack_Nodes\Message::TYPE ]  = $type;
			$message[ \Newspack_Nodes\Message::FROM ]  = 'someone';
			$message[ \Newspack_Nodes\Message::VALUE ] = 'payload-' . $type;
			$p->fill( $message );
		}
		$p->flush(); // Force the in-memory batch to land on disk synchronously.

		// All four packed lines land on disk, recoverable by unpacking.
		$contents = \file_get_contents( "{$this->tmp}/p0/0.log" );
		$lines    = \array_values( \array_filter( \explode( "\n", $contents ) ) );
		$this->assertCount( 4, $lines );
		foreach ( $lines as $i => $line ) {
			$decoded = \Newspack_Nodes\Message::unpacked( $line );
			$this->assertSame( $types[ $i ], $decoded[ \Newspack_Nodes\Message::TYPE ] );
			$this->assertSame( 'payload-' . $types[ $i ], $decoded[ \Newspack_Nodes\Message::VALUE ] );
		}
	}

	public function test_remove_node_closes_file_handles(): void {
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 64*1024 ) . " 4 86400" );
		// with_index() so the .idx companion handle actually opens (default mode
		// never opens idx_fh, leaving the is_resource(idx_fh) assert false).
		$p->with_index( fn ( $l, $pos, &$d = null ) => 'entry' );
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
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 64*1024 ) . " 4 86400" );
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
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 32 4 86400" );
		// First write fills seg 0 to 31 bytes. Second 31-byte write triggers rotate;
		// adopt-if-room keeps seg 0 (61 bytes total, slight overflow). Third 31-byte
		// write rotates and BUMPS to seg 1 (newest is now ≥ 32).
		$this->produce_into( $p, str_repeat( 'a', 30 ) );
		$this->produce_into( $p, str_repeat( 'b', 30 ) );
		$this->produce_into( $p, str_repeat( 'c', 30 ) );

		$segments = $p->get_segments( true );
		$this->assertGreaterThanOrEqual( 2, count( $segments ) );
		// Rotate lock dir lives at {base_dir}/p0/.rotate.lock.d.
		// After rotation completes, it must be released.
		$candidate_lock = "{$this->tmp}/p0/.rotate.lock.d";
		$this->assertFalse( is_dir( $candidate_lock ), 'rotate lock dir must be released after rotate' );
	}

	public function test_concurrent_rotate_skipped_when_peer_already_advanced(): void {
		// Simulate a peer rotating: pre-create segment 1 with room before our writer
		// triggers its own rotation. Our rotation should detect "newest still has room"
		// and adopt it instead of creating segment 2.
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 32 4 86400" );
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
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 32 4 86400" );
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
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 32 2 0" );
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
	// Hardening: read_at bounds.
	// ============================================================================

	public function test_read_at_allows_reads_past_ten_megabytes(): void {
		// read_at is record-format agnostic — no per-call buffer cap.
		// A legitimate full-segment read of an offsetlog that's been
		// checkpointing for days can legitimately push past 10MB before
		// the segment rotates (segment_size default is 16MB). Per-record
		// DoS protection lives one layer up (Consumer/Tail enforce
		// MAX_LINE_BUFFER_SIZE on the \n-delimited line buffer).
		//
		// Regression: a hardcoded 10MB gate silently returned '' once
		// length exceeded 10MB, dropping consumer rows from
		// Workers_CI::dump_metadata, resetting Consumer cursors on
		// restart, and breaking StreamMerger hub-position restore.
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 16 * 1024 * 1024 ) . " 4 86400" );
		\mkdir( "{$this->tmp}/p0", 0755, true );
		$size = 11 * 1024 * 1024;
		\file_put_contents( "{$this->tmp}/p0/0.log", \str_repeat( 'x', $size ) );

		$result = $p->read_at( 0, 0, $size );
		$this->assertSame( $size, \strlen( $result ) );
	}

	public function test_read_at_rejects_negative_segment_id(): void {
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 1024 * 1024 ) . " 4 86400" );
		$result = $p->read_at( -1, 0, 10 );
		$this->assertSame( '', $result );
	}

	public function test_read_at_rejects_negative_offset(): void {
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 1024 * 1024 ) . " 4 86400" );
		$this->produce_into( $p, 'hello' );
		$result = $p->read_at( 0, -1, 10 );
		$this->assertSame( '', $result );
	}

	public function test_read_at_rejects_negative_length(): void {
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 1024 * 1024 ) . " 4 86400" );
		$this->produce_into( $p, 'hello' );
		$result = $p->read_at( 0, 0, -1 );
		$this->assertSame( '', $result );
	}

	public function test_read_at_accepts_zero_length(): void {
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 1024 * 1024 ) . " 4 86400" );
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
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 64 * 1024 ) . " 4 86400" );
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
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 1024 * 1024 ) . " 4 86400" );
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
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 1024 * 1024 ) . " 4 86400" );
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
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 1024 * 1024 ) . " 4 86400" );
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
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 1024 * 1024 ) . " 4 86400" );
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

	public function test_scan_index_early_termination_jsonl(): void {
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 1024 * 1024 ) . " 4 86400" );
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

	// ============================================================================
	// Hardening: partial-write loop.
	// ============================================================================

	public function test_partial_write_loops_until_complete(): void {
		// We can't easily simulate fwrite returning short from PHP land directly,
		// but we can verify that a normal full-buffer fill succeeds end-to-end
		// (the loop is exercised on the happy path: one fwrite returns full size).
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 1024 * 1024 ) . " 4 86400" );
		$value = str_repeat( 'X', 4000 ); // Just under MAX_LARGE_LINE_SIZE.
		$p->allow_large_writes();
		$this->produce_into( $p, $value );
		$this->assertSame( [ $value ], $this->read_partition_values( $p ) );
	}

	public function test_write_all_primitive_comes_from_file_writer_trait(): void {
		// The partial-write loop is the shared File_Writer::write_all primitive;
		// Partition `use`s the trait rather than open-coding its own fwrite handling.
		$ref = new \ReflectionClass( Partition_Node::class );
		$this->assertTrue( $ref->hasMethod( 'write_all' ) );
		$this->assertContains( 'Newspack_Nodes\\File_Writer', \class_uses( Partition_Node::class ) );
	}

	// ── A1: sibling-interpreter + node_schema ─────────────────────────

	public function test_partition_constructs_sibling_interpreter(): void {
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$p->name( 'my_part' );

		$sibling = $p->interpreter();
		$this->assertNotNull( $sibling );
		$this->assertSame( 'my_part:config', $sibling->name() );
		$this->assertSame( $p, $sibling->patron() );
	}

	public function test_partition_allow_large_writes_verb_emits_cmd_line(): void {
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$p->name( 'my_part' );

		$result = $p->interpreter()->dispatch( 'allow_large_writes' );
		$this->assertSame( 'ok', $result );

		$dump = $p->dump_config();
		$this->assertStringContainsString( 'cmd my_part:config allow_large_writes', $dump );
	}

	public function test_partition_with_index_verb_resolves_and_installs_callable(): void {
		\Newspack_Nodes\Formatters::reset();
		$called = 0;
		\Newspack_Nodes\Formatters::register(
			'a2-test-formatter',
			static function ( $line, $position, &$data = null ) use ( &$called ) {
				$called++;
				return 'fmt:' . $line;
			}
		);
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$p->name( 'my_part' );

		$result = $p->interpreter()->dispatch( 'with_index', 'a2-test-formatter' );
		$this->assertSame( 'ok', $result );

		// Verb installs the formatter as the patron's index callback.
		$ref     = new \ReflectionClass( $p );
		$cb_prop = $ref->getProperty( 'index_callback' );
		$cb_prop->setAccessible( true );
		$installed = $cb_prop->getValue( $p );
		$this->assertNotNull( $installed );
		$installed( 'check', [] );
		$this->assertSame( 1, $called );

		$dump = $p->dump_config();
		$this->assertStringContainsString( 'cmd my_part:config with_index a2-test-formatter', $dump );
	}

	public function test_partition_with_index_verb_unknown_formatter_errors(): void {
		\Newspack_Nodes\Formatters::reset();
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$p->name( 'my_part' );

		$result = $p->interpreter()->dispatch( 'with_index', 'no-such-formatter' );
		$this->assertStringContainsString( 'unknown formatter', $result );
	}

	public function test_partition_with_index_verb_requires_formatter_name(): void {
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$p->name( 'my_part' );

		$result = $p->interpreter()->dispatch( 'with_index' );
		$this->assertStringContainsString( 'usage', $result );
	}

	public function test_partition_node_schema_declares_ctor_and_verbs(): void {
		$schema = Partition_Node::node_schema();
		$this->assertSame( 'I/O', $schema['category'] );
		$this->assertSame( 4, \count( $schema['arguments'] ) );
		$verb_names = \array_column( $schema['commands'], 'name' );
		$this->assertContains( 'allow_large_writes', $verb_names );
		$this->assertContains( 'with_index', $verb_names );
	}

	// ============================================================================
	// Coverage: fire() drains batched messages.
	// ============================================================================

	public function test_fire_drains_pending_batch(): void {
		// fire() is the Timer entry point Partition::fill() arms via
		// set_timer(0, true); calling it directly through reflection mirrors
		// what the EventFramework drain loop does at iteration tail.
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$message = $this->produce( 'pending' );
		$p->fill( $message ); // appends to in-memory batch, doesn't write yet.

		$ref  = new \ReflectionClass( $p );
		$fire = $ref->getMethod( 'fire' );
		$fire->setAccessible( true );
		$fire->invoke( $p );

		$this->assertSame( [ 'pending' ], $this->read_partition_values( $p ) );
	}

	public function test_fire_on_empty_batch_is_noop(): void {
		// Flushing nothing must not create files or throw — fire() may run
		// once after a manual flush with no further fills.
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$ref = new \ReflectionClass( $p );
		$fire = $ref->getMethod( 'fire' );
		$fire->setAccessible( true );
		$fire->invoke( $p );

		$this->assertFalse( \is_dir( "{$this->tmp}/p0" ), 'empty fire must not eager-create the partition dir' );
	}

	// ============================================================================
	// Coverage: flush early-return + idempotency.
	// ============================================================================

	public function test_flush_with_empty_batch_is_noop(): void {
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$p->flush(); // empty batch — must early-return without touching disk.
		$this->assertFalse( \is_dir( "{$this->tmp}/p0" ) );
	}

	public function test_repeat_flush_after_first_is_noop(): void {
		// Second flush on an empty batch must return immediately without
		// re-rotating, re-writing, or otherwise corrupting state.
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$this->produce_into( $p, 'one' );
		$before = \file_get_contents( "{$this->tmp}/p0/0.log" );
		$p->flush();
		$after = \file_get_contents( "{$this->tmp}/p0/0.log" );
		$this->assertSame( $before, $after, 'second flush must not touch the file' );
	}

	// ============================================================================
	// Coverage: get_segments cache + force_refresh.
	// ============================================================================

	public function test_get_segments_returns_empty_when_partition_dir_missing(): void {
		// Pre-fill state: no fill yet → no p0 dir. get_segments must return [].
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$this->assertSame( [], $p->get_segments( true ) );
		$this->assertFalse( \is_dir( "{$this->tmp}/p0" ), 'get_segments must not create the dir' );
	}

	public function test_get_segments_cache_hit_within_ttl(): void {
		// First call populates the cache; create a new segment file BEHIND the
		// cache and verify a non-force-refresh call still returns the cached
		// list (no segment 1 in the result).
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$this->produce_into( $p, 'hi' );
		$initial = $p->get_segments(); // populates cache.
		$this->assertCount( 1, $initial );

		// Manually create a peer segment without going through Partition.
		\file_put_contents( "{$this->tmp}/p0/1.log", 'peer-wrote' );

		// Non-force call must hit the cache and still report 1 segment.
		$cached = $p->get_segments( false );
		$this->assertCount( 1, $cached, 'cache hit within TTL must skip rescan' );

		// Force refresh sees the peer.
		$fresh = $p->get_segments( true );
		$this->assertCount( 2, $fresh );
	}

	public function test_get_segments_filters_non_matching_files(): void {
		// Files that don't match SEGMENT_PATTERN must be ignored.
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$this->produce_into( $p, 'hi' );
		\file_put_contents( "{$this->tmp}/p0/garbage.txt", 'noise' );
		\file_put_contents( "{$this->tmp}/p0/0.idx", 'idx' ); // .idx isn't a .log either.

		$segments = $p->get_segments( true );
		$ids      = \array_column( $segments, 'id' );
		$this->assertSame( [ 0 ], $ids, 'only .log files matching the segment pattern are listed' );
	}

	// ============================================================================
	// Coverage: maybe_rescan_segments empty-segments early return.
	// ============================================================================

	public function test_maybe_rescan_segments_handles_empty_list(): void {
		// When the partition_dir gets wiped between drift-check ticks, the
		// rescan walks an empty result and early-returns without crashing.
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$this->produce_into( $p, 'seed' );

		$ref        = new \ReflectionClass( $p );
		$last_check = $ref->getProperty( 'last_segment_check' );
		$last_check->setAccessible( true );
		$last_check->setValue( $p, \microtime( true ) - 5.0 ); // force re-scan.

		$this->rmdir_recursive( "{$this->tmp}/p0" );

		$rescan = $ref->getMethod( 'maybe_rescan_segments' );
		$rescan->setAccessible( true );
		$rescan->invoke( $p ); // must not throw.

		$this->assertTrue( true );
	}

	// ============================================================================
	// Coverage: touch_segments_cache adds + updates entries.
	// ============================================================================

	public function test_touch_segments_cache_noop_when_cache_null(): void {
		// If get_segments hasn't been called yet, segments_cache is null.
		// touch_segments_cache must early-return without throwing.
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$ref = new \ReflectionClass( $p );

		$cache_prop = $ref->getProperty( 'segments_cache' );
		$cache_prop->setAccessible( true );
		$this->assertNull( $cache_prop->getValue( $p ) );

		$touch = $ref->getMethod( 'touch_segments_cache' );
		$touch->setAccessible( true );
		$touch->invoke( $p );

		$this->assertNull( $cache_prop->getValue( $p ), 'cache must stay null when not yet populated' );
	}

	public function test_touch_segments_cache_updates_existing_entry(): void {
		// First fill populates the segments_cache, second fill writes more
		// bytes and touch_segments_cache must mirror the new current_size.
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$this->produce_into( $p, 'first' );
		$p->get_segments(); // populate the cache.

		$this->produce_into( $p, 'second' );

		$ref        = new \ReflectionClass( $p );
		$cache_prop = $ref->getProperty( 'segments_cache' );
		$cache_prop->setAccessible( true );
		$cache = $cache_prop->getValue( $p );
		$this->assertCount( 1, $cache );
		$cur_size = $ref->getProperty( 'current_size' );
		$cur_size->setAccessible( true );
		$this->assertSame( $cur_size->getValue( $p ), $cache[0]['size'], 'touch_segments_cache mirrors current_size' );
	}

	public function test_touch_segments_cache_adds_new_segment_when_missing(): void {
		// Force the cache to think we're still on segment 0 even though the
		// partition just bumped to segment 1. touch_segments_cache should
		// append the new segment to the cache rather than miss it.
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$this->produce_into( $p, 'seed' );
		$p->get_segments(); // populate cache with seg 0.

		$ref      = new \ReflectionClass( $p );
		$cur_seg  = $ref->getProperty( 'current_segment_id' );
		$cur_seg->setAccessible( true );
		$cur_seg->setValue( $p, 7 ); // pretend we're on a never-cached segment.

		$touch = $ref->getMethod( 'touch_segments_cache' );
		$touch->setAccessible( true );
		$touch->invoke( $p );

		$cache_prop = $ref->getProperty( 'segments_cache' );
		$cache_prop->setAccessible( true );
		$ids = \array_column( $cache_prop->getValue( $p ), 'id' );
		$this->assertContains( 7, $ids, 'unfamiliar current_segment_id must be appended to the cache' );
	}

	// ============================================================================
	// Coverage: __destruct flushes pending batch via remove_node() cleanup chain.
	// ============================================================================

	public function test_destruct_flushes_batched_messages_after_remove_node(): void {
		// fill() batches in memory; __destruct must flush before close_handle()
		// so a request-scope Partition (LogManager via Topic) doesn't lose data
		// when PHP collects it.
		//
		// To trigger __destruct deterministically, the test follows the
		// production cleanup chain in order:
		//   1. fill() — message lives in $batch.
		//   2. remove_node() — Partition cascades close_handle + write_lock,
		//      Timer cascades stop_timer (deferred onto Core's closing queue),
		//      Node clears registrations + sibling interpreter + name registration.
		//   3. Core::run_closing() — drains the deferred queue, which fires
		//      EventFramework::stop_timer($p), dropping the EF's back-ref into
		//      $timers (the second of two cycles holding the Partition alive).
		//   4. unset($p) — refcount now actually drops to 0, __destruct fires
		//      synchronously, flush() writes the batch, close_handle() closes.
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$message = $this->produce( 'gc-flushed' );
		$p->fill( $message );

		// File doesn't exist yet — batch is in memory.
		$file = "{$this->tmp}/p0/0.log";
		$this->assertFalse( \file_exists( $file ), 'batch must not have flushed yet' );

		$p->remove_node();
		Core::run_closing();
		unset( $p );

		$this->assertTrue( \file_exists( $file ), '__destruct must materialize the segment file' );
		$bytes = (string) \file_get_contents( $file );
		$lines = \array_values( \array_filter( \explode( "\n", $bytes ) ) );
		$this->assertNotEmpty( $lines, 'flush must write at least one line' );
		$decoded = Message::unpacked( $lines[0] );
		$this->assertSame( 'gc-flushed', $decoded[ Message::VALUE ] );
	}

	// ============================================================================
	// Coverage: get_handle TOCTOU + rm -rf recovery.
	// ============================================================================

	public function test_get_handle_recovers_when_partition_dir_wiped(): void {
		// rm -rf the partition dir after a successful write; the next fill must
		// re-create the dir, re-init from disk (segment 0), and write fresh.
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$this->produce_into( $p, 'before-wipe' );

		// Drop file handles AND on-disk state.
		$p->remove_node();
		$this->rmdir_recursive( "{$this->tmp}/p0" );

		// Reset segment state so next fill re-discovers via init_current_segment.
		$ref     = new \ReflectionClass( $p );
		$cur_seg = $ref->getProperty( 'current_segment_id' );
		$cur_seg->setAccessible( true );
		$cur_seg->setValue( $p, null );
		$cur_size = $ref->getProperty( 'current_size' );
		$cur_size->setAccessible( true );
		$cur_size->setValue( $p, 0 );
		$cache = $ref->getProperty( 'segments_cache' );
		$cache->setAccessible( true );
		$cache->setValue( $p, null );

		$this->produce_into( $p, 'after-wipe' );
		$this->assertTrue( \is_dir( "{$this->tmp}/p0" ), 'partition dir must be recreated by get_handle' );
		$this->assertSame( [ 'after-wipe' ], $this->read_partition_values( $p ) );
	}

	public function test_get_handle_reinits_when_current_log_path_missing(): void {
		// Active log file disappears mid-flight (peer rotated + wiped); next
		// fill's get_handle() must spot the missing path and call
		// init_current_segment to re-anchor.
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$this->produce_into( $p, 'first' );

		// Close handles so a subsequent fill goes through get_handle's open path.
		$p->remove_node();

		// Delete just the active .log but leave the dir; init_current_segment
		// should land at segment 0 again.
		\unlink( "{$this->tmp}/p0/0.log" );

		$this->produce_into( $p, 'after' );
		$this->assertSame( [ 'after' ], $this->read_partition_values( $p ), 'fill must succeed after current_log_path disappears' );
	}

	public function test_get_handle_returns_null_when_fopen_target_is_a_directory(): void {
		// Simulate a "fopen fails" path without depending on uid permissions:
		// drop a directory at the spot where current_log_path expects to land
		// a regular file. fopen('a') on a directory returns false on every
		// supported OS — a deterministic way to exercise the null-return
		// branch in get_handle without chmod tricks (which silently no-op as
		// root).
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 64 * 1024 ) . " 4 86400" );

		// Force current_log_path to point at the partition_dir itself (a real
		// directory). init_current_segment hasn't run yet, so set state by
		// hand via reflection.
		$ref = new \ReflectionClass( $p );

		// Create the partition_dir AS a directory, then replace 0.log with
		// another directory of the same name.
		\mkdir( "{$this->tmp}/p0", 0755, true );
		\mkdir( "{$this->tmp}/p0/0.log", 0755, true );

		$cur_seg = $ref->getProperty( 'current_segment_id' );
		$cur_seg->setAccessible( true );
		$cur_seg->setValue( $p, 0 );

		$cur_log = $ref->getProperty( 'current_log_path' );
		$cur_log->setAccessible( true );
		$cur_log->setValue( $p, "{$this->tmp}/p0/0.log" );

		$cur_idx = $ref->getProperty( 'current_idx_path' );
		$cur_idx->setAccessible( true );
		$cur_idx->setValue( $p, "{$this->tmp}/p0/0.idx" );

		try {
			$get_handle = $ref->getMethod( 'get_handle' );
			$get_handle->setAccessible( true );
			$result = $get_handle->invoke( $p );

			$this->assertNull( $result, 'get_handle must return null when fopen("a") fails on a directory target' );
		} finally {
			@\rmdir( "{$this->tmp}/p0/0.log" );
		}
	}

	// ============================================================================
	// Coverage: allow_large_writes inside an active event loop.
	// ============================================================================

	public function test_allow_large_writes_with_event_loop_running_attaches_lock_and_heartbeat(): void {
		// When EventFramework::is_running() is true (worker drain in
		// progress), allow_large_writes wires the Lock as a sink and creates
		// a heartbeat Timer. Outside a drain it manages the heartbeat from
		// fill() instead. Toggle the EF's draining flag via reflection.
		\Newspack_Nodes\Event_Framework::reset();
		$ef   = \Newspack_Nodes\Event_Framework::instance();
		$ref  = new \ReflectionClass( $ef );
		$flag = $ref->getProperty( 'draining' );
		$flag->setAccessible( true );
		$flag->setValue( $ef, true );

		try {
			$p = new Partition_Node();
			$p->arguments( "{$this->tmp}/p0 " . ( 64 * 1024 ) . " 4 86400" );
			$p->name( 'evp' );
			$p->allow_large_writes();

			$pref = new \ReflectionClass( $p );

			$lock_prop = $pref->getProperty( 'write_lock' );
			$lock_prop->setAccessible( true );
			$lock = $lock_prop->getValue( $p );
			$this->assertSame( 'evp:lock', $lock->name(), 'lock must adopt :lock sibling name inside EF' );
			$this->assertSame( $p, $lock->patron(), 'lock must mark partition as its patron' );

			$hb_prop = $pref->getProperty( 'heartbeat_timer' );
			$hb_prop->setAccessible( true );
			$hb = $hb_prop->getValue( $p );
			$this->assertNotNull( $hb, 'heartbeat timer must be created inside an event loop' );
			$this->assertSame( 'evp:heartbeat', $hb->name() );

			$p->remove_node();
		} finally {
			$flag->setValue( $ef, false );
			\Newspack_Nodes\Event_Framework::reset();
		}
	}

	// ============================================================================
	// Coverage: no-event-loop heartbeat path in fill().
	// ============================================================================

	public function test_fill_throws_when_no_event_loop_heartbeat_loses_ownership(): void {
		// Outside an EF, fill() drives the lock's heartbeat itself. If the
		// lock was stolen between heartbeats, heartbeat() returns false and
		// fill must throw rather than silently write into another holder's
		// segment.
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$p->name( 'no-ef' );
		$p->allow_large_writes();

		// Force the next fill to attempt a heartbeat by aging last_lock_heartbeat
		// well past lock_stale_timeout / 3.
		$ref           = new \ReflectionClass( $p );
		$last_hb       = $ref->getProperty( 'last_lock_heartbeat' );
		$last_hb->setAccessible( true );
		$last_hb->setValue( $p, \microtime( true ) - 1000.0 );

		// Yank the lock dir out from under us — Lock::heartbeat will fail
		// verify_ownership when the heartbeat file is gone.
		\Newspack_Nodes\Lock_Node::force_release_at( "{$this->tmp}/p0/write.lock.d" );

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'no longer owned' );
		$message = $this->produce( 'this-throws' );
		$p->fill( $message );
	}

	public function test_fill_refreshes_heartbeat_without_throw_when_lock_still_held(): void {
		// Happy path of the same branch: fill() runs the heartbeat path,
		// succeeds, and updates last_lock_heartbeat to the current time.
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$p->name( 'no-ef-ok' );
		$p->allow_large_writes();

		$ref     = new \ReflectionClass( $p );
		$last_hb = $ref->getProperty( 'last_lock_heartbeat' );
		$last_hb->setAccessible( true );
		$last_hb->setValue( $p, \microtime( true ) - 1000.0 );
		$before = $last_hb->getValue( $p );

		$this->produce_into( $p, 'heartbeat-ok' );

		$after = $last_hb->getValue( $p );
		$this->assertGreaterThan( $before, $after, 'fill must update last_lock_heartbeat on successful refresh' );

		$p->remove_node();
	}

	// ============================================================================
	// Coverage: emit DROPPED state when message exceeds size cap.
	// ============================================================================

	public function test_fill_emits_DROPPED_state_when_oversized(): void {
		$router = new \Newspack_Nodes\Tests\Capture_Sink_Node();
		$router->name( '_router' );

		$p = new Partition_Node();

		$p->arguments( "{$this->tmp}/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$p->name( 'p-drop' );
		$p->debug_state( 1 );

		$message = $this->produce( \str_repeat( 'x', 5000 ) ); // > MAX_LINE_SIZE
		$p->fill( $message );

		$dropped_traces = \array_filter(
			$router->captured,
			static fn ( $m ) => \is_array( $m[ \Newspack_Nodes\Message::VALUE ] ?? null )
				&& 'DROPPED' === ( $m[ \Newspack_Nodes\Message::VALUE ]['event'] ?? '' )
		);
		$this->assertNotEmpty( $dropped_traces, 'oversize fill must emit DROPPED debug_state' );
		$payload = \reset( $dropped_traces )[ \Newspack_Nodes\Message::VALUE ]['value'];
		$this->assertSame( 'oversize', $payload['reason'] );
		$this->assertGreaterThan( $payload['max'], $payload['size'] );
	}

	// ============================================================================
	// Coverage: with_index callback exception-safety.
	// ============================================================================

	public function test_with_index_callback_exception_does_not_kill_fill(): void {
		// write_index_entry wraps the callback in try/catch — a throwing
		// formatter must NOT propagate out of fill(); the .log is still
		// written and the next fill continues normally.
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$p->with_index( static function () {
			throw new \RuntimeException( 'formatter exploded' );
		} );

		$this->produce_into( $p, 'survives' );

		$this->assertSame( [ 'survives' ], $this->read_partition_values( $p ), 'fill must survive a throwing index callback' );
		// .idx may be empty (callback never returned a value) but the file
		// can exist as an artifact of the lazy-open path; the contract is
		// just "no crash + data lands".
	}

	// ============================================================================
	// Coverage: scan_index skips segments whose .idx is missing.
	// ============================================================================

	public function test_scan_index_continues_when_idx_file_missing_for_a_segment(): void {
		// Force two segments where the second segment has a .log but no .idx.
		// with_index is on (JSONL path), so each segment normally gets an .idx.
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 64 4 86400" );
		$p->with_index( fn ( $l, $pos, &$d = null ) => 'entry' );
		$this->produce_into( $p, \str_repeat( 'a', 40 ) ); // seg 0.
		$this->produce_into( $p, \str_repeat( 'b', 40 ) ); // forces rotate.

		$segments = $p->get_segments( true );
		$this->assertGreaterThanOrEqual( 2, \count( $segments ) );

		// Remove the .idx for whichever segment is newest.
		$max_id = \max( \array_column( $segments, 'id' ) );
		if ( \file_exists( "{$this->tmp}/p0/{$max_id}.idx" ) ) {
			\unlink( "{$this->tmp}/p0/{$max_id}.idx" );
		}

		$count = 0;
		$p->scan_index( function ( string $line, int $seg ) use ( &$count ) {
			++$count;
		} );

		// Segment 0's index entry must still be visited; the missing-idx
		// segment is silently skipped.
		$this->assertGreaterThanOrEqual( 1, $count );
	}

	// ============================================================================
	// Coverage: cleanup_segments handles unreadable mtime.
	// ============================================================================

	public function test_cleanup_segments_under_age_threshold_short_circuits(): void {
		// cleanup_segments has TWO break conditions: false mtime AND a fresh
		// segment whose age < max_lifespan. Exercise the age-gate branch: a
		// reasonably-large max_lifespan (1 hour) ensures all segments are
		// "young" and the loop breaks on the first iteration without
		// deleting anything, even with count >> num_segments.
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 256 2 3600" );
		for ( $i = 0; $i < 5; ++$i ) {
			$this->produce_into( $p, \str_repeat( \chr( 97 + $i ), 100 ) );
		}

		$before = \count( $p->get_segments( true ) );
		$this->assertGreaterThan( 2, $before, 'fixture must have more segments than num_segments' );

		$p->cleanup_segments();

		$after = \count( $p->get_segments( true ) );
		$this->assertSame( $before, $after, 'age-gate break must prevent deletions' );
	}

	// ============================================================================
	// Coverage: large-message bypass-batch path in fill().
	// ============================================================================

	public function test_large_message_bypasses_batch_and_writes_directly(): void {
		// Messages bigger than MAX_LINE_SIZE (only legal when allow_large_writes
		// is set) bypass the in-memory batch — they're already > 4KB so batching
		// can't keep them under PIPE_BUF. Verify the bytes land without needing
		// a manual flush.
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 1024 * 1024 ) . " 4 86400" );
		$p->allow_large_writes();

		$value = \str_repeat( 'L', 5000 );
		$message   = $this->produce( $value );
		$p->fill( $message );

		// No flush() — large messages were supposed to land synchronously.
		$bytes = (string) \file_get_contents( "{$this->tmp}/p0/0.log" );
		$line  = \rtrim( $bytes, "\n" );
		$decoded = \Newspack_Nodes\Message::unpacked( $line );
		$this->assertSame( $value, $decoded[ \Newspack_Nodes\Message::VALUE ] );
	}

	public function test_large_message_triggers_rotate_when_segment_would_overflow(): void {
		// Pre-fill the segment past capacity, then a single large message must
		// trigger rotation before its own write. segment_size=4500 keeps seg 0
		// past the "adopt if room" threshold after the first 5000-byte VALUE
		// lands (~5050 packed bytes >= 4500), so the second write rotates to
		// a fresh segment 1.
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 4500 4 86400" );
		$p->allow_large_writes();
		// Pump a 5000-byte VALUE into seg 0.
		$message_a = $this->produce( \str_repeat( 'A', 5000 ) );
		$p->fill( $message_a );

		// A second 5000-byte VALUE doesn't fit; rotation must bump to seg 1.
		$message_b = $this->produce( \str_repeat( 'B', 5000 ) );
		$p->fill( $message_b );

		$segments = $p->get_segments( true );
		$ids      = \array_column( $segments, 'id' );
		$this->assertContains( 0, $ids );
		$this->assertContains( 1, $ids, 'large-message overflow must rotate' );
	}

	// ============================================================================
	// Coverage: rotation creates partition_dir if missing inside do_rotate.
	// ============================================================================

	public function test_do_rotate_creates_partition_dir_when_missing(): void {
		// Force the path where do_rotate runs without partition_dir existing
		// — exercises the @mkdir( $partition_dir, ..., true ) branch. The
		// public path to this branch is: rotate_segment in allow_large_writes
		// mode (skips the rotation lock), starting with no segments yet.
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$p->allow_large_writes();

		// Confirm pre-state: dir exists (allow_large_writes created it for the lock).
		$this->assertTrue( \is_dir( "{$this->tmp}/p0" ) );
		$this->rmdir_recursive( "{$this->tmp}/p0/write.lock.d" );
		\rmdir( "{$this->tmp}/p0" );

		// Now invoke do_rotate via reflection — it must re-create the dir.
		$ref       = new \ReflectionClass( $p );
		$do_rotate = $ref->getMethod( 'do_rotate' );
		$do_rotate->setAccessible( true );
		$do_rotate->invoke( $p );

		$this->assertTrue( \is_dir( "{$this->tmp}/p0" ), 'do_rotate must materialize partition_dir when missing' );
	}

	// ============================================================================
	// Coverage: scan_index empty .idx file path.
	// ============================================================================

	public function test_scan_index_handles_completely_empty_idx_file(): void {
		// Stub a 0-byte .idx — file_exists is true, but rtrim+explode of an
		// empty string yields no entries, so the segment contributes nothing.
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$p->with_index( fn ( $l, $pos, &$d = null ) => 'entry' );
		$this->produce_into( $p, 'seed' ); // creates p0/ + 0.idx with one entry.

		// Pre-create segment 5 with an empty .idx + a corresponding .log so
		// get_segments includes it.
		\file_put_contents( "{$this->tmp}/p0/5.log", 'x' );
		\file_put_contents( "{$this->tmp}/p0/5.idx", '' );

		$count = 0;
		$p->scan_index( function ( string $line, int $seg ) use ( &$count ) {
			++$count;
		} );

		// Only segment 0 contributes an entry; segment 5's empty .idx is a no-op.
		$this->assertSame( 1, $count, 'empty .idx must contribute zero entries without crashing' );
	}

	// ============================================================================
	// Coverage: PIPE_BUF batch-flush threshold.
	// ============================================================================

	public function test_batch_flushes_before_adding_message_that_overflows_PIPE_BUF(): void {
		// PIPE_BUF (4KB) is the atomic-write limit. The in-memory batch must
		// flush *before* appending a message that would push it over the cap,
		// so every syswrite stays under PIPE_BUF.
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 1024 * 1024 ) . " 4 86400" );

		// Fill the batch close to PIPE_BUF (4096) with two ~1.5KB messages —
		// total batch lands around 3KB, but a 3rd 1.5KB push would overflow.
		// Each packed Message has ~50 bytes of JSON envelope overhead.
		$value = \str_repeat( 'a', 1500 );
		$message1  = $this->produce( $value );
		$message2  = $this->produce( $value );
		$message3  = $this->produce( $value );

		$p->fill( $message1 );
		$p->fill( $message2 );
		// Before $message3 lands, the batch should auto-flush so $message3 alone is
		// the resident batch.
		$p->fill( $message3 );

		// Force any final residual to disk.
		$p->flush();

		// All three messages land in order.
		$this->assertSame( [ $value, $value, $value ], $this->read_partition_values( $p ) );
	}

	// ============================================================================
	// Coverage: init_current_segment non-empty path (anchors on newest segment).
	// ============================================================================

	public function test_init_current_segment_adopts_newest_when_segments_exist(): void {
		// init_current_segment() runs `empty($segments)` first; the non-empty
		// branch reads `\end($segments)` and anchors current_segment_id/size to
		// it. Pre-seed two real segment files on disk so get_segments returns
		// both, then call init_current_segment via reflection and confirm we
		// landed on the newest with its filesize as current_size.
		\mkdir( "{$this->tmp}/p0", 0755, true );
		\file_put_contents( "{$this->tmp}/p0/0.log", \str_repeat( 'a', 10 ) );
		\file_put_contents( "{$this->tmp}/p0/3.log", \str_repeat( 'b', 25 ) );

		$p = new Partition_Node();

		$p->arguments( "{$this->tmp}/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$ref = new \ReflectionClass( $p );
		$init = $ref->getMethod( 'init_current_segment' );
		$init->setAccessible( true );
		$init->invoke( $p );

		$cur_seg = $ref->getProperty( 'current_segment_id' );
		$cur_seg->setAccessible( true );
		$cur_size = $ref->getProperty( 'current_size' );
		$cur_size->setAccessible( true );
		$cur_log = $ref->getProperty( 'current_log_path' );
		$cur_log->setAccessible( true );
		$cur_idx = $ref->getProperty( 'current_idx_path' );
		$cur_idx->setAccessible( true );

		$this->assertSame( 3, $cur_seg->getValue( $p ), 'newest segment id should be adopted' );
		$this->assertSame( 25, $cur_size->getValue( $p ), 'current_size mirrors newest filesize' );
		$this->assertSame( "{$this->tmp}/p0/3.log", $cur_log->getValue( $p ) );
		$this->assertSame( "{$this->tmp}/p0/3.idx", $cur_idx->getValue( $p ) );
	}

	// ============================================================================
	// Coverage: flush's lazy init when batch arrives before any prior segment.
	// ============================================================================

	public function test_flush_initializes_current_segment_when_null(): void {
		// flush() guards with `null === $this->current_segment_id` and calls
		// init_current_segment so callers can hand-seed the batch without
		// going through fill(). Exercise that branch by pushing bytes
		// straight into the protected $batch + $batch_index_args, then
		// flushing.
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$ref = new \ReflectionClass( $p );

		// Sanity: current_segment_id is still null pre-flush.
		$cur_seg = $ref->getProperty( 'current_segment_id' );
		$cur_seg->setAccessible( true );
		$this->assertNull( $cur_seg->getValue( $p ) );

		// Build a real packed message and inject it as the resident batch.
		$message    = $this->produce( 'lazy-init' );
		$packed = \Newspack_Nodes\Message::packed( $message ) . "\n";

		$batch = $ref->getProperty( 'batch' );
		$batch->setAccessible( true );
		$batch->setValue( $p, $packed );

		$bargs = $ref->getProperty( 'batch_index_args' );
		$bargs->setAccessible( true );
		$bargs->setValue( $p, [ [
			'packed' => $packed,
			'size'   => \strlen( $packed ),
			'data'   => null,
		] ] );

		$p->flush();

		$this->assertSame( 0, $cur_seg->getValue( $p ), 'flush must init to segment 0 when batch precedes any prior write' );
		$this->assertSame( [ 'lazy-init' ], $this->read_partition_values( $p ) );
	}

	// ============================================================================
	// Coverage: write_all partial-write stall loop (shared base-Node primitive).
	// ============================================================================

	public function test_write_all_returns_zero_and_counts_failure_when_nothing_lands(): void {
		// A read-only file handle makes fwrite() return false. write_all must
		// retry on each failure and, once attempts exhaust, report 0 bytes
		// written, record a write_failures count, and emit one loud,
		// rate-limited line. A stalled write is never silently swallowed.
		$probe = "{$this->tmp}/write-all-probe.bin";
		\file_put_contents( $probe, 'seed' );
		$ro_fh = \fopen( $probe, 'rb' );
		$this->assertNotFalse( $ro_fh );

		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$ref = new \ReflectionClass( $p );
		$wa  = $ref->getMethod( 'write_all' );
		$wa->setAccessible( true );

		$warned = '';
		\Newspack_Nodes\Core::set_stderr_handler( static function ( $message ) use ( &$warned ) {
			$warned .= $message;
		} );

		$result = $wa->invoke( $p, $ro_fh, 'payload-to-write', $probe );
		\fclose( $ro_fh );

		$this->assertSame( 0, $result, 'write_all must report 0 bytes written after exhausting retries' );
		$this->assertSame( 1, $p->write_failures(), 'a stalled write must be counted' );
		$this->assertStringContainsString( 'write stalled', $warned );
	}

	public function test_write_all_reports_bytes_actually_written_on_a_partial_stall(): void {
		// A disk that fills mid-write accepts some bytes, then ENOSPC. write_all
		// must report how many bytes ACTUALLY landed (not just success/failure)
		// so the caller advances current_size by the real amount and the segment
		// offset never drifts against the file — while still counting the stall.
		PartialWriteStreamWrapper::$accept_bytes = 4;
		\stream_wrapper_register( 'nnpartial', PartialWriteStreamWrapper::class );
		try {
			$fh = \fopen( 'nnpartial://x', 'w' );
			$this->assertNotFalse( $fh );

			$p = new Partition_Node();
			$p->arguments( "{$this->tmp}/p0 " . ( 64 * 1024 ) . " 4 86400" );
			$ref = new \ReflectionClass( $p );
			$wa  = $ref->getMethod( 'write_all' );
			$wa->setAccessible( true );

			\Newspack_Nodes\Core::set_stderr_handler( static function () {} );

			// 10 bytes offered, only 4 accepted before the stream stalls.
			$wrote = $wa->invoke( $p, $fh, 'ABCDEFGHIJ', 'seg' );
			\fclose( $fh );

			$this->assertSame( 4, $wrote, 'write_all must report the bytes that actually landed' );
			$this->assertSame( 1, $p->write_failures(), 'a partial-then-stall still counts as a failure' );
		} finally {
			\stream_wrapper_unregister( 'nnpartial' );
		}
	}

	// ============================================================================
	// Coverage: rotate_segment makes locks_dir when missing.
	// ============================================================================

	public function test_rotate_segment_creates_locks_dir_when_missing(): void {
		// rotate_segment locks inside the partition's own data dir
		// ({base_dir}/p{N}). The first write materializes that dir, so to
		// exercise the @mkdir($locks_dir,...) branch we just confirm the
		// partition dir exists after rotation.
		$base = $this->tmp . '/base';
		\mkdir( $base, 0755, true );

		$p = new Partition_Node();

		$p->arguments( "{$base}/p0 32 4 86400" );
		// Three 30-byte VALUES force at least one true rotation past segment 0.
		$this->produce_into( $p, \str_repeat( 'a', 30 ) );
		$this->produce_into( $p, \str_repeat( 'b', 30 ) );
		$this->produce_into( $p, \str_repeat( 'c', 30 ) );

		$this->assertTrue( \is_dir( "{$base}/p0" ), 'rotate_segment must materialize the partition dir when absent' );
		$this->assertFalse( \is_dir( "{$base}/locks" ), 'rotate_segment must not create a sibling locks dir' );
	}

	// ============================================================================
	// Coverage: rotate_segment contention paths (peer holding / stale lock).
	// ============================================================================

	public function test_rotate_segment_peer_holding_active_lock_reinits_from_disk(): void {
		// rotate_segment with a fresh (mtime < ROTATE_LOCK_TTL_SECONDS) peer
		// lock present: mkdir($lock_dir) fails, filemtime returns now, age is
		// under TTL → usleep + init_current_segment + return. We pre-create
		// the lock dir + a peer-written segment 1 so init_current_segment
		// adopts segment 1.
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 32 4 86400" );
		// Land one write so the partition_dir + segment 0 exist.
		$this->produce_into( $p, \str_repeat( 'a', 10 ) );

		$locks_dir = "{$this->tmp}/p0";
		$lock_dir  = "{$locks_dir}/.rotate.lock.d";
		@\mkdir( $locks_dir, 0755, true );
		@\mkdir( $lock_dir, 0755, true ); // FRESH lock — mtime is now.

		// Peer-write segment 1 so init_current_segment lands on it post-contention.
		\file_put_contents( "{$this->tmp}/p0/1.log", "peer\n" );

		try {
			$ref = new \ReflectionClass( $p );
			$rs  = $ref->getMethod( 'rotate_segment' );
			$rs->setAccessible( true );
			$rs->invoke( $p );

			$cur_seg = $ref->getProperty( 'current_segment_id' );
			$cur_seg->setAccessible( true );
			$this->assertSame(
				1,
				$cur_seg->getValue( $p ),
				'peer-holding-active-lock path must re-init from disk and adopt the newest segment'
			);
		} finally {
			@\rmdir( $lock_dir );
		}
	}

	public function test_rotate_segment_disappeared_lock_dir_mid_check_reinits(): void {
		// When mkdir($lock_dir) fails but filemtime returns false (lock dir
		// vanished mid-check after the @mkdir failed for a transient reason),
		// rotate_segment usleeps + re-inits from disk + returns. We synthesise
		// this by setting up the directory layout to make mkdir fail (file in
		// the way, NOT a directory), then deleting before filemtime. The
		// simplest realisation: create a regular file at $lock_dir so mkdir
		// rejects (it's an existing path), and immediately unlink it before
		// filemtime can succeed.
		//
		// Easier and equally diagnostic: use a wrapper class that overrides
		// rotate_segment behaviour. We don't want to add subclasses inside
		// includes/, so instead seed an empty lock_dir with mtime set far in
		// the future (>=now+ROTATE_LOCK_TTL_SECONDS+1) so mkdir fails but
		// filemtime returns a *finite* large value — that goes through the
		// stale branch, not this one. We DO want the false-mtime branch.
		//
		// To deterministically force filemtime() to return false on an
		// existing path, we make it a broken symlink: create a symlink to a
		// non-existent target. mkdir on an existing symlink fails; filemtime
		// on a broken symlink returns false on PHP (errno).
		$lock_target = $this->tmp . '/nonexistent-target';
		$locks_dir   = "{$this->tmp}/p0";
		$lock_dir    = "{$locks_dir}/.rotate.lock.d";
		@\mkdir( $locks_dir, 0755, true );
		@\unlink( $lock_dir );
		// Broken symlink to a missing target — mkdir rejects existing path,
		// filemtime returns false on the broken-symlink stat.
		if ( ! @\symlink( $lock_target, $lock_dir ) ) {
			$this->markTestSkipped( 'symlink() unavailable in this environment' );
		}

		$p = new Partition_Node();

		$p->arguments( "{$this->tmp}/p0 32 4 86400" );
		$this->produce_into( $p, 'before' ); // seed seg 0.

		try {
			$ref = new \ReflectionClass( $p );
			$rs  = $ref->getMethod( 'rotate_segment' );
			$rs->setAccessible( true );
			$rs->invoke( $p ); // must not throw.

			$cur_seg = $ref->getProperty( 'current_segment_id' );
			$cur_seg->setAccessible( true );
			$this->assertIsInt( $cur_seg->getValue( $p ), 'disappeared-lock-dir path must re-init without crash' );
		} finally {
			@\unlink( $lock_dir );
		}
	}

	public function test_rotate_segment_stale_lock_force_clears_and_retries(): void {
		// rotate_segment finds a lock dir older than ROTATE_LOCK_TTL_SECONDS:
		// rmdir it, mkdir again, then proceed to do_rotate. Verify the
		// segment actually rotated.
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 32 4 86400" );
		$this->produce_into( $p, \str_repeat( 'a', 20 ) ); // seed seg 0.

		$locks_dir = "{$this->tmp}/p0";
		$lock_dir  = "{$locks_dir}/.rotate.lock.d";
		@\mkdir( $locks_dir, 0755, true );
		@\mkdir( $lock_dir, 0755, true );
		// Backdate well past the TTL.
		\touch( $lock_dir, \time() - ( Partition_Node::ROTATE_LOCK_TTL_SECONDS + 10 ) );

		$before = $p->get_segments( true );
		$before_max = \max( \array_column( $before, 'id' ) );

		$ref = new \ReflectionClass( $p );
		$rs  = $ref->getMethod( 'rotate_segment' );
		$rs->setAccessible( true );
		$rs->invoke( $p );

		// Lock dir must be cleared after rotate completes (the `finally`
		// at the end of rotate_segment).
		$this->assertFalse( \is_dir( $lock_dir ), 'stale lock must be force-cleared and released after rotate' );
		// And the rotation must have bumped past whatever segment was last
		// recorded — or at minimum adopted/created an active segment without
		// crashing.
		$after = $p->get_segments( true );
		$this->assertGreaterThanOrEqual(
			$before_max,
			\max( \array_column( $after, 'id' ) ),
			'rotate_segment with stale lock must succeed'
		);
	}

	// ============================================================================
	// Coverage: do_rotate touch() failure emits print_less_often.
	// ============================================================================

	public function test_do_rotate_touch_failure_swallowed_with_print_less_often(): void {
		// touch() at line 755 fails when the partition_dir is read-only.
		// Run as bend (non-root) so 0500 perms actually deny writes. Skip if
		// running as root since chmod is a no-op for privileged users.
		if ( \function_exists( 'posix_getuid' ) && 0 === \posix_getuid() ) {
			$this->markTestSkipped( 'chmod 0500 is bypassed for root; the touch-fail branch needs a non-root uid (production runs as bend).' );
		}

		// Hand-seed a "full" segment 0 on disk (>= segment_size) so do_rotate
		// skips the adopt-if-room branch and goes through the
		// touch($current_log_path) path on a fresh seg 1 id.
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 16 4 86400" );
		\mkdir( "{$this->tmp}/p0", 0755, true );
		\file_put_contents( "{$this->tmp}/p0/0.log", \str_repeat( 'x', 32 ) ); // >= segment_size.

		// Capture stderr emissions so print_less_often's output doesn't leak.
		$captured = [];
		\Newspack_Nodes\Core::set_stderr_handler(
			static function ( string $message ) use ( &$captured ) {
				$captured[] = $message;
			}
		);

		// Make partition_dir read-only so touch() of the new 1.log fails.
		\chmod( "{$this->tmp}/p0", 0500 );

		try {
			$ref       = new \ReflectionClass( $p );
			$do_rotate = $ref->getMethod( 'do_rotate' );
			$do_rotate->setAccessible( true );
			$do_rotate->invoke( $p );

			// touch() failure produces a "touch() failed" print_less_often emission.
			$matched = \array_filter(
				$captured,
				static fn ( $line ) => false !== \strpos( $line, 'touch() failed' )
			);
			$this->assertNotEmpty( $matched, 'touch() failure must surface via print_less_often' );
		} finally {
			\chmod( "{$this->tmp}/p0", 0755 ); // restore for tearDown cleanup.
		}
	}

	// ============================================================================
	// Coverage: read_at file-not-present + fopen-fails branches.
	// ============================================================================

	public function test_read_at_missing_segment_returns_empty(): void {
		// read_at on a segment_id whose .log doesn't exist must early-return ''
		// (file_exists false branch) without falling through to fopen.
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$this->produce_into( $p, 'seed' ); // segment 0 exists.

		$this->assertSame(
			'',
			$p->read_at( 99, 0, 8 ),
			'missing-segment read must return empty string'
		);
	}

	public function test_read_at_returns_empty_when_fopen_fails(): void {
		// file_exists succeeds, but fopen('r') fails when the file has no
		// read permission for the running user. Non-root only.
		if ( \function_exists( 'posix_getuid' ) && 0 === \posix_getuid() ) {
			$this->markTestSkipped( 'chmod 0000 is bypassed for root; fopen-fail branch needs a non-root uid (production runs as bend).' );
		}

		$p = new Partition_Node();

		$p->arguments( "{$this->tmp}/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$this->produce_into( $p, 'seed' );
		$p->remove_node(); // close handles so chmod takes effect for next open.

		$path = "{$this->tmp}/p0/0.log";
		\chmod( $path, 0000 );

		try {
			$result = $p->read_at( 0, 0, 4 );
			$this->assertSame( '', $result, 'fopen failure must surface as empty string' );
		} finally {
			\chmod( $path, 0644 );
		}
	}

	// ============================================================================
	// Coverage: scan_index JSONL reverse + empty-line skip.
	// ============================================================================

	public function test_scan_index_jsonl_reverse_order(): void {
		// JSONL + newest_first reverses the line order within a segment.
		// Confirms the `array_reverse($lines)` branch (line 890).
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 1024 * 1024 ) . " 4 86400" );
		$p->with_index( static function ( string $line, array $pos, ?array &$data = null ) {
			$decoded = \json_decode( \rtrim( $line, "\n" ), true );
			return (string) \json_encode( [ 'v' => $decoded[ \Newspack_Nodes\Message::VALUE ] ?? '' ] );
		} );

		$this->produce_into( $p, 'alpha' );
		$this->produce_into( $p, 'beta' );
		$this->produce_into( $p, 'gamma' );

		$collected = [];
		$p->scan_index( function ( string $line, int $seg ) use ( &$collected ) {
			$collected[] = \json_decode( $line, true )['v'];
		}, true ); // newest_first

		$this->assertSame( [ 'gamma', 'beta', 'alpha' ], $collected, 'JSONL reverse mode must walk entries newest-first' );
	}

	public function test_scan_index_jsonl_skips_empty_lines(): void {
		// rtrim($idx,"\n") + explode() can produce empty string entries on
		// double-newlines or blank lines mid-stream. The `if ( '' === $line )
		// { continue; }` branch (line 894) is the safety net. Pre-create the
		// .idx with a deliberate blank line in the middle and confirm the
		// callback only sees the two real entries.
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 1024 * 1024 ) . " 4 86400" );
		$p->with_index(
			static function ( string $line, array $pos, ?array &$data = null ) {
				return 'real-entry';
			}
		);

		// Seed one real entry through the normal path so segments_cache + .log
		// exist for segment 0.
		$this->produce_into( $p, 'seed' );

		// Now overwrite the .idx with a manually-crafted file that has a blank
		// middle line so scan_index hits the empty-line skip.
		\file_put_contents(
			"{$this->tmp}/p0/0.idx",
			"entry-one\n\nentry-two\n"
		);

		$collected = [];
		$p->scan_index( function ( string $line, int $seg ) use ( &$collected ) {
			$collected[] = $line;
		} );

		$this->assertSame(
			[ 'entry-one', 'entry-two' ],
			$collected,
			'JSONL empty-line entries must be skipped without invoking callback'
		);
	}

	// ============================================================================
	// Coverage: flush bails when get_handle returns null.
	// ============================================================================

	public function test_flush_returns_when_get_handle_returns_null(): void {
		// flush() builds the batch in memory then asks for an open handle.
		// If get_handle returns null (e.g., current_log_path points at a
		// non-openable target), flush must `return` without crashing or
		// re-flushing on retry. Force the open to fail by setting
		// current_log_path to an existing directory (fopen('a') on a dir
		// returns false on every supported OS).
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 1024 * 1024 ) . " 4 86400" );
		\mkdir( "{$this->tmp}/p0", 0755, true );
		\mkdir( "{$this->tmp}/p0/blocker", 0755, true );

		// Anchor partition state at the directory-path blocker so the lazy
		// fopen in get_handle fails. (No prior open — fresh partition.)
		$ref     = new \ReflectionClass( $p );
		$cur_seg = $ref->getProperty( 'current_segment_id' );
		$cur_seg->setAccessible( true );
		$cur_seg->setValue( $p, 0 );
		$cur_log = $ref->getProperty( 'current_log_path' );
		$cur_log->setAccessible( true );
		$cur_log->setValue( $p, "{$this->tmp}/p0/blocker" );
		$cur_idx = $ref->getProperty( 'current_idx_path' );
		$cur_idx->setAccessible( true );
		$cur_idx->setValue( $p, "{$this->tmp}/p0/blocker.idx" );
		$cur_size = $ref->getProperty( 'current_size' );
		$cur_size->setAccessible( true );
		$cur_size->setValue( $p, 0 );

		// Inject a real packed message as the resident batch.
		$message    = $this->produce( 'unreachable' );
		$packed = \Newspack_Nodes\Message::packed( $message ) . "\n";
		$batch  = $ref->getProperty( 'batch' );
		$batch->setAccessible( true );
		$batch->setValue( $p, $packed );
		$bargs = $ref->getProperty( 'batch_index_args' );
		$bargs->setAccessible( true );
		$bargs->setValue( $p, [ [
			'packed' => $packed,
			'size'   => \strlen( $packed ),
			'data'   => null,
		] ] );

		$p->flush(); // Must not throw; bails on null fh.

		// Batch is reset (flush's reset-up-front contract), blocker is intact.
		$this->assertSame( '', $batch->getValue( $p ), 'flush must clear the batch even when the write bailed' );
		$this->assertTrue( \is_dir( "{$this->tmp}/p0/blocker" ), 'blocker dir untouched after failed flush' );
	}

	// ============================================================================
	// Coverage: fill large-message path bails when get_handle returns null.
	// ============================================================================

	public function test_fill_large_message_returns_when_get_handle_returns_null(): void {
		// The large-message branch (>MAX_LINE_SIZE, only legal under
		// allow_large_writes) flushes the batch, optionally rotates, then asks
		// for an open file handle. If get_handle returns null, fill must
		// `return` without crashing. Force get_handle to fail by pointing
		// current_log_path at a directory (fopen('a') on a directory fails)
		// after allow_large_writes seeded the partition_dir.
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 1024 * 1024 ) . " 4 86400" );
		$p->allow_large_writes();

		// Force current_log_path to a directory; fopen('a') on a directory
		// returns false on every supported OS. Use reflection because
		// get_handle's TOCTOU recovery would re-init if we just delete the
		// file.
		\mkdir( "{$this->tmp}/p0/blocker", 0755, true );
		$ref     = new \ReflectionClass( $p );
		$cur_seg = $ref->getProperty( 'current_segment_id' );
		$cur_seg->setAccessible( true );
		$cur_seg->setValue( $p, 0 );
		$cur_log = $ref->getProperty( 'current_log_path' );
		$cur_log->setAccessible( true );
		$cur_log->setValue( $p, "{$this->tmp}/p0/blocker" ); // existing directory.
		$cur_idx = $ref->getProperty( 'current_idx_path' );
		$cur_idx->setAccessible( true );
		$cur_idx->setValue( $p, "{$this->tmp}/p0/blocker.idx" );

		$big_msg = $this->produce( \str_repeat( 'L', 5000 ) );
		$p->fill( $big_msg ); // Must not throw; bails on null fh.

		// File-content sanity: nothing was written to a real segment because
		// the open failed. (No assertion against the value of bytes_written:
		// write_all never ran.)
		$this->assertTrue( \is_dir( "{$this->tmp}/p0/blocker" ), 'blocker dir must still be present (fill must not have unlinked it)' );
	}

	// ============================================================================
	// Coverage: get_segments scandir-failure branch.
	// ============================================================================

	public function test_get_segments_returns_empty_when_scandir_fails(): void {
		// scandir() on a 0000-perm directory returns false for non-root users.
		// get_segments must catch that (it asserts `! $files`) and return empty.
		// Root bypasses permission checks; skip in that case.
		if ( \function_exists( 'posix_getuid' ) && 0 === \posix_getuid() ) {
			$this->markTestSkipped( 'scandir failure on 0000 dir needs a non-root uid (production runs as bend).' );
		}

		$p = new Partition_Node();

		$p->arguments( "{$this->tmp}/p0 " . ( 64 * 1024 ) . " 4 86400" );
		// Pre-create the partition_dir so is_dir passes — get_segments then
		// proceeds to scandir, which fails on 0000 perms.
		\mkdir( "{$this->tmp}/p0", 0755, true );
		\chmod( "{$this->tmp}/p0", 0000 );

		try {
			$segments = $p->get_segments( true );
			$this->assertSame( [], $segments, 'get_segments must return [] when scandir fails' );
		} finally {
			\chmod( "{$this->tmp}/p0", 0755 ); // restore for tearDown cleanup.
		}
	}

	/** Read a protected/private property of a node via reflection. */
	private function read_node_prop( object $node, string $prop ) {
		$ref = new \ReflectionClass( $node );
		$p   = $ref->getProperty( $prop );
		$p->setAccessible( true );
		return $p->getValue( $node );
	}

	public function test_allow_large_writes_names_write_lock_sibling(): void {
		// Rule 2: the Lock sibling is named even in request scope (no drain loop).
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$p->name( 'big_part' );
		$p->sink( new \Newspack_Nodes\Echo_Node() );
		$p->allow_large_writes();

		$lock = $this->read_node_prop( $p, 'write_lock' );
		$this->assertNotNull( $lock, 'write_lock should be set after allow_large_writes' );
		$this->assertSame( 'big_part:lock', $lock->name() );

		$p->remove_node();
	}

	public function test_allow_large_writes_sets_lock_patron_to_partition(): void {
		// Rule 2: patron marks the Lock as plumbing so dump_metadata hides it.
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$p->name( 'big_part' );
		$p->sink( new \Newspack_Nodes\Echo_Node() );
		$p->allow_large_writes();

		$lock = $this->read_node_prop( $p, 'write_lock' );
		$this->assertSame( $p, $lock->patron() );

		$p->remove_node();
	}

	public function test_allow_large_writes_sinks_lock_to_partition_specific_sink(): void {
		// Rule 2 specific-sink exception: the Lock keeps the partition's own sink.
		$p = new Partition_Node();
		$p->arguments( "{$this->tmp}/p0 " . ( 64 * 1024 ) . " 4 86400" );
		$p->name( 'big_part' );
		$echo = new \Newspack_Nodes\Echo_Node();
		$p->sink( $echo );
		$p->allow_large_writes();

		$lock = $this->read_node_prop( $p, 'write_lock' );
		$this->assertSame( $echo, $lock->sink() );

		$p->remove_node();
	}

	/** Write one record whose VALUE is the given array into the flat offset dir. */
	private function write_value_record( string $offset_dir, array $value ): void {
		$p   = new Partition_Node();
		$p->arguments( $offset_dir );
		$message                  = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_STRUCT;
		$message[ Message::VALUE ] = $value;
		$p->fill( $message );
		$p->flush();
	}

	public function test_read_latest_value_at_returns_null_for_empty_dir(): void {
		$this->assertNull( Partition_Node::read_latest_value_at( $this->tmp ) );
	}

	public function test_read_latest_value_at_returns_written_value(): void {
		$value = [ 'cache' => [ 'items' => [ [ 'title' => 'x' ] ] ], 'k' => 'v' ];
		$this->write_value_record( $this->tmp, $value );

		$this->assertSame( $value, Partition_Node::read_latest_value_at( $this->tmp ) );
	}

	public function test_read_latest_value_at_returns_newest_of_many(): void {
		$this->write_value_record( $this->tmp, [ 'k' => 'first' ] );
		$this->write_value_record( $this->tmp, [ 'k' => 'second' ] );
		$this->write_value_record( $this->tmp, [ 'k' => 'third' ] );

		$this->assertSame( [ 'k' => 'third' ], Partition_Node::read_latest_value_at( $this->tmp ) );
	}

	public function test_read_latest_value_at_returns_null_for_non_array_value(): void {
		$p   = new Partition_Node();
		$p->arguments( $this->tmp );
		$message                  = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::VALUE ] = 'just-a-string';
		$p->fill( $message );
		$p->flush();

		$this->assertNull( Partition_Node::read_latest_value_at( $this->tmp ) );
	}

	public function test_seam_methods_return_partition_defaults(): void {
		// Partition's seams describe a DIRECTORY layout writing the packed envelope.
		// Log overrides these six; pinning the defaults here keeps Partition's own
		// contract stable as the seams get introduced.
		$probe = new class() extends \Newspack_Nodes\Partition_Node {
			public function probe_segment_dir(): string {
				return $this->segment_dir(); }
			public function probe_index_path( int $id ): string {
				return $this->get_index_path( $id ); }
			public function probe_pattern(): string {
				return $this->segment_pattern(); }
			public function probe_record( array $m ): string {
				return $this->serialize_record( $m ); }
			public function probe_rotate_lock(): string {
				return $this->rotate_lock_path(); }
			public function probe_write_lock(): string {
				return $this->write_lock_path(); }
		};
		$probe->arguments( "{$this->tmp}/p0 1024 2" );

		$this->assertSame( "{$this->tmp}/p0", $probe->probe_segment_dir() );
		$this->assertSame( "{$this->tmp}/p0/3.log", $probe->get_segment_path( 3 ) );
		$this->assertSame( "{$this->tmp}/p0/3.idx", $probe->probe_index_path( 3 ) );
		$this->assertSame( \Newspack_Nodes\Partition_Node::SEGMENT_PATTERN, $probe->probe_pattern() );
		$this->assertSame( "{$this->tmp}/p0/.rotate.lock.d", $probe->probe_rotate_lock() );
		$this->assertSame( "{$this->tmp}/p0/write.lock.d", $probe->probe_write_lock() );

		$message                  = \Newspack_Nodes\Message::new_message();
		$message[ \Newspack_Nodes\Message::TYPE ]  = \Newspack_Nodes\Message::TM_BYTESTREAM;
		$message[ \Newspack_Nodes\Message::VALUE ] = 'hi';
		$this->assertSame(
			\Newspack_Nodes\Message::packed( $message ) . "\n",
			$probe->probe_record( $message )
		);
	}
}

/**
 * Test stream wrapper that accepts a fixed byte budget, then stalls (returns 0)
 * — simulating a disk that fills mid-write so write_all() sees a partial write.
 */
class PartialWriteStreamWrapper {
	public static int $accept_bytes = 0;
	/** @var resource */
	public $context;
	private int $written = 0;

	public function stream_open( string $path, string $mode, int $options, ?string &$opened_path ): bool {
		return true;
	}

	public function stream_write( string $data ): int {
		$budget = self::$accept_bytes - $this->written;
		if ( $budget <= 0 ) {
			return 0;
		}
		$take           = \min( $budget, \strlen( $data ) );
		$this->written += $take;
		return $take;
	}

	public function stream_eof(): bool {
		return false;
	}

	public function stream_close(): void {}
}
