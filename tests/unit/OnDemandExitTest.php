<?php
/**
 * OnDemandExitTest: when an on-demand worker scales itself to zero.
 *
 * The exit condition is NOT "no messages arrived". A request that logs its
 * start and then goes quiet — a slow external call, a long query — leaves a
 * builder holding an envelope while its consumer sits at EOF, and a worker that
 * exits there abandons a started span for a successor to reconstruct. So nodes
 * report their own idleness through `Idle_Reporter` and the worker stops only
 * when EVERY reporter has been idle for the whole window.
 *
 * Opting in is the point: the substrate names no application node. A graph with
 * no reporter at all has nothing to measure, and never idle-exits.
 *
 * @package Newspack_Nodes
 */

declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Core;
use Newspack_Nodes\Idle_Reporter;
use Newspack_Nodes\Node;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Worker_Base;

#[CoversClass( Worker_Base::class )]
class OnDemandExitTest extends TestCase {

	/** Seeded apart from the 5s default so a dropped override cannot pass. */
	private const IDLE_SECONDS = 23;

	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		$this->tmp               = $this->make_temp_dir( 'on-demand-exit-' );
		Worker_Base::$last_error = static fn (): ?array => null;
	}

	protected function tearDown(): void {
		Worker_Base::$last_error = null;
		Core::cleanup_all_nodes();
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	/** Mount a reporter quiet since $seconds ago. */
	private function quiet_for( string $name, int $seconds ): void {
		( new IdleProbe( \microtime( true ) - $seconds ) )->name( $name );
	}

	/** Mount a reporter holding work: no idle timestamp to offer. */
	private function busy( string $name ): void {
		( new IdleProbe( null ) )->name( $name );
	}

	private function worker( bool $on_demand = true ): OnDemandWorker {
		$w = new OnDemandWorker(
			$this->tmp,
			'quokka-workers',
			0,
			on_demand: $on_demand,
			on_demand_idle: self::IDLE_SECONDS
		);
		$w->acquire();
		return $w;
	}

	public function test_it_stops_once_every_reporter_has_been_idle_for_the_window(): void {
		$this->quiet_for( 'quokka-probe', self::IDLE_SECONDS + 1 );
		$w = $this->worker();

		$this->assertFalse( $w->should_continue() );
		$this->assertSame( 'idle', $w->stop_reason_for_test() );
	}

	public function test_it_keeps_running_inside_the_window(): void {
		$this->quiet_for( 'quokka-probe', self::IDLE_SECONDS - 2 );
		$w = $this->worker();

		$this->assertTrue( $w->should_continue() );
	}

	/** A builder holding an open envelope is work in flight, EOF or not. */
	public function test_one_busy_reporter_holds_the_worker_open(): void {
		$this->quiet_for( 'quokka-consumer', self::IDLE_SECONDS + 1 );
		$this->busy( 'quokka-builder' );
		$w = $this->worker();

		$this->assertTrue( $w->should_continue() );
	}

	/** The window runs from the LATEST reporter, not the earliest. */
	public function test_the_most_recently_busy_reporter_sets_the_window(): void {
		$this->quiet_for( 'quokka-stale', self::IDLE_SECONDS * 10 );
		$this->quiet_for( 'quokka-recent', self::IDLE_SECONDS - 2 );
		$w = $this->worker();

		$this->assertTrue( $w->should_continue() );
	}

	/** Nothing to measure: fail closed rather than exit a graph we can't read. */
	public function test_a_graph_with_no_reporter_never_idle_exits(): void {
		$w = $this->worker();

		$this->assertTrue( $w->should_continue() );
	}

	public function test_a_resident_worker_never_idle_exits(): void {
		$this->quiet_for( 'quokka-probe', self::IDLE_SECONDS * 10 );
		$w = $this->worker( on_demand: false );

		$this->assertTrue( $w->should_continue() );
	}

	/**
	 * `Consumer_Node::idle_since()` lists segments and stats the newest one, and
	 * `should_continue()` runs every drain tick. Scanning per tick would spend
	 * more disk I/O than the residency this feature gives back.
	 */
	public function test_the_idle_scan_is_throttled_off_the_per_tick_path(): void {
		$probe = new IdleProbe( \microtime( true ) - ( self::IDLE_SECONDS - 2 ) );
		$probe->name( 'quokka-probe' );
		$w = $this->worker();

		$w->should_continue();
		$w->should_continue();
		$w->should_continue();

		$this->assertSame( 1, $probe->calls, 'one scan per second, not one per tick' );
	}

	/** The whole point: an idle exit must NOT hand the slot straight back. */
	public function test_an_idle_stop_does_not_self_respawn(): void {
		$w = $this->worker();
		$w->set_stop_reason_for_test( 'idle' );

		$this->assertFalse( $w->should_self_respawn() );
	}

	public function test_a_timeout_stop_still_self_respawns(): void {
		$w = $this->worker();
		$w->set_stop_reason_for_test( 'timeout' );

		$this->assertTrue( $w->should_self_respawn() );
	}
}

/** A node whose idle timestamp the test drives directly, counting every read. */
class IdleProbe extends Node implements Idle_Reporter {

	public int $calls = 0;

	public function __construct( private ?float $since ) {
		parent::__construct();
	}

	public function idle_since(): ?float {
		++$this->calls;
		return $this->since;
	}
}

/** Worker_Base with the stop category under test control. */
class OnDemandWorker extends Worker_Base {

	public function set_stop_reason_for_test( string $reason ): void {
		$this->stop_reason = $reason;
	}

	public function stop_reason_for_test(): string {
		return $this->stop_reason;
	}
}
