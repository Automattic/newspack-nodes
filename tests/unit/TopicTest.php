<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Topic_Node;
use PHPUnit\Framework\Attributes\CoversClass;

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
		$__topic->arguments( "{$this->tmp}/firehose.p{partition} 4 65536 4 86400" );
		$this->assertFalse( is_dir( "{$this->tmp}/firehose.p0" ) );
	}

	public function test_fill_routes_by_key(): void {
		$t = new Topic_Node();
		$t->arguments( "{$this->tmp}/firehose.p{partition} 4 65536 4 86400" );
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
		$t->arguments( "{$this->tmp}/firehose.p{partition} 4 65536 4 86400" );
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
		$t->arguments( "{$this->tmp}/firehose.p{partition} 4 65536 4 86400" );

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

	public function test_pre_declares_READY_event(): void {
		$t = new Topic_Node();
		$t->arguments( "{$this->tmp}/firehose.p{partition} 4 65536 4 86400" );
		$t->name( 'firehose' );
		// Should not throw — event is pre-declared.
		$t->register( 'READY', 'cb', function () {} );
		$this->assertTrue( true );
	}

	public function test_READY_fires_after_first_partition_materialized(): void {
		$t = new Topic_Node();
		$t->arguments( "{$this->tmp}/firehose.p{partition} 4 65536 4 86400" );
		$t->name( 'firehose' );

		$fired = [];
		$t->register( 'READY', 'early', function ( $payload ) use ( &$fired ) {
			$fired[] = $payload;
		} );

		// READY hasn't fired yet — no Partition materialized.
		$this->assertSame( [], $fired );

		// Trigger first-partition materialization via fill().
		$this->produce_into( $t, 'data', '/some/url' );

		// Listener registered BEFORE first partition should now have been notified.
		$this->assertSame( [ 'firehose' ], $fired );
	}

	public function test_READY_replays_to_late_registrants(): void {
		$t = new Topic_Node();
		$t->arguments( "{$this->tmp}/firehose.p{partition} 4 65536 4 86400" );
		$t->name( 'firehose' );

		// Materialize first partition before any listener registers.
		$this->produce_into( $t, 'data', '/some/url' );

		// Late registrant should get cached state immediately on register.
		$received = [];
		$t->register( 'READY', 'late', function ( $payload ) use ( &$received ) {
			$received[] = $payload;
		} );

		$this->assertSame( [ 'firehose' ], $received );
	}

	public function test_READY_fires_only_once_across_subsequent_partitions(): void {
		$t = new Topic_Node();
		$t->arguments( "{$this->tmp}/firehose.p{partition} 4 65536 4 86400" );
		$t->name( 'firehose' );

		$count = 0;
		$t->register( 'READY', 'count', function () use ( &$count ) {
			++$count;
		} );

		// Force materialization of all four partitions via key-routing.
		// Different keys hit different partitions; only the FIRST should fire READY.
		$this->produce_into( $t, 'a', 'k1' );
		$this->produce_into( $t, 'b', 'k2' );
		$this->produce_into( $t, 'c', 'k3' );
		$this->produce_into( $t, 'd', 'k4' );

		$this->assertSame( 1, $count, 'READY must fire exactly once across partition lifetime' );
	}

	public function test_num_partitions_returns_constructor_value(): void {
		$t = new Topic_Node();
		$t->arguments( "{$this->tmp}/firehose.p{partition} 7 65536 4 86400" );
		$this->assertSame( 7, $t->num_partitions() );
	}

	/**
	 * Tachikoma-parity constructible: no-arg ctor + arguments() setter walks
	 * the node_schema and assigns dir_template / num_partitions / segment_size /
	 * num_segments / max_lifespan to real int properties (not placeholder
	 * strings, which would TypeError the typed-int property assignment).
	 */
	public function test_constructible_via_no_arg_ctor_and_arguments_setter(): void {
		$t = new Topic_Node();
		$t->arguments( "{$this->tmp}/firehose.p{partition} 3 1048576 2 0" );
		$this->assertSame( 3, $t->num_partitions() );
		$ref = new \ReflectionClass( $t );
		$this->assertSame( "{$this->tmp}/firehose.p{partition}", $ref->getProperty( 'dir_template' )->getValue( $t ) );
		$this->assertSame( 3,        $ref->getProperty( 'num_partitions' )->getValue( $t ) );
		$this->assertSame( 1048576,  $ref->getProperty( 'segment_size' )->getValue( $t ) );
		$this->assertSame( 2,        $ref->getProperty( 'num_segments' )->getValue( $t ) );
		$this->assertSame( 0,        $ref->getProperty( 'max_lifespan' )->getValue( $t ) );
	}

	public function test_child_partition_dir_substitutes_curly_partition_token(): void {
		$t = new Topic_Node();
		$t->arguments( "{$this->tmp}/firehose.p{partition} 3 65536 4 86400" );
		$t->name( 'firehose' );

		// Route three distinct keys; each materialized child must write to
		// {tmp}/firehose.p{i}/, never to a literal "{partition}" dir.
		$this->produce_into( $t, 'a', 'k1' );
		$this->produce_into( $t, 'b', 'k2' );
		$this->produce_into( $t, 'c', 'k3' );

		$this->assertDirectoryDoesNotExist( "{$this->tmp}/firehose.p{partition}", 'the {partition} token must be substituted, not used literally' );
		$ref  = new \ReflectionClass( Topic_Node::class );
		$prop = $ref->getProperty( 'partitions' );
		$prop->setAccessible( true );
		foreach ( $prop->getValue( $t ) as $i => $child ) {
			$this->assertSame( "{$this->tmp}/firehose.p{$i}", $child->partition_dir() );
		}
	}

	/**
	 * Schema defaults are real int constants (not placeholder strings like
	 * '<config:num_partitions>') — so `arguments()` with only the required
	 * tokens leaves the optional ints at their DEFAULT_* values rather than
	 * a string that would TypeError the typed `int` property assignment.
	 */
	public function test_arguments_setter_applies_schema_defaults_for_missing_optional_tokens(): void {
		$t = new Topic_Node();
		$t->arguments( "{$this->tmp}/firehose.p{partition} 4" );
		$this->assertSame( 4, $t->num_partitions() );
		$ref = new \ReflectionClass( $t );
		$this->assertSame( Partition_Node::DEFAULT_SEGMENT_SIZE, $ref->getProperty( 'segment_size' )->getValue( $t ) );
		$this->assertSame( Partition_Node::DEFAULT_NUM_SEGMENTS, $ref->getProperty( 'num_segments' )->getValue( $t ) );
		$this->assertSame( Partition_Node::DEFAULT_MAX_LIFESPAN, $ref->getProperty( 'max_lifespan' )->getValue( $t ) );
	}

	public function test_constructor_clamps_num_partitions_to_minimum_one(): void {
		// max(1, $n) clamps zero/negative to 1 — callers that pass bad config don't
		// trip a divide-by-zero in hash_to_partition.
		$t = new Topic_Node();
		$t->arguments( "{$this->tmp}/firehose.p{partition} 0 65536 4 86400" );
		$this->assertSame( 1, $t->num_partitions() );

		$t2 = new Topic_Node();
		$t2->arguments( "{$this->tmp}/firehose.p{partition} -3 65536 4 86400" );
		$this->assertSame( 1, $t2->num_partitions() );
	}

	public function test_fill_packs_TM_REQUEST_TM_ERROR_TM_EOF(): void {
		// Topic::fill mirrors Partition::fill — it's the user-facing
		// multi-Partition wrapper. Control messages (TM_REQUEST, TM_ERROR,
		// TM_EOF) round-trip through Topic-as-transport in IPC scenarios,
		// so Topic packs them like any other type instead of dropping.
		$t = new Topic_Node();
		$t->arguments( "{$this->tmp}/firehose.p{partition} 2 65536 4 86400" );

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
		$t->arguments( "{$this->tmp}/firehose.p{partition} 4 65536 4 86400" );

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
		$t->arguments( "{$this->tmp}/firehose.p{partition} 2 65536 4 86400" );

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
		$t->arguments( "{$this->tmp}/firehose.p{partition} 4 65536 4 86400" );

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
		$t->arguments( "{$this->tmp}/firehose.p{partition} 4 65536 4 86400" );

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
		$prop->setAccessible( true );
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
		$t->arguments( "{$this->tmp}/firehose.p{partition} 4 65536 4 86400" );
		$t->name( 'firehose' );

		$this->produce_into( $t, 'data', 'k1' );
		$idx = Partition_Node::hash_to_partition( 'k1', 4 );

		$ref  = new \ReflectionClass( Topic_Node::class );
		$prop = $ref->getProperty( 'partitions' );
		$prop->setAccessible( true );
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
		$t->arguments( "{$this->tmp}/firehose.p{partition} 4 65536 4 86400" );
		$t->name( 'firehose' );
		$sink = new Capture_Sink_Node();
		$t->sink( $sink );

		$this->produce_into( $t, 'data', 'k1' );
		$idx = Partition_Node::hash_to_partition( 'k1', 4 );

		$ref  = new \ReflectionClass( Topic_Node::class );
		$prop = $ref->getProperty( 'partitions' );
		$prop->setAccessible( true );
		$partitions = $prop->getValue( $t );

		$this->assertSame( $sink, $partitions[ $idx ]->sink() );
	}

	/**
	 * An unnamed Topic leaves its Partition unnamed (mirrors Consumer guarding
	 * sibling naming on a non-empty owner name) — but still patron-links it.
	 */
	public function test_unnamed_topic_leaves_partition_unnamed_but_patron_linked(): void {
		$t = new Topic_Node();
		$t->arguments( "{$this->tmp}/firehose.p{partition} 4 65536 4 86400" );

		$this->produce_into( $t, 'data', 'k1' );
		$idx = Partition_Node::hash_to_partition( 'k1', 4 );

		$ref  = new \ReflectionClass( Topic_Node::class );
		$prop = $ref->getProperty( 'partitions' );
		$prop->setAccessible( true );
		$partitions = $prop->getValue( $t );

		$this->assertSame( '', $partitions[ $idx ]->name() );
		$this->assertSame( $t, $partitions[ $idx ]->patron() );
	}

	public function test_remove_node_tears_down_partitions(): void {
		$t = new Topic_Node();
		$t->arguments( "{$this->tmp}/firehose.p{partition} 4 65536 4 86400" );

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
}
