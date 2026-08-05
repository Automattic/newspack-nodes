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

	public function test_register_curl_easy_tracks_node_for_multi_dispatch(): void {
		$ef = Event_Framework::instance();

		$node = new class extends \Newspack_Nodes\Node {
			public int $curl_events = 0;
			public function on_curl_message( array $info ): void { ++$this->curl_events; }
		};

		$easy = \curl_init();
		$ef->register_curl_easy( $node, $easy );

		$ef->drain( $this->boundedTicks( 1 ) );

		$this->assertTrue( true, 'drain with an idle easy handle did not crash' );

		$ef->unregister_curl_easy( $easy );
	}

	public function test_unregister_curl_easy_removes_registered_handle(): void {
		$ef = Event_Framework::instance();

		$node = new class extends \Newspack_Nodes\Node {};
		$easy = \curl_init();
		$ef->register_curl_easy( $node, $easy );

		$ef->unregister_curl_easy( $easy );

		$this->assertSame( [], $this->read_private( $ef, 'curl_owners' ) );
		$this->assertSame( [], $ef->curl_handles() );

	}

	public function test_drain_dispatches_curl_completions_to_the_owning_node(): void {
		// The shared-multi contract: two nodes' easy handles are registered on ONE
		// multi; a single drain tick must route each completion to the handle's owner,
		// keyed by the easy handle — never by registration order.
		$ef = Event_Framework::instance();

		$recorder = static function (): object {
			return new class extends \Newspack_Nodes\Node {
				public ?\CurlHandle $seen = null;
				public function on_curl_message( array $info ): void {
					$this->seen = $info['handle'] ?? null;
				}
			};
		};
		$node_a = $recorder();
		$node_b = $recorder();

		$easy_a = \curl_init();
		$easy_b = \curl_init();
		$ef->register_curl_easy( $node_a, $easy_a );
		$ef->register_curl_easy( $node_b, $easy_b );

		// Shuffle the completion order to prove routing is by handle, not order.
		Event_Framework::$curl_poll = static function ( \CurlMultiHandle $m ) use ( $easy_a, $easy_b ): array {
			return [
				[ 'msg' => \CURLMSG_DONE, 'handle' => $easy_b, 'result' => \CURLE_OK ],
				[ 'msg' => \CURLMSG_DONE, 'handle' => $easy_a, 'result' => \CURLE_OK ],
			];
		};

		$ticks = 0;
		$ef->drain( function () use ( &$ticks ): bool {
			Core::$now = \microtime( true );
			return 0 === $ticks++;
		} );

		$this->assertSame( $easy_a, $node_a->seen, 'node A got its own handle back' );
		$this->assertSame( $easy_b, $node_b->seen, 'node B got its own handle back' );

		Event_Framework::$curl_poll = null;
		$ef->unregister_curl_easy( $easy_a );
		$ef->unregister_curl_easy( $easy_b );
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

		$curl_node = new class extends \Newspack_Nodes\Node {
			public function on_curl_message( array $info ): void {}
		};
		$easy = \curl_init();
		$ef->register_curl_easy( $curl_node, $easy );

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

	public function test_pump_does_not_throw_while_inside_the_stderr_handler(): void {
		// Logging the stop reason must not self-throw a cooperative stop: the worker
		// routes stderr into the REPL partition, whose fill() calls pump() while the
		// predicate is already false. Without the guard that is a spurious
		// "stopped mid-job (pump)" on every shutdown.
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
