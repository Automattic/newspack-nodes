<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\SupervisorBase;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( SupervisorBase::class )]
class SupervisorBaseTest extends TestCase {
	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		$this->tmp                            = $this->make_temp_dir();
		$GLOBALS['_wp_test_transients']       = [];
	}

	protected function tearDown(): void {
		$this->rmdir_recursive( $this->tmp );
		$GLOBALS['_wp_test_transients'] = [];
		parent::tearDown();
	}

	// ── worker_needs_spawn ────────────────────────────────────────────────

	public function test_worker_needs_spawn_when_no_lock(): void {
		$s      = new SupervisorBase( $this->tmp );
		$worker = [ 'type' => 'foo', 'partition' => 0, 'stale_timeout' => 60 ];
		$this->assertTrue( $s->worker_needs_spawn( $worker, microtime( true ) ) );
	}

	public function test_worker_does_not_need_spawn_when_lock_fresh(): void {
		$s = new SupervisorBase( $this->tmp );
		mkdir( "{$this->tmp}/locks/foo.p0.lock.d", 0755, true );
		touch( "{$this->tmp}/locks/foo.p0.lock.d/heartbeat" );
		$worker = [ 'type' => 'foo', 'partition' => 0, 'stale_timeout' => 60 ];
		$this->assertFalse( $s->worker_needs_spawn( $worker, microtime( true ) ) );
	}

	public function test_worker_needs_spawn_when_heartbeat_stale(): void {
		$s = new SupervisorBase( $this->tmp );
		mkdir( "{$this->tmp}/locks/foo.p0.lock.d", 0755, true );
		touch( "{$this->tmp}/locks/foo.p0.lock.d/heartbeat", time() - 3600 );
		$worker = [ 'type' => 'foo', 'partition' => 0, 'stale_timeout' => 60 ];
		$this->assertTrue( $s->worker_needs_spawn( $worker, microtime( true ) ) );
	}

	// ── is_recently_spawned ───────────────────────────────────────────────

	public function test_spawn_rate_limit_skips_recent_spawns(): void {
		$s   = new SupervisorBase( $this->tmp );
		$now = microtime( true );
		$s->record_spawn( 'foo', 0, $now - 5 );
		$this->assertTrue( $s->is_recently_spawned( 'foo', 0, $now ) );
		$this->assertFalse( $s->is_recently_spawned( 'foo', 0, $now + 20 ) );
	}

	public function test_record_spawn_persists_across_supervisor_instances(): void {
		// Simulates a supervisor process exit + restart (cron backstop or
		// self-respawn). The new instance must see the recent spawn so it
		// honors the 15s rate limit instead of re-spawning the same worker.
		$now = microtime( true );

		$first = new SupervisorBase( $this->tmp );
		$first->record_spawn( 'firehose-workers', 0, $now );

		// Fresh instance — empty in-memory map; relies on persistence.
		$second = new SupervisorBase( $this->tmp );
		$this->assertTrue(
			$second->is_recently_spawned( 'firehose-workers', 0, $now + 5 ),
			'cross-instance persistence must be honored'
		);
		$this->assertFalse(
			$second->is_recently_spawned( 'firehose-workers', 0, $now + 30 ),
			'beyond MIN_SPAWN_INTERVAL_S the rate limit must lapse'
		);
	}

	public function test_is_recently_spawned_returns_false_when_never_spawned(): void {
		$s = new SupervisorBase( $this->tmp );
		$this->assertFalse( $s->is_recently_spawned( 'never-seen', 0, microtime( true ) ) );
	}

	// ── delete_directory_recursive containment guard ─────────────────────

	public function test_delete_directory_recursive_removes_contained_tree(): void {
		$inside = "{$this->tmp}/data/p0";
		mkdir( $inside, 0755, true );
		file_put_contents( "{$inside}/a.log", 'hello' );
		mkdir( "{$inside}/sub" );
		file_put_contents( "{$inside}/sub/b.log", 'world' );

		SupervisorBase::delete_directory_recursive( $inside, $this->tmp );

		$this->assertFalse( is_dir( $inside ), 'inner tree must be removed' );
		$this->assertTrue( is_dir( "{$this->tmp}/data" ), 'parent must remain' );
	}

	public function test_delete_directory_recursive_refuses_outside_base(): void {
		// Build a sibling tree alongside the base to verify path-containment.
		$sibling = $this->make_temp_dir( 'siblling-' );
		file_put_contents( "{$sibling}/keep.log", 'survive' );

		SupervisorBase::delete_directory_recursive( $sibling, $this->tmp );

		$this->assertTrue( is_dir( $sibling ), 'sibling tree must NOT be deleted' );
		$this->assertTrue( is_file( "{$sibling}/keep.log" ) );

		$this->rmdir_recursive( $sibling );
	}

	public function test_delete_directory_recursive_refuses_parent_traversal(): void {
		// Attempt to delete a parent via .. traversal — must be refused by
		// realpath-based containment check.
		$inside = "{$this->tmp}/data";
		mkdir( $inside, 0755, true );
		file_put_contents( "{$inside}/safe.log", 'guard' );

		SupervisorBase::delete_directory_recursive( "{$this->tmp}/data/..", $this->tmp );

		$this->assertTrue( is_dir( $this->tmp ), 'base must remain' );
		$this->assertTrue( is_file( "{$inside}/safe.log" ) );
	}

	public function test_delete_directory_recursive_skips_missing_path(): void {
		// Should be a no-op if the candidate doesn't exist — not an error.
		SupervisorBase::delete_directory_recursive( "{$this->tmp}/nope", $this->tmp );
		$this->assertTrue( is_dir( $this->tmp ) );
	}

	public function test_delete_directory_recursive_respects_max_depth(): void {
		// Build a deep tree well past the requested cap; verify the cap is
		// honored by checking that depth-cap+1 directory survives.
		$base  = "{$this->tmp}/d";
		$cap   = 2;
		mkdir( "{$base}/l1/l2/l3/l4", 0755, true );
		file_put_contents( "{$base}/l1/l2/l3/l4/leaf.log", 'leaf' );

		SupervisorBase::delete_directory_recursive( $base, $this->tmp, $cap );

		// At depth 2 the recursion must stop — the dir at depth 2 is not
		// recursed into, so the leaf survives.
		$this->assertTrue( is_file( "{$base}/l1/l2/l3/l4/leaf.log" ) );
	}

	public function test_delete_directory_recursive_skips_symlinks(): void {
		if ( ! function_exists( 'symlink' ) ) {
			$this->markTestSkipped( 'symlink() unavailable in this environment' );
		}
		// Create a target outside the base and a symlink inside the tree
		// pointing at it. Containment must refuse to follow the link.
		$outside = $this->make_temp_dir( 'outside-' );
		file_put_contents( "{$outside}/protected.log", 'survive' );

		mkdir( "{$this->tmp}/data", 0755, true );
		@symlink( $outside, "{$this->tmp}/data/link" );

		SupervisorBase::delete_directory_recursive( "{$this->tmp}/data", $this->tmp );

		$this->assertTrue( is_dir( $outside ), 'symlinked target must survive' );
		$this->assertTrue( is_file( "{$outside}/protected.log" ) );

		$this->rmdir_recursive( $outside );
	}

	// ── is_within ─────────────────────────────────────────────────────────

	public function test_is_within_accepts_path_under_base(): void {
		mkdir( "{$this->tmp}/a/b", 0755, true );
		$this->assertTrue( SupervisorBase::is_within( "{$this->tmp}/a/b", $this->tmp ) );
	}

	public function test_is_within_accepts_base_itself(): void {
		$this->assertTrue( SupervisorBase::is_within( $this->tmp, $this->tmp ) );
	}

	public function test_is_within_rejects_sibling(): void {
		$other = $this->make_temp_dir( 'other-' );
		$this->assertFalse( SupervisorBase::is_within( $other, $this->tmp ) );
		$this->rmdir_recursive( $other );
	}

	public function test_is_within_rejects_unresolvable_path(): void {
		$this->assertFalse( SupervisorBase::is_within( '/nonexistent/path', $this->tmp ) );
	}

	// ── remove_stale_directory threshold ──────────────────────────────────

	public function test_remove_stale_directory_removes_old_dir(): void {
		$dir = "{$this->tmp}/old-partition";
		mkdir( $dir, 0755, true );
		file_put_contents( "{$dir}/file.log", 'stale' );
		// Backdate file mtime well past the threshold.
		touch( "{$dir}/file.log", time() - 7200 );

		$s = new SupervisorBase( $this->tmp );
		$s->remove_stale_directory( $dir, 3600 );

		$this->assertFalse( is_dir( $dir ), 'stale dir must be removed' );
	}

	public function test_remove_stale_directory_keeps_fresh_dir(): void {
		$dir = "{$this->tmp}/fresh-partition";
		mkdir( $dir, 0755, true );
		file_put_contents( "{$dir}/file.log", 'recent' );
		// Default mtime — recent.

		$s = new SupervisorBase( $this->tmp );
		$s->remove_stale_directory( $dir, 3600 );

		$this->assertTrue( is_dir( $dir ), 'fresh dir must NOT be removed' );
	}

	public function test_remove_stale_directory_no_op_when_missing(): void {
		$s = new SupervisorBase( $this->tmp );
		$s->remove_stale_directory( "{$this->tmp}/no-such-dir", 3600 );
		// No exception, no side effect.
		$this->assertTrue( is_dir( $this->tmp ) );
	}

	public function test_remove_stale_directory_skips_empty_dir(): void {
		// Empty dir → newest_mtime stays 0 → no removal (we only delete
		// dirs we can confirm are stale; empty dirs are ambiguous).
		$dir = "{$this->tmp}/empty";
		mkdir( $dir );

		$s = new SupervisorBase( $this->tmp );
		$s->remove_stale_directory( $dir, 3600 );

		$this->assertTrue( is_dir( $dir ) );
	}

	public function test_remove_stale_directory_skips_symlink_top_level(): void {
		if ( ! function_exists( 'symlink' ) ) {
			$this->markTestSkipped( 'symlink() unavailable in this environment' );
		}
		$target = $this->make_temp_dir( 'symlink-target-' );
		file_put_contents( "{$target}/file.log", 'stale' );
		touch( "{$target}/file.log", time() - 7200 );

		$link = "{$this->tmp}/link";
		@symlink( $target, $link );

		$s = new SupervisorBase( $this->tmp );
		$s->remove_stale_directory( $link, 3600 );

		$this->assertTrue( is_dir( $target ), 'symlink target must survive' );

		@unlink( $link );
		$this->rmdir_recursive( $target );
	}

	// ── Constants ─────────────────────────────────────────────────────────

	public function test_constants_match_spec(): void {
		$this->assertSame( 15, SupervisorBase::MIN_SPAWN_INTERVAL_S );
		$this->assertSame( 16, SupervisorBase::MAX_PARTITIONS );
		$this->assertSame( 3600, SupervisorBase::STALE_PARTITION_AGE_S );
	}
}
