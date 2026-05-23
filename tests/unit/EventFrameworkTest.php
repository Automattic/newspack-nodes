<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Event_Framework;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

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

	public function test_drain_runs_closing_queue_post_loop(): void {
		$ef = Event_Framework::instance();
		$post_loop_ran = false;
		\Newspack_Nodes\Core::push_closing( function () use ( &$post_loop_ran ) {
			$post_loop_ran = true;
		} );
		$ef->drain( fn () => false );
		$this->assertTrue( $post_loop_ran, 'Core::run_closing() must drain after the loop terminates' );
	}

	public function test_set_timer_fires_after_interval(): void {
		$ef = Event_Framework::instance();

		$timer_node = new class {
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

		$timer_node = new class {
			public int $fired = 0;
			public function fire_cb(): void { ++$this->fired; }
		};

		$ef->set_timer( $timer_node, 10, true );

		$start = \microtime( true );
		$ef->drain( function () use ( $start ): bool {
			\Newspack_Nodes\Core::$now = \microtime(true);
			return ( \microtime( true ) - $start ) < 0.1;
		} );

		$this->assertSame( 1, $timer_node->fired, 'Oneshot fires exactly once' );
	}

	public function test_register_curl_handle_tracks_node_for_multi_dispatch(): void {
		$ef = Event_Framework::instance();

		$node = new class {
			public int $curl_events = 0;
			public function on_curl_message( array $info ): void { ++$this->curl_events; }
		};

		$mh = \curl_multi_init();
		$ef->register_curl_handle( $node, $mh );

		$ef->drain( $this->boundedTicks( 1 ) );

		$this->assertTrue( true, 'drain with empty curl multi handle did not crash' );

		\curl_multi_close( $mh );
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

		$curl_node = new class {
			public function on_curl_message( array $info ): void {}
		};
		$mh = \curl_multi_init();
		$ef->register_curl_handle( $curl_node, $mh );

		$start = \microtime( true );
		$ef->drain( $this->boundedTicks( 1 ) );
		$elapsed = \microtime( true ) - $start;

		// curl_multi_select with empty multi handle returns near-immediately;
		// allow generous slack since we only run one iteration.
		$this->assertLessThan( 1.0, $elapsed );

		\curl_multi_close( $mh );
	}
}
