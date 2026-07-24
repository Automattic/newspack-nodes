<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Supervisor_Base;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Supervisor_Base::class )]
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
		$s      = new Supervisor_Base( $this->tmp );
		$worker = [ 'type' => 'foo', 'partition' => 0, 'stale_timeout' => 60 ];
		$this->assertTrue( $s->worker_needs_spawn( $worker, microtime( true ) ) );
	}

	public function test_worker_does_not_need_spawn_when_lock_fresh(): void {
		$s = new Supervisor_Base( $this->tmp );
		mkdir( "{$this->tmp}/locks/foo.p0.lock.d", 0755, true );
		touch( "{$this->tmp}/locks/foo.p0.lock.d/heartbeat" );
		$worker = [ 'type' => 'foo', 'partition' => 0, 'stale_timeout' => 60 ];
		$this->assertFalse( $s->worker_needs_spawn( $worker, microtime( true ) ) );
	}

	public function test_worker_needs_spawn_when_heartbeat_stale(): void {
		$s = new Supervisor_Base( $this->tmp );
		mkdir( "{$this->tmp}/locks/foo.p0.lock.d", 0755, true );
		touch( "{$this->tmp}/locks/foo.p0.lock.d/heartbeat", time() - 3600 );
		$worker = [ 'type' => 'foo', 'partition' => 0, 'stale_timeout' => 60 ];
		$this->assertTrue( $s->worker_needs_spawn( $worker, microtime( true ) ) );
	}

	// ── is_recently_spawned ───────────────────────────────────────────────

	public function test_spawn_rate_limit_skips_recent_spawns(): void {
		$s   = new Supervisor_Base( $this->tmp );
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

		$first = new Supervisor_Base( $this->tmp );
		$first->record_spawn( 'firehose-workers', 0, $now );

		// Fresh instance — empty in-memory map; relies on persistence.
		$second = new Supervisor_Base( $this->tmp );
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
		$s = new Supervisor_Base( $this->tmp );
		$this->assertFalse( $s->is_recently_spawned( 'never-seen', 0, microtime( true ) ) );
	}

	// ── delete_directory_recursive containment guard ─────────────────────

	public function test_delete_directory_recursive_removes_contained_tree(): void {
		$inside = "{$this->tmp}/data/p0";
		mkdir( $inside, 0755, true );
		file_put_contents( "{$inside}/a.log", 'hello' );
		mkdir( "{$inside}/sub" );
		file_put_contents( "{$inside}/sub/b.log", 'world' );

		Supervisor_Base::delete_directory_recursive( $inside, $this->tmp );

		$this->assertFalse( is_dir( $inside ), 'inner tree must be removed' );
		$this->assertTrue( is_dir( "{$this->tmp}/data" ), 'parent must remain' );
	}

	public function test_delete_directory_recursive_refuses_outside_base(): void {
		// Build a sibling tree alongside the base to verify path-containment.
		$sibling = $this->make_temp_dir( 'siblling-' );
		file_put_contents( "{$sibling}/keep.log", 'survive' );

		Supervisor_Base::delete_directory_recursive( $sibling, $this->tmp );

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

		Supervisor_Base::delete_directory_recursive( "{$this->tmp}/data/..", $this->tmp );

		$this->assertTrue( is_dir( $this->tmp ), 'base must remain' );
		$this->assertTrue( is_file( "{$inside}/safe.log" ) );
	}

	public function test_delete_directory_recursive_skips_missing_path(): void {
		// Should be a no-op if the candidate doesn't exist — not an error.
		Supervisor_Base::delete_directory_recursive( "{$this->tmp}/nope", $this->tmp );
		$this->assertTrue( is_dir( $this->tmp ) );
	}

	public function test_delete_directory_recursive_respects_max_depth(): void {
		// Build a deep tree well past the requested cap; verify the cap is
		// honored by checking that depth-cap+1 directory survives.
		$base  = "{$this->tmp}/d";
		$cap   = 2;
		mkdir( "{$base}/l1/l2/l3/l4", 0755, true );
		file_put_contents( "{$base}/l1/l2/l3/l4/leaf.log", 'leaf' );

		Supervisor_Base::delete_directory_recursive( $base, $this->tmp, $cap );

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

		Supervisor_Base::delete_directory_recursive( "{$this->tmp}/data", $this->tmp );

		$this->assertTrue( is_dir( $outside ), 'symlinked target must survive' );
		$this->assertTrue( is_file( "{$outside}/protected.log" ) );

		$this->rmdir_recursive( $outside );
	}

	// ── is_within ─────────────────────────────────────────────────────────

	public function test_is_within_accepts_path_under_base(): void {
		mkdir( "{$this->tmp}/a/b", 0755, true );
		$this->assertTrue( Supervisor_Base::is_within( "{$this->tmp}/a/b", $this->tmp ) );
	}

	public function test_is_within_accepts_base_itself(): void {
		$this->assertTrue( Supervisor_Base::is_within( $this->tmp, $this->tmp ) );
	}

	public function test_is_within_rejects_sibling(): void {
		$other = $this->make_temp_dir( 'other-' );
		$this->assertFalse( Supervisor_Base::is_within( $other, $this->tmp ) );
		$this->rmdir_recursive( $other );
	}

	public function test_is_within_rejects_unresolvable_path(): void {
		$this->assertFalse( Supervisor_Base::is_within( '/nonexistent/path', $this->tmp ) );
	}

	// ── remove_stale_directory threshold ──────────────────────────────────

	public function test_remove_stale_directory_removes_old_dir(): void {
		$dir = "{$this->tmp}/old-partition";
		mkdir( $dir, 0755, true );
		file_put_contents( "{$dir}/file.log", 'stale' );
		// Backdate file mtime well past the threshold.
		touch( "{$dir}/file.log", time() - 7200 );

		$s = new Supervisor_Base( $this->tmp );
		$s->remove_stale_directory( $dir, 3600 );

		$this->assertFalse( is_dir( $dir ), 'stale dir must be removed' );
	}

	public function test_remove_stale_directory_keeps_fresh_dir(): void {
		$dir = "{$this->tmp}/fresh-partition";
		mkdir( $dir, 0755, true );
		file_put_contents( "{$dir}/file.log", 'recent' );
		// Default mtime — recent.

		$s = new Supervisor_Base( $this->tmp );
		$s->remove_stale_directory( $dir, 3600 );

		$this->assertTrue( is_dir( $dir ), 'fresh dir must NOT be removed' );
	}

	public function test_remove_stale_directory_no_op_when_missing(): void {
		$s = new Supervisor_Base( $this->tmp );
		$s->remove_stale_directory( "{$this->tmp}/no-such-dir", 3600 );
		// No exception, no side effect.
		$this->assertTrue( is_dir( $this->tmp ) );
	}

	public function test_remove_stale_directory_skips_empty_dir(): void {
		// Empty dir → newest_mtime stays 0 → no removal (we only delete
		// dirs we can confirm are stale; empty dirs are ambiguous).
		$dir = "{$this->tmp}/empty";
		mkdir( $dir );

		$s = new Supervisor_Base( $this->tmp );
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

		$s = new Supervisor_Base( $this->tmp );
		$s->remove_stale_directory( $link, 3600 );

		$this->assertTrue( is_dir( $target ), 'symlink target must survive' );

		@unlink( $link );
		$this->rmdir_recursive( $target );
	}

	// ── Constants ─────────────────────────────────────────────────────────

	public function test_constants_match_spec(): void {
		$this->assertSame( 15, Supervisor_Base::MIN_SPAWN_INTERVAL_S );
		$this->assertSame( 16, Supervisor_Base::MAX_PARTITIONS );
	}

	// ── worker_needs_spawn: heartbeat-missing-but-dir-exists ─────────────

	/**
	 * A lock dir can exist transiently without a heartbeat file (mid-acquire,
	 * or after force_release that left the dir but cleaned the heartbeat).
	 * Supervisor must treat this as "needs spawn" — the worker is not running.
	 *
	 * This is distinct from "no lock dir" (test_worker_needs_spawn_when_no_lock)
	 * and "stale heartbeat" (test_worker_needs_spawn_when_heartbeat_stale).
	 */
	public function test_worker_needs_spawn_when_heartbeat_file_missing(): void {
		$s = new Supervisor_Base( $this->tmp );
		// Lock dir exists but heartbeat file is absent.
		mkdir( "{$this->tmp}/locks/foo.p0.lock.d", 0755, true );

		$worker = [ 'type' => 'foo', 'partition' => 0, 'stale_timeout' => 60 ];
		$this->assertTrue(
			$s->worker_needs_spawn( $worker, microtime( true ) ),
			'missing heartbeat file in existing dir must trigger spawn'
		);
	}

	/**
	 * worker_needs_spawn must default the stale_timeout to Lock::STALE_TIMEOUT
	 * when the worker descriptor omits it. Verifies the ?? fallback.
	 */
	public function test_worker_needs_spawn_uses_default_stale_timeout(): void {
		$s = new Supervisor_Base( $this->tmp );
		mkdir( "{$this->tmp}/locks/foo.p0.lock.d", 0755, true );
		// Heartbeat older than default Lock::STALE_TIMEOUT (60s) but younger
		// than 90s — this asserts the default is in fact ~60.
		touch( "{$this->tmp}/locks/foo.p0.lock.d/heartbeat", time() - 75 );

		$worker = [ 'type' => 'foo', 'partition' => 0 ]; // no stale_timeout key
		$this->assertTrue(
			$s->worker_needs_spawn( $worker, microtime( true ) ),
			'missing stale_timeout must default to Lock::STALE_TIMEOUT (60s)'
		);
	}

	// ── delete_directory_recursive_inner: edge cases ──────────────────────

	/**
	 * delete_directory_recursive must be a no-op when invoked on a regular
	 * file (not a directory). The is_dir check inside the inner helper
	 * gates this. Defends against accidental misuse — a file inside the
	 * base shouldn't be silently unlinked through this API.
	 */
	public function test_delete_directory_recursive_noop_on_regular_file(): void {
		$file = "{$this->tmp}/data/regular.txt";
		mkdir( "{$this->tmp}/data", 0755, true );
		file_put_contents( $file, 'preserve' );

		// Should be a no-op.
		Supervisor_Base::delete_directory_recursive( $file, $this->tmp );

		$this->assertFileExists( $file, 'regular files must NOT be unlinked' );
	}

	/**
	 * When the top-level path itself is a symlink (within base), the inner
	 * helper's is_link guard refuses to follow. The symlink and its target
	 * both survive.
	 */
	public function test_delete_directory_recursive_refuses_symlinked_top_path(): void {
		if ( ! function_exists( 'symlink' ) ) {
			$this->markTestSkipped( 'symlink() unavailable in this environment' );
		}

		$target = "{$this->tmp}/real-target";
		mkdir( $target, 0755, true );
		file_put_contents( "{$target}/preserved.log", 'data' );

		$link = "{$this->tmp}/symlink-to-target";
		@symlink( $target, $link );

		Supervisor_Base::delete_directory_recursive( $link, $this->tmp );

		$this->assertTrue( is_dir( $target ), 'symlink target must survive' );
		$this->assertTrue( is_file( "{$target}/preserved.log" ) );
	}

	// ── remove_stale_directory: child symlinks skipped ────────────────────

	/**
	 * remove_stale_directory's child loop skips symlinks when computing
	 * newest_mtime. A symlinked file inside the dir must not contribute
	 * its target's mtime to the staleness decision.
	 */
	public function test_remove_stale_directory_skips_symlinked_children(): void {
		if ( ! function_exists( 'symlink' ) ) {
			$this->markTestSkipped( 'symlink() unavailable in this environment' );
		}

		$dir = "{$this->tmp}/with-symlink-child";
		mkdir( $dir, 0755, true );

		// One real, OLD file in the dir.
		file_put_contents( "{$dir}/old.log", 'old' );
		touch( "{$dir}/old.log", time() - 7200 );

		// One symlinked file pointing at a FRESH external file. If the loop
		// followed the symlink, it would see a fresh mtime and KEEP the dir.
		// The is_link skip guarantees only the real file's mtime is consulted.
		$external = $this->make_temp_dir( 'sym-target-' );
		file_put_contents( "{$external}/fresh.log", 'now' );
		@symlink( "{$external}/fresh.log", "{$dir}/symlink-to-fresh" );

		$s = new Supervisor_Base( $this->tmp );
		$s->remove_stale_directory( $dir, 3600 );

		// The dir's only "real" file is old → stale → removed despite
		// the fresh-symlinked child.
		$this->assertFalse( is_dir( $dir ), 'symlinked children must not protect a stale dir' );

		// External target must survive (we never followed the link).
		$this->assertTrue( is_file( "{$external}/fresh.log" ) );

		$this->rmdir_recursive( $external );
	}

	// ── persist_spawn_ts / load_spawn_ts: TTL via transient ───────────────

	/**
	 * persist_spawn_ts must use a TTL of 2 * MIN_SPAWN_INTERVAL_S (30s) so
	 * stale entries auto-expire and don't accumulate after retired worker
	 * types. Verifies the TTL computation by checking the transient store.
	 */
	public function test_persist_spawn_ts_writes_with_bounded_ttl(): void {
		$s   = new Supervisor_Base( $this->tmp );
		$now = microtime( true );
		$s->record_spawn( 'firehose-workers', 0, $now );

		$key = Supervisor_Base::SPAWN_TS_CACHE_KEY . 'firehose-workers|0';
		// Bootstrap stores transients as [value, expires_at]. Inspect the raw
		// store to verify expiry was bounded.
		$entry = $GLOBALS['_wp_test_transients'][ $key ] ?? null;
		$this->assertNotNull( $entry, 'spawn ts must be persisted under the cache key' );

		[ $value, $expires_at ] = $entry;
		$ttl = $expires_at - time();
		$this->assertSame( (int) $now, (int) $value );
		// TTL bounded by 2 * MIN_SPAWN_INTERVAL_S = 30. Allow off-by-one for
		// time() roundoff between persist_spawn_ts and our read.
		$this->assertGreaterThanOrEqual( 28, $ttl );
		$this->assertLessThanOrEqual( 30, $ttl );
	}

	/**
	 * load_spawn_ts returns null when no persisted timestamp exists for
	 * the key. is_recently_spawned then returns false (nothing to gate).
	 */
	public function test_load_spawn_ts_returns_null_on_miss(): void {
		// No record_spawn called — no persisted state.
		$s = new Supervisor_Base( $this->tmp );
		$method = new \ReflectionMethod( Supervisor_Base::class, 'load_spawn_ts' );

		$result = $method->invoke( $s, 'never-recorded|0' );
		$this->assertNull( $result, 'load_spawn_ts must return null on miss' );
	}

	/**
	 * load_spawn_ts caches the persisted value into in-memory state on first
	 * read (via is_recently_spawned). Subsequent reads use the in-memory copy.
	 *
	 * This optimization avoids a transient read per tick
	 * after the first. We assert by clearing the transient store and showing
	 * is_recently_spawned still returns true.
	 */
	public function test_is_recently_spawned_caches_persisted_value_after_first_read(): void {
		$now = microtime( true );

		// First instance: persist via record_spawn.
		$first = new Supervisor_Base( $this->tmp );
		$first->record_spawn( 'foo', 0, $now );

		// Second instance: triggers load_spawn_ts internally.
		$second = new Supervisor_Base( $this->tmp );
		$this->assertTrue( $second->is_recently_spawned( 'foo', 0, $now + 5 ) );

		// Clear the transient store. If is_recently_spawned were re-fetching,
		// the next call would return false. The cache means it remembers.
		$GLOBALS['_wp_test_transients'] = [];

		$this->assertTrue(
			$second->is_recently_spawned( 'foo', 0, $now + 6 ),
			'second call must use cached in-memory value, not re-fetch from transient'
		);
	}

	public function test_spawn_ts_persists_to_the_shared_cache_backend(): void {
		// ADR-9 claims memcache-backed spawn throttling; wp_cache_set is
		// non-persistent without an object-cache drop-in. The ts must land in
		// the Cache_Backend (Core::$memd here), not the WP object cache.
		$memd                        = new \Newspack_Nodes\Tests\Helpers\InMemoryMemcached();
		\Newspack_Nodes\Core::$memd = $memd;
		try {
			$s = new Supervisor_Base( $this->tmp );
			$s->record_spawn( 'throttled-type', 3, 1234567.0 );

			$stored = $memd->get( Supervisor_Base::SPAWN_TS_CACHE_KEY . 'throttled-type|3' );
			$this->assertSame( 1234567, $stored, 'spawn ts must land in the shared backend' );

			$fresh = new Supervisor_Base( $this->tmp );
			$this->assertTrue( $fresh->is_recently_spawned( 'throttled-type', 3, 1234567.0 + 7 ) );
			$this->assertFalse( $fresh->is_recently_spawned( 'throttled-type', 3, 1234567.0 + 31 ) );
		} finally {
			\Newspack_Nodes\Core::$memd = null;
		}
	}

}
