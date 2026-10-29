<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Core;
use Newspack_Nodes\Event_Framework;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Timer_Node;

#[CoversClass( Router_Node::class )]
class RouterTimerTest extends TestCase {
	protected function setUp(): void {
		parent::setUp();
		Event_Framework::reset();
	}

	public function test_router_pre_declares_TIMER_event(): void {
		$router = new Router_Node();
		$router->name( '_router' );
		$listener = new Timer_Node();
		$listener->name( 't1' );

		$router->register( 'TIMER', 't1' );
		$this->assertSame( [ 'TIMER' => [ 't1' ] ], $router->registered_listeners() );
	}

	/**
	 * notify_timer is node-name dispatch (Perl Router::notify_timer): it calls
	 * Core::node($name)->fire_cb() directly. A registered name with no live node is
	 * warned + dropped (forgot to unregister), not left polling a dead node.
	 */
	public function test_router_drops_a_registered_name_with_no_live_node(): void {
		$router = new Router_Node();
		$router->name( '_router' );
		$router->register( 'TIMER', 'ghost' ); // no node named 'ghost' in Core

		$router->fire_cb();

		$prop = ( new \ReflectionObject( $router ) )->getProperty( 'registrations' );
		$regs = $prop->getValue( $router );
		$this->assertArrayNotHasKey( 'ghost', $regs['TIMER'] );
	}

	/**
	 * A name that leaves the TIMER channel during the walk is skipped without a
	 * warning, whether its node was removed or only stopped; a name still
	 * registered with no node behind it is warned about and dropped.
	 */
	public function test_a_name_that_leaves_the_channel_mid_walk_is_skipped_quietly(): void {
		$router = new Router_Node();
		$router->name( '_router' );
		$stopper = new class() extends Timer_Node {
			/** @var list<\Closure():void> What this timer does to its peers when it fires. */
			public array $acts = [];

			protected function fire(): void {
				foreach ( $this->acts as $act ) {
					$act();
				}
			}
		};
		$stopper->name( 'kea-5108-stopper' );
		$stopper->sink( new Capture_Sink_Node() );
		$stopper->set_timer( 5000 );
		$removed = new Timer_Node();
		$removed->name( 'kea-5108-removed' );
		$removed->set_timer( 5000 );
		$stopped = new Timer_Node();
		$stopped->name( 'kea-5108-stopped' );
		$beats = new Capture_Sink_Node();
		$stopped->sink( $beats );
		$stopped->set_timer( 5000 );
		$stopper->acts = [ static fn () => $removed->remove_node(), static fn () => $stopped->stop_timer() ];
		$router->register( 'TIMER', 'kea-5108-ghost' );
		$errors = $this->capture_stderr();

		$router->fire_cb();

		$regs = ( new \ReflectionObject( $router ) )->getProperty( 'registrations' )->getValue( $router );
		$this->assertSame( [ '_router: WARNING: kea-5108-ghost forgot to unregister' ], self::stderr_lines( $errors ) );
		$this->assertSame( [], $beats->captured, 'a timer stopped mid-walk does not fire on that tick' );
		$this->assertSame( [ 'kea-5108-stopper' ], \array_keys( $regs['TIMER'] ) );
	}

	public function test_hitchhike_oneshot_unregisters_after_its_single_fire(): void {
		$router = new Router_Node();
		$router->name( '_router' );
		$timer = new Timer_Node();
		$timer->name( 'once0' );
		$capture = new Capture_Sink_Node();
		$timer->sink( $capture );
		$timer->set_timer( 5000, true );

		$router->fire_cb();
		Core::$now += 6; // past the 5s hitchhike throttle: a leak would re-fire
		$router->fire_cb();

		$this->assertCount( 1, $capture->captured, 'a spent oneshot must not keep riding the router TIMER' );
		$this->assertFalse( $timer->oneshot );
		$this->assertSame( 'inactive', $timer->timer_mode() );
	}

	public function test_router_fire_cb_increments_its_own_fire_count(): void {
		$router = new Router_Node();
		$router->name( '_router' );

		$router->fire_cb();
		$router->fire_cb();

		$this->assertSame( 2, $router->get_fire_count(), 'list_timers FIRES must tally router ticks' );
	}

	public function test_timer_with_no_args_registers_with_router_TIMER_event(): void {
		$router = new Router_Node();
		$router->name( '_router' );

		$timer = new Timer_Node();
		$timer->name( 'piggyback' );
		$timer->sink( $router );
		$timer->set_timer();

		$before = $timer->counter();
		$router->fire_cb();
		$this->assertSame( $before + 1, $timer->counter() );
	}

