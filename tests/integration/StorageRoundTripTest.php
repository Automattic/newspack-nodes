<?php
namespace Newspack_Nodes\Tests\Integration;

use Newspack_Nodes\Consumer;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Partition;
use Newspack_Nodes\Tests\CaptureSink;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Topic;

class StorageRoundTripTest extends TestCase {
	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		$this->tmp = $this->make_temp_dir();
	}

	protected function tearDown(): void {
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	public function test_topic_write_then_consumer_read_with_restart_replay(): void {
		// Topic with 4 partitions.
		$topic = new Topic( "{$this->tmp}/firehose.log", 4 );

		// Two writes with the same KEY land in the same partition.
		$topic->write( '/url1', "{\"k\":\"start\",\"id\":1}\n" );
		$topic->write( '/url1', "{\"k\":\"complete\",\"id\":1}\n" );

		// Identify which partition got the data.
		$pid = Partition::hash_to_partition( '/url1', 4 );

		// Consumer reads that partition.
		$c1 = new Consumer( "{$this->tmp}/firehose.log", $pid, "{$this->tmp}/offsets/reader/p{$pid}" );
		$cap1 = new CaptureSink();
		$c1->sink( $cap1 );
		$c1->poll();
		$c1->checkpoint();

		$this->assertCount( 2, $cap1->captured );

		// Write more, simulate restart, expect resume.
		$topic->write( '/url1', "{\"k\":\"third\",\"id\":1}\n" );

		unset( $c1 );

		$c2 = new Consumer( "{$this->tmp}/firehose.log", $pid, "{$this->tmp}/offsets/reader/p{$pid}" );
		$cap2 = new CaptureSink();
		$c2->sink( $cap2 );
		$c2->poll();

		$this->assertCount( 1, $cap2->captured, 'Restart resumes from checkpoint, sees only the new entry' );
		$this->assertStringContainsString( 'third', $cap2->captured[0][ Message::VALUE ] );
	}
}
