<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Core;
use Newspack_Nodes\Event_Framework;
use Newspack_Nodes\Timer_Node;
use Newspack_Nodes\Worker_Should_Stop;
use Newspack_Nodes\Tests\TestCase;

#[CoversClass( Event_Framework::class )]
class EventFrameworkTest extends TestCase {
	protected function setUp(): void {
		parent::setUp();
		Event_Framework::reset();
	}

	public function test_drain_exits_when_should_continue_returns_false(): void {
		$ef     = Event_Framework::instance();
		$ticks  = 0;
		$should = function () use ( &$ticks ): bool {
			++$ticks;
			return $ticks <= 3;
		};
		$ef->drain( $should );
		$this->assertSame( 4, $ticks );
	}

	public function test_is_running_reflects_drain_loop_state(): void {
		$ef = Event_Framework::instance();
		$this->assertFalse( $ef->is_running() );

		$observed = null;
		$ef->drain(
			function () use ( $ef, &$observed ): bool {
				$observed = $ef->is_running();
				return false;
			}
		);

		$this->assertTrue( $observed );
		$this->assertFalse( $ef->is_running() );
	}

	public function test_set_timer_fires_after_interval(): void {
		$ef = Event_Framework::instance();

		$timer_node = new class extends \Newspack_Nodes\Timer_Node {
			public int $fired = 0;
			public function fire_cb(): void { ++$this->fired; }
		};

		$ef->set_timer( $timer_node, 50 );

		$start = \microtime( true );
		$ef->drain( function () use ( $start ): bool {
			\Newspack_Nodes\Core::$now = \microtime(true);
			return ( \microtime( true ) - $start ) < 0.2;
		} );

		$this->assertGreaterThan( 0, $timer_node->fired );
	}

	public function test_oneshot_timer_fires_exactly_once(): void {
		$ef = Event_Framework::instance();

		$timer_node = new class extends \Newspack_Nodes\Timer_Node {
			public int $fired = 0;
			public function fire_cb(): void { ++$this->fired; }
		};

		$timer_node->set_timer( 10, true );

		$start = \microtime( true );
		$ef->drain( function () use ( $start ): bool {
			\Newspack_Nodes\Core::$now = \microtime(true);
			return ( \microtime( true ) - $start ) < 0.1;
		} );

		$this->assertSame( 1, $timer_node->fired, 'Oneshot fires exactly once' );
	}

	/** A Curl_Owner double recording each completion it is handed. */
	private function curl_owner(): object {
		return new class extends \Newspack_Nodes\Node implements \Newspack_Nodes\Curl_Owner {
			/** @var list<array{0:\CurlHandle,1:int,2:mixed}> */
			public array $done = [];
			public function on_curl_done( \CurlHandle $handle, int $result, mixed $context ): void {
				$this->done[] = [ $handle, $result, $context ];
			}
		};
	}

	/** Install a dispatch seam handing back idle handles and recording the opts. */
	private function capture_curl( array &$opts ): void {
		Event_Framework::$curl_dispatch = static function ( array $o ) use ( &$opts ): \CurlHandle {
			$opts[] = $o;
			return \curl_init();
		};
	}

	public function test_start_curl_dispatches_the_opts_and_holds_the_handle_for_its_owner(): void {
		$ef   = Event_Framework::instance();
		$opts = [];
		$this->capture_curl( $opts );
		$owner = $this->curl_owner();

		$easy = $ef->start_curl( $owner, [ \CURLOPT_URL => 'https://ef-61.example/start' ], 'ctx-61' );

		$this->assertInstanceOf( \CurlHandle::class, $easy );
		$this->assertSame( 'https://ef-61.example/start', $opts[0][ \CURLOPT_URL ] );
		$this->assertSame( [ $easy ], $ef->handles_of( $owner ) );
		$this->assertArrayHasKey( \spl_object_id( $owner ), $ef->curl_handles() );
		$ef->release_curl( $owner );
	}

