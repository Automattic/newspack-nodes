<?php
namespace Newspack_Nodes\Tests\Integration;

use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Consumer;
use Newspack_Nodes\Callback;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Partition;
use Newspack_Nodes\Tests\TestCase;

class WorkerDiscoveryTest extends TestCase {

	public function test_register_worker_partitions_creates_one_partition_per_live_worker(): void {
		$base = $this->make_temp_dir( 'worker-disc-' );
		\mkdir( "{$base}/locks/firehose-workers.p0.lock.d", 0755, true );
		\mkdir( "{$base}/locks/firehose-workers.p1.lock.d", 0755, true );
		\mkdir( "{$base}/locks/job-workers.p0.lock.d",      0755, true );
		\mkdir( "{$base}/ipc/firehose-workers.p0/input",    0755, true );
		\mkdir( "{$base}/ipc/firehose-workers.p1/input",    0755, true );
		\mkdir( "{$base}/ipc/job-workers.p0/input",         0755, true );

		$count = Bootstrap::register_worker_partitions( $base );

		$this->assertSame( 3, $count );
		$this->assertInstanceOf( Partition::class, Core::node( 'firehose-workers.p0' ) );
		$this->assertInstanceOf( Partition::class, Core::node( 'firehose-workers.p1' ) );
		$this->assertInstanceOf( Partition::class, Core::node( 'job-workers.p0' ) );
	}

	public function test_filling_a_registered_worker_partition_writes_to_disk(): void {
		$base = $this->make_temp_dir( 'worker-disc-' );
		$input_dir = "{$base}/ipc/firehose-workers.p0/input";
		\mkdir( "{$base}/locks/firehose-workers.p0.lock.d", 0755, true );
		\mkdir( $input_dir, 0755, true );

		Bootstrap::register_worker_partitions( $base );

		$msg = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_COMMAND;
		$msg[ Message::FROM ]  = '_http/4242';
		$msg[ Message::TO ]    = '_command_interpreter';
		$msg[ Message::ID ]    = 'cmd-xyz';
		$msg[ Message::VALUE ] = \wp_json_encode( [ 'name' => 'dump_metadata', 'arguments' => '', 'payload' => '' ] );
		Core::node( 'firehose-workers.p0' )->fill( $msg );
		// Production: Partition flushes via Timer fire during the worker's
		// drain loop. Tests have no event loop, so drive the flush directly
		// — same as TestCase::produce_into().
		Core::node( 'firehose-workers.p0' )->flush();

		$consumer = new Consumer( $input_dir, 0, '' );
		$consumer->next_offset( 'start' );
		$got = [];
		$consumer->sink( new Callback( static function ( array &$m ) use ( &$got ): void {
			$got[] = $m;
		} ) );
		$consumer->poll();
		$this->assertCount( 1, $got );
		// Consumer overwrites Message::ID with a `seg:offset` position
		// breadcrumb (see Consumer::poll comment on line ~500). VALUE is
		// the message payload that survives the round-trip — assert on
		// that to prove the same message landed on disk.
		$decoded = \json_decode( $got[0][ Message::VALUE ], true );
		$this->assertSame( 'dump_metadata', $decoded['name'] );
	}

	public function test_skips_workers_with_missing_input_dir(): void {
		$base = $this->make_temp_dir( 'worker-disc-' );
		\mkdir( "{$base}/locks/dead-worker.p0.lock.d", 0755, true );
		// No matching ipc/dead-worker.p0/input dir.

		$count = Bootstrap::register_worker_partitions( $base );

		$this->assertSame( 0, $count );
		$this->assertNull( Core::node( 'dead-worker.p0' ) );
	}
}
