<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Tests\CaptureSink;
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
		new Topic_Node( "{$this->tmp}/firehose.log", 4, 64*1024, 4, 86400 );
		$this->assertFalse( is_dir( "{$this->tmp}/firehose.log/p0" ) );
	}

	public function test_fill_routes_by_key(): void {
		$t = new Topic_Node( "{$this->tmp}/firehose.log", 4, 64*1024, 4, 86400 );
		$this->produce_into( $t, 'data', '/url1' );

		// Key routing is deterministic; whichever partition got it contains the
		// packed message. Decode the file to assert on VALUE rather than raw bytes.
		$found = false;
		for ( $i = 0; $i < 4; ++$i ) {
			$path = "{$this->tmp}/firehose.log/p{$i}/0.log";
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
		$t = new Topic_Node( "{$this->tmp}/firehose.log", 4, 64*1024, 4, 86400 );
		$this->produce_into( $t, 'first', '/url1' );
		$this->produce_into( $t, 'second', '/url1' );

		// Find the partition that has data; it must contain two packed lines, both with the same key.
		for ( $i = 0; $i < 4; ++$i ) {
			$path = "{$this->tmp}/firehose.log/p{$i}/0.log";
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
		$t = new Topic_Node( "{$this->tmp}/firehose.log", 4, 64*1024, 4, 86400 );

		$msg = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$msg[ Message::KEY ]   = '/some/url';
		$msg[ Message::VALUE ] = 'fill-data';
		$t->fill( $msg );
		$t->flush();

		$expected_partition = Partition_Node::hash_to_partition( '/some/url', 4 );
		$path = "{$this->tmp}/firehose.log/p{$expected_partition}/0.log";
		$decoded = Message::unpacked( rtrim( file_get_contents( $path ), "\n" ) );
		$this->assertSame( 'fill-data', $decoded[ Message::VALUE ] );
		$this->assertSame( '/some/url', $decoded[ Message::KEY ] );
	}

	public function test_pre_declares_READY_event(): void {
		$t = new Topic_Node( "{$this->tmp}/firehose.log", 4, 64*1024, 4, 86400 );
		$t->name( 'firehose' );
		// Should not throw — event is pre-declared.
		$t->register( 'READY', 'cb', function () {} );
		$this->assertTrue( true );
	}

	public function test_READY_fires_after_first_partition_materialized(): void {
		$t = new Topic_Node( "{$this->tmp}/firehose.log", 4, 64*1024, 4, 86400 );
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
		$t = new Topic_Node( "{$this->tmp}/firehose.log", 4, 64*1024, 4, 86400 );
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
		$t = new Topic_Node( "{$this->tmp}/firehose.log", 4, 64*1024, 4, 86400 );
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
		$t = new Topic_Node( "{$this->tmp}/firehose.log", 7, 64*1024, 4, 86400 );
		$this->assertSame( 7, $t->num_partitions() );
	}

	public function test_constructor_clamps_num_partitions_to_minimum_one(): void {
		// max(1, $n) clamps zero/negative to 1 — callers that pass bad config don't
		// trip a divide-by-zero in hash_to_partition.
		$t = new Topic_Node( "{$this->tmp}/firehose.log", 0, 64*1024, 4, 86400 );
		$this->assertSame( 1, $t->num_partitions() );

		$t2 = new Topic_Node( "{$this->tmp}/firehose.log", -3, 64*1024, 4, 86400 );
		$this->assertSame( 1, $t2->num_partitions() );
	}

	public function test_fill_packs_TM_REQUEST_TM_ERROR_TM_EOF(): void {
		// Topic::fill mirrors Partition::fill — it's the user-facing
		// multi-Partition wrapper. Control messages (TM_REQUEST, TM_ERROR,
		// TM_EOF) round-trip through Topic-as-transport in IPC scenarios,
		// so Topic packs them like any other type instead of dropping.
		$t = new Topic_Node( "{$this->tmp}/firehose.log", 2, 64*1024, 4, 86400 );

		$types = [
			Message::TM_REQUEST,
			Message::TM_ERROR,
			Message::TM_EOF,
		];
		foreach ( $types as $type ) {
			$msg                   = Message::new_message();
			$msg[ Message::TYPE ]  = $type;
			$msg[ Message::KEY ]   = '/url'; // Same KEY routes to same partition.
			$msg[ Message::VALUE ] = 'payload-' . $type;
			$t->fill( $msg );
		}
		$t->flush(); // Force the in-memory batch to land on disk synchronously.

		// All three packed onto the partition (3 lines on disk).
		$idx     = Partition_Node::hash_to_partition( '/url', 2 );
		$lines   = \array_values( \array_filter(
			\explode( "\n", \file_get_contents( "{$this->tmp}/firehose.log/p{$idx}/0.log" ) )
		) );
		$this->assertCount( 3, $lines );
		foreach ( $lines as $i => $line ) {
			$decoded = Message::unpacked( $line );
			$this->assertSame( $types[ $i ], $decoded[ Message::TYPE ] );
		}
	}

	public function test_fill_pre_pinned_TO_routes_to_specified_partition(): void {
		$t = new Topic_Node( "{$this->tmp}/firehose.log", 4, 64*1024, 4, 86400 );

		// TO=p2/... pins partition 2 regardless of KEY.
		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$msg[ Message::TO ]    = 'p2/some/path';
		$msg[ Message::KEY ]   = 'unrelated-key';
		$msg[ Message::VALUE ] = 'pinned-data';
		$t->fill( $msg );
		$t->flush();

		$this->assertFileExists( "{$this->tmp}/firehose.log/p2/0.log" );
		// Other partitions must not be touched.
		$this->assertFalse( is_dir( "{$this->tmp}/firehose.log/p0" ) );
		$this->assertFalse( is_dir( "{$this->tmp}/firehose.log/p1" ) );
		$this->assertFalse( is_dir( "{$this->tmp}/firehose.log/p3" ) );
	}

	public function test_fill_pre_pinned_TO_out_of_range_falls_through_to_key_routing(): void {
		// TO=p99/... where 99 >= num_partitions(2) → falls through to KEY routing.
		$t = new Topic_Node( "{$this->tmp}/firehose.log", 2, 64*1024, 4, 86400 );

		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$msg[ Message::TO ]    = 'p99/path';
		$msg[ Message::KEY ]   = 'k';
		$msg[ Message::VALUE ] = 'data';
		$t->fill( $msg );
		$t->flush();

		// Whichever partition the key hashes to is materialized; the out-of-range
		// pin was ignored.
		$idx = \Newspack_Nodes\Partition_Node::hash_to_partition( 'k', 2 );
		$this->assertFileExists( "{$this->tmp}/firehose.log/p{$idx}/0.log" );
	}

	public function test_fill_empty_key_uses_round_robin(): void {
		// Round-robin counter is static — clear by getting baseline first.
		$t = new Topic_Node( "{$this->tmp}/firehose.log", 4, 64*1024, 4, 86400 );

		// Empty KEY → round-robin. Send 8 messages and confirm at least 2 partitions
		// got data (deterministic round-robin, but counter is shared across tests).
		for ( $i = 0; $i < 8; ++$i ) {
			$msg                   = Message::new_message();
			$msg[ Message::TYPE ]  = Message::TM_BYTESTREAM;
			$msg[ Message::KEY ]   = '';
			$msg[ Message::VALUE ] = "msg-{$i}";
			$t->fill( $msg );
		}
		$t->flush();

		$populated = 0;
		for ( $i = 0; $i < 4; ++$i ) {
			if ( file_exists( "{$this->tmp}/firehose.log/p{$i}/0.log" ) ) {
				++$populated;
			}
		}
		// Round-robin across 4 partitions with 8 messages = each partition got exactly 2.
		$this->assertSame( 4, $populated );
	}

	public function test_sink_propagates_to_existing_partitions(): void {
		$t = new Topic_Node( "{$this->tmp}/firehose.log", 4, 64*1024, 4, 86400 );

		// Materialize a partition first.
		$this->produce_into( $t, 'data', 'k1' );

		// Find which partition got materialized.
		$partition_idx = Partition_Node::hash_to_partition( 'k1', 4 );

		// Now wire a sink AFTER partition materialization — it must propagate to
		// every partition currently held so their persist responses still flow.
		$new_sink = new CaptureSink();
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

	public function test_remove_node_tears_down_partitions(): void {
		$t = new Topic_Node( "{$this->tmp}/firehose.log", 4, 64*1024, 4, 86400 );

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
