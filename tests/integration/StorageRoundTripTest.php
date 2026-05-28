<?php
namespace Newspack_Nodes\Tests\Integration;

use Newspack_Nodes\Consumer_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Topic_Node;

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

	public function test_topic_fill_then_consumer_read_with_restart_replay(): void {
		// Topic with 4 partitions.
		$topic = new Topic_Node();
		$topic->arguments( "{$this->tmp}/firehose.log 4" );

		// Two fills with the same KEY land in the same partition.
		$this->produce_into( $topic, '{"k":"start","id":1}', '/url1'  );
		$this->produce_into( $topic, '{"k":"complete","id":1}', '/url1'  );

		// Identify which partition got the data.
		$pid = Partition_Node::hash_to_partition( '/url1', 4 );

		// Consumer reads that partition.
		$c1   = new Consumer_Node();
		$c1->arguments( "{$this->tmp}/firehose.log {$pid} {$this->tmp}/offsets/reader/p{$pid}" );
		$cap1 = new Capture_Sink_Node();
		$c1->sink( $cap1 );
		$c1->poll();
		$c1->checkpoint();

		$this->assertCount( 2, $cap1->captured );

		// Write more, simulate restart, expect resume.
		$this->produce_into( $topic, '{"k":"third","id":1}', '/url1'  );

		unset( $c1 );

		$c2   = new Consumer_Node();
		$c2->arguments( "{$this->tmp}/firehose.log {$pid} {$this->tmp}/offsets/reader/p{$pid}" );
		$cap2 = new Capture_Sink_Node();
		$c2->sink( $cap2 );
		$c2->poll();

		$this->assertCount( 1, $cap2->captured, 'Restart resumes from checkpoint, sees only the new entry' );
		$this->assertStringContainsString( 'third', $cap2->captured[0][ Message::VALUE ] );
	}
}
