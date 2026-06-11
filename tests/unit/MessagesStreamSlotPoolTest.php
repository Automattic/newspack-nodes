<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Rest\SSE_Out_Node;
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
#[CoversClass( SSE_Out_Node::class )]
#[Medium]
class MessagesStreamSlotPoolTest extends TestCase {

	protected function setUp(): void {
		parent::setUp();
		// Drop the EventFramework singleton so timers / curl handles from
		// prior tests don't bleed into this one's drain loop and eat
		// iteration budget before the Consumer's first fire().
		\Newspack_Nodes\Event_Framework::reset();
	}

	protected function tearDown(): void {
		SSE_Out_Node::$acquire_slot = null;
		SSE_Out_Node::$release_slot = null;
		SSE_Out_Node::$check_slot   = null;
		\Newspack_Nodes\Event_Framework::reset();
		parent::tearDown();
	}

	public function test_stream_returns_429_when_acquire_slot_returns_false(): void {
		SSE_Out_Node::$acquire_slot = static fn (): int|false => false;

		$ctrl = new SSE_Out_Node();
		$req  = new \WP_REST_Request( 'GET' );
		$req->set_param( 'subscribe', 'firehose' );

		$result = $ctrl->stream( $req );

		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 429, $result->get_error_data()['status'] ?? null );
		$this->assertSame( 'too_many_connections', $result->get_error_code() );
	}

	public function test_acquire_slot_receives_partition_neg_one_for_log_subscription(): void {
		$captured = null;
		SSE_Out_Node::$acquire_slot = static function ( int $partition ) use ( &$captured ): int|false {
			$captured = $partition;
			return false; // short-circuit before headers
		};

		$ctrl = new SSE_Out_Node();
		$req  = new \WP_REST_Request( 'GET' );
		$req->set_param( 'subscribe', 'firehose' );
		$ctrl->stream( $req );

		$this->assertSame( -1, $captured );
	}

	public function test_acquire_slot_receives_partition_n_for_ipc_subscription(): void {
		$captured = null;
		SSE_Out_Node::$acquire_slot = static function ( int $partition ) use ( &$captured ): int|false {
			$captured = $partition;
			return false;
		};

		$ctrl = new SSE_Out_Node();
		$req  = new \WP_REST_Request( 'GET' );
		$req->set_param( 'subscribe', 'firehose-workers.p3' );
		$ctrl->stream( $req );

		$this->assertSame( 3, $captured );
	}

	public function test_run_stream_loop_releases_slot_in_finally(): void {
		$released_slot      = null;
		$released_partition = null;
		SSE_Out_Node::$acquire_slot = static fn (): int|false => 7;
		SSE_Out_Node::$release_slot = static function ( int $slot, int $partition ) use ( &$released_slot, &$released_partition ): void {
			$released_slot      = $slot;
			$released_partition = $partition;
		};

		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $this->make_temp_dir( 'msg-slot-release-' ) );
		$ctrl->set_num_partitions( 1 );
		SSE_Out_Node::$check_slot = $this->boundedTicks( 2 );

		\ob_start();
		$ctrl->run_stream_loop( [ 'firehose' ], null, 500, 7, -1 );
		\ob_get_clean();

		$this->assertSame( 7, $released_slot );
		$this->assertSame( -1, $released_partition );
	}

	public function test_run_stream_loop_aborts_when_check_slot_returns_false(): void {
		$checks                                  = 0;
		SSE_Out_Node::$check_slot = static function () use ( &$checks ): bool {
			$checks++;
			return false; // slot expired on first check → drain stops
		};

		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $this->make_temp_dir( 'msg-slot-check-' ) );
		$ctrl->set_num_partitions( 1 );
		// No bounding closure needed: this test's own check_slot returns false on
		// the first consult, so it IS what terminates the drain — exactly the
		// behaviour under test.

		\ob_start();
		$ctrl->run_stream_loop( [ 'firehose' ], null, 500, 7, -1 );
		\ob_get_clean();

		$this->assertGreaterThan( 0, $checks, 'check_slot closure should have been consulted at least once' );
	}

	public function test_connected_envelope_carries_the_acquired_slot(): void {
		SSE_Out_Node::$acquire_slot = static fn (): int|false => 4;

		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $this->make_temp_dir( 'msg-slot-conn-' ) );
		$ctrl->set_num_partitions( 1 );
		SSE_Out_Node::$check_slot = $this->boundedTicks( 1 );

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
		SSE_Out_Node::$acquire_slot = static fn (): int|false => 1;

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

		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $base );
		$ctrl->set_num_partitions( 1 );
		// Consumer's first fire() is scheduled at POLL_INTERVAL_EOF_MS=100ms.
		// Drain iterates between events; we need enough iterations that the
		// timer fires AND its read+callback path completes within the loop.
		// 3 was empirically flaky under load; 10 leaves room for slow CI.
		SSE_Out_Node::$check_slot = $this->boundedTicks( 10 );

		// Capture all router fills so we can assert the message landed on
		// _router (instead of being emitted to SSE). Use a Callback under
		// the `some-target` name so Router::fill walks TO=some-target to it.
		$routed = [];
		$capture = new \Newspack_Nodes\Callback_Node(
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