	public function test_start_curl_answers_null_when_no_handle_could_be_made(): void {
		$ef                             = Event_Framework::instance();
		Event_Framework::$curl_dispatch = static fn ( array $o ): bool => false;
		$owner                          = $this->curl_owner();

		$this->assertNull( $ef->start_curl( $owner, [ \CURLOPT_URL => 'https://ef-62.example/' ], 'ctx-62' ) );
		$this->assertSame( [], $ef->handles_of( $owner ) );
	}

	public function test_a_completion_reaches_its_owner_with_its_context_and_releases_the_handle(): void {
		// One multi, two owners; routing is by handle, never by completion order.
		$ef   = Event_Framework::instance();
		$opts = [];
		$this->capture_curl( $opts );
		$owner_a = $this->curl_owner();
		$owner_b = $this->curl_owner();
		$easy_a  = $ef->start_curl( $owner_a, [ \CURLOPT_URL => 'https://a-63.example/' ], 'ctx-a-63' );
		$easy_b  = $ef->start_curl( $owner_b, [ \CURLOPT_URL => 'https://b-64.example/' ], 'ctx-b-64' );

		Event_Framework::$curl_poll = static fn ( \CurlMultiHandle $m ): array => [
			[ 'msg' => \CURLMSG_DONE, 'handle' => $easy_b, 'result' => \CURLE_OK ],
			[ 'msg' => \CURLMSG_DONE, 'handle' => $easy_a, 'result' => \CURLE_OPERATION_TIMEDOUT ],
		];
		$ticks = 0;
		$ef->drain( function () use ( &$ticks ): bool {
			Core::$now = \microtime( true );
			return 0 === $ticks++;
		} );

		$this->assertSame( [ [ $easy_a, \CURLE_OPERATION_TIMEDOUT, 'ctx-a-63' ] ], $owner_a->done );
		$this->assertSame( [ [ $easy_b, \CURLE_OK, 'ctx-b-64' ] ], $owner_b->done );
		$this->assertSame( [], $ef->handles_of( $owner_a ), 'a completed handle is released' );
		$this->assertSame( [], $ef->curl_handles() );
	}

	public function test_a_row_that_is_not_done_reaches_no_owner(): void {
		$ef   = Event_Framework::instance();
		$opts = [];
		$this->capture_curl( $opts );
		$owner = $this->curl_owner();
		$easy  = $ef->start_curl( $owner, [ \CURLOPT_URL => 'https://ef-65.example/' ], 'ctx-65' );

		$this->complete_curl( $easy, \CURLE_OK, 0 );

		$this->assertSame( [], $owner->done );
		$this->assertSame( [ $easy ], $ef->handles_of( $owner ), 'still in flight' );
		$ef->release_curl( $owner );
	}

	public function test_release_curl_releases_one_owners_handles_and_counts_them(): void {
		$ef   = Event_Framework::instance();
		$opts = [];
		$this->capture_curl( $opts );
		$owner = $this->curl_owner();
		$other = $this->curl_owner();
		$ef->start_curl( $owner, [ \CURLOPT_URL => 'https://ef-66.example/1' ], 'ctx-66' );
		$ef->start_curl( $owner, [ \CURLOPT_URL => 'https://ef-66.example/2' ], 'ctx-67' );
		$kept = $ef->start_curl( $other, [ \CURLOPT_URL => 'https://ef-68.example/' ], 'ctx-68' );

		$this->assertSame( 2, $ef->release_curl( $owner ) );

		$this->assertSame( [], $ef->handles_of( $owner ) );
		$this->assertSame( [ $kept ], $ef->handles_of( $other ) );
		$ef->release_curl( $other );
	}

