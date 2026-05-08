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

	private function rmdir_recursive( string $dir ): void {
		if ( ! is_dir( $dir ) ) return;
		foreach ( scandir( $dir ) as $f ) {
			if ( $f === '.' || $f === '..' ) continue;
			$path = "$dir/$f";
			is_dir( $path ) ? $this->rmdir_recursive( $path ) : @unlink( $path );
		}
		@rmdir( $dir );
	}

	public function test_constructor_does_not_create_partitions(): void {
		new Topic( "{$this->tmp}/firehose.log", 4, 64*1024, 4, 86400 );
		$this->assertFalse( is_dir( "{$this->tmp}/firehose.log/p0" ) );
	}

	public function test_class_api_write_routes_by_key(): void {
		$t = new Topic( "{$this->tmp}/firehose.log", 4, 64*1024, 4, 86400 );
		$t->write( '/url1', "data\n" );

		// Key routing is deterministic; whichever partition got it must contain the data.
		$found = false;
		for ( $i = 0; $i < 4; ++$i ) {
			$path = "{$this->tmp}/firehose.log/p{$i}/0.log";
			if ( file_exists( $path ) && file_get_contents( $path ) === "data\n" ) {
				$found = true;
				break;
			}
		}
		$this->assertTrue( $found );
	}

	public function test_same_key_routes_to_same_partition(): void {
		$t = new Topic( "{$this->tmp}/firehose.log", 4, 64*1024, 4, 86400 );
		$t->write( '/url1', "first\n" );
		$t->write( '/url1', "second\n" );

		// Find the partition that has data; it must contain both lines.
		for ( $i = 0; $i < 4; ++$i ) {
			$path = "{$this->tmp}/firehose.log/p{$i}/0.log";
			if ( file_exists( $path ) ) {
				$this->assertSame( "first\nsecond\n", file_get_contents( $path ) );
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
		$msg[ Message::VALUE ] = "fill-data\n";
		$t->fill( $msg );

		$expected_partition = Partition::hash_to_partition( '/some/url', 4 );
		$path = "{$this->tmp}/firehose.log/p{$expected_partition}/0.log";
		$this->assertSame( "fill-data\n", file_get_contents( $path ) );
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

		// Trigger first-partition materialization via class-API write().
		$t->write( '/some/url', "data\n" );

		// Listener registered BEFORE first partition should now have been notified.
		$this->assertSame( [ 'firehose' ], $fired );
	}

	public function test_READY_replays_to_late_registrants(): void {
		$t = new Topic( "{$this->tmp}/firehose.log", 4, 64*1024, 4, 86400 );
		$t->name( 'firehose' );

		// Materialize first partition before any listener registers.
		$t->write( '/some/url', "data\n" );

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
		$t->write( 'k1', "a\n" );
		$t->write( 'k2', "b\n" );
		$t->write( 'k3', "c\n" );
		$t->write( 'k4', "d\n" );

		$this->assertSame( 1, $count, 'READY must fire exactly once across partition lifetime' );
	}

	public function test_TM_PERSIST_on_oversize_write_cancels_not_answers(): void {
		// Partition has MAX_LINE_SIZE=4096; oversize lines drop and write() returns false.
		// Producer's max_unanswered slot must be released via cancel, not answer.
		$t = new Topic( "{$this->tmp}/firehose.log", 4, 64*1024, 4, 86400 );
		$t->name( 'firehose' );

		$capture = new CaptureSink();
		$t->sink( $capture );

		$msg = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_BYTESTREAM | Message::TM_PERSIST;
		$msg[ Message::FROM ]  = 'producer';
		$msg[ Message::ID ]    = 'req-42';
		$msg[ Message::KEY ]   = '/some/url';
		$msg[ Message::VALUE ] = str_repeat( 'x', Partition::MAX_LINE_SIZE + 1 );
		$t->fill( $msg );

		// Should have one TM_PERSIST|TM_RESPONSE with payload 'cancel' going back to FROM.
		$this->assertCount( 1, $capture->captured );
		$resp = $capture->captured[0];
		$this->assertSame( Message::TM_PERSIST | Message::TM_RESPONSE, $resp[ Message::TYPE ] );
		$this->assertSame( 'cancel', $resp[ Message::VALUE ] );
		$this->assertSame( 'req-42', $resp[ Message::ID ] );
		$this->assertSame( 'producer', $resp[ Message::TO ] );
	}

	public function test_TM_PERSIST_on_successful_write_answers(): void {
		$t = new Topic( "{$this->tmp}/firehose.log", 4, 64*1024, 4, 86400 );
		$t->name( 'firehose' );

		$capture = new CaptureSink();
		$t->sink( $capture );

		$msg = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_BYTESTREAM | Message::TM_PERSIST;
		$msg[ Message::FROM ]  = 'producer';
		$msg[ Message::ID ]    = 'req-7';
		$msg[ Message::KEY ]   = '/some/url';
		$msg[ Message::VALUE ] = "ok-data\n";
		$t->fill( $msg );

		$this->assertCount( 1, $capture->captured );
		$resp = $capture->captured[0];
		$this->assertSame( Message::TM_PERSIST | Message::TM_RESPONSE, $resp[ Message::TYPE ] );
		$this->assertSame( 'answer', $resp[ Message::VALUE ] );
		$this->assertSame( 'req-7', $resp[ Message::ID ] );
		$this->assertSame( 'producer', $resp[ Message::TO ] );
	}

	public function test_TM_PERSIST_on_pre_pinned_write_failure_cancels(): void {
		// Pre-pinned routing path (TO=p0/...) must also delegate persist contract.
		$t = new Topic( "{$this->tmp}/firehose.log", 4, 64*1024, 4, 86400 );
		$t->name( 'firehose' );

		$capture = new CaptureSink();
		$t->sink( $capture );

		$msg = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_BYTESTREAM | Message::TM_PERSIST;
		$msg[ Message::FROM ]  = 'producer';
		$msg[ Message::ID ]    = 'req-99';
		$msg[ Message::TO ]    = 'p0/anything';
		$msg[ Message::VALUE ] = str_repeat( 'x', Partition::MAX_LINE_SIZE + 1 );
		$t->fill( $msg );

		$this->assertCount( 1, $capture->captured );
		$resp = $capture->captured[0];
		$this->assertSame( 'cancel', $resp[ Message::VALUE ] );
	}
}
