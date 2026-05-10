<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Partition;
use Newspack_Nodes\Tests\CaptureSink;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Topic;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Topic::class )]
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
		new Topic( "{$this->tmp}/firehose.log", 4, 64*1024, 4, 86400 );
		$this->assertFalse( is_dir( "{$this->tmp}/firehose.log/p0" ) );
	}

	public function test_fill_routes_by_key(): void {
		$t = new Topic( "{$this->tmp}/firehose.log", 4, 64*1024, 4, 86400 );
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
		$t = new Topic( "{$this->tmp}/firehose.log", 4, 64*1024, 4, 86400 );
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
		$t = new Topic( "{$this->tmp}/firehose.log", 4, 64*1024, 4, 86400 );

		$msg = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$msg[ Message::KEY ]   = '/some/url';
		$msg[ Message::VALUE ] = 'fill-data';
		$t->fill( $msg );
		$t->flush();

		$expected_partition = Partition::hash_to_partition( '/some/url', 4 );
		$path = "{$this->tmp}/firehose.log/p{$expected_partition}/0.log";
		$decoded = Message::unpacked( rtrim( file_get_contents( $path ), "\n" ) );
		$this->assertSame( 'fill-data', $decoded[ Message::VALUE ] );
		$this->assertSame( '/some/url', $decoded[ Message::KEY ] );
	}

	public function test_pre_declares_READY_event(): void {
		$t = new Topic( "{$this->tmp}/firehose.log", 4, 64*1024, 4, 86400 );
		$t->name( 'firehose' );
		// Should not throw — event is pre-declared.
		$t->register( 'READY', 'cb', function () {} );
		$this->assertTrue( true );
	}

	public function test_READY_fires_after_first_partition_materialized(): void {
		$t = new Topic( "{$this->tmp}/firehose.log", 4, 64*1024, 4, 86400 );
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
		$t = new Topic( "{$this->tmp}/firehose.log", 4, 64*1024, 4, 86400 );
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
		$t = new Topic( "{$this->tmp}/firehose.log", 4, 64*1024, 4, 86400 );
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
}