	public function test_unregister_curl_easy_removes_registered_handle(): void {
		$ef    = Event_Framework::instance();
		$owner = $this->curl_owner();
		$easy  = \curl_init();
		$ef->register_curl_easy( $owner, $easy, 'ctx-69' );

		$ef->unregister_curl_easy( $easy );

		$this->assertSame( [], $this->read_private( $ef, 'curl_transfers' ) );
		$this->assertSame( [], $ef->curl_handles() );
	}

	public function test_drain_exits_when_shutting_down_flag_is_set(): void {
		$ef = Event_Framework::instance();
		$ticks = 0;
		$ef->drain( function () use ( &$ticks ): bool {
			++$ticks;
			if ( 2 === $ticks ) {
				\Newspack_Nodes\Core::$shutting_down = true;
			}
			return true;
		} );
		$this->assertGreaterThanOrEqual( 2, $ticks );
		$this->assertLessThan( 5, $ticks );
	}

	public function test_install_signal_handlers_does_not_crash(): void {
		if ( ! \function_exists( 'pcntl_signal' ) ) {
			$this->markTestSkipped( 'pcntl not available' );
		}
		$ef = Event_Framework::instance();
		$ef->install_signal_handlers();
		$this->assertTrue( true );
	}

	public function test_drain_with_curl_and_no_timers_still_returns(): void {
		// Confirms the cURL branch in drain_inner doesn't hang when no timers
		// are registered: curl_multi_select uses the IDLE_TIMEOUT_US fallback
		// (~100ms) and we exit on the should_continue gate.
		$ef = Event_Framework::instance();

		$curl_node = $this->curl_owner();
		$easy      = \curl_init();
		$ef->register_curl_easy( $curl_node, $easy, 'ctx-70' );

		$start = \microtime( true );
		$ef->drain( $this->boundedTicks( 1 ) );
		$elapsed = \microtime( true ) - $start;

		// curl_multi_select with an idle handle returns near-immediately;
		// allow generous slack since we only run one iteration.
		$this->assertLessThan( 1.0, $elapsed );

		$ef->unregister_curl_easy( $easy );
	}

	// --- pump(): test helpers + in-job cooperative heartbeat ----------------

	/** A oneshot timer that runs an injected closure on fire — drives pump() from inside a live drain. */
	private function fire_once( callable $cb ): Timer_Node {
		$timer = new class extends Timer_Node {
			/** @var callable */
			public $on_fire;
			public function fire_cb(): void {
				( $this->on_fire )();
			}
		};
		$timer->on_fire = $cb;
		$timer->set_timer( 1, true );
		return $timer;
	}

	/** Stop-predicate that advances the clock so the timer fires, and bails after a tick cap so a missed fire fails clean instead of hanging. */
	private function clocked_predicate( object $state ): callable {
		return function () use ( $state ): bool {
			Core::$now = \microtime( true );
			return ! $state->stop && ++$state->ticks < 1000;
		};
	}

	public function test_pump_is_noop_outside_a_drain(): void {
		$ef = Event_Framework::instance();
		$ef->pump(); // no stored predicate (web-request context) — must not throw.
		$this->assertFalse( $ef->is_running() );
	}

	public function test_pump_is_noop_for_a_plain_non_worker_drain(): void {
		// A plain (non-cooperative_stop) drain — cli / SSE — must never have pump() throw at it.
		$ef    = Event_Framework::instance();
		$state = (object) [ 'stop' => false, 'ticks' => 0, 'reached' => false ];
		$this->fire_once( function () use ( $ef, $state ) {
			$state->stop    = true; // predicate now false …
			$ef->pump();            // … but this drain didn't opt in → no throw
			$state->reached = true;
		} );

		$ef->drain( $this->clocked_predicate( $state ) ); // no cooperative_stop flag
		$this->assertTrue( $state->reached, 'pump() stayed inert in a plain drain' );
	}

