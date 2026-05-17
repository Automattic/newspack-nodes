<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Consumer;
use Newspack_Nodes\Rest\Messages_Stream_Controller;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * Unit tests for the M5-cutover SSE controller's subscription resolver.
 *
 * Locks the contract for `open_subscription` (one Consumer per log
 * partition; exactly one Consumer per IPC reader; throw on anything
 * that doesn't match either shape) and the trivial CSV parsing of
 * `parse_subscriptions`. The route registration is just enough to
 * surface signature regressions — the drain-loop body itself lands in
 * Task 18.
 */
#[CoversClass( Messages_Stream_Controller::class )]
class MessagesStreamSubscriptionResolverTest extends TestCase {

	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		$this->tmp = $this->make_temp_dir( 'messages-stream-resolver-' );
	}

	protected function tearDown(): void {
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	public function test_log_partition_subscription_returns_one_consumer_per_partition(): void {
		// The Partition constructor doesn't require the partition_dir to
		// pre-exist (get_segments tolerates a missing dir); creating the
		// base log dir is enough to mirror the production layout
		// `{base}/logs/{name}.log/p{N}/`.
		\mkdir( "{$this->tmp}/logs/firehose.log", 0755, true );
		$ctrl = new Messages_Stream_Controller();
		$ctrl->set_base_dir( $this->tmp );
		$ctrl->set_num_partitions( 3 );

		$consumers = $ctrl->open_subscription( 'firehose', null );

		$this->assertCount( 3, $consumers );
		$this->assertContainsOnlyInstancesOf( Consumer::class, $consumers );
	}

	public function test_ipc_reader_subscription_returns_one_consumer(): void {
		// IPC pattern `{type}.p{N}` resolves through `Cli::attach_to_worker`,
		// which requires a worker lock dir to exist (typo guard).
		\mkdir( "{$this->tmp}/locks/firehose-workers.p0.lock.d", 0755, true );
		\mkdir( "{$this->tmp}/ipc/firehose-workers.p0/output", 0755, true );

		$ctrl = new Messages_Stream_Controller();
		$ctrl->set_base_dir( $this->tmp );

		$consumers = $ctrl->open_subscription( 'firehose-workers.p0', null );

		$this->assertCount( 1, $consumers );
		$this->assertContainsOnlyInstancesOf( Consumer::class, $consumers );
	}

	public function test_invalid_subscription_throws(): void {
		$ctrl = new Messages_Stream_Controller();
		$ctrl->set_base_dir( $this->tmp );

		$this->expectException( \InvalidArgumentException::class );
		$ctrl->open_subscription( '../etc/passwd', null );
	}

	public function test_parse_subscriptions_splits_csv_and_trims(): void {
		$ctrl = new Messages_Stream_Controller();
		$this->assertSame(
			[ 'firehose', 'errors', 'completed' ],
			$ctrl->parse_subscriptions( ' firehose, errors , completed' )
		);
	}

	public function test_parse_subscriptions_empty_returns_empty(): void {
		$ctrl = new Messages_Stream_Controller();
		$this->assertSame( [], $ctrl->parse_subscriptions( '' ) );
	}
}
