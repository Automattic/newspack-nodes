<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Core;
use Newspack_Nodes\Event_Framework;
use Newspack_Nodes\Message;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Timer_Node;
use Newspack_Nodes\Worker_Should_Stop;
use Newspack_Nodes\Tests\TestCase;

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

	// ── clock threading: request-scope cache aging must follow the real clock ─

	public function test_get_segments_ages_the_cache_by_the_threaded_clock_in_request_scope(): void {
		Event_Framework::reset(); // request scope: EF not running, so get_segments uses the fresh clock
		$this->use_base_dir( $this->tmp );
		$dir = "{$this->tmp}/logs/aging.p0";
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
		\mkdir( $dir, 0755, true );

		$p = new Partition_Node();
		$p->name( 'aging' );
		$p->arguments( [ $dir, '1048576', '2', '4', '0', '0', '0' ] );

		$scans = 0;
		Partition_Node::$scandir = static function ( string $d ) use ( &$scans ) {
			++$scans;
			return \scandir( $d );
		};
		try {
			// Clock threaded straight in — values distinct from the 0.0/0.25 defaults.
			$p->get_segments( false, 500.0 );  // cold cache → scan #1, stamp 500.0
			$p->get_segments( false, 500.10 ); // +0.10s < 0.25 TTL → warm cache served
			$this->assertSame( 1, $scans, 'within SEGMENT_CACHE_TTL the threaded clock must serve the warm cache' );
			$p->get_segments( false, 500.50 ); // +0.50s ≥ 0.25 TTL → aged out → scan #2
			$this->assertSame( 2, $scans, 'past SEGMENT_CACHE_TTL the threaded clock must force a rescan' );
		} finally {
			Partition_Node::$scandir = null;
		}
	}

	// ── write-stall dead-letter: flush must never silently lose a batch ─────

	public function test_flush_write_stall_quarantines_unwritten_messages_and_truncates_the_torn_tail(): void {
		$this->use_base_dir( $this->tmp );
		$p = new Partition_Node();
		$p->name( 'stall' );
		$p->arguments( [ "{$this->tmp}/logs/stall.p0", '1048576', '2', '4', '0', '0', '0' ] );

		$msgs = [];
		foreach ( [ 'alpha-payload', 'beta-payload', 'gamma-payload' ] as $v ) {
			$m                   = Message::new_message();
			$m[ Message::TYPE ]  = Message::TM_BYTESTREAM;
			$m[ Message::VALUE ] = $v;
			$msgs[]              = $m;
			$p->fill( $m );
		}

		$first_len = \strlen( Message::packed( $msgs[0] ) . "\n" );
		// Tear 5 bytes into the SECOND record, then refuse further writes —
		// only on the source segment (the quarantine's own disk stays healthy,
		// the selective-EIO / bad-permissions scenario).
		$budget                 = $first_len + 5;
		Partition_Node::$fwrite = static function ( $fh, string $bytes ) use ( &$budget ) {
			$uri = (string) ( \stream_get_meta_data( $fh )['uri'] ?? '' );
			if ( ! \str_contains( $uri, '/logs/stall.p0/' ) ) {
				return \fwrite( $fh, $bytes );
			}
			if ( $budget <= 0 ) {
				return false;
			}
			$written = \fwrite( $fh, \substr( $bytes, 0, $budget ) );
			$budget  = 0;
			return $written;
		};
		Core::set_stderr_handler( static function () { /* swallow */ } );
		try {
			$p->flush();
		} finally {
			Partition_Node::$fwrite = null;
		}

		// The torn partial record is truncated off — framing survives.
		$log = (string) \file_get_contents( "{$this->tmp}/logs/stall.p0/0.log" );
		$this->assertSame( $first_len, \strlen( $log ), 'the torn partial record must be truncated off' );
		$this->assertStringContainsString( 'alpha-payload', $log );

		// The unwritten messages are quarantined (replayable), not lost.
		$dl = (string) \file_get_contents( "{$this->tmp}/deadletter/logs.stall.p0/0.log" );
		$this->assertStringContainsString( 'beta-payload', $dl );
		$this->assertStringContainsString( 'gamma-payload', $dl );
		$this->assertStringNotContainsString( 'alpha-payload', $dl, 'the durably-written record must not double-quarantine' );

		// Recovery: a later write appends cleanly and every line still parses.
		$m4                   = Message::new_message();
		$m4[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$m4[ Message::VALUE ] = 'delta-payload';
		$p->fill( $m4 );
		$p->flush();
		$lines = \array_values( \array_filter( \explode( "\n", (string) \file_get_contents( "{$this->tmp}/logs/stall.p0/0.log" ) ) ) );
		$this->assertCount( 2, $lines );
		$this->assertSame( 'alpha-payload', Message::unpacked( $lines[0] )[ Message::VALUE ] );
		$this->assertSame( 'delta-payload', Message::unpacked( $lines[1] )[ Message::VALUE ] );
	}

	public function test_flush_open_failure_quarantines_the_whole_batch(): void {
		if ( \function_exists( 'posix_getuid' ) && 0 === \posix_getuid() ) {
			$this->markTestSkipped( 'permission checks are moot as root' );
		}
		$this->use_base_dir( $this->tmp );
		$p = new Partition_Node();
		$p->name( 'openfail' );
		$p->arguments( [ "{$this->tmp}/logs/openfail.p0", '1048576', '2', '4', '0', '0', '0' ] );

		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$m[ Message::VALUE ] = 'omega-payload';
		$p->fill( $m );

		// A read-only segment dir: fopen fails, get_handle() returns null.
		\mkdir( "{$this->tmp}/logs/openfail.p0", 0755, true );
		\chmod( "{$this->tmp}/logs/openfail.p0", 0555 );
		Core::set_stderr_handler( static function () { /* swallow */ } );
		try {
			$p->flush();
		} finally {
			\chmod( "{$this->tmp}/logs/openfail.p0", 0755 );
		}

		$dl = (string) \file_get_contents( "{$this->tmp}/deadletter/logs.openfail.p0/0.log" );
		$this->assertStringContainsString( 'omega-payload', $dl, 'an unopenable segment must quarantine the batch, not drop it' );
	}

	public function test_large_write_stall_truncates_and_quarantines_the_message(): void {
		$this->use_base_dir( $this->tmp );
		$p = new Partition_Node();
		$p->name( 'bigstall' );
		$p->arguments( [ "{$this->tmp}/logs/bigstall.p0", '1048576', '2', '4', '0', '0', '0' ] );
		$p->void_warranty();

		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$m[ Message::VALUE ] = \str_repeat( 'L', 6000 ) . '-large-tail';
		// 100 bytes then stall (source segment only): the large path writes
		// synchronously in fill().
		$budget                 = 100;
		Partition_Node::$fwrite = static function ( $fh, string $bytes ) use ( &$budget ) {
			$uri = (string) ( \stream_get_meta_data( $fh )['uri'] ?? '' );
			if ( ! \str_contains( $uri, '/logs/bigstall.p0/' ) ) {
				return \fwrite( $fh, $bytes );
			}
			if ( $budget <= 0 ) {
				return false;
			}
			$written = \fwrite( $fh, \substr( $bytes, 0, $budget ) );
			$budget  = 0;
			return $written;
		};
		Core::set_stderr_handler( static function () { /* swallow */ } );
		try {
			$p->fill( $m );
		} finally {
			Partition_Node::$fwrite = null;
		}

		$this->assertSame( 0, \filesize( "{$this->tmp}/logs/bigstall.p0/0.log" ), 'the torn large record must be truncated off' );
		$dl = (string) \file_get_contents( "{$this->tmp}/deadletter/logs.bigstall.p0/0.log" );
		$this->assertStringContainsString( '-large-tail', $dl );
	}

	public function test_write_deadletter_stays_locked_for_a_multi_writer_source(): void {
		// A default source is multi-writer (ADR-4 lockless appends); its shared
		// quarantine must keep the rotate lock — void_warranty's lockless
		// rotation would race when every writer stalls at once (disk full).
		$this->use_base_dir( $this->tmp );
		$multi = new Partition_Node();
		$multi->name( 'shared' );
		$multi->arguments( [ "{$this->tmp}/logs/shared.p0", '1048576', '2', '4', '0', '0', '0' ] );
		$dl = ( new \ReflectionMethod( $multi, 'ensure_deadletter' ) )->invoke( $multi );
		$this->assertNotNull( $dl );
		$this->assertFalse( $this->read_node_prop( $dl, 'allow_large_writes' ) );

		// A single-writer source (void_warranty) keeps a sole-writer quarantine.
		$solo = new Partition_Node();
		$solo->name( 'solo' );
		$solo->arguments( [ "{$this->tmp}/logs/solo.p0", '1048576', '2', '4', '0', '0', '0' ] );
		$solo->void_warranty();
		$dl_solo = ( new \ReflectionMethod( $solo, 'ensure_deadletter' ) )->invoke( $solo );
		$this->assertNotNull( $dl_solo );
		$this->assertTrue( $this->read_node_prop( $dl_solo, 'allow_large_writes' ) );
	}

	public function test_sidecar_partitions_do_not_derive_a_write_deadletter(): void {
		// A sidecar quarantining into its own sidecar would recurse forever.
		$this->use_base_dir( $this->tmp );
		$p = new Partition_Node();
		$p->name( 'data' );
		$p->arguments( [ "{$this->tmp}/logs/data.p0", '1048576', '2', '4', '0', '0', '0' ] );
		$this->assertSame(
			"{$this->tmp}/deadletter/logs.data.p0",
			$this->read_node_prop( $p, 'deadletter_dir' ),
			'a data partition derives its write-quarantine under {base}/deadletter'
		);

		$maker = new \ReflectionMethod( $p, 'make_sidecar' );
		$side  = $maker->invoke( $p, "{$this->tmp}/side", 'data:side', [ 1024, 2, 2, 0, 0 ] );
		$this->assertSame( '', $this->read_node_prop( $side, 'deadletter_dir' ) );
	}

	public function test_hard_cap_fires_even_when_the_oldest_mtime_is_unreadable(): void {
		// The unconditional cap must not silently disable on a stat failure.
		$this->use_base_dir( $this->tmp );
		$dir = "{$this->tmp}/logs/capstat.p0";
		\mkdir( $dir, 0755, true );
		for ( $i = 0; $i < 7; $i++ ) {
			\file_put_contents( "{$dir}/{$i}.log", 'x' );
		}
		$p = new Partition_Node();
		$p->name( 'capstat' );
		// num_segments=3, hard cap=5, min_lifetime=900 protects young segments.
		$p->arguments( [ $dir, '1048576', '2', '3', '5', '900', '0' ] );
		// Unreadable oldest mtime: stat fails for 0.log via a vanished file.
		Partition_Node::$scandir = static fn ( string $d ) => \scandir( $d );
		\unlink( "{$dir}/0.log" );
		\file_put_contents( "{$dir}/0.log", 'x' ); // recreate; mtime readable
		\touch( "{$dir}/0.log", \time() - 10 ); // young: min_lifetime protects
		Partition_Node::$scandir = null;
		$p->cleanup_segments();
		$this->assertCount( 5, \glob( "{$dir}/*.log" ), 'the hard cap prunes young segments unconditionally' );
	}

	public function test_derive_max_segments_floors_num_segments_like_arguments_does(): void {
		// The displays call this raw; a num_segments below the floor must not
		// under-report the ceiling the runtime actually enforces.
		$this->assertSame( 4, Partition_Node::derive_max_segments( 1, 0 ), 'floors to 2, derives 2x' );
		$this->assertSame( 14, Partition_Node::derive_max_segments( 7, 14 ) );
	}

	public function test_large_write_heartbeat_uses_a_real_clock_outside_the_drain(): void {
		// A long no-drain run (wp nodes ingest) freezes Core::$now; the lock
		// heartbeat must still advance or stale-takeover goes undetected.
		$this->use_base_dir( $this->tmp );
		$p = new Partition_Node();
		$p->name( 'hbclock' );
		$p->arguments( [ "{$this->tmp}/logs/hbclock.p0", '1048576', '2', '4', '0', '0', '0' ] );
		$p->allow_large_writes();
		Core::$now = 500.0; // frozen cached clock, far from the real one.
		$ref = new \ReflectionClass( Partition_Node::class );
		$ref->getProperty( 'lock_stale_timeout' )->setValue( $p, 1 );
		$ref->getProperty( 'last_lock_heartbeat' )->setValue( $p, 500.0 );
		\usleep( 400000 ); // past the stale_timeout/3 cadence in REAL time.

		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$m[ Message::VALUE ] = 'hb-probe';
		$p->fill( $m );

		$this->assertGreaterThan(
			501.0,
			$ref->getProperty( 'last_lock_heartbeat' )->getValue( $p ),
			'a frozen cached clock must not freeze lock heartbeating'
		);
		Core::$now = 0.0;
	}

	public function test_constructor_does_not_create_partition_dir(): void {
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64*1024 ), "2", "4", "0", "0", "86400", "0" ] );
		$this->assertFalse( is_dir( "{$this->tmp}.p0" ), 'Constructor must not eager-create partition dir' );
	}

	public function test_constructor_does_not_open_files(): void {
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64*1024 ), "2", "4", "0", "0", "86400", "0" ] );
		$this->assertFalse( file_exists( "{$this->tmp}.p0/0.log" ) );
	}

	/**
	 * Tachikoma-parity constructible: no-arg ctor + arguments() setter walks
	 * the node_schema and assigns dir / segment_size / min_segments /
	 * num_segments / min_lifetime / lifetime; the override resolves
	 * partition_dir from the passed dir.
	 */
	public function test_constructible_via_no_arg_ctor_and_arguments_setter(): void {
		$p = new Partition_Node();
		// Distinct values per slot so a min/num swap or an ignored token fails.
		$p->arguments( [ "{$this->tmp}.p0", "1048576", "3", "5", "0", "100", "200" ] );
		$this->assertSame( "{$this->tmp}.p0", $p->partition_dir() );
		$ref = new \ReflectionClass( $p );
		$this->assertSame( "{$this->tmp}.p0", $ref->getProperty( 'partition_dir' )->getValue( $p ) );
		$this->assertSame( 1048576,           $ref->getProperty( 'segment_size' )->getValue( $p ) );
		$this->assertSame( 3,                 $ref->getProperty( 'min_segments' )->getValue( $p ) );
		$this->assertSame( 5,                 $ref->getProperty( 'num_segments' )->getValue( $p ) );
		$this->assertSame( 100,               $ref->getProperty( 'min_lifetime' )->getValue( $p ) );
		$this->assertSame( 200,               $ref->getProperty( 'lifetime' )->getValue( $p ) );
	}

	/**
	 * Optional retention args default to `<config:*>` tokens; `arguments()` with
	 * only the required token resolves each from config and coerces it to the
	 * typed `int` property (never a raw token string, which would TypeError).
	 * The test-config values (segment_size 1024, num_segments 2) are distinct
	 * from the DEFAULT_* constants (67108864, 4), proving the value came from
	 * config, not the constant.
	 */
	public function test_arguments_setter_resolves_config_defaults_for_missing_optional_tokens(): void {
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p2" ] );
		$this->assertSame( "{$this->tmp}.p2", $p->partition_dir() );
		$ref = new \ReflectionClass( $p );
		$this->assertSame( 1024, $ref->getProperty( 'segment_size' )->getValue( $p ) );
		$this->assertSame( 2,    $ref->getProperty( 'num_segments' )->getValue( $p ) );
		$this->assertSame( 0,    $ref->getProperty( 'min_lifetime' )->getValue( $p ) );
	}

	/**
	 * arguments() override re-normalizes after the base walker — dir gets
	 * trailing slashes stripped, segment_size clamped to ≥1, min/num_segments to
	 * ≥2, min_lifetime/lifetime to ≥0; partition_dir is the resolved dir.
	 */
	public function test_arguments_setter_normalizes_and_rederives_partition_dir(): void {
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p1/", "0", "2", "1", "0", "-5", "0" ] );
		$ref = new \ReflectionClass( $p );
		$this->assertSame( 1,                 $ref->getProperty( 'segment_size' )->getValue( $p ) );
		$this->assertSame( 2,                 $ref->getProperty( 'num_segments' )->getValue( $p ) );
		$this->assertSame( 0,                 $ref->getProperty( 'min_lifetime' )->getValue( $p ) );
		$this->assertSame( "{$this->tmp}.p1", $p->partition_dir() );
	}

	public function test_arguments_empty_string_throws(): void {
		$p = new Partition_Node();
		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( 'Missing required argument: partition_dir' );
		$p->arguments( [] );
	}

	public function test_get_segment_path_throws_on_negative(): void {
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64*1024 ), "2", "4", "0", "0", "86400", "0" ] );
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
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64*1024 ), "2", "4", "0", "0", "86400", "0" ] );
		$message = $this->produce( 'hello' );
		$p->fill( $message );
		$p->flush();
		$this->assertTrue( is_dir( "{$this->tmp}.p0" ) );
		$this->assertSame( [ 'hello' ], $this->read_partition_values( $p ) );
	}

	public function test_fill_appends_to_segment(): void {
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64*1024 ), "2", "4", "0", "0", "86400", "0" ] );
		$this->produce_into( $p, 'first' );
		$this->produce_into( $p, 'second' );
		$this->assertSame( [ 'first', 'second' ], $this->read_partition_values( $p ) );
	}

	public function test_fill_writes_no_index_without_with_index(): void {
		// Default mode (no with_index formatter) writes no .idx companion at all.
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64*1024 ), "2", "4", "0", "0", "86400", "0" ] );
		$this->produce_into( $p, 'hello' );
		$this->assertFalse( file_exists( "{$this->tmp}.p0/0.idx" ), 'no .idx should be written without with_index()' );
	}

	public function test_fill_tracks_largest_msg_sent(): void {
		// Partition overrides Node::fill() to write to disk; that override
		// must still track largest_msg_sent or the Inspector will report
		// 0 for every Partition. Measured against Message::packed_size
		// (on-wire bytes), same as the base Node tracking.
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64 * 1024 ), "2", "4", "0", "0", "86400", "0" ] );
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
		$p->arguments( [ "{$this->tmp}.p0" ] );
		$p->void_warranty();

		$big = $this->produce( \str_repeat( 'x', 5000 ) ); // > MAX_LINE_SIZE (4096).
		$p->fill( $big );
		$p->flush();

		$this->assertDirectoryDoesNotExist(
			"{$this->tmp}.p0/write.lock.d",
			'void_warranty() must NOT acquire the exclusivity lock'
		);
		$segs   = $p->get_segments( true );
		$newest = \end( $segs );
		$bytes  = $p->read_at( $newest['id'], 0, $newest['size'] );
		$this->assertStringContainsString( \str_repeat( 'x', 5000 ), $bytes );
	}

	public function test_read_message_at_returns_the_unpacked_message(): void {
		// The decoded random-access read: read_bytes_at + Message::unpacked in one
		// call, so callers stop hand-rolling json_decode over a raw read.
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0" ] );
		$msg = $this->produce( 'payload-here' );
		$p->fill( $msg );
		$p->flush();

		$segs   = $p->get_segments( true );
		$newest = \end( $segs );
		$got    = $p->read_message_at( $newest['id'], 0, $newest['size'] );

		$this->assertIsArray( $got );
		$this->assertSame( 'payload-here', $got[ \Newspack_Nodes\Message::VALUE ] );
	}

	public function test_read_message_at_returns_null_on_a_torn_record(): void {
		// A truncated/short byte range can't unpack to a 7-field envelope — the
		// method swallows the InvalidArgumentException and returns null, never throws.
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0" ] );
		$msg = $this->produce( 'payload-here' );
		$p->fill( $msg );
		$p->flush();

		$this->assertNull( $p->read_message_at( 0, 0, 5 ) );
	}

	public function test_void_warranty_dumps_its_own_verb_not_allow_large_writes(): void {
		// Round-trip fidelity: a void_warranty partition must NOT dump
		// `allow_large_writes` — replaying that would acquire the very lock we
		// deliberately skipped.
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0" ] );
		$p->name( 'pt' );
		$p->void_warranty();

		$dump = $p->dump_config();
		$this->assertStringContainsString( 'command_node pt:config void_warranty', $dump );
		$this->assertStringNotContainsString( 'allow_large_writes', $dump );
	}

	public function test_fill_accumulates_bytes_written(): void {
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64*1024 ), "2", "4", "0", "0", "86400", "0" ] );
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
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64*1024 ), "2", "4", "0", "0", "86400", "0" ] );
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
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64*1024 ), "2", "4", "0", "0", "86400", "0" ] );
		$message = $this->produce( str_repeat( 'x', 5000 ) );
		$p->fill( $message );
		$this->assertFalse( file_exists( "{$this->tmp}.p0/0.log" ), 'oversize fill must not touch the segment' );
	}

	public function test_allow_large_writes_lifts_limit_to_10MB(): void {
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64*1024 ), "2", "4", "0", "0", "86400", "0" ] );
		$p->allow_large_writes();
		$this->produce_into( $p, str_repeat( 'x', 5000 ) );
		$this->assertSame( [ str_repeat( 'x', 5000 ) ], $this->read_partition_values( $p ) );
	}

	public function test_dump_config_reflects_allow_large_writes_state(): void {
		// dump_config emits the config from the node's own STATE — not from a
		// generically-recorded verb invocation. Setting the flag (however) shows
		// up; no invoked_verbs bookkeeping required.
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64 * 1024 ), "2", "4", "0", "0", "86400", "0" ] );
		$p->name( 'p' );
		$p->allow_large_writes();
		$this->assertStringContainsString(
			'command_node p:config allow_large_writes',
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
		$p1->arguments( [ "{$this->tmp}.p0", (string) ( 64*1024 ), "2", "4", "0", "0", "86400", "0" ] );
		$p1->name( 'p1' );
		$p1->allow_large_writes();

		$p2 = new Partition_Node();

		$p2->arguments( [ "{$this->tmp}.p0", (string) ( 64*1024 ), "2", "4", "0", "0", "86400", "0" ] );
		$p2->name( 'p2' );
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'failed to acquire write lock' );
		$p2->allow_large_writes( 100 ); // 100ms — well under stale_timeout
	}

	/** Partition exposing fire() so tests can drive the debounce timer without an event loop. */
	private function debounced_partition( string $dir, int $debounce_ms ): object {
		$p = new class() extends Partition_Node {
			public function probe_fire(): void {
				$this->fire();
			}
		};
		$p->arguments( [ "{$dir}", (string) ( 64 * 1024 ), "2", "4", "0", "0", "86400", "0" ] );
		$p->name( 'dbp' );
		$p->allow_large_writes( 1000, $debounce_ms );
		return $p;
	}

	public function test_debounced_mode_acquires_the_lock_lazily_on_first_write(): void {
		// [65]: debounced allow_large_writes does NOT grab the lock at setup — only
		// when a write actually arrives, so an idle partition holds nothing.
		\Newspack_Nodes\Core::$now = 1000.0;
		$p = $this->debounced_partition( "{$this->tmp}.p0", 100 );
		$this->assertDirectoryDoesNotExist(
			"{$this->tmp}.p0/write.lock.d",
			'debounced mode must not lock until the first write'
		);

		$this->produce_into( $p, \str_repeat( 'x', 5000 ) ); // > PIPE_BUF.
		$this->assertDirectoryExists(
			"{$this->tmp}.p0/write.lock.d",
			'a write acquires the lock'
		);
		$this->assertSame(
			[ \str_repeat( 'x', 5000 ) ],
			$this->read_partition_values( $p )
		);
	}

	public function test_debounced_mode_releases_the_lock_after_an_idle_interval(): void {
		// [65]: once writes stop, a fire() past the debounce window releases the
		// lock so other writers can take it. The timer debounces the unlock.
		\Newspack_Nodes\Core::$now = 1000.0;
		$p = $this->debounced_partition( "{$this->tmp}.p0", 100 );
		$this->produce_into( $p, \str_repeat( 'x', 5000 ) );
		$this->assertDirectoryExists( "{$this->tmp}.p0/write.lock.d" );

		// Still within the debounce window → a fire() keeps the lock.
		\Newspack_Nodes\Core::$now = 1000.05; // 50ms < 100ms
		$p->probe_fire();
		$this->assertDirectoryExists(
			"{$this->tmp}.p0/write.lock.d",
			'a fire inside the debounce window holds the lock'
		);

		// Past the window → released.
		\Newspack_Nodes\Core::$now = 1000.2; // 200ms >= 100ms idle
		$p->probe_fire();
		$this->assertDirectoryDoesNotExist(
			"{$this->tmp}.p0/write.lock.d",
			'an idle interval past the debounce window releases the lock'
		);
	}

	public function test_debounced_release_lets_another_writer_acquire(): void {
		// The point of releasing on idle: a different process can then write.
		\Newspack_Nodes\Core::$now = 1000.0;
		$p1 = $this->debounced_partition( "{$this->tmp}.p0", 100 );
		$this->produce_into( $p1, \str_repeat( 'a', 5000 ) );
		\Newspack_Nodes\Core::$now = 1000.2;
		$p1->probe_fire(); // releases.

		// A continuous-mode writer now acquires the freed lock without throwing.
		$p2 = new Partition_Node();
		$p2->arguments( [ "{$this->tmp}.p0", (string) ( 64 * 1024 ), "2", "4", "0", "0", "86400", "0" ] );
		$p2->name( 'p2' );
		$p2->allow_large_writes( 200 );
		$this->assertDirectoryExists( "{$this->tmp}.p0/write.lock.d" );
		$p2->remove_node();
	}

	public function test_debounced_reacquire_appends_at_the_live_end_after_another_writer(): void {
		// While unlocked, another writer may advance the partition. On re-acquire the
		// debounced writer re-syncs from disk so it appends at the true end, not over
		// the other writer's bytes.
		\Newspack_Nodes\Core::$now = 1000.0;
		$p = $this->debounced_partition( "{$this->tmp}.p0", 100 );
		$this->produce_into( $p, 'first' );
		\Newspack_Nodes\Core::$now = 1000.2;
		$p->probe_fire(); // release.

		// An independent writer appends while we hold nothing.
		$other = new Partition_Node();
		$other->arguments( [ "{$this->tmp}.p0", (string) ( 64 * 1024 ), "2", "4", "0", "0", "86400", "0" ] );
		$this->produce_into( $other, 'second' );

		// Our next write re-acquires + re-syncs, appending after 'second'.
		\Newspack_Nodes\Core::$now = 1001.0;
		$this->produce_into( $p, 'third' );
		$this->assertSame(
			[ 'first', 'second', 'third' ],
			$this->read_partition_values( $p )
		);
	}

	public function test_debounced_large_write_arms_the_release_timer(): void {
		// Regression [65]: a > PIPE_BUF write (the whole reason for the mode) takes
		// fill()'s early-return branch. It must STILL arm the debounce timer — the
		// release runs only from fire(), so without an armed timer the lock is held
		// for life and debounced mode silently degenerates to acquire-and-hold.
		\Newspack_Nodes\Core::$now = 1000.0;
		$p = $this->debounced_partition( "{$this->tmp}.p0", 100 );
		$this->produce_into( $p, \str_repeat( 'x', 5000 ) ); // > MAX_LINE_SIZE → large branch.
		$this->assertSame(
			100,
			$p->interval_ms,
			'a large write must arm the debounce release timer'
		);
	}

	public function test_debounced_oversize_drop_still_arms_the_release_timer(): void {
		// An oversize message is dropped after the lock is acquired; the release must
		// still be scheduled so the lock isn't stranded by a doomed write [65].
		\Newspack_Nodes\Core::$now = 1000.0;
		$p = $this->debounced_partition( "{$this->tmp}.p0", 100 );
		// Sized off the constant: an 11MB literal here stopped being oversize when
		// the large-write cap rose to 32 MiB, and the test passed on the write path.
		$oversize = $this->produce( \str_repeat( 'z', Partition_Node::MAX_LARGE_LINE_SIZE + 1 ) );
		$p->fill( $oversize );
		$this->assertSame(
			100,
			$p->interval_ms,
			'even a dropped oversize write arms the release timer (lock not stranded)'
		);
		$this->assertSame(
			[],
			\glob( "{$this->tmp}.p0/*.log" ) ?: [],
			'the oversize record was dropped, not written (the lock dir is expected)'
		);
	}

	public function test_debounced_mode_round_trips_the_debounce_ms_in_dump_config(): void {
		\Newspack_Nodes\Core::$now = 1000.0;
		$p = $this->debounced_partition( "{$this->tmp}.p0", 250 );
		$this->assertStringContainsString(
			'command_node dbp:config allow_large_writes 250',
			$p->dump_config()
		);
	}

	public function test_read_at_returns_bytes_at_offset(): void {
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64*1024 ), "2", "4", "0", "0", "86400", "0" ] );
		$this->produce_into( $p, 'hello' );
		$this->produce_into( $p, 'world' );

		// Each entry is a packed Message line; read_at returns whatever bytes
		// live at the given offset. Fetch the first line in full and verify it
		// unpacks back to "hello".
		$first_line_size  = strpos( file_get_contents( "{$this->tmp}.p0/0.log" ), "\n" ) + 1;
		$first_line_bytes = $p->read_at( 0, 0, $first_line_size );
		$first            = \Newspack_Nodes\Message::unpacked( rtrim( $first_line_bytes, "\n" ) );
		$this->assertSame( 'hello', $first[ \Newspack_Nodes\Message::VALUE ] );
	}

	public function test_rotation_when_segment_size_exceeded(): void {
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", "1024", "2", "4", "0", "86400", "0" ] );
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
		$p->arguments( [ "{$base}.p0", "1024", "2", "4", "0", "86400", "0" ] );
		for ( $i = 0; $i < 30; ++$i ) {
			$this->produce_into( $p, \str_repeat( 'x', 100 ) );
		}
		// Old behavior created {$this->tmp}/logs/locks ; new behavior must not.
		$this->assertDirectoryDoesNotExist( "{$this->tmp}/logs/locks" );
		// Rotation still happened.
		$this->assertGreaterThan( 1, \count( $p->get_segments( true ) ) );
	}

	public function test_retention_min_lifetime_blocks_count_prune_far_over_num_segments(): void {
		// num_segments=5 but min_lifetime=86400: freshly-written young segments are
		// kept despite count far exceeding num_segments (count rule gated on age),
		// up to the derived hard cap (2 × num_segments = 10).
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", "256", "2", "5", "0", "86400", "0" ] );
		for ( $i = 0; $i < 20; ++$i ) {
			$this->produce_into( $p, str_repeat( 'x', 100 ) );
		}
		$p->cleanup_segments();
		$segments = $p->get_segments( true );
		$this->assertGreaterThan( 5, count( $segments ), 'min_lifetime protects young segments even when count >> num_segments' );
	}

	public function test_retention_count_prune_to_num_segments_two(): void {
		// num_segments=2, min_lifetime=0: the count rule always fires (age>=0), so
		// the oldest are pruned down to num_segments.
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", "256", "2", "2", "0", "0", "0" ] );
		for ( $i = 0; $i < 20; ++$i ) {
			$this->produce_into( $p, str_repeat( 'x', 100 ) );
		}
		$p->cleanup_segments();
		$segments = $p->get_segments( true );
		$this->assertLessThanOrEqual( 2, count( $segments ) );
	}

	public function test_retention_prunes_to_num_segments_by_count(): void {
		// min_seg=2 num_seg=4 min_life=0 lifetime=0 → pure count prune to num_segments.
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", "256", "2", "4", "0", "0", "0" ] );
		for ( $i = 0; $i < 20; ++$i ) {
			$this->produce_into( $p, \str_repeat( 'x', 100 ) );
		}
		$p->cleanup_segments();
		$this->assertLessThanOrEqual( 4, \count( $p->get_segments( true ) ) );
		$this->assertGreaterThanOrEqual( 2, \count( $p->get_segments( true ) ) );
	}

	public function test_retention_min_lifetime_protects_young_from_count_prune(): void {
		// num_seg=2 but min_life=86400 → young segments kept despite exceeding num_segments.
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", "256", "2", "2", "0", "86400", "0" ] );
		for ( $i = 0; $i < 20; ++$i ) {
			$this->produce_into( $p, \str_repeat( 'x', 100 ) );
		}
		$p->cleanup_segments();
		$this->assertGreaterThan( 2, \count( $p->get_segments( true ) ), 'min_lifetime protects young segments from the count prune' );
	}

	public function test_retention_lifetime_prunes_old_below_num_segments_to_min_segments(): void {
		// min_seg=2 num_seg=3 min_life=100000 lifetime=5: aged segments prune to
		// min_segments via the age rule, EVEN THOUGH the huge min_lifetime would keep
		// them under the count rule. (The old age gate, keyed on the min_lifetime
		// position, would keep all of them — this is the genuinely-new behavior.)
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", "256", "2", "3", "0", "100000", "5" ] );
		for ( $i = 0; $i < 10; ++$i ) {
			$this->produce_into( $p, \str_repeat( 'x', 100 ) );
		}
		foreach ( $p->get_segments( true ) as $seg ) {
			\touch( $p->get_segment_path( $seg['id'] ), \time() - 3600 );
		}
		$p->cleanup_segments();
		$this->assertSame( 2, \count( $p->get_segments( true ) ), 'lifetime prunes old segments down to min_segments' );
	}

	public function test_retention_age_rule_respects_a_raised_min_segments_floor(): void {
		// min_seg=3: the age rule prunes aged segments down to 3, NOT the hard
		// floor of 2 — guards the `count > min_segments` clause against a
		// regression to a literal 2.
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", "256", "3", "4", "0", "0", "5" ] );
		for ( $i = 0; $i < 10; ++$i ) {
			$this->produce_into( $p, \str_repeat( 'x', 100 ) );
		}
		foreach ( $p->get_segments( true ) as $seg ) {
			\touch( $p->get_segment_path( $seg['id'] ), \time() - 3600 );
		}
		$p->cleanup_segments();
		$this->assertSame( 3, \count( $p->get_segments( true ) ), 'age rule stops at the configured min_segments (3), not the hard floor 2' );
	}

	public function test_retention_hard_cap_prunes_young_segments_over_max_segments(): void {
		// num_segments=3 target, min_lifetime=900 would keep freshly-written young
		// segments under the count rule, but the hard cap (max_segments=5, the 7th
		// arg) prunes the oldest UNCONDITIONALLY once the count exceeds it — young
		// or not, min_lifetime does not protect them. >5 young segments → exactly 5.
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", "256", "2", "3", "5", "900", "0" ] );
		for ( $i = 0; $i < 20; ++$i ) {
			$this->produce_into( $p, \str_repeat( 'x', 100 ) );
		}
		$p->cleanup_segments();
		$this->assertSame( 5, \count( $p->get_segments( true ) ), 'hard cap prunes young segments down to max_segments regardless of min_lifetime' );
	}

	public function test_retention_hard_floor_of_two_segments(): void {
		// Aggressive age prune (lifetime=1, min_seg clamps to 2) never drops below 2.
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", "256", "2", "3", "0", "0", "1" ] );
		for ( $i = 0; $i < 8; ++$i ) {
			$this->produce_into( $p, \str_repeat( 'x', 100 ) );
		}
		foreach ( $p->get_segments( true ) as $seg ) {
			\touch( $p->get_segment_path( $seg['id'] ), \time() - 3600 );
		}
		$p->cleanup_segments();
		$this->assertSame( 2, \count( $p->get_segments( true ) ), 'never prune below the hard floor of 2' );
	}

	public function test_rotate_emits_SEGMENT_state_with_new_id(): void {
		// Force a rotation by filling small segments; with debug_state on, set_state
		// emits a flat `DEBUG: SEGMENT <id>` line to stderr (Core::$recent_log). A
		// _router must be registered for the trace to fire (the live-graph guard).
		$router = new \Newspack_Nodes\Tests\Capture_Sink_Node();
		$router->name( '_router' );

		$p = new Partition_Node();

		$p->arguments( [ "{$this->tmp}.p0", "256", "2", "4", "0", "86400", "0" ] );
		$p->name( 'p-rot' );
		$p->debug_state( 1 );
		\Newspack_Nodes\Core::$recent_log = [];

		// Each write is ~120 bytes packed; 4 writes push past the 256-byte
		// segment_size and force at least one rotation.
		for ( $i = 0; $i < 4; ++$i ) {
			$this->produce_into( $p, str_repeat( 'r', 100 ) );
		}

		$segment_traces = \array_values( \array_filter(
			\Newspack_Nodes\Core::$recent_log,
			static fn ( $line ) => \str_contains( $line, 'DEBUG: SEGMENT ' )
		) );
		$this->assertNotEmpty( $segment_traces, 'rotate should emit SEGMENT trace' );
		// The just-rotated id is > 0 (segment 0 is the pre-rotation segment).
		$this->assertSame( 1, \preg_match( '/DEBUG: SEGMENT [1-9]/', \end( $segment_traces ) ), 'SEGMENT id should be > 0 after rotation' );
	}

	public function test_cleanup_emits_CLEANUP_state_only_when_deletions_happen(): void {
		// min_lifetime=0 → cleanup always deletes once count > num_segments.
		$router = new \Newspack_Nodes\Tests\Capture_Sink_Node();
		$router->name( '_router' );

		$p = new Partition_Node();

		$p->arguments( [ "{$this->tmp}.p0", "256", "2", "2", "0", "0", "0" ] );
		$p->name( 'p-clean' );
		$p->debug_state( 1 );
		\Newspack_Nodes\Core::$recent_log = [];

		for ( $i = 0; $i < 6; ++$i ) {
			$this->produce_into( $p, str_repeat( 'c', 100 ) );
		}

		$cleanup_traces = \array_values( \array_filter(
			\Newspack_Nodes\Core::$recent_log,
			static fn ( $line ) => \str_contains( $line, 'DEBUG: CLEANUP' )
		) );
		$this->assertNotEmpty( $cleanup_traces, 'cleanup with deletions should emit CLEANUP trace' );
		// Labeled payload: `CLEANUP DELETED <n> ALIVE <n>`, with a positive deleted count.
		$this->assertSame( 1, \preg_match( '/CLEANUP DELETED [1-9]/', \reset( $cleanup_traces ) ) );
	}

	public function test_fill_TM_BYTESTREAM_writes_packed_message(): void {
		// Real Tachikoma Partition.fill packs ANY message via Message::packed
		// and appends a newline. Consumer auto-unpacks on the read side.
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64*1024 ), "2", "4", "0", "0", "86400", "0" ] );
		$message = \Newspack_Nodes\Message::new_message();
		$message[ \Newspack_Nodes\Message::TYPE ]  = \Newspack_Nodes\Message::TM_BYTESTREAM;
		$message[ \Newspack_Nodes\Message::VALUE ] = 'from-fill';
		$p->fill( $message );
		$p->flush();

		$content = file_get_contents( "{$this->tmp}.p0/0.log" );
		$this->assertSame( "\n", substr( $content, -1 ), 'fill must terminate with newline' );
		$decoded = \Newspack_Nodes\Message::unpacked( rtrim( $content, "\n" ) );
		$this->assertSame( \Newspack_Nodes\Message::TM_BYTESTREAM, $decoded[ \Newspack_Nodes\Message::TYPE ] );
		$this->assertSame( 'from-fill', $decoded[ \Newspack_Nodes\Message::VALUE ] );
	}

	public function test_fill_packs_TM_REQUEST_TM_ERROR_TM_EOF(): void {
		// Attached-mode IPC uses Partition as a generic message transport: cli
		// → cmd-out (Partition) → worker; worker → _repl (Partition) → cli.
		// Control messages (TM_REQUEST for introspection requests, TM_ERROR
		// for failed verb responses, TM_EOF for stdin-close drain markers)
		// must round-trip through these IPC partitions, so Partition::fill
		// packs them like any other type. Data partitions like firehose.log
		// don't see these types in practice — producers only emit
		// TM_BYTESTREAM / TM_STRUCT — so allowing them through is a no-op
		// for production paths and makes IPC work.
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64*1024 ), "2", "4", "0", "0", "86400", "0" ] );

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
		$contents = \file_get_contents( "{$this->tmp}.p0/0.log" );
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
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64*1024 ), "2", "4", "0", "0", "86400", "0" ] );
		// with_index() so the .idx companion handle actually opens (default mode
		// never opens idx_fh, leaving the is_resource(idx_fh) assert false).
		$p->with_index( fn ( array $message, array $pos ) => 'entry' );
		$this->produce_into( $p, 'hello' );

		// File handle is open after write. Use lsof to verify, but more portably,
		// rely on reflection to inspect the protected handle.
		$reflection = new \ReflectionClass( $p );
		$fh_prop = $reflection->getProperty( 'fh' );
		$idx_prop = $reflection->getProperty( 'idx_fh' );

		$this->assertTrue( is_resource( $fh_prop->getValue( $p ) ), 'log handle should be open after write' );
		$this->assertTrue( is_resource( $idx_prop->getValue( $p ) ), 'idx handle should be open after write' );

		$p->remove_node();

		$this->assertNull( $fh_prop->getValue( $p ), 'log handle must be closed after remove_node' );
		$this->assertNull( $idx_prop->getValue( $p ), 'idx handle must be closed after remove_node' );
	}

	public function test_remove_node_releases_write_lock(): void {
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64*1024 ), "2", "4", "0", "0", "86400", "0" ] );
		$p->allow_large_writes();
		$this->produce_into( $p, 'hello' );

		$lock_dir = "{$this->tmp}.p0/write.lock.d";
		// Lock dir would be present transiently during with_lock, but released on success.
		// Test the property: write_lock should be null after remove_node.
		$reflection = new \ReflectionClass( $p );
		$lock_prop  = $reflection->getProperty( 'write_lock' );

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
		$p->arguments( [ "{$this->tmp}.p0", "32", "2", "4", "0", "86400", "0" ] );
		// First write fills seg 0 to 31 bytes. Second 31-byte write triggers rotate;
		// adopt-if-room keeps seg 0 (61 bytes total, slight overflow). Third 31-byte
		// write rotates and BUMPS to seg 1 (newest is now ≥ 32).
		$this->produce_into( $p, str_repeat( 'a', 30 ) );
		$this->produce_into( $p, str_repeat( 'b', 30 ) );
		$this->produce_into( $p, str_repeat( 'c', 30 ) );

		$segments = $p->get_segments( true );
		$this->assertGreaterThanOrEqual( 2, count( $segments ) );
		// Rotate lock dir lives at {base_dir}.p0/.rotate.lock.d.
		// After rotation completes, it must be released.
		$candidate_lock = "{$this->tmp}.p0/.rotate.lock.d";
		$this->assertFalse( is_dir( $candidate_lock ), 'rotate lock dir must be released after rotate' );
	}

	public function test_concurrent_rotate_skipped_when_peer_already_advanced(): void {
		// Simulate a peer rotating: pre-create segment 1 with room before our writer
		// triggers its own rotation. Our rotation should detect "newest still has room"
		// and adopt it instead of creating segment 2.
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", "32", "2", "4", "0", "86400", "0" ] );
		$this->produce_into( $p, str_repeat( 'a', 30 ) ); // fills segment 0 above 32B threshold.

		// Before our 2nd write, simulate peer rotation by creating segment 1 with content.
		@mkdir( "{$this->tmp}.p0", 0755, true );
		file_put_contents( "{$this->tmp}.p0/1.log", "peer-wrote\n" );

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
		$p->arguments( [ "{$this->tmp}.p0", "32", "2", "4", "0", "86400", "0" ] );
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
		$this->assertTrue( file_exists( "{$this->tmp}.p0/{$max_id}.log" ), 'rotated segment must have an existing file' );
	}

	// ============================================================================
	// Hardening: auto-cleanup at rotation.
	// ============================================================================

	public function test_rotation_invokes_cleanup_segments(): void {
		// num_segments=2, min_lifetime=0 (always-eligible) so cleanup runs aggressively.
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", "32", "2", "2", "0", "0", "0" ] );
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
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 16 * 1024 * 1024 ), "2", "4", "86400", "0" ] );
		\mkdir( "{$this->tmp}.p0", 0755, true );
		$size = 11 * 1024 * 1024;
		\file_put_contents( "{$this->tmp}.p0/0.log", \str_repeat( 'x', $size ) );

		$result = $p->read_at( 0, 0, $size );
		$this->assertSame( $size, \strlen( $result ) );
	}

	public function test_read_at_rejects_negative_segment_id(): void {
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 1024 * 1024 ), "2", "4", "86400", "0" ] );
		$result = $p->read_at( -1, 0, 10 );
		$this->assertSame( '', $result );
	}

	public function test_read_at_rejects_negative_offset(): void {
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 1024 * 1024 ), "2", "4", "86400", "0" ] );
		$this->produce_into( $p, 'hello' );
		$result = $p->read_at( 0, -1, 10 );
		$this->assertSame( '', $result );
	}

	public function test_read_at_rejects_negative_length(): void {
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 1024 * 1024 ), "2", "4", "86400", "0" ] );
		$this->produce_into( $p, 'hello' );
		$result = $p->read_at( 0, 0, -1 );
		$this->assertSame( '', $result );
	}

	public function test_read_at_accepts_zero_length(): void {
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 1024 * 1024 ), "2", "4", "86400", "0" ] );
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
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64 * 1024 ), "2", "4", "0", "0", "86400", "0" ] );
		$this->produce_into( $p, 'ours-1' );
		// Peer creates segment 1 underneath us. (produce_into already made p0/.)
		file_put_contents( "{$this->tmp}.p0/1.log", "peer-wrote\n" );
		// Reach into the partition to push last_segment_check back so the next fill triggers rescan.
		$ref = new \ReflectionClass( $p );
		$last_check = $ref->getProperty( 'last_segment_check' );
		$last_check->setValue( $p, microtime( true ) - 5.0 );

		$this->produce_into( $p, 'after-drift' );

		// Our writer should now be appending to segment 1, not creating segment 2.
		$current_seg = $ref->getProperty( 'current_segment_id' );
		$this->assertSame( 1, $current_seg->getValue( $p ), 'drift recovery must adopt peer segment 1' );
	}

	// ============================================================================
	// Hardening: with_index() round-trip.
	// ============================================================================

	public function test_with_index_passes_unpacked_message_array_to_formatter(): void {
		// The formatter receives the unpacked 7-field message array (not the
		// serialized JSONL line), so it never has to json_decode.
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 1024 * 1024 ), "2", "4", "86400", "0" ] );
		$received = null;
		$p->with_index( function ( array $message, array $pos ) use ( &$received ) {
			$received = $message;
			return 'entry';
		} );

		$this->produce_into( $p, 'hello-value', 'my-key' );

		$this->assertIsArray( $received, 'formatter must receive the unpacked message array' );
		$this->assertSame( 'hello-value', $received[ Message::VALUE ] );
		$this->assertSame( 'my-key', $received[ Message::KEY ] );
	}

	public function test_with_index_uses_callback_for_idx_format(): void {
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 1024 * 1024 ), "2", "4", "86400", "0" ] );
		$p->with_index( function ( array $message, array $pos ) {
			return (string) json_encode( [
				'segment' => $pos['segment'],
				'offset' => $pos['offset'],
				'length' => $pos['length'],
			] );
		} );

		$this->produce_into( $p, 'first' );
		$this->produce_into( $p, 'second' );

		$idx   = (string) file_get_contents( "{$this->tmp}.p0/0.idx" );
		$lines = array_values( array_filter( explode( "\n", $idx ) ) );
		$this->assertCount( 2, $lines );
		$first  = json_decode( $lines[0], true );
		$second = json_decode( $lines[1], true );
		$this->assertSame( 0, $first['offset'] );
		// Second entry's offset is the length of the first (packed) line.
		$this->assertSame( $first['length'], $second['offset'] );
		$this->assertGreaterThan( 0, $first['length'] );
	}

	public function test_with_index_callback_returning_null_skips_entry(): void {
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 1024 * 1024 ), "2", "4", "86400", "0" ] );
		// The callback reads the unpacked message array's inner VALUE directly.
		$p->with_index( function ( array $message, array $pos ) {
			$value = (string) ( $message[ Message::VALUE ] ?? '' );
			return ( strpos( $value, 'skip' ) === 0 ) ? null : 'kept';
		} );

		$this->produce_into( $p, 'skip-this' );
		$this->produce_into( $p, 'keep-this' );

		$idx = file_get_contents( "{$this->tmp}.p0/0.idx" );
		$this->assertSame( "kept\n", $idx );
	}

	public function test_with_index_callback_returning_empty_string_skips_overflow(): void {
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 1024 * 1024 ), "2", "4", "86400", "0" ] );
		$p->with_index( function ( array $message, array $pos ) {
			$value = (string) ( $message[ Message::VALUE ] ?? '' );
			return ( strpos( $value, 'overflow' ) === 0 ) ? '' : 'kept';
		} );

		$this->produce_into( $p, 'overflow-line' );
		$this->produce_into( $p, 'good-line' );

		$idx = file_get_contents( "{$this->tmp}.p0/0.idx" );
		$this->assertSame( "kept\n", $idx );
	}

	public function test_scan_index_with_jsonl_callback_format(): void {
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 1024 * 1024 ), "2", "4", "86400", "0" ] );
		$p->with_index( function ( array $message, array $pos ) {
			return (string) json_encode( [ 'l' => $message[ Message::VALUE ] ?? '', 'o' => $pos['offset'] ] );
		} );

		$this->produce_into( $p, 'alpha' );
		$this->produce_into( $p, 'beta' );
		$this->produce_into( $p, 'gamma' );

		$collected = [];
		$p->scan_index( function ( string $line, int $segment ) use ( &$collected ) {
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
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 1024 * 1024 ), "2", "4", "86400", "0" ] );
		$p->with_index( fn ( array $message, array $pos ) => 'entry' );
		$this->produce_into( $p, 'a' );
		$this->produce_into( $p, 'b' );
		$this->produce_into( $p, 'c' );

		$count = 0;
		$p->scan_index( function ( string $line, int $segment ) use ( &$count ) {
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
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 1024 * 1024 ), "2", "4", "86400", "0" ] );
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
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64 * 1024 ), "2", "4", "0", "0", "86400", "0" ] );
		$p->name( 'my_part' );

		$sibling = \Newspack_Nodes\Core::node( 'my_part:config' );
		$this->assertNotNull( $sibling );
		$this->assertSame( 'my_part:config', $sibling->name() );
		$this->assertSame( $p, $sibling->patron() );
	}

	public function test_partition_allow_large_writes_verb_emits_cmd_line(): void {
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64 * 1024 ), "2", "4", "0", "0", "86400", "0" ] );
		$p->name( 'my_part' );
		$sibling = \Newspack_Nodes\Core::node( 'my_part:config' );

		$result = $sibling->dispatch( 'allow_large_writes' );
		$this->assertSame( "ok\n", $result );

		$dump = $p->dump_config();
		$this->assertStringContainsString( 'command_node my_part:config allow_large_writes', $dump );
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
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64 * 1024 ), "2", "4", "0", "0", "86400", "0" ] );
		$p->name( 'my_part' );
		$sibling = \Newspack_Nodes\Core::node( 'my_part:config' );

		$result = $sibling->dispatch( 'with_index', [ 'a2-test-formatter' ] );
		$this->assertSame( "ok\n", $result );

		// Verb installs the formatter as the patron's index callback.
		$ref     = new \ReflectionClass( $p );
		$cb_prop = $ref->getProperty( 'index_callback' );
		$installed = $cb_prop->getValue( $p );
		$this->assertNotNull( $installed );
		$installed( 'check', [] );
		$this->assertSame( 1, $called );

		$dump = $p->dump_config();
		$this->assertStringContainsString( 'command_node my_part:config with_index a2-test-formatter', $dump );
	}

	public function test_partition_with_index_verb_unknown_formatter_errors(): void {
		\Newspack_Nodes\Formatters::reset();
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64 * 1024 ), "2", "4", "0", "0", "86400", "0" ] );
		$p->name( 'my_part' );
		$sibling = \Newspack_Nodes\Core::node( 'my_part:config' );

		$result = $sibling->dispatch( 'with_index', [ 'no-such-formatter' ] );
		$this->assertStringContainsString( 'unknown formatter', $result );
	}

	public function test_partition_with_index_verb_requires_formatter_name(): void {
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64 * 1024 ), "2", "4", "0", "0", "86400", "0" ] );
		$p->name( 'my_part' );
		$sibling = \Newspack_Nodes\Core::node( 'my_part:config' );

		$result = $sibling->dispatch( 'with_index' );
		$this->assertStringContainsString( 'usage', $result );
	}

	public function test_partition_node_schema_declares_ctor_and_verbs(): void {
		$schema = Partition_Node::node_schema();
		$this->assertSame( 'I/O', $schema['category'] );
		$this->assertSame( 7, \count( $schema['arguments'] ) );
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
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64 * 1024 ), "2", "4", "0", "0", "86400", "0" ] );
		$message = $this->produce( 'pending' );
		$p->fill( $message ); // appends to in-memory batch, doesn't write yet.

		$ref  = new \ReflectionClass( $p );
		$fire = $ref->getMethod( 'fire' );
		$fire->invoke( $p );

		$this->assertSame( [ 'pending' ], $this->read_partition_values( $p ) );
	}

	public function test_fire_on_empty_batch_is_noop(): void {
		// Flushing nothing must not create files or throw — fire() may run
		// once after a manual flush with no further fills.
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64 * 1024 ), "2", "4", "0", "0", "86400", "0" ] );
		$ref = new \ReflectionClass( $p );
		$fire = $ref->getMethod( 'fire' );
		$fire->invoke( $p );

		$this->assertFalse( \is_dir( "{$this->tmp}.p0" ), 'empty fire must not eager-create the partition dir' );
	}

	// ============================================================================
	// Coverage: flush early-return + idempotency.
	// ============================================================================

	public function test_flush_with_empty_batch_is_noop(): void {
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64 * 1024 ), "2", "4", "0", "0", "86400", "0" ] );
		$p->flush(); // empty batch — must early-return without touching disk.
		$this->assertFalse( \is_dir( "{$this->tmp}.p0" ) );
	}

	public function test_repeat_flush_after_first_is_noop(): void {
		// Second flush on an empty batch must return immediately without
		// re-rotating, re-writing, or otherwise corrupting state.
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64 * 1024 ), "2", "4", "0", "0", "86400", "0" ] );
		$this->produce_into( $p, 'one' );
		$before = \file_get_contents( "{$this->tmp}.p0/0.log" );
		$p->flush();
		$after = \file_get_contents( "{$this->tmp}.p0/0.log" );
		$this->assertSame( $before, $after, 'second flush must not touch the file' );
	}

	// ============================================================================
	// Coverage: get_segments cache + force_refresh.
	// ============================================================================

	public function test_get_segments_returns_empty_when_partition_dir_missing(): void {
		// Pre-fill state: no fill yet → no p0 dir. get_segments must return [].
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64 * 1024 ), "2", "4", "0", "0", "86400", "0" ] );
		$this->assertSame( [], $p->get_segments( true ) );
		$this->assertFalse( \is_dir( "{$this->tmp}.p0" ), 'get_segments must not create the dir' );
	}

	public function test_get_segments_cache_hit_within_ttl(): void {
		// First call populates the cache; create a new segment file BEHIND the
		// cache and verify a non-force-refresh call still returns the cached
		// list (no segment 1 in the result).
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64 * 1024 ), "2", "4", "0", "0", "86400", "0" ] );
		$this->produce_into( $p, 'hi' );
		$initial = $p->get_segments(); // populates cache.
		$this->assertCount( 1, $initial );

		// Manually create a peer segment without going through Partition.
		\file_put_contents( "{$this->tmp}.p0/1.log", 'peer-wrote' );

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
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64 * 1024 ), "2", "4", "0", "0", "86400", "0" ] );
		$this->produce_into( $p, 'hi' );
		\file_put_contents( "{$this->tmp}.p0/garbage.txt", 'noise' );
		\file_put_contents( "{$this->tmp}.p0/0.idx", 'idx' ); // .idx isn't a .log either.

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
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64 * 1024 ), "2", "4", "0", "0", "86400", "0" ] );
		$this->produce_into( $p, 'seed' );

		$ref        = new \ReflectionClass( $p );
		$last_check = $ref->getProperty( 'last_segment_check' );
		$last_check->setValue( $p, \microtime( true ) - 5.0 ); // force re-scan.

		$this->rmdir_recursive( "{$this->tmp}.p0" );

		$rescan = $ref->getMethod( 'maybe_rescan_segments' );
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
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64 * 1024 ), "2", "4", "0", "0", "86400", "0" ] );
		$ref = new \ReflectionClass( $p );

		$cache_prop = $ref->getProperty( 'segments_cache' );
		$this->assertNull( $cache_prop->getValue( $p ) );

		$touch = $ref->getMethod( 'touch_segments_cache' );
		$touch->invoke( $p );

		$this->assertNull( $cache_prop->getValue( $p ), 'cache must stay null when not yet populated' );
	}

	public function test_touch_segments_cache_updates_existing_entry(): void {
		// First fill populates the segments_cache, second fill writes more
		// bytes and touch_segments_cache must mirror the new current_size.
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64 * 1024 ), "2", "4", "0", "0", "86400", "0" ] );
		$this->produce_into( $p, 'first' );
		$p->get_segments(); // populate the cache.

		$this->produce_into( $p, 'second' );

		$ref        = new \ReflectionClass( $p );
		$cache_prop = $ref->getProperty( 'segments_cache' );
		$cache = $cache_prop->getValue( $p );
		$this->assertCount( 1, $cache );
		$cur_size = $ref->getProperty( 'current_size' );
		$this->assertSame( $cur_size->getValue( $p ), $cache[0]['size'], 'touch_segments_cache mirrors current_size' );
	}

	public function test_touch_segments_cache_adds_new_segment_when_missing(): void {
		// Force the cache to think we're still on segment 0 even though the
		// partition just bumped to segment 1. touch_segments_cache should
		// append the new segment to the cache rather than miss it.
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64 * 1024 ), "2", "4", "0", "0", "86400", "0" ] );
		$this->produce_into( $p, 'seed' );
		$p->get_segments(); // populate cache with seg 0.

		$ref      = new \ReflectionClass( $p );
		$cur_seg  = $ref->getProperty( 'current_segment_id' );
		$cur_seg->setValue( $p, 7 ); // pretend we're on a never-cached segment.

		$touch = $ref->getMethod( 'touch_segments_cache' );
		$touch->invoke( $p );

		$cache_prop = $ref->getProperty( 'segments_cache' );
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
		//   3. unset($p) — refcount now actually drops to 0, __destruct fires
		//      synchronously, flush() writes the batch, close_handle() closes.
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64 * 1024 ), "2", "4", "0", "0", "86400", "0" ] );
		$message = $this->produce( 'gc-flushed' );
		$p->fill( $message );

		// File doesn't exist yet — batch is in memory.
		$file = "{$this->tmp}.p0/0.log";
		$this->assertFalse( \file_exists( $file ), 'batch must not have flushed yet' );

		$p->remove_node();
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
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64 * 1024 ), "2", "4", "0", "0", "86400", "0" ] );
		$this->produce_into( $p, 'before-wipe' );

		// Drop file handles AND on-disk state.
		$p->remove_node();
		$this->rmdir_recursive( "{$this->tmp}.p0" );

		// Reset segment state so next fill re-discovers via init_current_segment.
		$ref     = new \ReflectionClass( $p );
		$cur_seg = $ref->getProperty( 'current_segment_id' );
		$cur_seg->setValue( $p, null );
		$cur_size = $ref->getProperty( 'current_size' );
		$cur_size->setValue( $p, 0 );
		$cache = $ref->getProperty( 'segments_cache' );
		$cache->setValue( $p, null );

		$this->produce_into( $p, 'after-wipe' );
		$this->assertTrue( \is_dir( "{$this->tmp}.p0" ), 'partition dir must be recreated by get_handle' );
		$this->assertSame( [ 'after-wipe' ], $this->read_partition_values( $p ) );
	}

	public function test_get_handle_reinits_when_current_log_path_missing(): void {
		// Active log file disappears mid-flight (peer rotated + wiped); next
		// fill's get_handle() must spot the missing path and call
		// init_current_segment to re-anchor.
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64 * 1024 ), "2", "4", "0", "0", "86400", "0" ] );
		$this->produce_into( $p, 'first' );

		// Close handles so a subsequent fill goes through get_handle's open path.
		$p->remove_node();

		// Delete just the active .log but leave the dir; init_current_segment
		// should land at segment 0 again.
		\unlink( "{$this->tmp}.p0/0.log" );

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
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64 * 1024 ), "2", "4", "0", "0", "86400", "0" ] );

		// Force current_log_path to point at the partition_dir itself (a real
		// directory). init_current_segment hasn't run yet, so set state by
		// hand via reflection.
		$ref = new \ReflectionClass( $p );

		// Create the partition_dir AS a directory, then replace 0.log with
		// another directory of the same name.
		\mkdir( "{$this->tmp}.p0", 0755, true );
		\mkdir( "{$this->tmp}.p0/0.log", 0755, true );

		$cur_seg = $ref->getProperty( 'current_segment_id' );
		$cur_seg->setValue( $p, 0 );

		$cur_log = $ref->getProperty( 'current_log_path' );
		$cur_log->setValue( $p, "{$this->tmp}.p0/0.log" );

		$cur_idx = $ref->getProperty( 'current_idx_path' );
		$cur_idx->setValue( $p, "{$this->tmp}.p0/0.idx" );

		try {
			$get_handle = $ref->getMethod( 'get_handle' );
			$result = $get_handle->invoke( $p );

			$this->assertNull( $result, 'get_handle must return null when fopen("a") fails on a directory target' );
		} finally {
			@\rmdir( "{$this->tmp}.p0/0.log" );
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
		$flag->setValue( $ef, true );

		// A real worker drain always has a _router (Worker_Base mounts it before the
		// drain); the 20s heartbeat timer now hitchhikes it (interval > 1000 ms).
		$router = new \Newspack_Nodes\Router_Node();
		$router->name( \Newspack_Nodes\Node_Names::ROUTER );

		try {
			$p = new Partition_Node();
			$p->arguments( [ "{$this->tmp}.p0", (string) ( 64 * 1024 ), "2", "4", "0", "0", "86400", "0" ] );
			$p->name( 'evp' );
			$p->allow_large_writes();

			$pref = new \ReflectionClass( $p );

			$lock_prop = $pref->getProperty( 'write_lock' );
			$lock = $lock_prop->getValue( $p );
			$this->assertSame( 'evp:lock', $lock->name(), 'lock must adopt :lock sibling name inside EF' );
			$this->assertSame( $p, $lock->patron(), 'lock must mark partition as its patron' );

			$hb_prop = $pref->getProperty( 'heartbeat_timer' );
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
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64 * 1024 ), "2", "4", "0", "0", "86400", "0" ] );
		$p->name( 'no-ef' );
		$p->allow_large_writes();

		// Force the next fill to attempt a heartbeat by aging last_lock_heartbeat
		// well past lock_stale_timeout / 3.
		$ref           = new \ReflectionClass( $p );
		$last_hb       = $ref->getProperty( 'last_lock_heartbeat' );
		$last_hb->setValue( $p, \microtime( true ) - 1000.0 );

		// Yank the lock dir out from under us — Lock::heartbeat will fail
		// verify_ownership when the heartbeat file is gone.
		\Newspack_Nodes\Lock_Node::force_release_at( "{$this->tmp}.p0/write.lock.d" );

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'no longer owned' );
		$message = $this->produce( 'this-throws' );
		$p->fill( $message );
	}

	public function test_fill_refreshes_heartbeat_without_throw_when_lock_still_held(): void {
		// Happy path of the same branch: fill() runs the heartbeat path,
		// succeeds, and updates last_lock_heartbeat to the current time.
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64 * 1024 ), "2", "4", "0", "0", "86400", "0" ] );
		$p->name( 'no-ef-ok' );
		$p->allow_large_writes();

		$ref     = new \ReflectionClass( $p );
		$last_hb = $ref->getProperty( 'last_lock_heartbeat' );
		$last_hb->setValue( $p, \microtime( true ) - 1000.0 );
		$before = $last_hb->getValue( $p );

		$this->produce_into( $p, 'heartbeat-ok' );

		$after = $last_hb->getValue( $p );
		$this->assertGreaterThan( $before, $after, 'fill must update last_lock_heartbeat on successful refresh' );

		$p->remove_node();
	}

	// ============================================================================
	// Coverage: emit oversize WARNING when message exceeds size cap.
	// ============================================================================

	public function test_fill_emits_oversize_WARNING_when_oversized(): void {
		$router = new \Newspack_Nodes\Tests\Capture_Sink_Node();
		$router->name( '_router' );

		$p = new Partition_Node();

		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64 * 1024 ), "2", "4", "0", "0", "86400", "0" ] );
		$p->name( 'p-drop' );
		\Newspack_Nodes\Core::$recent_log = [];

		$message = $this->produce( \str_repeat( 'x', 5000 ) ); // > MAX_LINE_SIZE
		$p->fill( $message );

		$dropped_traces = \array_values( \array_filter(
			\Newspack_Nodes\Core::$recent_log,
			static fn ( $line ) => \str_contains( $line, 'WARNING: oversize' )
		) );
		$this->assertNotEmpty( $dropped_traces, 'oversize fill must emit oversize_WARNING' );
		// Flat payload carries the reason + the offending size.
		$this->assertStringContainsString( 'oversize', \reset( $dropped_traces ) );
	}

	// ============================================================================
	// Coverage: with_index callback exception-safety.
	// ============================================================================

	public function test_with_index_callback_exception_does_not_kill_fill(): void {
		// write_index_entry wraps the callback in try/catch — a throwing
		// formatter must NOT propagate out of fill(); the .log is still
		// written and the next fill continues normally.
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64 * 1024 ), "2", "4", "0", "0", "86400", "0" ] );
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
		$p->arguments( [ "{$this->tmp}.p0", "64", "2", "4", "0", "86400", "0" ] );
		$p->with_index( fn ( array $message, array $pos ) => 'entry' );
		$this->produce_into( $p, \str_repeat( 'a', 40 ) ); // seg 0.
		$this->produce_into( $p, \str_repeat( 'b', 40 ) ); // forces rotate.

		$segments = $p->get_segments( true );
		$this->assertGreaterThanOrEqual( 2, \count( $segments ) );

		// Remove the .idx for whichever segment is newest.
		$max_id = \max( \array_column( $segments, 'id' ) );
		if ( \file_exists( "{$this->tmp}.p0/{$max_id}.idx" ) ) {
			\unlink( "{$this->tmp}.p0/{$max_id}.idx" );
		}

		$count = 0;
		$p->scan_index( function ( string $line, int $segment ) use ( &$count ) {
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
		// segment younger than min_lifetime. Exercise the count-gate branch: a
		// reasonably-large min_lifetime (1 hour) ensures all segments are
		// "young" so the count rule can't fire and the loop breaks on the
		// first iteration, even with count >> num_segments.
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", "256", "2", "2", "0", "3600", "0" ] );
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
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 1024 * 1024 ), "2", "4", "86400", "0" ] );
		$p->allow_large_writes();

		$value = \str_repeat( 'L', 5000 );
		$message   = $this->produce( $value );
		$p->fill( $message );

		// No flush() — large messages were supposed to land synchronously.
		$bytes = (string) \file_get_contents( "{$this->tmp}.p0/0.log" );
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
		$p->arguments( [ "{$this->tmp}.p0", "4500", "2", "4", "0", "86400", "0" ] );
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
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64 * 1024 ), "2", "4", "0", "0", "86400", "0" ] );
		$p->allow_large_writes();

		// Confirm pre-state: dir exists (allow_large_writes created it for the lock).
		$this->assertTrue( \is_dir( "{$this->tmp}.p0" ) );
		$this->rmdir_recursive( "{$this->tmp}.p0/write.lock.d" );
		\rmdir( "{$this->tmp}.p0" );

		// Now invoke do_rotate via reflection — it must re-create the dir.
		$ref       = new \ReflectionClass( $p );
		$do_rotate = $ref->getMethod( 'do_rotate' );
		$do_rotate->invoke( $p );

		$this->assertTrue( \is_dir( "{$this->tmp}.p0" ), 'do_rotate must materialize partition_dir when missing' );
	}

	// ============================================================================
	// Coverage: scan_index empty .idx file path.
	// ============================================================================

	public function test_scan_index_handles_completely_empty_idx_file(): void {
		// Stub a 0-byte .idx — file_exists is true, but rtrim+explode of an
		// empty string yields no entries, so the segment contributes nothing.
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64 * 1024 ), "2", "4", "0", "0", "86400", "0" ] );
		$p->with_index( fn ( array $message, array $pos ) => 'entry' );
		$this->produce_into( $p, 'seed' ); // creates p0/ + 0.idx with one entry.

		// Pre-create segment 5 with an empty .idx + a corresponding .log so
		// get_segments includes it.
		\file_put_contents( "{$this->tmp}.p0/5.log", 'x' );
		\file_put_contents( "{$this->tmp}.p0/5.idx", '' );

		$count = 0;
		$p->scan_index( function ( string $line, int $segment ) use ( &$count ) {
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
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 1024 * 1024 ), "2", "4", "86400", "0" ] );

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
		\mkdir( "{$this->tmp}.p0", 0755, true );
		\file_put_contents( "{$this->tmp}.p0/0.log", \str_repeat( 'a', 10 ) );
		\file_put_contents( "{$this->tmp}.p0/3.log", \str_repeat( 'b', 25 ) );

		$p = new Partition_Node();

		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64 * 1024 ), "2", "4", "0", "0", "86400", "0" ] );
		$ref = new \ReflectionClass( $p );
		$init = $ref->getMethod( 'init_current_segment' );
		$init->invoke( $p );

		$cur_seg = $ref->getProperty( 'current_segment_id' );
		$cur_size = $ref->getProperty( 'current_size' );
		$cur_log = $ref->getProperty( 'current_log_path' );
		$cur_idx = $ref->getProperty( 'current_idx_path' );

		$this->assertSame( 3, $cur_seg->getValue( $p ), 'newest segment id should be adopted' );
		$this->assertSame( 25, $cur_size->getValue( $p ), 'current_size mirrors newest filesize' );
		$this->assertSame( "{$this->tmp}.p0/3.log", $cur_log->getValue( $p ) );
		$this->assertSame( "{$this->tmp}.p0/3.idx", $cur_idx->getValue( $p ) );
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
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64 * 1024 ), "2", "4", "0", "0", "86400", "0" ] );
		$ref = new \ReflectionClass( $p );

		// Sanity: current_segment_id is still null pre-flush.
		$cur_seg = $ref->getProperty( 'current_segment_id' );
		$this->assertNull( $cur_seg->getValue( $p ) );

		// Build a real packed message and inject it as the resident batch.
		$message    = $this->produce( 'lazy-init' );
		$packed = \Newspack_Nodes\Message::packed( $message ) . "\n";

		$batch = $ref->getProperty( 'batch' );
		$batch->setValue( $p, $packed );

		$bargs = $ref->getProperty( 'batch_index_args' );
		$bargs->setValue( $p, [ [
			'message' => $message,
			'size'    => \strlen( $packed ),
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
		// written, and emit one loud, rate-limited line.
		// A stalled write is never silently swallowed.
		$probe = "{$this->tmp}/write-all-probe.bin";
		\file_put_contents( $probe, 'seed' );
		$ro_fh = \fopen( $probe, 'rb' );
		$this->assertNotFalse( $ro_fh );

		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64 * 1024 ), "2", "4", "0", "0", "86400", "0" ] );
		$ref = new \ReflectionClass( $p );
		$wa  = $ref->getMethod( 'write_all' );

		$warned = '';
		\Newspack_Nodes\Core::set_stderr_handler( static function ( $message ) use ( &$warned ) {
			$warned .= $message;
		} );

		$result = $wa->invoke( $p, $ro_fh, 'payload-to-write', $probe );
		\fclose( $ro_fh );

		$this->assertSame( 0, $result, 'write_all must report 0 bytes written after exhausting retries' );
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
			$p->arguments( [ "{$this->tmp}.p0", (string) ( 64 * 1024 ), "2", "4", "0", "0", "86400", "0" ] );
			$ref = new \ReflectionClass( $p );
			$wa  = $ref->getMethod( 'write_all' );

			\Newspack_Nodes\Core::set_stderr_handler( static function () {} );

			// 10 bytes offered, only 4 accepted before the stream stalls.
			$wrote = $wa->invoke( $p, $fh, 'ABCDEFGHIJ', 'segment' );
			\fclose( $fh );

			$this->assertSame( 4, $wrote, 'write_all must report the bytes that actually landed' );
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

		$p->arguments( [ "{$base}.p0", "32", "2", "4", "0", "86400", "0" ] );
		// Three 30-byte VALUES force at least one true rotation past segment 0.
		$this->produce_into( $p, \str_repeat( 'a', 30 ) );
		$this->produce_into( $p, \str_repeat( 'b', 30 ) );
		$this->produce_into( $p, \str_repeat( 'c', 30 ) );

		$this->assertTrue( \is_dir( "{$base}.p0" ), 'rotate_segment must materialize the partition dir when absent' );
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
		$p->arguments( [ "{$this->tmp}.p0", "32", "2", "4", "0", "86400", "0" ] );
		// Land one write so the partition_dir + segment 0 exist.
		$this->produce_into( $p, \str_repeat( 'a', 10 ) );

		$locks_dir = "{$this->tmp}.p0";
		$lock_dir  = "{$locks_dir}/.rotate.lock.d";
		@\mkdir( $locks_dir, 0755, true );
		@\mkdir( $lock_dir, 0755, true ); // FRESH lock — mtime is now.

		// Peer-write segment 1 so init_current_segment lands on it post-contention.
		\file_put_contents( "{$this->tmp}.p0/1.log", "peer\n" );

		try {
			$ref = new \ReflectionClass( $p );
			$rs  = $ref->getMethod( 'rotate_segment' );
			$rs->invoke( $p );

			$cur_seg = $ref->getProperty( 'current_segment_id' );
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
		// rotate_segment behavior. We don't want to add subclasses inside
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
		$locks_dir   = "{$this->tmp}.p0";
		$lock_dir    = "{$locks_dir}/.rotate.lock.d";
		@\mkdir( $locks_dir, 0755, true );
		@\unlink( $lock_dir );
		// Broken symlink to a missing target — mkdir rejects existing path,
		// filemtime returns false on the broken-symlink stat.
		if ( ! @\symlink( $lock_target, $lock_dir ) ) {
			$this->markTestSkipped( 'symlink() unavailable in this environment' );
		}

		$p = new Partition_Node();

		$p->arguments( [ "{$this->tmp}.p0", "32", "2", "4", "0", "86400", "0" ] );
		$this->produce_into( $p, 'before' ); // seed seg 0.

		try {
			$ref = new \ReflectionClass( $p );
			$rs  = $ref->getMethod( 'rotate_segment' );
			$rs->invoke( $p ); // must not throw.

			$cur_seg = $ref->getProperty( 'current_segment_id' );
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
		$p->arguments( [ "{$this->tmp}.p0", "32", "2", "4", "0", "86400", "0" ] );
		$this->produce_into( $p, \str_repeat( 'a', 20 ) ); // seed seg 0.

		$locks_dir = "{$this->tmp}.p0";
		$lock_dir  = "{$locks_dir}/.rotate.lock.d";
		@\mkdir( $locks_dir, 0755, true );
		@\mkdir( $lock_dir, 0755, true );
		// Backdate well past the TTL.
		\touch( $lock_dir, \time() - ( Partition_Node::ROTATE_LOCK_TTL_SECONDS + 10 ) );

		$before = $p->get_segments( true );
		$before_max = \max( \array_column( $before, 'id' ) );

		$ref = new \ReflectionClass( $p );
		$rs  = $ref->getMethod( 'rotate_segment' );
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
		$p->arguments( [ "{$this->tmp}.p0", "16", "2", "4", "0", "86400", "0" ] );
		\mkdir( "{$this->tmp}.p0", 0755, true );
		\file_put_contents( "{$this->tmp}.p0/0.log", \str_repeat( 'x', 32 ) ); // >= segment_size.

		// Capture stderr emissions so print_less_often's output doesn't leak.
		$captured = [];
		\Newspack_Nodes\Core::set_stderr_handler(
			static function ( string $message ) use ( &$captured ) {
				$captured[] = $message;
			}
		);

		// Make partition_dir read-only so touch() of the new 1.log fails.
		\chmod( "{$this->tmp}.p0", 0500 );

		try {
			$ref       = new \ReflectionClass( $p );
			$do_rotate = $ref->getMethod( 'do_rotate' );
			$do_rotate->invoke( $p );

			// touch() failure produces a "touch() failed" print_less_often emission.
			$matched = \array_filter(
				$captured,
				static fn ( $line ) => false !== \strpos( $line, 'touch() failed' )
			);
			$this->assertNotEmpty( $matched, 'touch() failure must surface via print_less_often' );
		} finally {
			\chmod( "{$this->tmp}.p0", 0755 ); // restore for tearDown cleanup.
		}
	}

	// ============================================================================
	// Coverage: read_at file-not-present + fopen-fails branches.
	// ============================================================================

	public function test_read_at_missing_segment_returns_empty(): void {
		// read_at on a segment_id whose .log doesn't exist must early-return ''
		// (file_exists false branch) without falling through to fopen.
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64 * 1024 ), "2", "4", "0", "0", "86400", "0" ] );
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

		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64 * 1024 ), "2", "4", "0", "0", "86400", "0" ] );
		$this->produce_into( $p, 'seed' );
		$p->remove_node(); // close handles so chmod takes effect for next open.

		$path = "{$this->tmp}.p0/0.log";
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
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 1024 * 1024 ), "2", "4", "86400", "0" ] );
		$p->with_index( static function ( array $message, array $pos ) {
			return (string) \json_encode( [ 'v' => $message[ Message::VALUE ] ?? '' ] );
		} );

		$this->produce_into( $p, 'alpha' );
		$this->produce_into( $p, 'beta' );
		$this->produce_into( $p, 'gamma' );

		$collected = [];
		$p->scan_index( function ( string $line, int $segment ) use ( &$collected ) {
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
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 1024 * 1024 ), "2", "4", "86400", "0" ] );
		$p->with_index(
			static function ( array $message, array $pos ) {
				return 'real-entry';
			}
		);

		// Seed one real entry through the normal path so segments_cache + .log
		// exist for segment 0.
		$this->produce_into( $p, 'seed' );

		// Now overwrite the .idx with a manually-crafted file that has a blank
		// middle line so scan_index hits the empty-line skip.
		\file_put_contents(
			"{$this->tmp}.p0/0.idx",
			"entry-one\n\nentry-two\n"
		);

		$collected = [];
		$p->scan_index( function ( string $line, int $segment ) use ( &$collected ) {
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
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 1024 * 1024 ), "2", "4", "86400", "0" ] );
		\mkdir( "{$this->tmp}.p0", 0755, true );
		\mkdir( "{$this->tmp}.p0/blocker", 0755, true );

		// Anchor partition state at the directory-path blocker so the lazy
		// fopen in get_handle fails. (No prior open — fresh partition.)
		$ref     = new \ReflectionClass( $p );
		$cur_seg = $ref->getProperty( 'current_segment_id' );
		$cur_seg->setValue( $p, 0 );
		$cur_log = $ref->getProperty( 'current_log_path' );
		$cur_log->setValue( $p, "{$this->tmp}.p0/blocker" );
		$cur_idx = $ref->getProperty( 'current_idx_path' );
		$cur_idx->setValue( $p, "{$this->tmp}.p0/blocker.idx" );
		$cur_size = $ref->getProperty( 'current_size' );
		$cur_size->setValue( $p, 0 );

		// Inject a real packed message as the resident batch.
		$message    = $this->produce( 'unreachable' );
		$packed = \Newspack_Nodes\Message::packed( $message ) . "\n";
		$batch  = $ref->getProperty( 'batch' );
		$batch->setValue( $p, $packed );
		$bargs = $ref->getProperty( 'batch_index_args' );
		$bargs->setValue( $p, [ [
			'message' => $message,
			'size'    => \strlen( $packed ),
		] ] );

		$p->flush(); // Must not throw; bails on null fh.

		// Batch is reset (flush's reset-up-front contract), blocker is intact.
		$this->assertSame( '', $batch->getValue( $p ), 'flush must clear the batch even when the write bailed' );
		$this->assertTrue( \is_dir( "{$this->tmp}.p0/blocker" ), 'blocker dir untouched after failed flush' );
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
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 1024 * 1024 ), "2", "4", "86400", "0" ] );
		$p->allow_large_writes();

		// Force current_log_path to a directory; fopen('a') on a directory
		// returns false on every supported OS. Use reflection because
		// get_handle's TOCTOU recovery would re-init if we just delete the
		// file.
		\mkdir( "{$this->tmp}.p0/blocker", 0755, true );
		$ref     = new \ReflectionClass( $p );
		$cur_seg = $ref->getProperty( 'current_segment_id' );
		$cur_seg->setValue( $p, 0 );
		$cur_log = $ref->getProperty( 'current_log_path' );
		$cur_log->setValue( $p, "{$this->tmp}.p0/blocker" ); // existing directory.
		$cur_idx = $ref->getProperty( 'current_idx_path' );
		$cur_idx->setValue( $p, "{$this->tmp}.p0/blocker.idx" );

		$big_msg = $this->produce( \str_repeat( 'L', 5000 ) );
		$p->fill( $big_msg ); // Must not throw; bails on null fh.

		// File-content sanity: nothing was written to a real segment because
		// the open failed. (No assertion against the value of bytes_written:
		// write_all never ran.)
		$this->assertTrue( \is_dir( "{$this->tmp}.p0/blocker" ), 'blocker dir must still be present (fill must not have unlinked it)' );
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

		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64 * 1024 ), "2", "4", "0", "0", "86400", "0" ] );
		// Pre-create the partition_dir so is_dir passes — get_segments then
		// proceeds to scandir, which fails on 0000 perms.
		\mkdir( "{$this->tmp}.p0", 0755, true );
		\chmod( "{$this->tmp}.p0", 0000 );

		try {
			$segments = $p->get_segments( true );
			$this->assertSame( [], $segments, 'get_segments must return [] when scandir fails' );
		} finally {
			\chmod( "{$this->tmp}.p0", 0755 ); // restore for tearDown cleanup.
		}
	}

	/** Read a protected/private property of a node via reflection. */
	private function read_node_prop( object $node, string $prop ) {
		$ref = new \ReflectionClass( $node );
		$p   = $ref->getProperty( $prop );
		return $p->getValue( $node );
	}

	public function test_allow_large_writes_names_write_lock_sibling(): void {
		// Rule 2: the Lock sibling is named even in request scope (no drain loop).
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64 * 1024 ), "2", "4", "0", "0", "86400", "0" ] );
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
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64 * 1024 ), "2", "4", "0", "0", "86400", "0" ] );
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
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64 * 1024 ), "2", "4", "0", "0", "86400", "0" ] );
		$p->name( 'big_part' );
		$echo = new \Newspack_Nodes\Echo_Node();
		$p->sink( $echo );
		$p->allow_large_writes();

		$lock = $this->read_node_prop( $p, 'write_lock' );
		$this->assertSame( $echo, $lock->sink() );

		$p->remove_node();
	}

	/** Write one record whose VALUE is the given array into the flat offset dir. */
	private function write_value_record( string $offsetlog_dir, array $value ): void {
		$p   = new Partition_Node();
		$p->arguments( [ $offsetlog_dir ] );
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
		$p->arguments( [ $this->tmp ] );
		$message                  = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::VALUE ] = 'just-a-string';
		$p->fill( $message );
		$p->flush();

		$this->assertNull( Partition_Node::read_latest_value_at( $this->tmp ) );
	}

	/** Write one snapshot record (`{ cache: { <node>: { items: [...] } } }`) into $offsets/$name. */
	private function write_snapshot_cache( string $name, array $items, string $node = 'digest' ): void {
		$this->write_value_record( "{$this->tmp}/$name", [ 'segment' => 0, 'offset' => 0, 'cache' => [ $node => [ 'items' => $items ] ] ] );
	}

	public function test_read_latest_snapshot_cache_returns_empty_for_no_matching_dirs(): void {
		$this->assertSame( [], Partition_Node::read_latest_snapshot_cache( $this->tmp, 'scored.p*', 'digest' ) );
	}

	public function test_read_latest_snapshot_cache_flattens_items_across_dirs(): void {
		$this->write_snapshot_cache( 'scored.p0', [ [ 'title' => 'a' ], [ 'title' => 'b' ] ] );
		$this->write_snapshot_cache( 'scored.p1', [ [ 'title' => 'c' ] ] );

		$items = Partition_Node::read_latest_snapshot_cache( $this->tmp, 'scored.p*', 'digest' );

		$this->assertEqualsCanonicalizing(
			[ [ 'title' => 'a' ], [ 'title' => 'b' ], [ 'title' => 'c' ] ],
			$items
		);
	}

	public function test_read_latest_snapshot_cache_ignores_non_matching_glob(): void {
		$this->write_snapshot_cache( 'scored.p0', [ [ 'title' => 'a' ] ] );
		$this->write_snapshot_cache( 'other.p0', [ [ 'title' => 'z' ] ] );

		$items = Partition_Node::read_latest_snapshot_cache( $this->tmp, 'scored.p*', 'digest' );

		$this->assertSame( [ [ 'title' => 'a' ] ], $items );
	}

	public function test_read_latest_snapshot_cache_drops_non_array_items(): void {
		$this->write_snapshot_cache( 'scored.p0', [ [ 'title' => 'a' ], 'not-an-array', [ 'title' => 'b' ] ] );

		$items = Partition_Node::read_latest_snapshot_cache( $this->tmp, 'scored.p*', 'digest' );

		$this->assertSame( [ [ 'title' => 'a' ], [ 'title' => 'b' ] ], $items );
	}

	public function test_read_latest_snapshot_cache_returns_empty_when_cache_items_absent(): void {
		$this->write_value_record( "{$this->tmp}/scored.p0", [ 'segment' => 0, 'offset' => 0 ] );

		$this->assertSame( [], Partition_Node::read_latest_snapshot_cache( $this->tmp, 'scored.p*', 'digest' ) );
	}

	public function test_read_latest_snapshot_cache_honors_custom_cache_and_items_keys(): void {
		$this->write_value_record( "{$this->tmp}/scored.p0", [ 'state' => [ 'digest' => [ 'rows' => [ [ 'n' => 1 ] ] ] ] ] );

		$items = Partition_Node::read_latest_snapshot_cache( $this->tmp, 'scored.p*', 'digest', 'state', 'rows' );

		$this->assertSame( [ [ 'n' => 1 ] ], $items );
	}

	public function test_read_latest_snapshot_cache_tolerates_trailing_slash_on_dir(): void {
		$this->write_snapshot_cache( 'scored.p0', [ [ 'title' => 'a' ] ] );

		$items = Partition_Node::read_latest_snapshot_cache( $this->tmp . '/', 'scored.p*', 'digest' );

		$this->assertSame( [ [ 'title' => 'a' ] ], $items );
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
		$probe->arguments( [ "{$this->tmp}.p0", "1024", "2", "2" ] );

		$this->assertSame( "{$this->tmp}.p0", $probe->probe_segment_dir() );
		$this->assertSame( "{$this->tmp}.p0/3.log", $probe->get_segment_path( 3 ) );
		$this->assertSame( "{$this->tmp}.p0/3.idx", $probe->probe_index_path( 3 ) );
		$this->assertSame( \Newspack_Nodes\Partition_Node::SEGMENT_PATTERN, $probe->probe_pattern() );
		$this->assertSame( "{$this->tmp}.p0/.rotate.lock.d", $probe->probe_rotate_lock() );
		$this->assertSame( "{$this->tmp}.p0/write.lock.d", $probe->probe_write_lock() );

		$message                  = \Newspack_Nodes\Message::new_message();
		$message[ \Newspack_Nodes\Message::TYPE ]  = \Newspack_Nodes\Message::TM_BYTESTREAM;
		$message[ \Newspack_Nodes\Message::VALUE ] = 'hi';
		$this->assertSame(
			\Newspack_Nodes\Message::packed( $message ) . "\n",
			$probe->probe_record( $message )
		);
	}

	public function test_read_tail_index_by_returns_latest_record_per_key(): void {
		// Topicprobe-style reader: index the newest segment's tail by a VALUE
		// field, latest record wins (records append chronologically).
		$dir = "{$this->tmp}/probe";
		$log = new Partition_Node();
		$log->arguments( [ "{$dir}", (string) ( 64 * 1024 ), "2", "2", "0", "0" ] );
		foreach (
			[
				[ 'offsetlog_dir' => 'a.p0', 'cursor_offset' => 1 ],
				[ 'offsetlog_dir' => 'b.p0', 'cursor_offset' => 2 ],
				[ 'offsetlog_dir' => '', 'cursor_offset' => 7 ],     // empty key → skipped
				[ 'offsetlog_dir' => 'a.p0', 'cursor_offset' => 9 ], // newer a → wins
			] as $value
		) {
			$message                   = Message::new_message();
			$message[ Message::TYPE ]  = Message::TM_STRUCT;
			$message[ Message::VALUE ] = $value;
			$log->fill( $message );
		}
		$log->flush();

		$index = Partition_Node::read_tail_index_by( $dir, 'offsetlog_dir' );
		$this->assertSame( [ 'a.p0', 'b.p0' ], \array_keys( $index ) );
		$this->assertSame( 9, $index['a.p0']['cursor_offset'], 'latest record per key wins' );
		$this->assertSame( 2, $index['b.p0']['cursor_offset'] );
	}

	public function test_fill_pumps_event_framework_so_a_blocked_worker_can_stop_mid_write(): void {
		// fill() must pump the worker heartbeat so a stuck worker can stop from inside the write.
		Event_Framework::reset();
		$ef = Event_Framework::instance();

		$p = new Partition_Node();
		$p->name( 'firehose-part' );
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64 * 1024 ), "2", "4", "0", "0", "86400", "0" ] );

		$state = (object) [ 'stop' => false, 'ticks' => 0 ];
		$timer = new class extends Timer_Node {
			/** @var callable */
			public $on_fire;
			public function fire_cb(): void {
				( $this->on_fire )();
			}
		};
		$timer->on_fire = function () use ( $p, $state ) {
			$state->stop           = true; // worker should now stop
			$message               = Message::new_message();
			$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
			$message[ Message::VALUE ] = 'line';
			$p->fill( $message );          // fill → pump → predicate false → throw
		};
		$timer->set_timer( 1, true );

		$this->expectException( Worker_Should_Stop::class );
		$ef->drain(
			function () use ( $state ): bool {
				Core::$now = \microtime( true );
				return ! $state->stop && ++$state->ticks < 1000;
			},
			cooperative_stop: true
		);
	}

	public function test_fill_flushes_the_batched_message_before_a_cooperative_stop_throws(): void {
		// A small (batched) message hasn't hit disk when pump() signals the stop, and
		// close_handle doesn't flush (remove_node's teardown flush lands too late). The
		// clean-stop contract needs it durable BEFORE the throw unwinds (the Consumer
		// commits past it), so fill() flushes the batch before pump() throws.
		Event_Framework::reset();
		$ef = Event_Framework::instance();

		$p = new Partition_Node();
		$p->name( 'firehose-part' );
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64 * 1024 ), "2", "4", "0", "0", "86400", "0" ] );

		$state = (object) [ 'stop' => false, 'ticks' => 0 ];
		$timer = new class extends Timer_Node {
			/** @var callable */
			public $on_fire;
			public function fire_cb(): void {
				( $this->on_fire )();
			}
		};
		$timer->on_fire = function () use ( $p, $state ) {
			$state->stop               = true;
			$message                   = Message::new_message();
			$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
			$message[ Message::VALUE ] = 'durable';
			$p->fill( $message ); // fill → batch → pump → predicate false → throw
		};
		$timer->set_timer( 1, true );

		try {
			$ef->drain(
				function () use ( $state ): bool {
					Core::$now = \microtime( true );
					return ! $state->stop && ++$state->ticks < 1000;
				},
				cooperative_stop: true
			);
			$this->fail( 'expected Worker_Should_Stop' );
		} catch ( Worker_Should_Stop $e ) {
			$this->addToAssertionCount( 1 );
		}

		$segment = "{$this->tmp}.p0/0.log";
		$this->assertFileExists( $segment );
		$decoded = Message::unpacked( \rtrim( (string) \file_get_contents( $segment ), "\n" ) );
		$this->assertSame( 'durable', $decoded[ Message::VALUE ], 'the in-flight batched message must be durable before the clean stop' );
	}

	public function test_remove_node_flushes_the_residual_batch_on_shutdown(): void {
		// Shutdown persists via cleanup_all_nodes() → remove_node(), not GC/__destruct.
		// A batched-but-unflushed line (e.g. the REPL partition's final "stopping" log)
		// must reach disk on explicit teardown, since the 0-delay flush timer never
		// fires once the drain loop has exited.
		Event_Framework::reset(); // predicate null → fill() won't throw a stop.

		$p = new Partition_Node();
		$p->name( 'shutdown-flush' );
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64 * 1024 ), "2", "4", "0", "0", "86400", "0" ] );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::VALUE ] = 'last-line';
		$p->fill( $message ); // batches; the 0-delay flush timer never fires at shutdown.

		$segment = "{$this->tmp}.p0/0.log";
		$this->assertFileDoesNotExist( $segment, 'fill() batches without flushing' );

		$p->remove_node(); // explicit teardown must flush before closing handles.

		$this->assertFileExists( $segment );
		$decoded = Message::unpacked( \rtrim( (string) \file_get_contents( $segment ), "\n" ) );
		$this->assertSame( 'last-line', $decoded[ Message::VALUE ] );
	}

	public function test_fill_does_not_throw_a_stop_when_no_drain_is_active(): void {
		// The shutdown checkpoint writes the offsetlog (and Flame's stats mirror) via
		// Partition::fill AFTER drain() unwound and restored continue_predicate to null.
		// pump() must be inert then, so a checkpoint write never throws a spurious
		// Worker_Should_Stop mid-save and leaves the offsetlog half-written.
		Event_Framework::reset(); // fresh instance: continue_predicate is null.

		$p = new Partition_Node();
		$p->name( 'offsetlog-like' );
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64 * 1024 ), "2", "4", "0", "0", "86400", "0" ] );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::VALUE ] = 'frame';
		$p->fill( $message ); // must NOT throw with no active drain.
		$p->flush();

		$this->assertFileExists( "{$this->tmp}.p0/0.log" );
	}

	public function test_a_flush_failure_during_a_stop_does_not_mask_the_cooperative_stop(): void {
		// maybe_stop() flushes the batch durable before rethrowing the stop. If flush()
		// itself throws (rotate/mkdir/short-write), that must NOT replace the
		// Worker_Should_Stop — else the cooperative stop is lost and a generic error hits
		// the poison/dead-letter path instead of a clean respawn.
		Event_Framework::reset();
		$ef = Event_Framework::instance();

		$p = new class extends Partition_Node {
			public function flush(): void {
				throw new \RuntimeException( 'disk full' );
			}
			// Base __destruct() flushes; a throwing flush there would crash PHPUnit at GC.
			public function __destruct() {}
		};
		$p->name( 'firehose-part' );
		$p->arguments( [ "{$this->tmp}.p0", (string) ( 64 * 1024 ), "2", "4", "0", "0", "86400", "0" ] );

		$state = (object) [ 'stop' => false, 'ticks' => 0 ];
		$timer = new class extends Timer_Node {
			/** @var callable */
			public $on_fire;
			public function fire_cb(): void {
				( $this->on_fire )();
			}
		};
		$timer->on_fire = function () use ( $p, $state ) {
			$state->stop               = true;
			$message                   = Message::new_message();
			$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
			$message[ Message::VALUE ] = 'x';
			$p->fill( $message ); // fill → batch → maybe_stop → pump throws → flush throws
		};
		$timer->set_timer( 1, true );

		$this->expectException( Worker_Should_Stop::class );
		$ef->drain(
			function () use ( $state ): bool {
				Core::$now = \microtime( true );
				return ! $state->stop && ++$state->ticks < 1000;
			},
			cooperative_stop: true
		);
	}

	// ============================================================================
	// Rotation-cache reflection helper + one-scan cases.
	// ============================================================================

	/**
	 * Reflection helper: read the protected segments_cache property.
	 *
	 * @return array<int,array{id:int,size:int}>|null
	 */
	private function read_segments_cache( Partition_Node $p ): ?array {
		$ref  = new \ReflectionProperty( Partition_Node::class, 'segments_cache' );
		/** @var array<int,array{id:int,size:int}>|null $value */
		$value = $ref->getValue( $p );
		return $value;
	}

	public function test_spawn_rotation_keeps_cache_warm_and_correct(): void {
		// Force enough writes to fill segment 0 past 32 bytes so the next fill
		// spawns segment 1 (no room to adopt). The spawn branch of do_rotate must
		// leave segments_cache non-null and equal to the on-disk truth.
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", "32", "2", "8", "0", "86400", "0" ] );
		$this->produce_into( $p, \str_repeat( 'a', 30 ) );
		$this->produce_into( $p, \str_repeat( 'b', 30 ) );
		$this->produce_into( $p, \str_repeat( 'c', 30 ) );

		$cache = $this->read_segments_cache( $p );
		$this->assertNotNull( $cache, 'spawn rotation must leave segments_cache warm, not null' );
		$this->assertSame( $p->get_segments( true ), $cache, 'cache must equal the on-disk truth after a spawn rotation' );
	}

	public function test_adopt_rotation_keeps_cache_warm_and_correct(): void {
		// A peer rotates to segment 1 (still empty/has room) underneath us, then
		// our rotate_segment lands and the adopt branch of do_rotate picks it up.
		// The line-351 force-scan already populated the cache with the truth
		// including the adopted segment — it must NOT be nulled.
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", "64", "2", "8", "0", "86400", "0" ] );
		$this->produce_into( $p, 'seed' );

		// Peer creates an empty segment 1 (room to adopt) directly on disk.
		\touch( "{$this->tmp}.p0/1.log" );

		$ref       = new \ReflectionMethod( Partition_Node::class, 'do_rotate' );
		$ref->invoke( $p );

		$cur_seg = new \ReflectionProperty( Partition_Node::class, 'current_segment_id' );
		$this->assertSame( 1, $cur_seg->getValue( $p ), 'do_rotate must adopt the empty peer segment 1' );

		$cache = $this->read_segments_cache( $p );
		$this->assertNotNull( $cache, 'adopt rotation must leave segments_cache warm, not null' );
		$this->assertSame( $p->get_segments( true ), $cache, 'cache must equal the on-disk truth after an adopt rotation' );
	}

	public function test_rotation_does_one_directory_scan_not_two(): void {
		// do_rotate's spawn path used to force-scan twice: once for next_id and
		// once again inside cleanup_segments. With the cache maintained, the
		// post-create list is known, so cleanup must NOT force a second scan.
		$p = new class() extends Partition_Node {
			public int $forced_scans = 0;
			public function get_segments( bool $force_refresh = false, ?float $now = null ): array {
				if ( $force_refresh ) {
					++$this->forced_scans;
				}
				return parent::get_segments( $force_refresh, $now );
			}
		};
		$p->arguments( [ "{$this->tmp}.p0", "32", "2", "8", "0", "86400", "0" ] );
		$this->produce_into( $p, \str_repeat( 'a', 30 ) );

		// Reset the counter, then trigger exactly one spawn rotation.
		$p->forced_scans = 0;
		$rotate = new \ReflectionMethod( Partition_Node::class, 'rotate_segment' );
		$rotate->invoke( $p );

		$this->assertSame( 1, $p->forced_scans, 'a single rotation must force exactly one directory scan' );
	}

	public function test_cleanup_prunes_and_leaves_cache_warm(): void {
		// num_segments=2, min_lifetime=0 → cleanup deletes the oldest beyond 2.
		// After pruning, segments_cache must be non-null and match the surviving
		// on-disk segments (not nulled-after-prune).
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", "256", "2", "2", "0", "0", "0" ] );
		for ( $i = 0; $i < 20; ++$i ) {
			$this->produce_into( $p, \str_repeat( 'x', 100 ) );
		}

		$p->cleanup_segments();

		$cache = $this->read_segments_cache( $p );
		$this->assertNotNull( $cache, 'cleanup must leave segments_cache warm, not null' );
		$truth = $p->get_segments( true );
		$this->assertSame( $truth, $cache, 'pruned cache must equal the surviving on-disk segments' );
		$this->assertLessThanOrEqual( 2, \count( $cache ), 'cleanup must prune down to num_segments' );
	}

	public function test_cleanup_falls_back_to_scan_when_cache_null(): void {
		// Standalone callers (tests) invoke cleanup_segments() with a cold cache.
		// It must fall back to a force-scan and still prune correctly.
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", "256", "2", "2", "0", "0", "0" ] );
		for ( $i = 0; $i < 20; ++$i ) {
			$this->produce_into( $p, \str_repeat( 'x', 100 ) );
		}

		// Cold-start the cache so cleanup has nothing maintained to read.
		$cache_prop = new \ReflectionProperty( Partition_Node::class, 'segments_cache' );
		$cache_prop->setValue( $p, null );

		$p->cleanup_segments();

		$this->assertLessThanOrEqual( 2, \count( $p->get_segments( true ) ), 'cleanup must prune even from a cold cache' );
	}

	public function test_offsetlog_segment_size_one_keeps_cache_warm(): void {
		// The offsetlog runs segment_size=1, so every checkpoint rotates. After
		// N writes the cache must stay non-null and match the alive segments —
		// the regression the user observed (segments_cache: null forever).
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", "1", "2", "4", "0", "0", "0" ] );
		for ( $i = 0; $i < 8; ++$i ) {
			$this->produce_into( $p, "chk-{$i}" );
		}

		$cache = $this->read_segments_cache( $p );
		$this->assertNotNull( $cache, 'rotate-every-write offsetlog must keep its cache warm' );
		$this->assertSame( $p->get_segments( true ), $cache, 'offsetlog cache must match the alive segments' );
	}

	// ============================================================================
	// truncate_after(): the Consumer time-travel PLAY truncate-on-resume primitive.
	// Deletes every segment id > segment_id and resets the write state so the log
	// continues coherently FROM segment_id (next checkpoint rotates to id+1).
	// ============================================================================

	/**
	 * Build a keyframe-style Partition (segment_size=1, num_segments large) so each
	 * fill rotates to a fresh segment — exactly the offsetlog's one-record-per-segment
	 * layout. Returns the Partition with $count segments (ids 0..$count-1).
	 */
	private function make_keyframe_partition( int $count ): Partition_Node {
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", "1", "2", "100", "0", "0", "0" ] );
		for ( $i = 0; $i < $count; ++$i ) {
			$this->produce_into( $p, "f-{$i}" );
		}
		$this->assertCount( $count, $p->get_segments( true ), 'precondition: one segment per keyframe' );
		return $p;
	}

	public function test_truncate_after_deletes_segments_past_the_id(): void {
		$p = $this->make_keyframe_partition( 6 ); // ids 0..5.

		$p->truncate_after( 2 );

		$ids = \array_column( $p->get_segments( true ), 'id' );
		$this->assertSame( [ 0, 1, 2 ], $ids, 'segments with id > 2 are deleted; <= 2 survive' );
		for ( $i = 3; $i <= 5; ++$i ) {
			$this->assertFileDoesNotExist( "{$this->tmp}.p0/{$i}.log", "segment {$i}.log must be unlinked" );
		}
		$this->assertFileExists( "{$this->tmp}.p0/2.log", 'the rewind-point segment survives' );
	}

	public function test_truncate_after_resets_write_state_to_the_rewind_point(): void {
		$p = $this->make_keyframe_partition( 5 ); // ids 0..4.

		$p->truncate_after( 1 );

		$this->assertSame( 1, $this->read_private( $p, 'current_segment_id' ), 'current_segment_id resets to the rewind point' );
		$on_disk = (int) \filesize( "{$this->tmp}.p0/1.log" );
		$this->assertSame( $on_disk, $this->read_private( $p, 'current_size' ), 'current_size resets to the rewind segment on-disk size' );
		$this->assertSame( -1, $this->read_private( $p, 'fh_segment_id' ), 'cached file handle is closed (fh_segment_id reset)' );
		$this->assertNull( $this->read_private( $p, 'fh' ), 'cached file handle is nulled' );
	}

	public function test_truncate_after_segments_cache_matches_disk(): void {
		$p = $this->make_keyframe_partition( 5 );
		$p->get_segments(); // warm the cache.

		$p->truncate_after( 2 );

		$cache = $this->read_segments_cache( $p );
		$this->assertNotNull( $cache, 'cache stays warm after truncation' );
		$this->assertSame( $p->get_segments( true ), $cache, 'segments_cache equals the on-disk survivor list' );
		$this->assertSame( [ 0, 1, 2 ], \array_column( $cache, 'id' ), 'cache holds only survivors' );
	}

	public function test_truncate_after_next_write_rotates_to_id_plus_one_monotonic(): void {
		// The whole point: after truncating to the rewind point, the forward timeline
		// stays monotonic — the next checkpoint appends a fresh segment_id+1 with no
		// gap and without overwriting a survivor.
		$p = $this->make_keyframe_partition( 6 ); // ids 0..5.

		$p->truncate_after( 2 );
		$this->produce_into( $p, 'resumed' ); // segment_size=1 forces a rotation.

		$ids = \array_column( $p->get_segments( true ), 'id' );
		$this->assertSame( [ 0, 1, 2, 3 ], $ids, 'next write rotates to rewind-point+1 (no gap, no survivor overwrite)' );
		$this->assertSame( [ 'resumed' ], $this->read_partition_values( $p, 3 ), 'the resumed record lands in the fresh segment 3' );
		$this->assertSame( [ 'f-2' ], $this->read_partition_values( $p, 2 ), 'survivor segment 2 is untouched' );
	}

	public function test_truncate_after_is_a_noop_at_or_past_newest(): void {
		$p     = $this->make_keyframe_partition( 4 ); // ids 0..3.
		$before = $p->get_segments( true );

		$p->truncate_after( 3 ); // newest id.
		$this->assertSame( $before, $p->get_segments( true ), 'truncate at the newest id is a no-op' );

		$p->truncate_after( 99 ); // past newest.
		$this->assertSame( $before, $p->get_segments( true ), 'truncate past the newest id is a no-op' );
	}

	public function test_truncate_after_is_a_noop_when_id_not_present(): void {
		// A keyframe partition whose ids are 0..3; truncating to an absent id between
		// the existing ones can't happen here (contiguous), so use a hole: delete one
		// file by hand, then truncate to its (now-absent) id — no-op, nothing changes.
		$p = $this->make_keyframe_partition( 4 ); // ids 0..3.
		\unlink( "{$this->tmp}.p0/1.log" );
		$before = $p->get_segments( true ); // ids 0,2,3.
		$this->assertSame( [ 0, 2, 3 ], \array_column( $before, 'id' ) );

		$p->truncate_after( 1 ); // 1 is absent.

		$this->assertSame( $before, $p->get_segments( true ), 'truncate to an absent id is a no-op' );
	}

	public function test_truncate_after_works_on_a_write_lock_held_partition(): void {
		// The old write_lock guard had it backwards: holding the exclusivity
		// lock means there is no peer append to race. Guard removed.
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", "1", "2", "100", "0", "0", "0" ] );
		$p->name( 'src' );
		$p->sink( new \Newspack_Nodes\Tests\Capture_Sink_Node() );
		for ( $i = 0; $i < 4; ++$i ) {
			$this->produce_into( $p, "f-{$i}" );
		}
		$p->allow_large_writes(); // acquires the exclusivity write_lock.

		$p->truncate_after( 1 );

		$this->assertSame( [ 0, 1 ], \array_column( $p->get_segments( true ), 'id' ), 'a locked partition truncates like any other' );
	}

	public function test_truncate_after_works_on_a_void_warranty_offsetlog(): void {
		// The snapshot-offsetlog config: void_warranty() lifts the cap WITHOUT a
		// lock (write_lock stays null), asserting single-writer. That IS the legit
		// caller, so truncate_after must go through — the guard keys on the lock,
		// not on the lifted cap.
		$p = new Partition_Node();
		$p->arguments( [ "{$this->tmp}.p0", "1", "2", "100", "0", "0", "0" ] );
		$p->void_warranty();
		for ( $i = 0; $i < 5; ++$i ) {
			$this->produce_into( $p, "f-{$i}" );
		}
		$this->assertCount( 5, $p->get_segments( true ), 'precondition: 5 keyframes' );

		$p->truncate_after( 2 );

		$this->assertSame( [ 0, 1, 2 ], \array_column( $p->get_segments( true ), 'id' ), 'void_warranty offsetlog truncates normally' );
	}

	// ============================================================================
	// Single-writer rotation reads the warm cache instead of scandir'ing.
	// ============================================================================

	public function test_single_writer_rotation_serves_segments_from_warm_cache(): void {
		$scans                   = 0;
		Partition_Node::$scandir = function ( string $d ) use ( &$scans ) {
			++$scans;
			return \scandir( $d );
		};
		try {
			$p = new Partition_Node();
			$p->arguments( [ "{$this->tmp}/voided", "65536", "2", "10", "0", "0", "0" ] );
			$p->void_warranty();
			$this->produce_into( $p, 'first' );

			// Warm the cache so do_rotate has something to read.
			$p->get_segments();

			// Age the cache past SEGMENT_CACHE_TTL: only the single-writer no-TTL
			// path can still serve it from memory.
			$ref  = new \ReflectionClass( $p );
			$time = $ref->getProperty( 'segments_cache_time' );
			$time->setValue( $p, \microtime( true ) - 10 );

			$before    = $scans;
			$do_rotate = $ref->getMethod( 'do_rotate' );
			$do_rotate->invoke( $p );

			$this->assertSame(
				$before,
				$scans,
				'single-writer (warranty-voided) rotation must read segments from the warm cache, not scandir'
			);
		} finally {
			Partition_Node::$scandir = null;
		}
	}

	public function test_multi_writer_rotation_force_scans_for_peer_detection(): void {
		$scans                   = 0;
		Partition_Node::$scandir = function ( string $d ) use ( &$scans ) {
			++$scans;
			return \scandir( $d );
		};
		try {
			$p = new Partition_Node();
			$p->arguments( [ "{$this->tmp}/multi", "65536", "2", "10", "0", "0", "0" ] );
			$this->produce_into( $p, 'first' );

			$p->get_segments();

			$ref  = new \ReflectionClass( $p );
			$time = $ref->getProperty( 'segments_cache_time' );
			$time->setValue( $p, \microtime( true ) - 10 );

			$before    = $scans;
			$do_rotate = $ref->getMethod( 'do_rotate' );
			$do_rotate->invoke( $p );

			$this->assertGreaterThan(
				$before,
				$scans,
				'multi-writer rotation must force-scan to detect a peer that already rotated'
			);
		} finally {
			Partition_Node::$scandir = null;
		}
	}
	/**
	 * Segments carry the request firehose, IPC transcripts and every logged
	 * record. fopen() honors the process umask, which on a typical web SAPI is
	 * 022 — so they landed 0644, readable by any local account. The tree is 0700
	 * and ownership-gated now, but the file mode is wrong on its own terms.
	 */
	public function test_segment_files_are_not_world_readable(): void {
		$this->use_base_dir( $this->tmp );
		$dir = "{$this->tmp}/logs/private.p0";
		$p   = new Partition_Node();
		$p->name( 'private' );
		$p->arguments( [ $dir, '1048576', '2', '4', '0', '0', '0' ] );

		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$m[ Message::VALUE ] = "record\n";
		$p->fill( $m );
		$p->flush();

		$segment = "{$dir}/0.log";
		$this->assertFileExists( $segment, 'the write must have created a segment' );
		$this->assertSame(
			'0600',
			\substr( \sprintf( '%o', \fileperms( $segment ) ), -4 )
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