	public function test_pump_throws_worker_should_stop_when_predicate_reports_stop(): void {
		$ef    = Event_Framework::instance();
		$state = (object) [ 'stop' => false, 'ticks' => 0 ];
		$this->fire_once( function () use ( $ef, $state ) {
			$state->stop = true; // worker should now stop
			$ef->pump();         // predicate now false → cooperative abort
		} );

		$this->expectException( Worker_Should_Stop::class );
		$ef->drain( $this->clocked_predicate( $state ), cooperative_stop: true );
	}

	public function test_pump_does_not_throw_while_worker_should_continue(): void {
		$ef    = Event_Framework::instance();
		$state = (object) [ 'stop' => false, 'ticks' => 0 ];
		$this->fire_once( function () use ( $ef, $state ) {
			$ef->pump();         // predicate still true → no throw
			$state->stop = true; // then end the loop normally
			$state->pumped = true;
		} );

		$ef->drain( $this->clocked_predicate( $state ), cooperative_stop: true );
		$this->assertTrue( $state->pumped ?? false, 'pump() ran inside the drain without throwing' );
	}

	public function test_pump_throttles_rapid_successive_calls(): void {
		$ef    = Event_Framework::instance();
		$state = (object) [ 'stop' => false, 'ticks' => 0 ];
		$this->fire_once( function () use ( $ef, $state ) {
			$ef->pump();         // first pump: predicate true (stop still false) → no throw
			$state->stop = true; // a second, un-throttled pump WOULD now see false and throw
			$ef->pump();         // throttled (same instant) → predicate not re-run → no throw
			$state->reached = true;
		} );

		$ef->drain( $this->clocked_predicate( $state ), cooperative_stop: true );
		$this->assertTrue( $state->reached ?? false, 'second rapid pump was throttled, not re-checked' );
	}

	public function test_a_stop_due_inside_an_uninterruptible_unit_raises_at_the_first_pump_after_it(): void {
		$finished = false;
		$stop     = $this->with_stop_due(
			static function () use ( &$finished ): void {
				$ef = Event_Framework::instance();
				$ef->uninterruptible(
					static function () use ( $ef, &$finished ): void {
						$ef->stop_check();
						$ef->pump();
						$finished = true;
					}
				);
				$ef->pump();
			}
		);

		$this->assertTrue( $finished, 'the unit ran to its end' );
		$this->assertNotNull( $stop, 'the stop raised once the unit closed' );
	}

	public function test_an_uninterruptible_unit_nested_in_another_restores_the_outer_hold(): void {
		$reached = false;
		$stop    = $this->with_stop_due(
			static function () use ( &$reached ): void {
				$ef = Event_Framework::instance();
				$ef->uninterruptible(
					static function () use ( $ef, &$reached ): void {
						$ef->uninterruptible( static fn () => null );
						$ef->stop_check();
						$reached = true;
					}
				);
			}
		);

		$this->assertTrue( $reached, 'the outer unit still holds after the inner one closed' );
		$this->assertNull( $stop, 'nothing reached a stop boundary after the units' );
	}

	public function test_pump_does_not_throw_while_inside_the_stderr_handler(): void {
		// Logging the stop reason must not self-throw a cooperative stop: the worker
		// routes stderr into the REPL partition, whose fill() calls pump() while the
		// predicate is already false. Without the guard every shutdown's own
		// stop-reason line would raise a second, spurious stop.
		$ef    = Event_Framework::instance();
		$state = (object) [ 'stop' => false, 'ticks' => 0, 'reached' => false ];

		Core::set_stderr_handler( static function ( string $text ): void {
			Event_Framework::instance()->pump(); // mimic the REPL-partition write
		} );

		$this->fire_once( function () use ( $state ) {
			$state->stop    = true;       // predicate is now false
			Core::stderr( 'stopping' );   // handler → pump() while in_stderr → no throw
			$state->reached = true;       // reached only if pump() did not throw
		} );

		$ef->drain( $this->clocked_predicate( $state ), cooperative_stop: true );
		$this->assertTrue( $state->reached, 'a stderr write must not raise a cooperative stop' );
	}
}
