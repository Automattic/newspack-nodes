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
 * a complete lease the stream carries that exact pair through the
 * `connected`, check, and release paths.
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
		SSE_Out_Node::$inspect_slot = null;
		SSE_Out_Node::$diagnostic_log = null;
		\Newspack_Nodes\Event_Framework::reset();
		parent::tearDown();
	}

	public function test_stream_returns_429_when_acquire_slot_returns_false(): void {
		SSE_Out_Node::$acquire_slot = static fn (): array|false => false;

		$ctrl = new SSE_Out_Node();
		$req  = new \WP_REST_Request( 'GET' );
		$req->set_param( 'subscribe', 'firehose.*' );

		$result = $ctrl->stream( $req );

		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 429, $result->get_error_data()['status'] ?? null );
		$this->assertSame( 'too_many_connections', $result->get_error_code() );
	}

	public function test_acquire_slot_receives_partition_neg_one_for_log_subscription(): void {
		$captured = null;
		SSE_Out_Node::$acquire_slot = static function ( int $partition ) use ( &$captured ): array|false {
			$captured = $partition;
			return false; // short-circuit before headers
		};

		$ctrl = new SSE_Out_Node();
		$req  = new \WP_REST_Request( 'GET' );
		$req->set_param( 'subscribe', 'firehose.*' );
		$ctrl->stream( $req );

		$this->assertSame( -1, $captured );
	}

	public function test_acquire_slot_receives_partition_n_for_ipc_subscription(): void {
		$captured = null;
		SSE_Out_Node::$acquire_slot = static function ( int $partition ) use ( &$captured ): array|false {
			$captured = $partition;
			return false;
		};

		$ctrl = new SSE_Out_Node();
		$req  = new \WP_REST_Request( 'GET' );
		$req->set_param( 'subscribe', 'firehose-workers.p3' );
		$ctrl->stream( $req );

		$this->assertSame( 3, $captured );
	}

	public function test_acquire_slot_strips_the_group_prefix_for_partition_shaped_subs(): void {
		// `offsets/x.p3` must pool like its bare sibling `x.p3` — the group
		// prefix addresses a root, not a different accounting bucket.
		$captured = null;
		SSE_Out_Node::$acquire_slot = static function ( int $partition ) use ( &$captured ): array|false {
			$captured = $partition;
			return false;
		};

		$ctrl = new SSE_Out_Node();
		$req  = new \WP_REST_Request( 'GET' );
		$req->set_param( 'subscribe', 'offsets/jobs.p3' );
		$ctrl->stream( $req );

		$this->assertSame( 3, $captured );
	}

	public function test_stream_enables_ignore_user_abort_before_entering_the_loop(): void {
		$previous = \ignore_user_abort( false );
		$ctrl     = new class() extends SSE_Out_Node {
			public bool $ignored_user_abort = false;

			protected function init_sse_headers(): void {
				$this->ignored_user_abort = 1 === \ignore_user_abort();
				throw new \RuntimeException( 'stop before stream exit 731' );
			}
		};
		SSE_Out_Node::$acquire_slot = static fn (): array => [ 'slot' => 7, 'owner' => 42424243 ];
		$request = new \WP_REST_Request( 'GET' );
		$request->set_param( 'subscribe', 'firehose-workers.p3' );

		try {
			$ctrl->stream( $request );
		} catch ( \RuntimeException $e ) {
			$this->assertSame( 'stop before stream exit 731', $e->getMessage() );
		} finally {
			\ignore_user_abort( (bool) $previous );
		}

		$this->assertTrue( $ctrl->ignored_user_abort );
	}

	public function test_stream_setup_exception_is_diagnosed_released_once_and_rethrown(): void {
		$lease              = [ 'slot' => 6, 'owner' => 62626263 ];
		$partition          = 5;
		$failure            = new \RuntimeException( 'distinct header setup failure 86420' );
		$acquired_partition = null;
		$released           = [];
		$logged             = [];
		$previous           = \ignore_user_abort();
		SSE_Out_Node::$acquire_slot = static function ( int $actual_partition ) use ( &$acquired_partition, $lease ): array {
			$acquired_partition = $actual_partition;
			return $lease;
		};
		SSE_Out_Node::$release_slot = static function ( array $actual_lease, int $actual_partition ) use ( &$released ): void {
			$released[] = [ $actual_lease, $actual_partition ];
		};
		SSE_Out_Node::$diagnostic_log = static function ( array $context ) use ( &$logged ): void {
			$logged[] = $context;
		};

		$ctrl = new class() extends SSE_Out_Node {
			public ?\Throwable $setup_failure = null;

			protected function init_sse_headers(): void {
				throw $this->setup_failure ?? new \LogicException( 'setup failure was not configured' );
			}
		};
		$ctrl->setup_failure = $failure;
		$request = new \WP_REST_Request( 'GET' );
		$request->set_param( 'subscribe', 'firehose-workers.p5' );

		$caught = null;
		try {
			$ctrl->stream( $request );
		} catch ( \Throwable $e ) {
			$caught = $e;
		} finally {
			\ignore_user_abort( (bool) $previous );
		}

		$this->assertSame( $failure, $caught, 'the original setup exception must escape unchanged' );
		$this->assertSame( $partition, $acquired_partition );
		$this->assertSame( [ [ $lease, $partition ] ], $released, 'the exact acquired lease must be released once' );
		$this->assertSame(
			[
				[
					'reason'            => 'unexpected_exception',
					'pid'               => \getmypid(),
					'slot'              => 6,
					'partition'         => 5,
					'subscriptions'     => [ 'firehose-workers.p5' ],
					'exception_class'   => \RuntimeException::class,
					'exception_message' => 'distinct header setup failure 86420',
				],
			],
			$logged
		);
		$this->assertStringNotContainsString( (string) $lease['owner'], \wp_json_encode( $logged ) );
	}

	public function test_stream_rejects_a_legacy_slot_only_acquire_result(): void {
		$ctrl = new class() extends SSE_Out_Node {
			protected function init_sse_headers(): void {}
		};
		SSE_Out_Node::$acquire_slot = static fn (): int => 7;
		$request = new \WP_REST_Request( 'GET' );
		$request->set_param( 'subscribe', 'firehose-workers.p3' );

		$this->expectException( \UnexpectedValueException::class );
		$this->expectExceptionMessage( 'SSE slot acquisition did not return a complete lease.' );
		$ctrl->stream( $request );
	}

	public function test_run_stream_loop_requires_a_complete_lease_array(): void {
		$method = new \ReflectionMethod( SSE_Out_Node::class, 'run_stream_loop' );
		$type   = $method->getParameters()[3]->getType();

		$this->assertInstanceOf( \ReflectionNamedType::class, $type );
		$this->assertSame( 'array', $type->getName() );
	}

	public function test_run_stream_loop_default_is_an_explicit_unmetered_lease(): void {
		$method  = new \ReflectionMethod( SSE_Out_Node::class, 'run_stream_loop' );
		$default = $method->getParameters()[3]->getDefaultValue();

		$this->assertSame(
			[
				'slot'  => -1,
				'owner' => 93939397,
			],
			$default
		);
	}

	public function test_run_stream_loop_rejects_an_incomplete_lease(): void {
		SSE_Out_Node::$check_slot = static fn (): bool => false;
		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $this->make_temp_dir( 'msg-incomplete-lease-' ) );

		$this->expectException( \UnexpectedValueException::class );
		$this->expectExceptionMessage( 'SSE slot acquisition did not return a complete lease.' );
		$ctrl->run_stream_loop( [ 'firehose.*' ], null, 500, [ 'slot' => 7 ], 3 );
	}

	public function test_run_stream_loop_releases_slot_in_finally(): void {
		$lease              = [ 'slot' => 7, 'owner' => 42424243 ];
		$released_lease     = null;
		$released_partition = null;
		SSE_Out_Node::$acquire_slot = static fn (): array|false => $lease;
		SSE_Out_Node::$release_slot = static function ( $actual_lease, int $partition ) use ( &$released_lease, &$released_partition ): void {
			$released_lease     = $actual_lease;
			$released_partition = $partition;
		};

		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $this->make_temp_dir( 'msg-slot-release-' ) );
		SSE_Out_Node::$check_slot = $this->boundedTicks( 2 );

		\ob_start();
		$ctrl->run_stream_loop( [ 'firehose.*' ], null, 500, $lease, 3 );
		\ob_get_clean();

		$this->assertSame( $lease, $released_lease );
		$this->assertSame( 3, $released_partition );
	}

	public function test_run_stream_loop_aborts_when_check_slot_returns_false(): void {
		$lease             = [ 'slot' => 7, 'owner' => 42424243 ];
		$checks            = 0;
		$checked_lease     = null;
		$checked_partition = null;
		SSE_Out_Node::$check_slot = static function ( $actual_lease, int $partition ) use ( &$checks, &$checked_lease, &$checked_partition ): bool {
			$checks++;
			$checked_lease     = $actual_lease;
			$checked_partition = $partition;
			return false; // slot expired on first check → drain stops
		};

		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $this->make_temp_dir( 'msg-slot-check-' ) );
		// No bounding closure needed: this test's own check_slot returns false on
		// the first consult, so it IS what terminates the drain — exactly the
		// behavior under test.

		\ob_start();
		$ctrl->run_stream_loop( [ 'firehose.*' ], null, 500, $lease, 3 );
		\ob_get_clean();

		$this->assertGreaterThan( 0, $checks, 'check_slot closure should have been consulted at least once' );
		$this->assertSame( $lease, $checked_lease );
		$this->assertSame( 3, $checked_partition );
	}

	public function test_connected_envelope_carries_the_complete_acquired_lease(): void {
		$lease = [ 'slot' => 7, 'owner' => 42424243 ];
		SSE_Out_Node::$acquire_slot = static fn (): array|false => $lease;

		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $this->make_temp_dir( 'msg-slot-conn-' ) );
		SSE_Out_Node::$check_slot = $this->boundedTicks( 1 );

		\ob_start();
		$ctrl->run_stream_loop( [ 'firehose.*' ], null, 500, $lease, 3 );
		$raw = \ob_get_clean();

		// First data: line carries the connected envelope (flat `KEY VALUE` string).
		$this->assertStringContainsString( 'SLOT 7 OWNER 42424243', $raw );
	}

	public function test_run_stream_loop_routes_messages_with_non_empty_TO_through_router(): void {
		// The direct_sink Callback's else-branch: when an incoming message
		// carries a non-empty TO, the SSE writer doesn't emit it directly —
		// it forwards through _router so HTTP_Filter can gate per-session
		// attached replies. Seed a log partition with a TO-stamped packed
		// Message and prove the Callback routes it via Router instead of
		// emitting it on the wire.
		SSE_Out_Node::$acquire_slot = static fn (): array|false => [ 'slot' => 7, 'owner' => 42424243 ];

		$base = $this->make_temp_dir( 'msg-slot-direct-sink-' );
		// Flat layout: the bare-name `firehose` subscription fans out to `firehose.p0`.
		$pdir = "{$base}/logs/firehose.p0";
		\mkdir( $pdir, 0755, true );

		// Pre-seed segment 0 of the firehose log partition 0 with a packed
		// Message whose TO is non-empty. Partition writes the JSON-encoded
		// 7-field message plus a newline — same on-the-wire shape Consumer
		// reads back per fgets() in poll().
		$message                       = \Newspack_Nodes\Message::new_message();
		$message[ \Newspack_Nodes\Message::TYPE ]  = \Newspack_Nodes\Message::TM_BYTESTREAM;
		$message[ \Newspack_Nodes\Message::FROM ]  = 'firehose';
		$message[ \Newspack_Nodes\Message::TO ]    = 'some-target';
		$message[ \Newspack_Nodes\Message::VALUE ] = 'attached-payload';
		\file_put_contents( "{$pdir}/0.log", \Newspack_Nodes\Message::packed( $message ) . "\n" );

		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $base );
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
		$positions = [ 'firehose.p0' => [ 'segment' => 0, 'offset' => 0 ] ];

		\ob_start();
		$ctrl->run_stream_loop( [ 'firehose.*' ], $positions, 500, [ 'slot' => 7, 'owner' => 42424243 ], 3 );
		\ob_get_clean();

		$this->assertNotEmpty( $routed, 'Callback else-branch must have routed the TO-stamped message through Router' );
		$this->assertSame( 'attached-payload', $routed[0][ \Newspack_Nodes\Message::VALUE ] );
	}
}