	/**
	 * A hitchhiked TIMER fires on every tick. A closure listener returning void → null →
	 * falsy would have Node::notify auto-unregister it after tick 1; node-name dispatch
	 * keeps the registration alive across ticks.
	 */
	public function test_hitchhiked_timer_fires_on_every_tick_not_just_first(): void {
		$router = new Router_Node();
		$router->name( '_router' );

		$timer = new Timer_Node();
		$timer->name( 'persistent' );
		$timer->sink( $router );
		$timer->set_timer();

		$router->fire_cb();
		$router->fire_cb();
		$router->fire_cb();
		$router->fire_cb();
		$router->fire_cb();

		$this->assertSame( 5, $timer->counter(), 'hitchhiked Timer should fire on every Router tick, not self-unregister after the first' );
	}

	/**
	 * notify_timer must only call fire_cb() on Timer_Nodes. A plain Node (no
	 * fire_cb method) registered under TIMER must be skipped, not fataled on —
	 * the guard protects against a non-Timer registrant slipping through.
	 */
	public function test_notify_timer_skips_a_registered_non_timer_node(): void {
		$router = new Router_Node();
		$router->name( '_router' );

		$plain = new Capture_Sink_Node();
		$plain->name( 'plain' ); // registers in Core; Capture_Sink_Node has no fire_cb().
		$router->register( 'TIMER', 'plain' );

		// Unguarded this fatals with "undefined method Node::fire_cb()". The
		// guard skips the non-Timer registrant, so the call returns normally.
		$router->notify_timer();

		$this->assertEmpty( $plain->captured, 'a non-Timer node must not be driven by notify_timer' );
	}

	/**
	 * A no-ms rider fires at the router's own cadence, and list_timers prints
	 * interval_ms — so the value has to BE that cadence, not a 0 sentinel, or
	 * the same node reads differently in a worker than in a browser graph.
	 * Mirrors src/runtime/timer-node.js.
	 */
	public function test_no_ms_hitchhike_reports_the_router_cadence(): void {
		$router = new Router_Node();
		$router->name( '_router' );
		// Worker_Base arms it at DEFAULT_TICK_MS; JS's RouterNode self-arms.
		$router->set_timer( Router_Node::DEFAULT_TICK_MS );
		$this->assertSame( 1000, $router->interval_ms );

		$timer = new Timer_Node();
		$timer->name( 'rides' );
		$timer->sink( new Capture_Sink_Node() );
		$timer->set_timer();

		$this->assertSame( $router->interval_ms, $timer->interval_ms );
		$timer->stop_timer();
	}

	/**
	 * An unnamed timer cannot ride the name-keyed hitchhike, so it never
	 * registers — it takes an own slot instead (TimerTest covers that path).
	 * With no interval to take one at, the no-arg call fails loud.
	 */
	public function test_set_timer_no_args_on_unnamed_timer_never_registers(): void {
		$router = new Router_Node();
		$router->name( '_router' );

		$timer = new Timer_Node(); // no name() call

		$e = $this->caught(
			fn () => $timer->set_timer(),
			'expected the own-slot interval guard to throw'
		);
		$this->assertStringContainsString(
			'Own-slot timer requires an interval (ms)',
			$e->getMessage()
		);

		$router->notify_timer();
		$this->assertSame( 0, $timer->get_fire_count(), 'never joined the tick' );
	}

