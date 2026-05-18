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
		// Reset the static seam so a test that reassigns it can't leak into
		// later tests (today no other test touches it, but Task 18 will add
		// more tests against this controller).
		Messages_Stream_Controller::$attach_to_worker = null;
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

	public function test_log_subscription_stamps_partition_into_from(): void {
		// Dashboards subscribing to a multi-partition log need to know which
		// partition each line came from (rawlogs UI shows P0/P1/P2 alongside
		// each row). The resolver overrides Consumer's FROM stamp with the
		// subscription-scoped `{sub}.p{N}` shape so the JS side can parse it
		// without a separate sidecar field. Without this, every partition's
		// stream emits FROM=`firehose` and the dashboard loses the per-row
		// partition column.
		\mkdir( "{$this->tmp}/logs/firehose.log", 0755, true );
		$ctrl = new Messages_Stream_Controller();
		$ctrl->set_base_dir( $this->tmp );
		$ctrl->set_num_partitions( 3 );

		$consumers = $ctrl->open_subscription( 'firehose', null );

		$ref    = new \ReflectionProperty( Consumer::class, 'stamp_override' );
		$stamps = [];
		foreach ( $consumers as $c ) {
			$stamps[] = $ref->getValue( $c );
		}
		\sort( $stamps );
		$this->assertSame( [ 'firehose.p0', 'firehose.p1', 'firehose.p2' ], $stamps );
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

	public function test_ipc_subscription_uses_attach_to_worker_seam_when_set(): void {
		// Mutation guard for the seam branch in `open_subscription`. The
		// existing IPC test goes through the real `Cli::attach_to_worker`,
		// so the `self::$attach_to_worker ?? ...` closure-property branch is
		// dead to coverage. Set the seam to a recording closure and verify
		// it gets invoked with the right args.
		$recorded = [];
		Messages_Stream_Controller::$attach_to_worker = static function ( string $reader_id, string $base_dir ) use ( &$recorded ): array {
			$recorded[] = [
				'reader_id' => $reader_id,
				'base_dir'  => $base_dir,
			];
			return [
				'input'     => "{$base_dir}/ipc/{$reader_id}/input",
				'output'    => "{$base_dir}/ipc/{$reader_id}/output",
				'type'      => 'firehose-workers',
				'partition' => 0,
			];
		};

		\mkdir( "{$this->tmp}/ipc/firehose-workers.p0/output", 0755, true );

		$ctrl = new Messages_Stream_Controller();
		$ctrl->set_base_dir( $this->tmp );
		$consumers = $ctrl->open_subscription( 'firehose-workers.p0', null );

		$this->assertCount( 1, $consumers );
		$this->assertContainsOnlyInstancesOf( Consumer::class, $consumers );
		$this->assertCount( 1, $recorded );
		$this->assertSame( 'firehose-workers.p0', $recorded[0]['reader_id'] );
		$this->assertSame( $this->tmp, $recorded[0]['base_dir'] );
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
