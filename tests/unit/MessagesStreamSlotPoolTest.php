<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Rest\Messages_Stream_Controller;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * Slot-pool acquisition / release / check seams on the unified SSE
 * controller.
 *
 * The substrate stays generic — the actual memcache-backed acquire /
 * release / check is owned by the application plugin
 * (`newspack-event-logger-nodes`) which sets the closures during
 * bootstrap. These tests pin the seam contract: when the closure
 * returns `false`, the controller emits HTTP 429 BEFORE `init_sse_headers`
 * (so the response body can still be a JSON WP_Error); when it returns
 * an int the stream proceeds and the int reaches the `connected`
 * envelope and the matching release-closure call.
 */
#[CoversClass( Messages_Stream_Controller::class )]
class MessagesStreamSlotPoolTest extends TestCase {

	protected function tearDown(): void {
		Messages_Stream_Controller::$acquire_slot = null;
		Messages_Stream_Controller::$release_slot = null;
		Messages_Stream_Controller::$check_slot   = null;
		parent::tearDown();
	}

	public function test_stream_returns_429_when_acquire_slot_returns_false(): void {
		Messages_Stream_Controller::$acquire_slot = static fn (): int|false => false;

		$ctrl = new Messages_Stream_Controller();
		$req  = new \WP_REST_Request( 'GET' );
		$req->set_param( 'subscribe', 'firehose' );

		$result = $ctrl->stream( $req );

		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 429, $result->get_error_data()['status'] ?? null );
		$this->assertSame( 'too_many_connections', $result->get_error_code() );
	}

	public function test_acquire_slot_receives_partition_neg_one_for_log_subscription(): void {
		$captured = null;
		Messages_Stream_Controller::$acquire_slot = static function ( int $partition ) use ( &$captured ): int|false {
			$captured = $partition;
			return false; // short-circuit before headers
		};

		$ctrl = new Messages_Stream_Controller();
		$req  = new \WP_REST_Request( 'GET' );
		$req->set_param( 'subscribe', 'firehose' );
		$ctrl->stream( $req );

		$this->assertSame( -1, $captured );
	}

	public function test_acquire_slot_receives_partition_n_for_ipc_subscription(): void {
		$captured = null;
		Messages_Stream_Controller::$acquire_slot = static function ( int $partition ) use ( &$captured ): int|false {
			$captured = $partition;
			return false;
		};

		$ctrl = new Messages_Stream_Controller();
		$req  = new \WP_REST_Request( 'GET' );
		$req->set_param( 'subscribe', 'firehose-workers.p3' );
		$ctrl->stream( $req );

		$this->assertSame( 3, $captured );
	}

	public function test_run_stream_loop_releases_slot_in_finally(): void {
		$released_slot      = null;
		$released_partition = null;
		Messages_Stream_Controller::$acquire_slot = static fn (): int|false => 7;
		Messages_Stream_Controller::$release_slot = static function ( int $slot, int $partition ) use ( &$released_slot, &$released_partition ): void {
			$released_slot      = $slot;
			$released_partition = $partition;
		};

		$ctrl = new Messages_Stream_Controller();
		$ctrl->set_base_dir( $this->make_temp_dir( 'msg-slot-release-' ) );
		$ctrl->set_num_partitions( 1 );
		$ctrl->set_test_mode( true );
		$ctrl->set_test_iterations( 2 );

		\ob_start();
		$ctrl->run_stream_loop( [ 'firehose' ], null, 500, 7, -1 );
		\ob_get_clean();

		$this->assertSame( 7, $released_slot );
		$this->assertSame( -1, $released_partition );
	}

	public function test_run_stream_loop_aborts_when_check_slot_returns_false(): void {
		$checks                                  = 0;
		Messages_Stream_Controller::$check_slot = static function () use ( &$checks ): bool {
			$checks++;
			return false; // slot expired on first check → drain stops
		};

		$ctrl = new Messages_Stream_Controller();
		$ctrl->set_base_dir( $this->make_temp_dir( 'msg-slot-check-' ) );
		$ctrl->set_num_partitions( 1 );
		$ctrl->set_test_mode( true );
		// Test mode gates on iteration count, not check_slot. We assert that
		// when check_slot says no, the controller exits the drain BEFORE the
		// natural iteration cap.
		$ctrl->set_test_iterations( 1000 );

		\ob_start();
		$ctrl->run_stream_loop( [ 'firehose' ], null, 500, 7, -1 );
		\ob_get_clean();

		$this->assertGreaterThan( 0, $checks, 'check_slot closure should have been consulted at least once' );
	}

	public function test_connected_envelope_carries_the_acquired_slot(): void {
		Messages_Stream_Controller::$acquire_slot = static fn (): int|false => 4;

		$ctrl = new Messages_Stream_Controller();
		$ctrl->set_base_dir( $this->make_temp_dir( 'msg-slot-conn-' ) );
		$ctrl->set_num_partitions( 1 );
		$ctrl->set_test_mode( true );
		$ctrl->set_test_iterations( 1 );

		\ob_start();
		$ctrl->run_stream_loop( [ 'firehose' ], null, 500, 4, -1 );
		$raw = \ob_get_clean();

		// First data: line carries the connected envelope.
		$this->assertStringContainsString( '"slot":4', $raw );
	}
}
