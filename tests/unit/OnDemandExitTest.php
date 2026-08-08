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
#[CoversClass( Idle_Reporter::class )]
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

	private function worker( int $on_demand_idle = self::IDLE_SECONDS ): OnDemandWorker {
		$w = new OnDemandWorker(
			$this->tmp,
			'quokka-workers',
			0,
			on_demand_idle: $on_demand_idle
		);
		$w->acquire();
		return $w;
	}

	/**
	 * A REAL Consumer tailing a log nobody has ever written must not veto the
	 * exit. ELN's `jobs` topology mounts `jobintake:consumer`, and a spoke that
	 * never takes a large-ingress job has no `jobintake.p0` at all — that one
	 * absent log kept its job worker running full lifetimes and respawning,
	 * because an empty source reported null and null reads as busy.
	 */
	public function test_a_consumer_whose_source_was_never_written_does_not_hold_the_worker(): void {
		$this->quiet_for( 'quokka-probe', self::IDLE_SECONDS + 1 );
		$never = new \Newspack_Nodes\Consumer_Node();
		$never->name( 'jobintake:consumer' );
		$never->arguments( [ "{$this->tmp}/jobintake.p0", "{$this->tmp}/offsets.p0" ] );
		$never->sink( new \Newspack_Nodes\Tests\Capture_Sink_Node() );
		// Empty for longer than the window — a worker that has been up a while
		// with the log still absent, which is the shape seen on a live spoke.
		$this->assertNotNull( $never->idle_since(), 'an empty source is idle, not busy' );
		$empty = new \ReflectionProperty( $never, 'empty_since' );
		$empty->setValue( $never, \microtime( true ) - ( self::IDLE_SECONDS + 1 ) );

		$this->assertFalse( $this->worker()->should_continue() );
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

	// --- A running job holds the worker open ---------------------------------

	/**
	 * A jobs.p0 → Consumer → Job_Worker graph whose log stopped growing before
	 * the window opened — the shape that let the consumer vote itself idle while
	 * it was still holding the line.
	 *
	 * @param callable $handler The `slow` job handler under test.
	 * @param bool     $seed    False writes an empty log (a worker handed nothing).
	 */
	private function job_graph( callable $handler, bool $seed = true ): \Newspack_Nodes\Consumer_Node {
		$dir = "{$this->tmp}/jobs.p0";
		\mkdir( $dir, 0755, true );
		$body = '';
		if ( $seed ) {
			$entry                                   = \Newspack_Nodes\Message::new_message();
			$entry[ \Newspack_Nodes\Message::TYPE ]  = \Newspack_Nodes\Message::TM_STRUCT;
			$entry[ \Newspack_Nodes\Message::VALUE ] = [ 'k' => 'job', 'handler' => 'slow', 'parameters' => [] ];
			$body                                    = \Newspack_Nodes\Message::packed( $entry ) . "\n";
		}
		\file_put_contents( "{$dir}/0.log", $body );
		\touch( "{$dir}/0.log", \time() - ( self::IDLE_SECONDS + 1 ) );

		$jw = new \Newspack_Nodes\Job_Worker_Node();
		$jw->name( 'job-worker' );
		\add_filter( 'newspack_nodes/job_handlers', static fn ( $h ) => \array_merge( (array) $h, [ 'slow' => $handler ] ) );
		$jw->load_handlers_from_filters();

		$consumer = new \Newspack_Nodes\Consumer_Node();
		$consumer->name( 'jobs:consumer' );
		$consumer->arguments( [ $dir, "{$this->tmp}/offsets.p0", "{$this->tmp}/deadletter.p0" ] );
		$consumer->sink( $jw );
		return $consumer;
	}

	/**
	 * Drain the graph. Exactly one `worker()` per test: the lock is per-dir, so
	 * a second acquire fails and `should_continue()` then answers false for the
	 * wrong reason — and the idle scan is throttled to once a second, so asking
	 * the SAME worker twice answers true for the wrong reason.
	 */
	private function drain( \Newspack_Nodes\Consumer_Node $consumer ): void {
		$consumer->poll();
		$consumer->poll();
	}

	/** should_continue() sampled from INSIDE the handler, where pump() runs it. */
	private function continued_mid_job( \Newspack_Nodes\Consumer_Node $consumer ): ?bool {
		$during = null;
		\add_action( 'newspack_nodes/job_worker/before_job', function () use ( &$during ) {
			$during = $this->worker()->should_continue();
		} );
		$this->drain( $consumer );
		return $during;
	}

	/**
	 * The jobs Consumer is what speaks for a running job — `Job_Worker_Node` is
	 * a plain Node and reports nothing of its own. That works because the
	 * consumer holds the line for the whole dispatch, which is the whole job.
	 */
	public function test_the_consumer_is_the_reporter_a_job_worker_has_none(): void {
		$consumer = $this->job_graph( static fn () => null );

		$this->assertNotInstanceOf( Idle_Reporter::class, Core::node( 'job-worker' ) );
		$this->assertInstanceOf( Idle_Reporter::class, $consumer );
	}

	/**
	 * The reported bug. The consumer's lag discounted the buffered line as
	 * consumed while the cursor only advances in drain_buffer()'s finally, so a
	 * job outlasting the window took a `Worker_Should_Stop` from `pump()`
	 * mid-work, replayed, and was killed again every generation.
	 */
	public function test_a_running_job_holds_the_worker_open(): void {
		$during = $this->continued_mid_job( $this->job_graph( static fn () => null ) );

		$this->assertTrue( $during, 'a job in flight must veto the idle exit' );
	}

	public function test_the_worker_may_exit_once_the_handler_returns(): void {
		$this->drain( $this->job_graph( static fn () => null ) );

		$this->assertFalse( $this->worker()->should_continue(), 'a finished job releases the hold' );
	}

	/** The hold must stand for a doomed job too, or its poison never lands. */
	public function test_a_job_that_will_throw_still_holds_the_worker_open(): void {
		$during = $this->continued_mid_job( $this->job_graph( static function () {
			throw new \RuntimeException( 'nope' );
		} ) );

		$this->assertTrue( $during );
	}

	/** A poison job is quarantined and the cursor moves on — no wedged hold. */
	public function test_the_worker_may_exit_after_a_handler_throws(): void {
		$this->drain( $this->job_graph( static function () {
			throw new \RuntimeException( 'nope' );
		} ) );

		$this->assertFalse( $this->worker()->should_continue(), 'the hold lifts once it is dead-lettered' );
	}

	/**
	 * A cooperative stop leaves the line UNCOMMITTED so it replays — so a
	 * successor must not read it as idle either, or the replay is skipped.
	 */
	public function test_a_cooperative_stop_leaves_the_job_still_owed(): void {
		$consumer = $this->job_graph( static function () {
			throw new \Newspack_Nodes\Worker_Should_Stop();
		} );

		try {
			$this->drain( $consumer );
			$this->fail( 'expected the cooperative stop to propagate' );
		} catch ( \Newspack_Nodes\Worker_Should_Stop $e ) {
			unset( $e );
		}

		$this->assertTrue( $this->worker()->should_continue(), 'an uncommitted line is still work owed' );
	}

	/** A worker handed nothing is idle, not busy — on-demand exit still works. */
	public function test_a_worker_that_has_run_nothing_is_idle(): void {
		$this->job_graph( static fn () => null, seed: false );

		$this->assertFalse( $this->worker()->should_continue() );
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
		$w = $this->worker( on_demand_idle: 0 );

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

	/**
	 * An attached REPL is someone using the worker. Its IPC-input Consumer is
	 * ANONYMOUS — checkpointed by Worker_Base directly, never registered in
	 * Core::$nodes_by_name — so the reporter scan could not see it, and a worker
	 * would exit under an operator mid-session.
	 */
	public function test_the_ipc_input_consumer_holds_the_worker_open(): void {
		$this->quiet_for( 'quokka-probe', self::IDLE_SECONDS + 1 );
		$w = $this->worker();
		$w->set_ipc_consumer_for_test( new IdleProbe( null ) );

		$this->assertTrue( $w->should_continue(), 'a live REPL forbids the exit' );
	}

	/** And once the REPL goes quiet it stops holding it. */
	public function test_a_quiet_ipc_consumer_stops_holding_the_worker_open(): void {
		$this->quiet_for( 'quokka-probe', self::IDLE_SECONDS + 1 );
		$w = $this->worker();
		$w->set_ipc_consumer_for_test(
			new IdleProbe( \microtime( true ) - ( self::IDLE_SECONDS + 1 ) )
		);

		$this->assertFalse( $w->should_continue() );
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

	public function set_ipc_consumer_for_test( Idle_Reporter $reporter ): void {
		$this->ipc_reporter = $reporter;
	}
}
