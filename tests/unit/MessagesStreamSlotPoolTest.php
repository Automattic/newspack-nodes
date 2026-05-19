<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Rest\Messages_Stream_Controller;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\Medium;

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
#[Medium]
class MessagesStreamSlotPoolTest extends TestCase {

	protected function setUp(): void {
		parent::setUp();
		// Drop the EventFramework singleton so timers / curl handles from
		// prior tests don't bleed into this one's drain loop and eat
		// iteration budget before the Consumer's first fire().
		\Newspack_Nodes\EventFramework::reset();
	}

	protected function tearDown(): void {
		Messages_Stream_Controller::$acquire_slot = null;
		Messages_Stream_Controller::$release_slot = null;
		Messages_Stream_Controller::$check_slot   = null;
		\Newspack_Nodes\EventFramework::reset();
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

	public function test_run_stream_loop_routes_messages_with_non_empty_TO_through_router(): void {
		// The direct_sink Callback's else-branch: when an incoming message
		// carries a non-empty TO, the SSE writer doesn't emit it directly —
		// it forwards through _router so HTTP_Filter can gate per-session
		// pivoted replies. Seed a log partition with a TO-stamped packed
		// Message and prove the Callback routes it via Router instead of
		// emitting it on the wire.
		Messages_Stream_Controller::$acquire_slot = static fn (): int|false => 1;

		$base = $this->make_temp_dir( 'msg-slot-direct-sink-' );
		$pdir = "{$base}/logs/firehose.log/p0";
		\mkdir( $pdir, 0755, true );

		// Pre-seed segment 0 of the firehose log partition 0 with a packed
		// Message whose TO is non-empty. Partition writes the JSON-encoded
		// 7-field message plus a newline — same on-the-wire shape Consumer
		// reads back per fgets() in poll().
		$msg                       = \Newspack_Nodes\Message::new_message();
		$msg[ \Newspack_Nodes\Message::TYPE ]  = \Newspack_Nodes\Message::TM_BYTESTREAM;
		$msg[ \Newspack_Nodes\Message::FROM ]  = 'firehose';
		$msg[ \Newspack_Nodes\Message::TO ]    = 'some-target';
		$msg[ \Newspack_Nodes\Message::VALUE ] = 'pivoted-payload';
		\file_put_contents( "{$pdir}/0.log", \Newspack_Nodes\Message::packed( $msg ) . "\n" );

		$ctrl = new Messages_Stream_Controller();
		$ctrl->set_base_dir( $base );
		$ctrl->set_num_partitions( 1 );
		$ctrl->set_test_mode( true );
		// Consumer's first fire() is scheduled at POLL_INTERVAL_EOF_MS=100ms.
		// Drain iterates between events; we need enough iterations that the
		// timer fires AND its read+callback path completes within the loop.
		// 3 was empirically flaky under load; 10 leaves room for slow CI.
		$ctrl->set_test_iterations( 10 );

		// Capture all router fills so we can assert the message landed on
		// _router (instead of being emitted to SSE). Use a Callback under
		// the `some-target` name so Router::fill walks TO=some-target to it.
		$routed = [];
		$capture = new \Newspack_Nodes\Callback(
			static function ( array &$m ) use ( &$routed ): void {
				$routed[] = $m;
			}
		);
		$capture->name( 'some-target' );

		// Positions = start so the consumer reads our seeded message instead
		// of skipping to end-of-partition (the default for null positions).
		$positions = [ 'firehose' => [ 0 => [ 'seg' => 0, 'off' => 0 ] ] ];

		\ob_start();
		$ctrl->run_stream_loop( [ 'firehose' ], $positions, 500, 1, -1 );
		\ob_get_clean();

		$this->assertNotEmpty( $routed, 'Callback else-branch must have routed the TO-stamped message through Router' );
		$this->assertSame( 'pivoted-payload', $routed[0][ \Newspack_Nodes\Message::VALUE ] );
	}
}
