<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Topic_Node;

#[CoversClass( Topic_Node::class )]
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

	public function test_constructor_does_not_create_partitions(): void {
		$__topic = new Topic_Node();
		$__topic->arguments( [ "{$this->tmp}/firehose.p{partition}", "4", "65536", "2", "4", "86400", "0" ] );
		$this->assertFalse( is_dir( "{$this->tmp}/firehose.p0" ) );
	}

	public function test_fill_routes_by_key(): void {
		$t = new Topic_Node();
		$t->arguments( [ "{$this->tmp}/firehose.p{partition}", "4", "65536", "2", "4", "86400", "0" ] );
		$this->produce_into( $t, 'data', '/url1' );

		// Key routing is deterministic; whichever partition got it contains the
		// packed message. Decode the file to assert on VALUE rather than raw bytes.
		$found = false;
		for ( $i = 0; $i < 4; ++$i ) {
			$path = "{$this->tmp}/firehose.p{$i}/0.log";
			if ( file_exists( $path ) ) {
				$decoded = Message::unpacked( rtrim( file_get_contents( $path ), "\n" ) );
				if ( 'data' === $decoded[ Message::VALUE ] && '/url1' === $decoded[ Message::KEY ] ) {
					$found = true;
				}
				break;
			}
		}
		$this->assertTrue( $found );
	}

	public function test_same_key_routes_to_same_partition(): void {
		$t = new Topic_Node();
		$t->arguments( [ "{$this->tmp}/firehose.p{partition}", "4", "65536", "2", "4", "86400", "0" ] );
		$this->produce_into( $t, 'first', '/url1' );
		$this->produce_into( $t, 'second', '/url1' );

		// Find the partition that has data; it must contain two packed lines, both with the same key.
		for ( $i = 0; $i < 4; ++$i ) {
			$path = "{$this->tmp}/firehose.p{$i}/0.log";
			if ( file_exists( $path ) ) {
				$lines = array_filter( explode( "\n", file_get_contents( $path ) ), static fn ( $l ) => '' !== $l );
				$this->assertCount( 2, $lines );
				$values = array_map( static fn ( $l ) => Message::unpacked( $l )[ Message::VALUE ], $lines );
				$this->assertSame( [ 'first', 'second' ], array_values( $values ) );
				return;
			}
		}
		$this->fail( 'No data written to any partition' );
	}

	public function test_node_fill_TM_BYTESTREAM_routes_by_KEY(): void {
		$t = new Topic_Node();
		$t->arguments( [ "{$this->tmp}/firehose.p{partition}", "4", "65536", "2", "4", "86400", "0" ] );

		$message = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::KEY ]   = '/some/url';
		$message[ Message::VALUE ] = 'fill-data';
		$t->fill( $message );
		$t->flush();

		$expected_partition = Partition_Node::hash_to_partition( '/some/url', 4 );
		$path = "{$this->tmp}/firehose.p{$expected_partition}/0.log";
		$decoded = Message::unpacked( rtrim( file_get_contents( $path ), "\n" ) );
		$this->assertSame( 'fill-data', $decoded[ Message::VALUE ] );
		$this->assertSame( '/some/url', $decoded[ Message::KEY ] );
	}

	public function test_num_partitions_contains_constructor_value(): void {
		$t = new Topic_Node();
		$t->arguments( [ "{$this->tmp}/firehose.p{partition}", "7", "65536", "2", "4", "86400", "0" ] );
		$ref = new \ReflectionClass( $t );
		$this->assertSame( 7, $ref->getProperty( 'num_partitions' )->getValue( $t ) );
	}

	/**
	 * Tachikoma-parity constructible: no-arg ctor + arguments() setter walks
	 * the node_schema and assigns dir_template / num_partitions / segment_size /
	 * min_segments / num_segments / min_lifetime / lifetime to real int properties (not placeholder
	 * strings, which would TypeError the typed-int property assignment).
	 */
	public function test_constructible_via_no_arg_ctor_and_arguments_setter(): void {
		$t = new Topic_Node();
		$t->arguments( [ "{$this->tmp}/firehose.p{partition}", "3", "1048576", "2", "2", "0", "0" ] );
		$ref = new \ReflectionClass( $t );
		$this->assertSame( "{$this->tmp}/firehose.p{partition}", $ref->getProperty( 'dir_template' )->getValue( $t ) );
		$this->assertSame( 3,        $ref->getProperty( 'num_partitions' )->getValue( $t ) );
		$this->assertSame( 1048576,  $ref->getProperty( 'segment_size' )->getValue( $t ) );
		$this->assertSame( 2,        $ref->getProperty( 'num_segments' )->getValue( $t ) );
		$this->assertSame( 0,        $ref->getProperty( 'min_lifetime' )->getValue( $t ) );
	}

	public function test_child_partition_dir_substitutes_curly_partition_token(): void {
		$t = new Topic_Node();
		$t->arguments( [ "{$this->tmp}/firehose.p{partition}", "3", "65536", "2", "4", "86400", "0" ] );
		$t->name( 'firehose' );

		// Route three distinct keys; each materialized child must write to
		// {tmp}/firehose.p{i}/, never to a literal "{partition}" dir.
		$this->produce_into( $t, 'a', 'k1' );
		$this->produce_into( $t, 'b', 'k2' );
		$this->produce_into( $t, 'c', 'k3' );

		$this->assertDirectoryDoesNotExist( "{$this->tmp}/firehose.p{partition}", 'the {partition} token must be substituted, not used literally' );
		$ref  = new \ReflectionClass( Topic_Node::class );
		$prop = $ref->getProperty( 'partitions' );
		foreach ( $prop->getValue( $t ) as $i => $child ) {
			$this->assertSame( "{$this->tmp}/firehose.p{$i}", $child->partition_dir() );
		}
	}

	/**
	 * Optional args default to `<config:*>` tokens; `arguments()` with only the
	 * required token resolves each omitted arg from config and coerces it to the
	 * typed `int` property (never a raw token string, which would TypeError).
	 * The test-config values (segment_size 1024, num_segments 2) are distinct
	 * from the DEFAULT_* constants (67108864, 4), proving the value came from
	 * config. num_partitions here is the explicit positional token (4).
	 */
	public function test_arguments_setter_resolves_config_defaults_for_missing_optional_tokens(): void {
		$t = new Topic_Node();
		$t->arguments( [ "{$this->tmp}/firehose.p{partition}", "4" ] );
		$ref = new \ReflectionClass( $t );
		$this->assertSame( 4,    $ref->getProperty( 'num_partitions' )->getValue( $t ) );
		$this->assertSame( 1024, $ref->getProperty( 'segment_size' )->getValue( $t ) );
		$this->assertSame( 2,    $ref->getProperty( 'num_segments' )->getValue( $t ) );
		$this->assertSame( 0,    $ref->getProperty( 'min_lifetime' )->getValue( $t ) );
	}

	public function test_constructor_clamps_num_partitions_to_minimum_one(): void {
		// max(1, $n) clamps zero/negative to 1 — callers that pass bad config don't
		// trip a divide-by-zero in hash_to_partition.
		$t = new Topic_Node();
		$t->arguments( [ "{$this->tmp}/firehose.p{partition}", "0", "65536", "2", "4", "86400", "0" ] );
		$ref = new \ReflectionClass( $t );
		$this->assertSame( 1, $ref->getProperty( 'num_partitions' )->getValue( $t ) );

		$t2 = new Topic_Node();
		$t2->arguments( [ "{$this->tmp}/firehose.p{partition}", "-3", "65536", "2", "4", "86400", "0" ] );
		$ref2 = new \ReflectionClass( $t );
		$this->assertSame( 1, $ref2->getProperty( 'num_partitions' )->getValue( $t2 ) );
	}

	public function test_fill_packs_TM_REQUEST_TM_ERROR_TM_EOF(): void {
		// Topic::fill mirrors Partition::fill — it's the user-facing
		// multi-Partition wrapper. Control messages (TM_REQUEST, TM_ERROR,
		// TM_EOF) round-trip through Topic-as-transport in IPC scenarios,
		// so Topic packs them like any other type instead of dropping.
		$t = new Topic_Node();
		$t->arguments( [ "{$this->tmp}/firehose.p{partition}", "2", "65536", "2", "4", "86400", "0" ] );

		$types = [
			Message::TM_REQUEST,
			Message::TM_ERROR,
			Message::TM_EOF,
		];
		foreach ( $types as $type ) {
			$message                   = Message::new_message();
			$message[ Message::TYPE ]  = $type;
			$message[ Message::KEY ]   = '/url'; // Same KEY routes to same partition.
			$message[ Message::VALUE ] = 'payload-' . $type;
			$t->fill( $message );
		}
		$t->flush(); // Force the in-memory batch to land on disk synchronously.

		// All three packed onto the partition (3 lines on disk).
		$idx     = Partition_Node::hash_to_partition( '/url', 2 );
		$lines   = \array_values( \array_filter(
			\explode( "\n", \file_get_contents( "{$this->tmp}/firehose.p{$idx}/0.log" ) )
		) );
		$this->assertCount( 3, $lines );
		foreach ( $lines as $i => $line ) {
			$decoded = Message::unpacked( $line );
			$this->assertSame( $types[ $i ], $decoded[ Message::TYPE ] );
		}
	}

	public function test_fill_pre_pinned_TO_routes_to_specified_partition(): void {
		$t = new Topic_Node();
		$t->arguments( [ "{$this->tmp}/firehose.p{partition}", "4", "65536", "2", "4", "86400", "0" ] );

		// TO=p2/... pins partition 2 regardless of KEY.
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::TO ]    = 'p2/some/path';
		$message[ Message::KEY ]   = 'unrelated-key';
		$message[ Message::VALUE ] = 'pinned-data';
		$t->fill( $message );
		$t->flush();

		$this->assertFileExists( "{$this->tmp}/firehose.p2/0.log" );
		// Other partitions must not be touched.
		$this->assertFalse( is_dir( "{$this->tmp}/firehose.p0" ) );
		$this->assertFalse( is_dir( "{$this->tmp}/firehose.p1" ) );
		$this->assertFalse( is_dir( "{$this->tmp}/firehose.p3" ) );
	}

	public function test_fill_pre_pinned_TO_out_of_range_falls_through_to_key_routing(): void {
		// TO=p99/... where 99 >= num_partitions(2) → falls through to KEY routing.
		$t = new Topic_Node();
		$t->arguments( [ "{$this->tmp}/firehose.p{partition}", "2", "65536", "2", "4", "86400", "0" ] );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::TO ]    = 'p99/path';
		$message[ Message::KEY ]   = 'k';
		$message[ Message::VALUE ] = 'data';
		$t->fill( $message );
		$t->flush();

		// Whichever partition the key hashes to is materialized; the out-of-range
		// pin was ignored.
		$idx = \Newspack_Nodes\Partition_Node::hash_to_partition( 'k', 2 );
		$this->assertFileExists( "{$this->tmp}/firehose.p{$idx}/0.log" );
	}

	public function test_fill_empty_key_uses_round_robin(): void {
		// Round-robin counter is static — clear by getting baseline first.
		$t = new Topic_Node();
		$t->arguments( [ "{$this->tmp}/firehose.p{partition}", "4", "65536", "2", "4", "86400", "0" ] );

		// Empty KEY → round-robin. Send 8 messages and confirm at least 2 partitions
		// got data (deterministic round-robin, but counter is shared across tests).
		for ( $i = 0; $i < 8; ++$i ) {
			$message                   = Message::new_message();
			$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
			$message[ Message::KEY ]   = '';
			$message[ Message::VALUE ] = "msg-{$i}";
			$t->fill( $message );
		}
		$t->flush();

		$populated = 0;
		for ( $i = 0; $i < 4; ++$i ) {
			if ( file_exists( "{$this->tmp}/firehose.p{$i}/0.log" ) ) {
				++$populated;
			}
		}
		// Round-robin across 4 partitions with 8 messages = each partition got exactly 2.
		$this->assertSame( 4, $populated );
	}

	public function test_sink_propagates_to_existing_partitions(): void {
		$t = new Topic_Node();
		$t->arguments( [ "{$this->tmp}/firehose.p{partition}", "4", "65536", "2", "4", "86400", "0" ] );

		// Materialize a partition first.
		$this->produce_into( $t, 'data', 'k1' );

		// Find which partition got materialized.
		$partition_idx = Partition_Node::hash_to_partition( 'k1', 4 );

		// Now wire a sink AFTER partition materialization — it must propagate to
		// every partition currently held so their persist responses still flow.
		$new_sink = new Capture_Sink_Node();
		$t->sink( $new_sink );

		// Verify the partition's sink was updated by routing a response back from it.
		// A partition's sink is exercised when it emits. Force one to emit by sending
		// a TM_REQUEST through Topic — Topic itself answers, but if we use the
		// reflection on Topic to peek at its partitions array we can verify directly.
		$ref      = new \ReflectionClass( Topic_Node::class );
		$prop     = $ref->getProperty( 'partitions' );
		$partitions = $prop->getValue( $t );

		$this->assertSame( $new_sink, $partitions[ $partition_idx ]->sink() );
	}

	/**
	 * Rule 2 sibling discipline: a named Topic names each materialized Partition
	 * `{topic_name}:p{i}` (mirrors Consumer's `{name}:source`) and patron-links
	 * it to the Topic so dump_metadata hides it from the canvas.
	 */
	public function test_materialized_partitions_are_named_and_patron_linked(): void {
		$t = new Topic_Node();
		$t->arguments( [ "{$this->tmp}/firehose.p{partition}", "4", "65536", "2", "4", "86400", "0" ] );
		$t->name( 'firehose' );

		$this->produce_into( $t, 'data', 'k1' );
		$idx = Partition_Node::hash_to_partition( 'k1', 4 );

		$ref  = new \ReflectionClass( Topic_Node::class );
		$prop = $ref->getProperty( 'partitions' );
		$partitions = $prop->getValue( $t );

		$this->assertSame( "firehose:p{$idx}", $partitions[ $idx ]->name() );
		$this->assertSame( $t, $partitions[ $idx ]->patron() );
	}

	/**
	 * The Partition sibling keeps Topic's own sink (the specific sink Topic
	 * already assigns) — Rule 2's "unless it already sets a specific sink".
	 */
	public function test_materialized_partition_inherits_topic_sink(): void {
		$t = new Topic_Node();
		$t->arguments( [ "{$this->tmp}/firehose.p{partition}", "4", "65536", "2", "4", "86400", "0" ] );
		$t->name( 'firehose' );
		$sink = new Capture_Sink_Node();
		$t->sink( $sink );

		$this->produce_into( $t, 'data', 'k1' );
		$idx = Partition_Node::hash_to_partition( 'k1', 4 );

		$ref  = new \ReflectionClass( Topic_Node::class );
		$prop = $ref->getProperty( 'partitions' );
		$partitions = $prop->getValue( $t );

		$this->assertSame( $sink, $partitions[ $idx ]->sink() );
	}

	/**
	 * An unnamed Topic leaves its Partition unnamed (mirrors Consumer guarding
	 * sibling naming on a non-empty owner name) — but still patron-links it.
	 */
	public function test_unnamed_topic_leaves_partition_unnamed_but_patron_linked(): void {
		$t = new Topic_Node();
		$t->arguments( [ "{$this->tmp}/firehose.p{partition}", "4", "65536", "2", "4", "86400", "0" ] );

		$this->produce_into( $t, 'data', 'k1' );
		$idx = Partition_Node::hash_to_partition( 'k1', 4 );

		$ref  = new \ReflectionClass( Topic_Node::class );
		$prop = $ref->getProperty( 'partitions' );
		$partitions = $prop->getValue( $t );

		$this->assertSame( '', $partitions[ $idx ]->name() );
		$this->assertSame( $t, $partitions[ $idx ]->patron() );
	}

	public function test_remove_node_tears_down_partitions(): void {
		$t = new Topic_Node();
		$t->arguments( [ "{$this->tmp}/firehose.p{partition}", "4", "65536", "2", "4", "86400", "0" ] );

		// Materialize two partitions.
		$this->produce_into( $t, 'a', 'k1' );
		$this->produce_into( $t, 'b', 'k2' );

		// remove_node calls Partition::remove_node on each, which closes file handles
		// and clears Core registrations. Should not throw.
		$t->remove_node();

		// After remove, internal partitions array is reset.
		// Subsequent fill should re-materialize cleanly.
		$this->produce_into( $t, 'c', 'k1' );
		// Test passes if no exception was thrown above.
		$this->assertTrue( true );
	}

	// -------------------------------------------------------------------------
	// large-write propagation: void_warranty() / allow_large_writes() flow to children
	// -------------------------------------------------------------------------

	public function test_void_warranty_lets_oversize_records_through_to_partitions(): void {
		// Default Partitions cap records at 4 KB (PIPE_BUF). void_warranty() on the
		// Topic must lift that cap on every partition it materializes.
		$t = new Topic_Node();
		$t->name( 'firehose' );
		$t->arguments( [ "{$this->tmp}/firehose.p{partition}", "1", "67108864", "2", "4", "0", "0" ] );
		$t->void_warranty();

		$big = str_repeat( 'x', 5000 );
		$this->produce_into( $t, $big, 'k1' );

		$path    = "{$this->tmp}/firehose.p0/0.log";
		$decoded = Message::unpacked( rtrim( (string) file_get_contents( $path ), "\n" ) );
		$this->assertSame( $big, $decoded[ Message::VALUE ] );
	}

	public function test_topic_without_large_write_flag_drops_oversize_records(): void {
		// Contrast partner: with no large-write opt-in, the >4 KB record is dropped
		// by the Partition (this is exactly what `ingest` must warn about in --dry-run).
		$t = new Topic_Node();
		$t->name( 'firehose' );
		$t->arguments( [ "{$this->tmp}/firehose.p{partition}", "1", "67108864", "2", "4", "0", "0" ] );

		$big = str_repeat( 'x', 5000 );
		$this->produce_into( $t, $big, 'k1' );

		$path = "{$this->tmp}/firehose.p0/0.log";
		$this->assertSame( '', file_exists( $path ) ? (string) file_get_contents( $path ) : '' );
	}

	public function test_arguments_null_returns_last_set_tokens(): void {
		// arguments(null) is the getter — it returns the token list last passed in,
		// not a re-parse. (The setter path stores it via parse_schema_args.)
		$t = new Topic_Node();
		$t->arguments( [ "{$this->tmp}/firehose.p{partition}", "4", "65536", "2", "4", "86400", "0" ] );
		$this->assertSame(
			[ "{$this->tmp}/firehose.p{partition}", "4", "65536", "2", "4", "86400", "0" ],
			$t->arguments()
		);
	}

	public function test_allow_large_writes_lifts_cap_on_existing_and_future_partitions(): void {
		// allow_large_writes() is the held-lock cousin of void_warranty(): it lifts
		// the 4 KB cap on every partition — both those already materialized (the
		// set_large_write_mode loop) AND any created later (apply at partition()).
		$t = new Topic_Node();
		$t->name( 'firehose' );
		$t->arguments( [ "{$this->tmp}/firehose.p{partition}", "1", "67108864", "2", "4", "0", "0" ] );

		// Materialize p0 BEFORE the opt-in so the existing-partition loop runs.
		$this->produce_into( $t, 'small', 'k1' );
		$this->assertSame( $t, $t->allow_large_writes() );

		$big = str_repeat( 'z', 5000 );
		$this->produce_into( $t, $big, 'k1' );

		$values = $this->read_partition_values(
			$this->read_private( $t, 'partitions' )[0]
		);
		$this->assertSame( [ 'small', $big ], $values );
	}

	public function test_allow_large_writes_repeat_in_same_mode_is_a_noop(): void {
		// The Topic-level guard short-circuits a repeat call in the same mode so it
		// never re-runs the existing-partition loop — which would call
		// Partition::allow_large_writes() a second time on the already-locked
		// partition and block re-acquiring the held write lock. Materialize a
		// partition FIRST so that loop has something to act on (without it the loop
		// is empty and the guard is never exercised).
		$t = new Topic_Node();
		$t->name( 'firehose' );
		$t->arguments( [ "{$this->tmp}/firehose.p{partition}", "1", "67108864", "2", "4", "0", "0" ] );
		$this->produce_into( $t, 'small', 'k1' );

		$this->assertSame( $t, $t->allow_large_writes() );
		$partition = $this->read_private( $t, 'partitions' )[0];
		// The mode actually reached the materialized partition.
		$this->assertTrue( $this->read_private( $partition, 'allow_large_writes' ) );
		$held_lock = $this->read_private( $partition, 'write_lock' );

		// Repeat in the same mode is a genuine no-op: the partition's held lock is the
		// SAME instance afterward (the guard skipped the re-lock loop entirely), and
		// the Topic itself is returned.
		$this->assertSame( $t, $t->allow_large_writes() );
		$this->assertSame( 'lock', $this->read_private( $t, 'large_write_mode' ) );
		$this->assertSame( $held_lock, $this->read_private( $partition, 'write_lock' ) );
	}

	public function test_byte_stats_aggregate_across_materialized_partitions(): void {
		// largest_msg_sent() is the max single record over partitions; bytes_written()
		// is the sum. Route two distinct keys (k1->p1, k2->p3) so they materialize two
		// partitions, then assert the aggregate against the actual on-disk bytes —
		// measured INDEPENDENTLY of the per-partition counters so the test can't
		// tautologically restate the production aggregation.
		$t = new Topic_Node();
		$t->arguments( [ "{$this->tmp}/firehose.p{partition}", "4", "65536", "2", "4", "86400", "0" ] );
		$this->produce_into( $t, 'hello', 'k1' );
		$this->produce_into( $t, 'a-longer-message', 'k2' );

		$partitions = $this->read_private( $t, 'partitions' );
		// Two distinct keys MUST land in two distinct partitions; a hash collision
		// would collapse them into one and turn max==sum into a tautology.
		$this->assertCount( 2, $partitions );

		// Ground truth from disk: each partition holds exactly one record, so its
		// segment file size IS that record's byte count. sum = both files, max = the
		// bigger file.
		$file_sizes = [];
		foreach ( $partitions as $p ) {
			$file_sizes[] = \strlen( (string) \file_get_contents( "{$p->partition_dir()}/0.log" ) );
		}
		$expected_sum = \array_sum( $file_sizes );
		$expected_max = \max( $file_sizes );

		// Two non-empty partitions → the sum is strictly larger than the largest
		// single record; collapsing both keys into one partition would break this.
		$this->assertGreaterThan( $expected_max, $expected_sum );
		$this->assertSame( $expected_max, $t->largest_msg_sent() );
		$this->assertSame( $expected_sum, $t->bytes_written() );
	}

	public function test_void_warranty_applies_to_partitions_materialized_after_the_call(): void {
		// void_warranty() before any fill() must still reach lazily-materialized
		// partitions — mirrors how sink() propagates to future children.
		$t = new Topic_Node();
		$t->name( 'firehose' );
		$t->arguments( [ "{$this->tmp}/firehose.p{partition}", "2", "67108864", "2", "4", "0", "0" ] );
		$t->void_warranty();

		// Pin one oversize record to EACH partition via TO so both materialize after the call.
		$big = str_repeat( 'y', 5000 );
		foreach ( [ 'p0', 'p1' ] as $pin ) {
			$message                  = $this->produce( $big );
			$message[ Message::TO ]   = $pin;
			$t->fill( $message );
			$t->flush();
		}

		$found = 0;
		for ( $i = 0; $i < 2; ++$i ) {
			$path = "{$this->tmp}/firehose.p{$i}/0.log";
			if ( file_exists( $path ) && '' !== rtrim( (string) file_get_contents( $path ), "\n" ) ) {
				++$found;
			}
		}
		$this->assertSame( 2, $found, 'both lazily-materialized partitions accepted the oversize record' );
	}

	/**
	 * A Topic is a fan of Partitions, so it must take the Partition verbs — and
	 * propagate them to partitions it materializes LATER (they're created lazily,
	 * on first write to that key). `allow_large_writes` and `void_warranty`
	 * already existed as PHP methods but were unreachable: `commands` was empty,
	 * so `cmd topic:config void_warranty` silently did nothing.
	 */
	public function test_void_warranty_verb_reaches_partitions_made_later(): void {
		$t = new Topic_Node();
		$t->name( 'zebra:topic' );
		$t->arguments( [ "{$this->tmp}/zebra.p{partition}", "4", "65536", "2", "4", "86400", "0" ] );

		$this->assertSame( "ok\n", $this->verb( $t, 'void_warranty' ) );

		// A >4KB write only lands if the cap was lifted on the partition the key
		// routes to — which does not exist yet at the time of the verb.
		$big = \str_repeat( 'x', 8000 );
		$this->produce_into( $t, $big, '/late' );

		$found = false;
		for ( $i = 0; $i < 4; ++$i ) {
			$path = "{$this->tmp}/zebra.p{$i}/0.log";
			if ( \file_exists( $path ) ) {
				$decoded = Message::unpacked( \rtrim( \file_get_contents( $path ), "\n" ) );
				$found   = $big === $decoded[ Message::VALUE ];
				break;
			}
		}
		$this->assertTrue( $found, 'the >4KB write must land — the cap was lifted' );
	}

	public function test_allow_large_writes_verb_is_dispatchable(): void {
		$t = new Topic_Node();
		$t->name( 'zebra:topic' );
		$t->arguments( [ "{$this->tmp}/zebra.p{partition}", "2", "65536", "2", "4", "86400", "0" ] );

		$this->assertSame( "ok\n", $this->verb( $t, 'allow_large_writes' ) );
	}

	/** with_index names a line-formatter for each partition's companion index. */
	public function test_with_index_verb_names_a_formatter(): void {
		\Newspack_Nodes\Formatters::register( 'zebra-index', static fn ( $m ): string => 'z' );
		$t = new Topic_Node();
		$t->name( 'zebra:topic' );
		$t->arguments( [ "{$this->tmp}/zebra.p{partition}", "2", "65536", "2", "4", "86400", "0" ] );

		$this->assertStringContainsString(
			'unknown formatter',
			$this->verb( $t, 'with_index', 'no-such-formatter' )
		);
		$this->assertSame(
			"ok\n",
			$this->verb( $t, 'with_index', 'zebra-index' )
		);
	}

	/** The verbs round-trip: dump_config re-emits them, like Partition's does. */
	public function test_dump_config_round_trips_the_verbs(): void {
		\Newspack_Nodes\Formatters::register( 'zebra-index', static fn ( $m ): string => 'z' );
		$t = new Topic_Node();
		$t->name( 'zebra:topic' );
		$t->arguments( [ "{$this->tmp}/zebra.p{partition}", "2", "65536", "2", "4", "86400", "0" ] );
		$this->verb( $t, 'void_warranty' );
		$this->verb( $t, 'with_index', 'zebra-index' );

		$dump = $t->dump_config();

		$this->assertStringContainsString( 'command_node zebra:topic:config void_warranty', $dump );
		$this->assertStringContainsString( 'command_node zebra:topic:config with_index zebra-index', $dump );
	}

	/** Dispatch a verb through the node's own `{name}:config` interpreter. */
	private function verb( Topic_Node $t, string $name, string $args = '' ): mixed {
		$interpreter = $this->read_private( $t, 'interpreter' );
		return $interpreter->dispatch( $name, '' === $args ? [] : [ $args ] );
	}
}
