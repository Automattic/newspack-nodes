<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Config;
use Newspack_Nodes\Core;
use Newspack_Nodes\Fleet_Sweep;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use Newspack_Nodes\Tests\TestCase;

#[CoversClass( Fleet_Sweep::class )]
class FleetSweepTest extends TestCase {
	private string $tmp;
	private ?\Memcached $prev_memd = null;

	protected function setUp(): void {
		parent::setUp();
		$this->tmp       = $this->make_temp_dir();
		$this->prev_memd = Core::$memd;
		// The unique-enqueue claim needs a shared store; without one it throws.
		Core::$memd = new InMemoryMemcached();
		$this->use_base_dir( $this->tmp );
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'ledger-workers' ];
		Config::reset();
	}

	protected function tearDown(): void {
		Core::$memd                                 = $this->prev_memd;
		\Newspack_Nodes\Cache_Backend::$apcu_usable = null;
		$this->rmdir_recursive( $this->tmp );
		unset( $GLOBALS['_wp_options']['newspack_nodes_topologies'] );
		Config::reset();
		parent::tearDown();
	}

	private function with_topology( array $topologies ): void {
		\add_filter( 'newspack_nodes/topologies', static fn() => $topologies );
	}

	private function make_lock( string $name ): void {
		\mkdir( "{$this->tmp}/locks/{$name}.lock.d", 0755, true );
		\touch( "{$this->tmp}/locks/{$name}.lock.d/heartbeat" );
	}

	// ── the unique enqueue ─────────────────────────────────────────────────

	public function test_only_one_scanner_per_window_enqueues_the_sweep(): void {
		// THE property that replaces a lock: N workers all try, one wins.
		$now = 1893456000.0; // fixed, so both calls share a window

		$first  = Fleet_Sweep::enqueue( $now );
		$second = Fleet_Sweep::enqueue( $now );

		$this->assertTrue( $first, 'the first scanner in a window wins the claim' );
		$this->assertFalse( $second, 'a peer in the same window must not enqueue a second sweep' );
	}

	public function test_a_contended_intake_lock_gives_up_instead_of_blocking(): void {
		// enqueue() runs INSIDE the worker drain loop. The default write-lock
		// wait is ~65s, past the 60s stale_timeout — a worker that waited it out
		// would stop heartbeating, read as down, and have its lock stolen while
		// alive with open Partition handles. A missed window costs one sweep.
		$now      = 1893542400.0;
		$lock_dir = "{$this->tmp}/logs/jobintake.p0/write.lock.d";
		\mkdir( $lock_dir, 0755, true );
		\file_put_contents( "{$lock_dir}/heartbeat", (string) \getmypid() );

		$started = \microtime( true );
		$result  = Fleet_Sweep::enqueue( $now );
		$elapsed = \microtime( true ) - $started;

		$this->assertFalse( $result, 'a contended intake yields the window' );
		$this->assertLessThan( 2.0, $elapsed, 'the drain loop must never block on the intake write lock' );
	}

	public function test_a_later_window_enqueues_again(): void {
		$now = 1893456000.0;
		Fleet_Sweep::enqueue( $now );

		$this->assertTrue(
			Fleet_Sweep::enqueue( $now + Fleet_Sweep::INTERVAL_S ),
			'housekeeping must resume on the next window'
		);
	}

	public function test_the_sweep_is_never_scheduled_for_later(): void {
		// Job_Delay's sweep is IN the sweep. A delayed sweep would depend on
		// the very machinery it exists to drive.
		Fleet_Sweep::enqueue( 1893456000.0 );

		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_glob
		$delayed = \glob( "{$this->tmp}/logs/jobdelay.p0/*" ) ?: [];
		$this->assertSame( [], $delayed, 'the sweep must land in jobs.log, never jobdelay' );
	}

	// ── the sweep body ─────────────────────────────────────────────────────

	public function test_run_fires_the_periodic_hook(): void {
		$fired = 0;
		\add_action( 'newspack_nodes/periodic', static function () use ( &$fired ): void {
			++$fired;
		} );

		Fleet_Sweep::run( [] );

		$this->assertSame( 1, $fired );
	}

	public function test_run_flags_a_lock_dir_past_the_active_partition_count(): void {
		// Operator shrank ledger-workers from 4 partitions to 2: p3 must retire.
		$this->with_topology( [
			'ledger-workers' => [ 'num_partitions' => 2, 'topology' => '/ledger.php' ],
		] );
		$this->make_lock( 'ledger-workers.p1' );
		$this->make_lock( 'ledger-workers.p3' );

		Fleet_Sweep::run( [] );

		$this->assertFileDoesNotExist( "{$this->tmp}/locks/ledger-workers.p1.lock.d/restart", 'an in-fleet partition is left alone' );
		$this->assertFileExists( "{$this->tmp}/locks/ledger-workers.p3.lock.d/restart", 'a partition past the count must retire' );
	}

	public function test_run_removes_an_orphan_ipc_dir(): void {
		$this->with_topology( [
			'ledger-workers' => [ 'num_partitions' => 1, 'topology' => '/ledger.php' ],
		] );
		\mkdir( "{$this->tmp}/ipc/ledger-workers.p0/input", 0755, true );
		\mkdir( "{$this->tmp}/ipc/retired-workers.p7/input", 0755, true );

		Fleet_Sweep::run( [] );

		$this->assertDirectoryExists( "{$this->tmp}/ipc/ledger-workers.p0", 'an active worker keeps its ipc dir' );
		$this->assertDirectoryDoesNotExist( "{$this->tmp}/ipc/retired-workers.p7", 'an orphan ipc dir is reaped' );
	}

	// ── hostile input ──────────────────────────────────────────────────────

	public function test_a_throwing_periodic_subscriber_does_not_abort_the_sweep(): void {
		// Third-party code: pyrobase and nuclear-gyrobase both subscribe. One
		// bad subscriber must not stop retention or ipc reaping for everyone,
		// nor burn the job's retries until housekeeping dead-letters.
		$this->with_topology( [
			'ledger-workers' => [ 'num_partitions' => 1, 'topology' => '/ledger.php' ],
		] );
		\mkdir( "{$this->tmp}/ipc/retired-workers.p7", 0755, true );
		\add_action( 'newspack_nodes/periodic', static function (): void {
			throw new \RuntimeException( 'a periodic subscriber exploded' );
		} );

		Fleet_Sweep::run( [] );

		$this->assertDirectoryDoesNotExist( "{$this->tmp}/ipc/retired-workers.p7" );
	}

	// ── ADR-14: a cooperative stop is not an error ─────────────────────────

	public function test_a_cooperative_stop_from_a_periodic_subscriber_escapes_the_sweep(): void {
		// A subscriber writing to a Partition raises this from pump(). Reported
		// as a step failure instead of re-thrown, the worker keeps draining past
		// its max_runtime / restart / memory stop — the exact hole ADR-14 exists
		// for. Distinct from the plain-Throwable case above, which IS reported.
		\add_action( 'newspack_nodes/periodic', static function (): void {
			throw new \Newspack_Nodes\Worker_Should_Stop( 'drain over' );
		} );

		$this->expectException( \Newspack_Nodes\Worker_Should_Stop::class );
		Fleet_Sweep::run( [] );
	}

	public function test_a_cooperative_stop_from_the_intake_write_escapes_the_enqueue(): void {
		// enqueue() runs inside the drain loop and writes to jobintake.p0, whose
		// fill() pumps: a stop signalled there must unwind to Worker_Base, not
		// be reported as "sweep not enqueued" and swallowed.
		\Newspack_Nodes\Event_Framework::reset();
		// The intake Partition arms a 0ms flush timer that router-hitchhikes,
		// as it does in every worker graph.
		( new \Newspack_Nodes\Router_Node() )->name( \Newspack_Nodes\Node_Names::ROUTER );
		$ef    = \Newspack_Nodes\Event_Framework::instance();
		$state = (object) [ 'stop' => false, 'ticks' => 0 ];
		$timer = new class extends \Newspack_Nodes\Timer_Node {
			/** @var callable */
			public $on_fire;
			public function fire_cb(): void {
				( $this->on_fire )();
			}
		};
		$timer->on_fire = static function () use ( $state ): void {
			$state->stop = true; // The worker should now stop.
			Fleet_Sweep::enqueue( 1893628800.0 );
		};
		$timer->set_timer( 1, true );

		$this->expectException( \Newspack_Nodes\Worker_Should_Stop::class );
		$ef->drain(
			static function () use ( $state ): bool {
				Core::$now = \microtime( true );
				return ! $state->stop && ++$state->ticks < 1000;
			},
			cooperative_stop: true
		);
	}

	public function test_run_survives_a_throwing_topology_provider(): void {
		\add_filter( 'newspack_nodes/topologies', static function (): array {
			throw new \RuntimeException( 'a topology provider exploded' );
		} );

		Fleet_Sweep::run( [] );

		$this->assertTrue( true, 'the sweep reports and returns rather than dead-lettering' );
	}

	public function test_a_host_with_no_claim_store_reports_instead_of_throwing(): void {
		// `unique` needs memcached or APCu; `claim_unique()` throws without one.
		// Revival may never depend on housekeeping, so the enqueue swallows it.
		Core::$memd                                 = null;
		\Newspack_Nodes\Cache_Backend::$apcu_usable = static fn (): bool => false;
		$seen                                       = [];
		Core::set_stderr_handler( static function ( string $line ) use ( &$seen ): void {
			$seen[] = $line;
		} );

		$this->assertFalse( Fleet_Sweep::enqueue( 1893456000.0 ) );
		$this->assertNotEmpty(
			\array_filter( $seen, static fn( $l ) => \str_contains( $l, 'fleet sweep not enqueued: ' ) ),
			'a claim-store outage must be reported, not silently dropped'
		);
	}

	// ── reconcile: what the sweep must NOT touch ───────────────────────────

	public function test_run_leaves_a_non_partitioned_lock_dir_alone(): void {
		// Anything without a `.p<N>` suffix is not a worker, so the sweep has
		// no partition count to judge it by and must not retire it.
		$this->with_topology( [
			'ledger-workers' => [ 'num_partitions' => 1, 'topology' => '/ledger.php' ],
		] );
		$this->make_lock( 'ledger-workers.p0' );
		\mkdir( "{$this->tmp}/locks/rotate.lock.d", 0755, true );

		Fleet_Sweep::run( [] );

		$this->assertDirectoryExists( "{$this->tmp}/locks/rotate.lock.d" );
		$this->assertFileDoesNotExist( "{$this->tmp}/locks/rotate.lock.d/restart" );
	}

	public function test_run_spares_an_orphan_ipc_dir_whose_worker_still_holds_a_lock(): void {
		// A worker mid-recycle is out of the active set but still flushing
		// through its IPC dir; its own lock is what defers the reap.
		$this->with_topology( [
			'ledger-workers' => [ 'num_partitions' => 1, 'topology' => '/ledger.php' ],
		] );
		\mkdir( "{$this->tmp}/ipc/retired-workers.p7/input", 0755, true );
		$this->make_lock( 'retired-workers.p7' );

		Fleet_Sweep::run( [] );

		$this->assertDirectoryExists( "{$this->tmp}/ipc/retired-workers.p7" );
	}

	// ── steal-scratch reaping ──────────────────────────────────────────────

	public function test_run_reaps_a_steal_scratch_dir_left_by_a_killed_takeover(): void {
		// Lock_Node's atomic steal renames the dir aside and removes it two
		// syscalls later; a process killed in that window leaks the scratch and
		// nothing else reaps it.
		$this->with_topology( [
			'ledger-workers' => [ 'num_partitions' => 1, 'topology' => '/ledger.php' ],
		] );
		$this->make_lock( 'ledger-workers.p0' );
		$leaked = "{$this->tmp}/locks/ledger-workers.p0.lock.d.stealing.12345.deadbeef";
		\mkdir( $leaked, 0755, true );
		\file_put_contents( "{$leaked}/heartbeat", '12345' );
		\touch( $leaked, \time() - ( \Newspack_Nodes\Lock_Node::STALE_TIMEOUT + 5 ) );

		Fleet_Sweep::run( [] );

		$this->assertDirectoryDoesNotExist( $leaked );
	}

	public function test_run_spares_a_steal_scratch_dir_from_an_in_flight_takeover(): void {
		// Younger than STALE_TIMEOUT means another process may be mid-steal
		// right now — reaping it would pull the lock out from under a live one.
		$this->with_topology( [
			'ledger-workers' => [ 'num_partitions' => 1, 'topology' => '/ledger.php' ],
		] );
		$this->make_lock( 'ledger-workers.p0' );
		$fresh = "{$this->tmp}/locks/ledger-workers.p0.lock.d.stealing.999.cafe";
		\mkdir( $fresh, 0755, true );

		Fleet_Sweep::run( [] );

		$this->assertDirectoryExists( $fresh );
	}
}
