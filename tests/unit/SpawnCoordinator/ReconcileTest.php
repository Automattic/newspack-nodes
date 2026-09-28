<?php
namespace Newspack_Nodes\Tests\Unit\SpawnCoordinator;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Lock_Node;
use Newspack_Nodes\Spawn_Coordinator;
use Newspack_Nodes\Tests\TestCase;

/**
 * The lock-dir and ipc janitorial passes. Both are lock lifecycle, so they live
 * beside the staleness rules and the contained-delete helper they consume.
 */
#[CoversClass( Spawn_Coordinator::class )]
class ReconcileTest extends TestCase {
	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		$this->tmp = $this->make_temp_dir();
		$this->use_base_dir( $this->tmp );
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'ledger-workers' ];
		\Newspack_Nodes\Config::reset();
	}

	protected function tearDown(): void {
		$this->rmdir_recursive( $this->tmp );
		unset( $GLOBALS['_wp_options']['newspack_nodes_topologies'] );
		\Newspack_Nodes\Config::reset();
		parent::tearDown();
	}

	private function with_topology( array $topologies ): void {
		\add_filter( 'newspack_nodes/topologies', static fn() => $topologies );
	}

	private function ledger( int $partitions ): void {
		$this->with_topology( [
			'ledger-workers' => [ 'num_partitions' => $partitions, 'topology' => '/ledger.php' ],
		] );
	}

	private function make_lock( string $name ): void {
		\mkdir( "{$this->tmp}/locks/{$name}.lock.d", 0755, true );
		\touch( "{$this->tmp}/locks/{$name}.lock.d/heartbeat" );
	}

	private function coordinator(): Spawn_Coordinator {
		return new Spawn_Coordinator( $this->tmp );
	}

	// ── lock-dir reconcile ─────────────────────────────────────────────────

	public function test_it_flags_a_lock_dir_past_the_active_partition_count(): void {
		// Operator shrank ledger-workers from 4 partitions to 2: p3 must retire.
		$this->ledger( 2 );
		$this->make_lock( 'ledger-workers.p1' );
		$this->make_lock( 'ledger-workers.p3' );

		$this->coordinator()->reconcile_lock_dirs();

		$this->assertFileDoesNotExist( "{$this->tmp}/locks/ledger-workers.p1.lock.d/restart", 'an in-fleet partition is left alone' );
		$this->assertFileExists( "{$this->tmp}/locks/ledger-workers.p3.lock.d/restart", 'a partition past the count must retire' );
	}

	public function test_a_refused_retire_flag_spares_the_other_surplus_dirs_and_escapes(): void {
		$this->ledger( 1 );
		$this->make_lock( 'ledger-workers.p2' );
		$this->make_lock( 'ledger-workers.p5' );
		\chmod( "{$this->tmp}/locks/ledger-workers.p2.lock.d", 0555 );

		try {
			$e = $this->caught(
				fn () => $this->coordinator()->reconcile_lock_dirs(),
				'a refused retire flag must escape'
			);
			$this->assertStringContainsString( 'ledger-workers.p2.lock.d', $e->getMessage() );
		} finally {
			\chmod( "{$this->tmp}/locks/ledger-workers.p2.lock.d", 0755 );
		}

		$this->assertFileExists( "{$this->tmp}/locks/ledger-workers.p5.lock.d/restart" );
	}

	public function test_it_leaves_a_non_partitioned_lock_dir_alone(): void {
		// Anything without a `.p<N>` suffix is not a worker, so there is no
		// partition count to judge it by and it must not be retired.
		$this->ledger( 1 );
		$this->make_lock( 'ledger-workers.p0' );
		\mkdir( "{$this->tmp}/locks/rotate.lock.d", 0755, true );

		$this->coordinator()->reconcile_lock_dirs();

		$this->assertDirectoryExists( "{$this->tmp}/locks/rotate.lock.d" );
		$this->assertFileDoesNotExist( "{$this->tmp}/locks/rotate.lock.d/restart" );
	}

	public function test_an_unknown_fleet_reconciles_nothing(): void {
		// With no active set every dir would read as an orphan.
		$this->with_topology( [] );
		$this->make_lock( 'ledger-workers.p9' );

		$this->coordinator()->reconcile_lock_dirs();

		$this->assertFileDoesNotExist( "{$this->tmp}/locks/ledger-workers.p9.lock.d/restart" );
	}

	// ── steal-scratch reaping ──────────────────────────────────────────────

	public function test_it_reaps_a_steal_scratch_dir_left_by_a_killed_takeover(): void {
		// Lock_Node's atomic steal renames the dir aside and removes it two
		// syscalls later; a process killed in that window leaks the scratch and
		// nothing else reaps it.
		$this->ledger( 1 );
		$this->make_lock( 'ledger-workers.p0' );
		$leaked = "{$this->tmp}/locks/ledger-workers.p0.lock.d.stealing.12345.deadbeef";
		\mkdir( $leaked, 0755, true );
		\file_put_contents( "{$leaked}/heartbeat", '12345' );
		\touch( $leaked, \time() - ( Lock_Node::STALE_TIMEOUT + 5 ) );

		$this->coordinator()->reconcile_lock_dirs();

		$this->assertDirectoryDoesNotExist( $leaked );
	}

	public function test_it_spares_a_steal_scratch_dir_from_an_in_flight_takeover(): void {
		// Younger than STALE_TIMEOUT means another process may be mid-steal right
		// now — reaping it would pull the lock out from under a live one.
		$this->ledger( 1 );
		$this->make_lock( 'ledger-workers.p0' );
		$fresh = "{$this->tmp}/locks/ledger-workers.p0.lock.d.stealing.999.cafe";
		\mkdir( $fresh, 0755, true );

		$this->coordinator()->reconcile_lock_dirs();

		$this->assertDirectoryExists( $fresh );
	}

	public function test_the_lock_layout_hangs_off_the_base_dir(): void {
		$this->assertSame( "{$this->tmp}/locks", Spawn_Coordinator::locks_dir( "{$this->tmp}/" ) );
		$this->assertSame(
			"{$this->tmp}/locks/kea-7713.p3.lock.d",
			Spawn_Coordinator::lock_path( "{$this->tmp}/", 'kea-7713', 3 )
		);
	}

	public function test_worker_lock_dirs_reads_the_worker_id_grammar(): void {
		foreach ( [ 'foo.bar.p41', 'kea-7713.p07', 'kea.pX' ] as $name ) {
			$this->make_lock( $name );
		}

		$this->assertSame(
			[ "{$this->tmp}/locks/foo.bar.p41.lock.d" => [ 'id' => 'foo.bar.p41', 'type' => 'foo.bar', 'partition' => 41 ] ],
			Spawn_Coordinator::worker_lock_dirs( $this->tmp )
		);
	}

	/** A lock is a directory; a file named like one is no worker's lock. */
	public function test_worker_lock_dirs_lists_directories_only(): void {
		$this->make_lock( 'kea-7713.p3' );
		\touch( "{$this->tmp}/locks/foo.bar.p41.lock.d" );

		$this->assertSame(
			[ "{$this->tmp}/locks/kea-7713.p3.lock.d" ],
			\array_keys( Spawn_Coordinator::worker_lock_dirs( $this->tmp ) )
		);
	}

	// ── orphan ipc ─────────────────────────────────────────────────────────

	public function test_it_removes_an_orphan_ipc_dir(): void {
		$this->ledger( 1 );
		\mkdir( "{$this->tmp}/ipc/ledger-workers.p0/input", 0755, true );
		\mkdir( "{$this->tmp}/ipc/retired-workers.p7/input", 0755, true );

		$this->coordinator()->cleanup_orphan_ipc();

		$this->assertDirectoryExists( "{$this->tmp}/ipc/ledger-workers.p0", 'an active worker keeps its ipc dir' );
		$this->assertDirectoryDoesNotExist( "{$this->tmp}/ipc/retired-workers.p7", 'an orphan ipc dir is reaped' );
	}

	public function test_it_spares_an_orphan_ipc_dir_whose_worker_still_holds_a_lock(): void {
		// A worker mid-recycle is out of the active set but still flushing
		// through its IPC dir; its own lock is what defers the reap.
		$this->ledger( 1 );
		\mkdir( "{$this->tmp}/ipc/retired-workers.p7/input", 0755, true );
		$this->make_lock( 'retired-workers.p7' );

		$this->coordinator()->cleanup_orphan_ipc();

		$this->assertDirectoryExists( "{$this->tmp}/ipc/retired-workers.p7" );
	}

	public function test_it_reaps_an_orphan_ipc_dir_of_a_dotted_type(): void {
		$this->ledger( 1 );
		\mkdir( "{$this->tmp}/ipc/foo.bar.p41/input", 0755, true );

		$this->coordinator()->cleanup_orphan_ipc();

		$this->assertDirectoryDoesNotExist( "{$this->tmp}/ipc/foo.bar.p41" );
	}

	/** An ipc dir no `worker_id()` spells is not a worker's, and is not reaped. */
	public function test_it_leaves_an_ipc_dir_no_worker_id_spells(): void {
		$this->ledger( 1 );
		\mkdir( "{$this->tmp}/ipc/kea-7713.p07/input", 0755, true );
		\mkdir( "{$this->tmp}/ipc/kea.pX/input", 0755, true );

		$this->coordinator()->cleanup_orphan_ipc();

		$this->assertDirectoryExists( "{$this->tmp}/ipc/kea-7713.p07" );
		$this->assertDirectoryExists( "{$this->tmp}/ipc/kea.pX" );
	}
}
