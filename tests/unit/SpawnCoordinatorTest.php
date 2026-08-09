<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Cache_Backend;
use Newspack_Nodes\Spawn_Coordinator;
use Newspack_Nodes\Tests\TestCase;

#[CoversClass( Spawn_Coordinator::class )]
class SpawnCoordinatorTest extends TestCase {
	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		$this->tmp                            = $this->make_temp_dir();
		$GLOBALS['_wp_test_transients']       = [];
	}

	protected function tearDown(): void {
		$this->rmdir_recursive( $this->tmp );
		$GLOBALS['_wp_test_transients']   = [];
		$GLOBALS['_test_outbound_posts'] = [];
		unset( $GLOBALS['_wp_options']['newspack_nodes_topologies'] );
		\Newspack_Nodes\Config::reset();
		parent::tearDown();
	}

	// ── worker_needs_spawn ────────────────────────────────────────────────

	public function test_worker_needs_spawn_when_no_lock(): void {
		$s      = new Spawn_Coordinator( $this->tmp );
		$worker = [ 'type' => 'foo', 'partition' => 0, 'stale_timeout' => 60 ];
		$this->assertTrue( $s->worker_needs_spawn( $worker, microtime( true ) ) );
	}

	public function test_worker_does_not_need_spawn_when_lock_fresh(): void {
		$s = new Spawn_Coordinator( $this->tmp );
		mkdir( "{$this->tmp}/locks/foo.p0.lock.d", 0755, true );
		touch( "{$this->tmp}/locks/foo.p0.lock.d/heartbeat" );
		$worker = [ 'type' => 'foo', 'partition' => 0, 'stale_timeout' => 60 ];
		$this->assertFalse( $s->worker_needs_spawn( $worker, microtime( true ) ) );
	}

	public function test_worker_needs_spawn_when_heartbeat_stale(): void {
		$s = new Spawn_Coordinator( $this->tmp );
		mkdir( "{$this->tmp}/locks/foo.p0.lock.d", 0755, true );
		touch( "{$this->tmp}/locks/foo.p0.lock.d/heartbeat", time() - 3600 );
		$worker = [ 'type' => 'foo', 'partition' => 0, 'stale_timeout' => 60 ];
		$this->assertTrue( $s->worker_needs_spawn( $worker, microtime( true ) ) );
	}

	// ── is_recently_spawned ───────────────────────────────────────────────

	public function test_spawn_rate_limit_skips_recent_spawns(): void {
		$s   = new Spawn_Coordinator( $this->tmp );
		$now = microtime( true );
		$s->record_spawn( 'foo', 0, $now - 5 );
		$this->assertTrue( $s->is_recently_spawned( 'foo', 0, $now ) );
		$this->assertFalse( $s->is_recently_spawned( 'foo', 0, $now + 20 ) );
	}

	public function test_record_spawn_persists_across_coordinator_instances(): void {
		// Simulates a worker process exit + restart (cron backstop or
		// self-respawn). The new instance must see the recent spawn so it
		// honors the 15s rate limit instead of re-spawning the same worker.
		$now = microtime( true );

		$first = new Spawn_Coordinator( $this->tmp );
		$first->record_spawn( 'firehose-workers', 0, $now );

		// Fresh instance — empty in-memory map; relies on persistence.
		$second = new Spawn_Coordinator( $this->tmp );
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
		$s = new Spawn_Coordinator( $this->tmp );
		$this->assertFalse( $s->is_recently_spawned( 'never-seen', 0, microtime( true ) ) );
	}

	// ── delete_directory_recursive containment guard ─────────────────────

	public function test_delete_directory_recursive_removes_contained_tree(): void {
		$inside = "{$this->tmp}/data/p0";
		mkdir( $inside, 0755, true );
		file_put_contents( "{$inside}/a.log", 'hello' );
		mkdir( "{$inside}/sub" );
		file_put_contents( "{$inside}/sub/b.log", 'world' );

		Spawn_Coordinator::delete_directory_recursive( $inside, $this->tmp );

		$this->assertFalse( is_dir( $inside ), 'inner tree must be removed' );
		$this->assertTrue( is_dir( "{$this->tmp}/data" ), 'parent must remain' );
	}

	public function test_delete_directory_recursive_refuses_outside_base(): void {
		// Build a sibling tree alongside the base to verify path-containment.
		$sibling = $this->make_temp_dir( 'siblling-' );
		file_put_contents( "{$sibling}/keep.log", 'survive' );

		Spawn_Coordinator::delete_directory_recursive( $sibling, $this->tmp );

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

		Spawn_Coordinator::delete_directory_recursive( "{$this->tmp}/data/..", $this->tmp );

		$this->assertTrue( is_dir( $this->tmp ), 'base must remain' );
		$this->assertTrue( is_file( "{$inside}/safe.log" ) );
	}

	public function test_delete_directory_recursive_skips_missing_path(): void {
		// Should be a no-op if the candidate doesn't exist — not an error.
		Spawn_Coordinator::delete_directory_recursive( "{$this->tmp}/nope", $this->tmp );
		$this->assertTrue( is_dir( $this->tmp ) );
	}

	public function test_delete_directory_recursive_respects_max_depth(): void {
		// Build a deep tree well past the requested cap; verify the cap is
		// honored by checking that depth-cap+1 directory survives.
		$base  = "{$this->tmp}/d";
		$cap   = 2;
		mkdir( "{$base}/l1/l2/l3/l4", 0755, true );
		file_put_contents( "{$base}/l1/l2/l3/l4/leaf.log", 'leaf' );

		Spawn_Coordinator::delete_directory_recursive( $base, $this->tmp, $cap );

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

		Spawn_Coordinator::delete_directory_recursive( "{$this->tmp}/data", $this->tmp );

		$this->assertTrue( is_dir( $outside ), 'symlinked target must survive' );
		$this->assertTrue( is_file( "{$outside}/protected.log" ) );

		$this->rmdir_recursive( $outside );
	}

	// ── is_within ─────────────────────────────────────────────────────────

	public function test_is_within_accepts_path_under_base(): void {
		mkdir( "{$this->tmp}/a/b", 0755, true );
		$this->assertTrue( Spawn_Coordinator::is_within( "{$this->tmp}/a/b", $this->tmp ) );
	}

	public function test_is_within_accepts_base_itself(): void {
		$this->assertTrue( Spawn_Coordinator::is_within( $this->tmp, $this->tmp ) );
	}

	public function test_is_within_rejects_sibling(): void {
		$other = $this->make_temp_dir( 'other-' );
		$this->assertFalse( Spawn_Coordinator::is_within( $other, $this->tmp ) );
		$this->rmdir_recursive( $other );
	}

	public function test_is_within_rejects_unresolvable_path(): void {
		$this->assertFalse( Spawn_Coordinator::is_within( '/nonexistent/path', $this->tmp ) );
	}

	// ── remove_stale_directory threshold ──────────────────────────────────

	public function test_remove_stale_directory_removes_old_dir(): void {
		$dir = "{$this->tmp}/old-partition";
		mkdir( $dir, 0755, true );
		file_put_contents( "{$dir}/file.log", 'stale' );
		// Backdate file mtime well past the threshold.
		touch( "{$dir}/file.log", time() - 7200 );

		$s = new Spawn_Coordinator( $this->tmp );
		$s->remove_stale_directory( $dir, 3600 );

		$this->assertFalse( is_dir( $dir ), 'stale dir must be removed' );
	}

	public function test_remove_stale_directory_keeps_fresh_dir(): void {
		$dir = "{$this->tmp}/fresh-partition";
		mkdir( $dir, 0755, true );
		file_put_contents( "{$dir}/file.log", 'recent' );
		// Default mtime — recent.

		$s = new Spawn_Coordinator( $this->tmp );
		$s->remove_stale_directory( $dir, 3600 );

		$this->assertTrue( is_dir( $dir ), 'fresh dir must NOT be removed' );
	}

	public function test_remove_stale_directory_no_op_when_missing(): void {
		$s = new Spawn_Coordinator( $this->tmp );
		$s->remove_stale_directory( "{$this->tmp}/no-such-dir", 3600 );
		// No exception, no side effect.
		$this->assertTrue( is_dir( $this->tmp ) );
	}

	public function test_remove_stale_directory_skips_empty_dir(): void {
		// Empty dir → newest_mtime stays 0 → no removal (we only delete
		// dirs we can confirm are stale; empty dirs are ambiguous).
		$dir = "{$this->tmp}/empty";
		mkdir( $dir );

		$s = new Spawn_Coordinator( $this->tmp );
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

		$s = new Spawn_Coordinator( $this->tmp );
		$s->remove_stale_directory( $link, 3600 );

		$this->assertTrue( is_dir( $target ), 'symlink target must survive' );

		@unlink( $link );
		$this->rmdir_recursive( $target );
	}

	// ── Constants ─────────────────────────────────────────────────────────

	public function test_constants_match_spec(): void {
		$this->assertSame( 15, Spawn_Coordinator::MIN_SPAWN_INTERVAL_S );
		$this->assertSame( 16, Spawn_Coordinator::MAX_PARTITIONS );
	}

	// ── worker_needs_spawn: heartbeat-missing-but-dir-exists ─────────────

	/**
	 * A lock dir can exist transiently without a heartbeat file (mid-acquire,
	 * or after force_release that left the dir but cleaned the heartbeat).
	 * fleet must treat this as "needs spawn" — the worker is not running.
	 *
	 * This is distinct from "no lock dir" (test_worker_needs_spawn_when_no_lock)
	 * and "stale heartbeat" (test_worker_needs_spawn_when_heartbeat_stale).
	 */
	public function test_worker_needs_spawn_when_heartbeat_file_missing(): void {
		$s = new Spawn_Coordinator( $this->tmp );
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
		$s = new Spawn_Coordinator( $this->tmp );
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
		Spawn_Coordinator::delete_directory_recursive( $file, $this->tmp );

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

		Spawn_Coordinator::delete_directory_recursive( $link, $this->tmp );

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

		$s = new Spawn_Coordinator( $this->tmp );
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
		$s   = new Spawn_Coordinator( $this->tmp );
		$now = microtime( true );
		$s->record_spawn( 'firehose-workers', 0, $now );

		$key = Cache_Backend::site_key( Spawn_Coordinator::SPAWN_TS_CACHE_KEY . 'firehose-workers|0' );
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
		$s = new Spawn_Coordinator( $this->tmp );
		$method = new \ReflectionMethod( Spawn_Coordinator::class, 'load_spawn_ts' );

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
		$first = new Spawn_Coordinator( $this->tmp );
		$first->record_spawn( 'foo', 0, $now );

		// Second instance: triggers load_spawn_ts internally.
		$second = new Spawn_Coordinator( $this->tmp );
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
			$s = new Spawn_Coordinator( $this->tmp );
			$s->record_spawn( 'throttled-type', 3, 1234567.0 );

			$stored = $memd->get( Cache_Backend::site_key( Spawn_Coordinator::SPAWN_TS_CACHE_KEY . 'throttled-type|3' ) );
			$this->assertSame( 1234567, $stored, 'spawn ts must land in the shared backend' );

			$fresh = new Spawn_Coordinator( $this->tmp );
			$this->assertTrue( $fresh->is_recently_spawned( 'throttled-type', 3, 1234567.0 + 7 ) );
			$this->assertFalse( $fresh->is_recently_spawned( 'throttled-type', 3, 1234567.0 + 31 ) );
		} finally {
			\Newspack_Nodes\Core::$memd = null;
		}
	}

	// ── spawn token ───────────────────────────────────────────────────────

	public function test_spawn_token_rotates_once_per_window(): void {
		$s     = new Spawn_Coordinator( $this->tmp, 'COLD_START_SALT' );
		$first = $s->generate_spawn_token( 1700000000 );

		$this->assertSame( $first, $s->generate_spawn_token( 1700000005 ) );
		$this->assertNotSame( $first, $s->generate_spawn_token( 1700000015 ) );
	}

	public function test_validate_spawn_token_accepts_the_previous_window_only(): void {
		$s     = new Spawn_Coordinator( $this->tmp, 'COLD_START_SALT' );
		$token = $s->generate_spawn_token( 1700000000 );

		$this->assertTrue( $s->validate_spawn_token( $token, 1700000012 ) );
		$this->assertFalse( $s->validate_spawn_token( $token, 1700000025 ) );
	}

	public function test_spawn_token_is_keyed_on_the_constructor_salt(): void {
		$alpha = new Spawn_Coordinator( $this->tmp, 'SALT_ALPHA' );
		$bravo = new Spawn_Coordinator( $this->tmp, 'SALT_BRAVO' );

		$this->assertFalse(
			$bravo->validate_spawn_token( $alpha->generate_spawn_token( 1700000000 ), 1700000000 ),
			'a token minted under one salt must not validate under another'
		);
	}

	public function test_spawn_token_defaults_to_the_site_nonce_salt(): void {
		$explicit = new Spawn_Coordinator( $this->tmp, \wp_salt( 'nonce' ) );
		$implicit = new Spawn_Coordinator( $this->tmp );

		$this->assertSame(
			$explicit->generate_spawn_token( 1700000000 ),
			$implicit->generate_spawn_token( 1700000000 ),
			'an omitted salt must resolve to the one production key'
		);
	}

	// ── post_spawn ────────────────────────────────────────────────────────

	public function test_post_spawn_body_carries_type_partition_and_token(): void {
		$GLOBALS['_test_outbound_posts'] = [];
		$s                               = new Spawn_Coordinator( $this->tmp, 'COLD_START_SALT' );

		$s->post_spawn( 'http://example.test/spawn', 'cold-start-workers', 2, 'TOKEN_XYZ' );

		$posts = $GLOBALS['_test_outbound_posts'];
		$this->assertCount( 1, $posts );
		$this->assertSame( 'cold-start-workers', $posts[0]['args']['body']['type'] );
		$this->assertSame( 2, $posts[0]['args']['body']['partition'] );
		$this->assertSame( 'TOKEN_XYZ', $posts[0]['args']['body']['nonce'] );
	}

	// ── spawn_due_workers: the cold-start pass ────────────────────────────

	/**
	 * Declare an active fleet for the spawn tests. Topology names are distinct
	 * from every stock topology so a leaked catalog entry cannot satisfy them.
	 *
	 * @param array<string, array<string, mixed>> $topologies Catalog entries.
	 */
	private function with_active_fleet( array $topologies ): void {
		$GLOBALS['_test_outbound_posts'] = [];
		$this->use_base_dir( $this->tmp );
		\add_filter( 'newspack_nodes/topologies', static fn () => $topologies );
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = \array_keys( $topologies );
		\Newspack_Nodes\Config::reset();
	}

	public function test_spawn_due_workers_posts_for_every_missing_lock(): void {
		$this->with_active_fleet( [
			'cold-start-workers' => [ 'num_partitions' => 3, 'topology' => '/cs.tsl', 'stale_timeout' => 45 ],
		] );
		$s = new Spawn_Coordinator( $this->tmp, 'COLD_START_SALT' );

		$this->assertSame( 3, $s->spawn_due_workers( 1700000000.0 ) );

		$posts = $GLOBALS['_test_outbound_posts'];
		$this->assertCount( 3, $posts );
		$this->assertEqualsCanonicalizing(
			[ 0, 1, 2 ],
			\array_map( static fn ( $p ) => $p['args']['body']['partition'], $posts )
		);
		$this->assertTrue(
			$s->validate_spawn_token( $posts[0]['args']['body']['nonce'], 1700000000 ),
			'the cold-start POST must carry a token this coordinator would accept'
		);
	}

	public function test_spawn_due_workers_skips_a_worker_with_a_fresh_heartbeat(): void {
		$this->with_active_fleet( [
			'cold-start-workers' => [ 'num_partitions' => 1, 'topology' => '/cs.tsl', 'stale_timeout' => 45 ],
		] );
		\mkdir( "{$this->tmp}/locks/cold-start-workers.p0.lock.d", 0755, true );
		\touch( "{$this->tmp}/locks/cold-start-workers.p0.lock.d/heartbeat" );
		$s = new Spawn_Coordinator( $this->tmp, 'COLD_START_SALT' );

		$this->assertSame( 0, $s->spawn_due_workers( \microtime( true ) ) );
		$this->assertEmpty( $GLOBALS['_test_outbound_posts'] );
	}

	public function test_spawn_due_workers_respawns_past_the_declared_stale_timeout(): void {
		// 45s is the topology's own stale_timeout, distinct from the 60s
		// default: a 50s-old heartbeat is stale here and fresh under the default.
		$this->with_active_fleet( [
			'cold-start-workers' => [ 'num_partitions' => 1, 'topology' => '/cs.tsl', 'stale_timeout' => 45 ],
		] );
		\mkdir( "{$this->tmp}/locks/cold-start-workers.p0.lock.d", 0755, true );
		\touch( "{$this->tmp}/locks/cold-start-workers.p0.lock.d/heartbeat", \time() - 50 );
		$s = new Spawn_Coordinator( $this->tmp, 'COLD_START_SALT' );

		$this->assertSame( 1, $s->spawn_due_workers( \microtime( true ) ) );
	}

	public function test_spawn_due_workers_honors_the_shared_spawn_throttle(): void {
		$this->with_active_fleet( [
			'cold-start-workers' => [ 'num_partitions' => 1, 'topology' => '/cs.tsl', 'stale_timeout' => 45 ],
		] );
		$now = \microtime( true );
		$s   = new Spawn_Coordinator( $this->tmp, 'COLD_START_SALT' );
		// The endpoint records every accepted spawn; a cron minute later the
		// window may still be open.
		$s->record_spawn( 'cold-start-workers', 0, $now - 5 );

		$this->assertSame( 0, $s->spawn_due_workers( $now ) );
		$this->assertEmpty( $GLOBALS['_test_outbound_posts'] );
	}

	public function test_spawn_due_workers_refuses_a_write_conflicting_active_set(): void {
		// Two topologies writing one partition log corrupt it. The cold-start
		// tier must refuse the whole set, exactly as the peer scan does.
		$stock     = $this->make_temp_dir( 'cold-start-conflict-' );
		$partition = 'make_node Partition requests:partition <config:logs_dir>/requests.p<partition> <config:segment_size> <config:min_segments> <config:max_segments> <config:min_lifetime> <config:max_lifetime>';
		\file_put_contents( "{$stock}/alpha.tsl", "var num_partitions = 2\n{$partition}\n" );
		\file_put_contents( "{$stock}/beta.tsl", "var num_partitions = 2\nmake_node Partition requests:partition <config:logs_dir>/requests.p<partition> 1048576 2 4 0 0\n" );
		\Newspack_Nodes\Topology_Registry::reset();
		\Newspack_Nodes\Topology_Registry::register_stock_dir( $stock );
		$GLOBALS['_test_outbound_posts']                     = [];
		$this->use_base_dir( $this->tmp );
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'alpha', 'beta' ];
		\Newspack_Nodes\Config::reset();

		$s = new Spawn_Coordinator( $this->tmp, 'COLD_START_SALT' );

		$this->assertSame( 0, $s->spawn_due_workers( \microtime( true ) ) );
		$this->assertEmpty( $GLOBALS['_test_outbound_posts'], 'no spawn POST for a conflicting set' );

		\Newspack_Nodes\Topology_Registry::reset();
		$this->rmdir_recursive( $stock );
	}

	// ── kill_readers ──────────────────────────────────────────────────────

	public function test_kill_readers_drops_a_restart_flag_for_each_partition(): void {
		$this->with_active_fleet( [
			'cold-start-workers' => [ 'num_partitions' => 3, 'topology' => '/cs.tsl' ],
		] );
		foreach ( [ 0, 1, 2 ] as $p ) {
			\mkdir( "{$this->tmp}/locks/cold-start-workers.p{$p}.lock.d", 0755, true );
		}

		( new Spawn_Coordinator( $this->tmp ) )->kill_readers( [ 'cold-start-workers' ] );

		foreach ( [ 0, 1, 2 ] as $p ) {
			$this->assertTrue(
				\Newspack_Nodes\Lock_Node::is_restart_pending( "{$this->tmp}/locks/cold-start-workers.p{$p}.lock.d" ),
				"partition p{$p} must be flagged"
			);
		}
	}

	public function test_kill_readers_only_targets_existing_lock_dirs(): void {
		$this->with_active_fleet( [
			'cold-start-workers' => [ 'num_partitions' => 3, 'topology' => '/cs.tsl' ],
		] );
		\mkdir( "{$this->tmp}/locks/cold-start-workers.p0.lock.d", 0755, true );

		( new Spawn_Coordinator( $this->tmp ) )->kill_readers( [ 'cold-start-workers' ] );

		$this->assertTrue( \Newspack_Nodes\Lock_Node::is_restart_pending( "{$this->tmp}/locks/cold-start-workers.p0.lock.d" ) );
		$this->assertFalse( \is_dir( "{$this->tmp}/locks/cold-start-workers.p1.lock.d" ) );
	}

	public function test_kill_readers_reaches_max_partitions_for_a_retired_type(): void {
		// A type no longer in the fleet has no partition count to consult, so
		// the sweep must walk the full range or leave high orphans running.
		$this->with_active_fleet( [
			'cold-start-workers' => [ 'num_partitions' => 1, 'topology' => '/cs.tsl' ],
		] );
		\mkdir( "{$this->tmp}/locks/retired-type.p0.lock.d", 0755, true );
		\mkdir( "{$this->tmp}/locks/retired-type.p9.lock.d", 0755, true );

		( new Spawn_Coordinator( $this->tmp ) )->kill_readers( [ 'retired-type' ] );

		$this->assertTrue( \Newspack_Nodes\Lock_Node::is_restart_pending( "{$this->tmp}/locks/retired-type.p0.lock.d" ) );
		$this->assertTrue( \Newspack_Nodes\Lock_Node::is_restart_pending( "{$this->tmp}/locks/retired-type.p9.lock.d" ) );
	}
}