	public function test_set_timer_no_args_throws_when_no_router_present(): void {
		// Named, but no _router registered in Core → the no-arg hitchhike has
		// nothing to register with. Fail loud rather than silently never firing.
		$timer = new Timer_Node();
		$timer->name( 'orphan' );

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'Router-hitchhike requires _router to be present' );
		$timer->set_timer();
	}

	/**
	 * stop_timer must clean up Router-hitchhike registrations as well as
	 * EventFramework slots. A registration left in Router's TIMER list keeps the Timer
	 * firing forever.
	 */
	public function test_stop_timer_unregisters_from_router_when_hitchhiked(): void {
		$router = new Router_Node();
		$router->name( '_router' );

		$timer = new Timer_Node();
		$timer->name( 'pulse' );
		$timer->sink( $router );
		$timer->set_timer();

		$router->fire_cb();
		$this->assertSame( 1, $timer->counter() );

		$timer->stop_timer();

		$router->fire_cb();
		$router->fire_cb();
		$this->assertSame( 1, $timer->counter(), 'stop_timer must unregister hitchhiked Timer so it stops firing' );
		$this->assertSame( 'inactive', $timer->timer_mode());
	}

	/**
	 * stop_timer unregisters the hitchhiked Timer from the Router immediately — no
	 * closing-queue drain needed. PHP foreach iterates a copy of the registration
	 * list (Node::notify even unset()s entries mid-loop), so synchronous unregister
	 * is safe; the Timer must not fire on the next tick.
	 */
	public function test_stop_timer_unregisters_immediately(): void {
		$router = new Router_Node();
		$router->name( '_router' );

		$timer = new Timer_Node();
		$timer->name( 'sync' );
		$timer->set_timer();

		$timer->stop_timer();
		// No run_closing(): teardown already happened synchronously.
		$router->fire_cb();
		$this->assertSame( 0, $timer->counter(), 'stop_timer must unregister immediately so the Timer never fires' );
		$this->assertSame( 'inactive', $timer->timer_mode());
	}

	/** The Router's own ticks land on the grid's boundaries, whatever the arming phase. */
	public function test_the_router_ticks_on_grid_boundaries_from_any_start_phase(): void {
		$ticks = $this->router_ticks( 1700.73, 3 );

		$this->assertSame( [ 1701.36, 1702.36, 1703.36 ], $this->to_the_microsecond( $ticks ) );
	}

	/** A late tick does not shift the ones after it. */
	public function test_a_late_router_tick_does_not_shift_the_next(): void {
		$ticks = $this->router_ticks( 1700.73, 3, 0.3 );

		$this->assertSame( [ 1701.36, 1702.66, 1703.36 ], $this->to_the_microsecond( $ticks ), 'only the second tick is late' );
	}

	/**
	 * With the tick on the grid, a one-second timer whose fire was stamped late
	 * by slow work ahead of it in the same tick still fires on the next tick.
	 * Off the grid, the same 0.7s carried the fire past a boundary and cost it.
	 */
	public function test_an_aligned_tick_fires_a_one_second_timer_stamped_late_in_its_tick(): void {
		$probe = null;
		$ticks = $this->router_ticks( 1700.73, 2, 0.0, $probe, 0.7 );

		$this->assertSame( [ 1701.36, 1702.36 ], $this->to_the_microsecond( $ticks ) );
		$this->assertSame( 2, $probe->get_fire_count(), 'it fires on both ticks' );
	}

	/**
	 * Tick times to the microsecond: a wait rounds up, so a tick lands at most
	 * a microsecond past its boundary.
	 *
	 * @param list<float> $ticks Tick times, in seconds.
	 * @return list<float> The same, rounded.
	 */
	private function to_the_microsecond( array $ticks ): array {
		return \array_map( static fn ( float $t ): float => \round( $t, 6 ), $ticks );
	}

	/**
	 * Arm a Router on a clock the test holds, from `$start`, with two
	 * hitchhikers at the tick's own cadence — the first records each tick and
	 * does the tick's work, the probe behind it — and drain until it has
	 * ticked `$count` times.
	 *
	 * @param float           $start Where the clock starts.
	 * @param int             $count Ticks to drain.
	 * @param float           $late  Seconds the wait after the first tick oversleeps.
	 * @param Timer_Node|null $probe Out: the hitchhiker the ticks fired.
	 * @param float           $work  Seconds a hitchhiker ahead of the probe moves
	 *                               the clock on during the first tick.
	 * @return list<float> The clock at each Router tick.
	 */
	private function router_ticks( float $start, int $count, float $late = 0.0, ?Timer_Node &$probe = null, float $work = 0.0 ): array {
		$t                      = $start;
		$waits                  = 0;
		Core::$clock            = static function () use ( &$t ): float {
			return $t;
		};
		Event_Framework::$sleep = static function ( int $us ) use ( &$t, &$waits, $late ): void {
			$t += $us / 1_000_000 + ( 1 === $waits ? $late : 0.0 );
			++$waits;
		};
		Core::right_now();
		Core::$secure_level = 1;
		$router             = new Router_Node();
		$router->name( '_router' );
		$router->set_timer( Router_Node::DEFAULT_TICK_MS );
		$slow       = new Timer_Node();
		$slow->name( 'kea-slow-work' );
		$slow_sink     = new class() extends Capture_Sink_Node {
			/** @var \Closure(): void Runs on each fill. */
			public \Closure $on_fill;

			public function fill( array $message ): void {
				( $this->on_fill )();
			}
		};
		$ticks              = [];
		$slow_sink->on_fill = static function () use ( &$t, &$work, &$ticks ): void {
			$ticks[] = Core::$now;
			$t      += $work;
			$work = 0.0;
			Core::right_now();
		};
		$slow->sink( $slow_sink );
		$slow->set_timer();
		$probe = new Timer_Node();
		$probe->name( 'kiwi-probe' );
		$probe->sink( new Capture_Sink_Node() );
		$probe->set_timer();

		$loops = 0;
		Event_Framework::instance()->drain(
			static function () use ( $count, &$ticks, &$loops ): bool {
				return \count( $ticks ) < $count && ++$loops < 50;
			}
		);
		$router->stop_timer();
		return $ticks;
	}
}
