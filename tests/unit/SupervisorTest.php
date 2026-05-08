<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Lock;
use Newspack_Nodes\Supervisor;
use Newspack_Nodes\SupervisorBase;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Supervisor::class )]
class SupervisorTest extends TestCase {
	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		$this->tmp                            = $this->make_temp_dir();
		$GLOBALS['_wp_actions']               = [];
		$GLOBALS['_wp_test_remote_posts']     = [];
		$GLOBALS['_wp_test_transients']       = [];
		// Force Bootstrap::base_dir() to point at our temp dir for cleanup tests.
		\add_filter( 'newspack_nodes/base_dir', fn() => $this->tmp );
	}

	protected function tearDown(): void {
		$this->rmdir_recursive( $this->tmp );
		$GLOBALS['_wp_actions']           = [];
		$GLOBALS['_wp_test_remote_posts'] = [];
		$GLOBALS['_wp_test_transients']   = [];
		unset(
			$_SERVER['NEWSPACK_NODES_WORKER_TYPE'],
			$_SERVER['NEWSPACK_NODES_WORKER_PARTITION']
		);
		parent::tearDown();
	}

	private function with_topology( array $topologies ): void {
		\add_filter( 'newspack_nodes/topologies', function () use ( $topologies ) {
			return $topologies;
		} );
	}

	// ── HMAC token ─────────────────────────────────────────────────────────

	public function test_spawn_token_uses_hmac_with_window(): void {
		$s = new Supervisor( '/tmp', 'NONCE_SALT_FOR_TEST' );
		$now = 1000000;
		$token = $s->generate_spawn_token( $now );
		$this->assertSame( 64, strlen( $token ) );
	}

	public function test_spawn_token_rotates_per_10s_window(): void {
		$s = new Supervisor( '/tmp', 'NONCE_SALT_FOR_TEST' );
		$t1 = $s->generate_spawn_token( 1000000 );
		$t2 = $s->generate_spawn_token( 1000005 );
		$t3 = $s->generate_spawn_token( 1000015 );
		$this->assertSame( $t1, $t2 );
		$this->assertNotSame( $t1, $t3 );
	}

	public function test_validate_spawn_token_accepts_current_window(): void {
		$s = new Supervisor( '/tmp', 'NONCE_SALT_FOR_TEST' );
		$now = 1000000;
		$token = $s->generate_spawn_token( $now );
		$this->assertTrue( $s->validate_spawn_token( $token, $now ) );
	}

	public function test_validate_spawn_token_accepts_previous_window(): void {
		$s = new Supervisor( '/tmp', 'NONCE_SALT_FOR_TEST' );
		$prev_token = $s->generate_spawn_token( 1000000 );
		$this->assertTrue( $s->validate_spawn_token( $prev_token, 1000012 ) );
	}

	public function test_validate_spawn_token_rejects_two_windows_old(): void {
		$s = new Supervisor( '/tmp', 'NONCE_SALT_FOR_TEST' );
		$old_token = $s->generate_spawn_token( 1000000 );
		$this->assertFalse( $s->validate_spawn_token( $old_token, 1000025 ) );
	}

	// ── Constants ──────────────────────────────────────────────────────────

	public function test_constants_match_spec(): void {
		$this->assertSame( 595, Supervisor::MAX_SUPERVISOR_RUNTIME_S );
		$this->assertSame( 15, Supervisor::CONFIG_CHECK_INTERVAL );
		$this->assertSame( 10, Supervisor::TOKEN_WINDOW_S );
	}

	// ── check_config: rebuild + gate ───────────────────────────────────────

	public function test_check_config_rebuilds_worker_locks_from_filter(): void {
		$this->with_topology( [
			'firehose-workers' => [ 'num_partitions' => 2, 'topology' => '/x.php' ],
			'job-workers'      => [ 'num_partitions' => 1, 'topology' => '/y.php' ],
		] );
		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );

		$ok = $s->check_config( microtime( true ) );

		$this->assertTrue( $ok );
		$workers = $s->worker_locks_for_test();
		$this->assertCount( 3, $workers );

		$types = array_column( $workers, 'type' );
		$this->assertContains( 'firehose-workers', $types );
		$this->assertContains( 'job-workers', $types );
	}

	public function test_check_config_returns_false_when_logging_disabled(): void {
		\add_filter( 'newspack_nodes/enable_logging', fn() => false );
		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );

		$this->assertFalse( $s->check_config( microtime( true ) ) );
	}

	public function test_check_config_clamps_num_partitions_to_max(): void {
		$this->with_topology( [
			'huge' => [ 'num_partitions' => 9999, 'topology' => '/x.php' ],
		] );
		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );

		$s->check_config( microtime( true ) );

		$this->assertSame( SupervisorBase::MAX_PARTITIONS, $s->num_partitions_for_test() );
	}

	public function test_check_config_picks_up_added_topology_on_subsequent_call(): void {
		// First call with one type.
		$captured_topologies = [
			'firehose-workers' => [ 'num_partitions' => 1, 'topology' => '/x.php' ],
		];
		\add_filter( 'newspack_nodes/topologies', function ( $existing ) use ( &$captured_topologies ) {
			return $captured_topologies;
		} );

		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$s->check_config( microtime( true ) );
		$this->assertCount( 1, $s->worker_locks_for_test() );

		// Plugin activation: topology filter now returns more types.
		$captured_topologies['job-workers'] = [ 'num_partitions' => 1, 'topology' => '/y.php' ];
		// Force config-check window with a forward-jumped clock.
		$s->check_config( microtime( true ) + 100 );
		$this->assertCount( 2, $s->worker_locks_for_test() );

		// Plugin deactivation.
		unset( $captured_topologies['job-workers'] );
		$s->check_config( microtime( true ) + 200 );
		$this->assertCount( 1, $s->worker_locks_for_test() );
	}

	// ── tick_for_test: spawn iteration ─────────────────────────────────────

	public function test_tick_spawns_for_missing_lock(): void {
		$this->with_topology( [
			'firehose-workers' => [ 'num_partitions' => 2, 'topology' => '/x.php' ],
		] );
		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$s->check_config( microtime( true ) );

		$now   = microtime( true );
		$token = $s->generate_spawn_token( (int) $now );
		$s->tick_for_test( $now, $token );

		$posts = $GLOBALS['_wp_test_remote_posts'] ?? [];
		$this->assertCount( 2, $posts, 'two missing locks → two spawn POSTs' );
		$this->assertSame( 'firehose-workers', $posts[0]['args']['body']['type'] );
		$this->assertSame( $token, $posts[0]['args']['body']['nonce'] );
	}

	public function test_tick_skips_workers_with_fresh_locks(): void {
		$this->with_topology( [
			'firehose-workers' => [ 'num_partitions' => 1, 'topology' => '/x.php' ],
		] );
		mkdir( "{$this->tmp}/locks/firehose-workers.p0.lock.d", 0755, true );
		touch( "{$this->tmp}/locks/firehose-workers.p0.lock.d/heartbeat" );

		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$s->check_config( microtime( true ) );

		$now = microtime( true );
		$s->tick_for_test( $now, $s->generate_spawn_token( (int) $now ) );

		$this->assertEmpty( $GLOBALS['_wp_test_remote_posts'] ?? [] );
	}

	public function test_tick_respects_min_spawn_interval(): void {
		$this->with_topology( [
			'firehose-workers' => [ 'num_partitions' => 1, 'topology' => '/x.php' ],
		] );
		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$s->check_config( microtime( true ) );

		$now   = microtime( true );
		$token = $s->generate_spawn_token( (int) $now );

		// First tick spawns.
		$s->tick_for_test( $now, $token );
		$this->assertCount( 1, $GLOBALS['_wp_test_remote_posts'] ?? [] );

		// Second tick within rate-limit window: no spawn.
		$s->tick_for_test( $now + 5, $token );
		$this->assertCount( 1, $GLOBALS['_wp_test_remote_posts'] ?? [] );

		// Third tick after rate-limit window: spawns again (lock still missing).
		$s->tick_for_test( $now + 20, $token );
		$this->assertCount( 2, $GLOBALS['_wp_test_remote_posts'] ?? [] );
	}

	public function test_min_spawn_interval_persists_across_supervisor_instances(): void {
		// Simulates supervisor exit + restart — second supervisor must see
		// the first one's recent spawn via memcache/transient persistence
		// and skip re-spawning.
		$this->with_topology( [
			'firehose-workers' => [ 'num_partitions' => 1, 'topology' => '/x.php' ],
		] );

		$now   = microtime( true );
		$token = ( new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' ) )->generate_spawn_token( (int) $now );

		$first = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$first->check_config( $now );
		$first->tick_for_test( $now, $token );
		$this->assertCount( 1, $GLOBALS['_wp_test_remote_posts'] ?? [] );

		// Fresh supervisor (cron backstop after crash, or self-respawn).
		$second = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$second->check_config( $now + 5 );
		$second->tick_for_test( $now + 5, $token );

		// No additional spawn — the persisted timestamp gates this.
		$this->assertCount(
			1,
			$GLOBALS['_wp_test_remote_posts'] ?? [],
			'persisted last_spawn must survive supervisor process restart'
		);
	}

	// ── own-lock contention ────────────────────────────────────────────────

	public function test_own_lock_prevents_concurrent_supervisors(): void {
		$first = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$this->assertTrue( $first->init_lock_for_test() );

		// Second supervisor cannot acquire while first holds.
		$second = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$this->assertFalse( $second->init_lock_for_test() );

		// After first releases, second can take the lock.
		$first->release_lock_for_test();
		$this->assertTrue( $second->init_lock_for_test() );
		$second->release_lock_for_test();
	}

	public function test_own_lock_writes_to_supervisor_lock_dir(): void {
		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$this->assertTrue( $s->init_lock_for_test() );
		$this->assertTrue( is_dir( "{$this->tmp}/locks/supervisor.lock.d" ) );
		$s->release_lock_for_test();
		$this->assertFalse( is_dir( "{$this->tmp}/locks/supervisor.lock.d" ) );
	}

	public function test_run_returns_when_logging_disabled(): void {
		\add_filter( 'newspack_nodes/enable_logging', fn() => false );
		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );

		$s->run();

		// No supervisor lock was created — exited at first check_config.
		$this->assertFalse( is_dir( "{$this->tmp}/locks/supervisor.lock.d" ) );
	}

	public function test_run_returns_when_another_supervisor_holds_lock(): void {
		// Pre-acquire the lock externally — run() should bail without
		// firing any spawns.
		$external_lock = new Lock( "{$this->tmp}/locks/supervisor.lock.d", 60 );
		mkdir( "{$this->tmp}/locks", 0755, true );
		$this->assertTrue( $external_lock->acquire() );

		$this->with_topology( [
			'firehose-workers' => [ 'num_partitions' => 1, 'topology' => '/x.php' ],
		] );

		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$s->run();

		$this->assertEmpty(
			$GLOBALS['_wp_test_remote_posts'] ?? [],
			'concurrent supervisor must not fire spawns'
		);

		$external_lock->release();
	}

	// ── cleanup_stale_partitions ───────────────────────────────────────────

	public function test_cleanup_stale_partitions_removes_old_partition_dirs(): void {
		$this->with_topology( [
			'firehose-workers' => [ 'num_partitions' => 2, 'topology' => '/x.php' ],
		] );

		// Create a stale lock dir for a retired partition (p4).
		$stale_dir = "{$this->tmp}/locks/firehose-workers.p4.lock.d";
		mkdir( $stale_dir, 0755, true );
		file_put_contents( "{$stale_dir}/heartbeat", '' );
		touch( "{$stale_dir}/heartbeat", time() - 7200 );

		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$s->check_config( microtime( true ) );

		$this->assertFalse( is_dir( $stale_dir ), 'stale retired-partition lock dir must be removed' );
	}

	public function test_cleanup_stale_partitions_keeps_fresh_orphans(): void {
		$this->with_topology( [
			'firehose-workers' => [ 'num_partitions' => 2, 'topology' => '/x.php' ],
		] );

		// Recently-touched orphan — within the grace window.
		$fresh_orphan = "{$this->tmp}/locks/firehose-workers.p4.lock.d";
		mkdir( $fresh_orphan, 0755, true );
		file_put_contents( "{$fresh_orphan}/heartbeat", '' );

		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$s->check_config( microtime( true ) );

		$this->assertTrue(
			is_dir( $fresh_orphan ),
			'fresh orphans within STALE_PARTITION_AGE_S grace period must survive'
		);
	}

	public function test_cleanup_stale_partitions_skips_active_partitions(): void {
		$this->with_topology( [
			'firehose-workers' => [ 'num_partitions' => 2, 'topology' => '/x.php' ],
		] );

		// Create active-partition lock dirs (p0, p1) and an old one (p3).
		foreach ( [ 0, 1 ] as $p ) {
			mkdir( "{$this->tmp}/locks/firehose-workers.p{$p}.lock.d", 0755, true );
			file_put_contents( "{$this->tmp}/locks/firehose-workers.p{$p}.lock.d/heartbeat", '' );
			touch( "{$this->tmp}/locks/firehose-workers.p{$p}.lock.d/heartbeat", time() - 7200 );
		}

		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$s->check_config( microtime( true ) );

		// Active partitions must NOT be touched by cleanup_stale_partitions
		// (it only walks num_partitions..MAX_PARTITIONS).
		$this->assertTrue( is_dir( "{$this->tmp}/locks/firehose-workers.p0.lock.d" ) );
		$this->assertTrue( is_dir( "{$this->tmp}/locks/firehose-workers.p1.lock.d" ) );
	}

	// ── kill_readers ───────────────────────────────────────────────────────

	public function test_kill_readers_drops_restart_flag_for_each_partition(): void {
		$this->with_topology( [
			'firehose-workers' => [ 'num_partitions' => 3, 'topology' => '/x.php' ],
		] );

		// Pre-create lock dirs (simulating running workers).
		foreach ( [ 0, 1, 2 ] as $p ) {
			$dir = "{$this->tmp}/locks/firehose-workers.p{$p}.lock.d";
			mkdir( $dir, 0755, true );
			file_put_contents( "{$dir}/heartbeat", (string) getmypid() );
		}

		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$s->kill_readers( [ 'firehose-workers' ] );

		// Each partition's lock dir now has the restart flag.
		foreach ( [ 0, 1, 2 ] as $p ) {
			$this->assertTrue(
				Lock::is_restart_pending( "{$this->tmp}/locks/firehose-workers.p{$p}.lock.d" ),
				"partition p{$p} must have restart flag dropped"
			);
		}
	}

	public function test_kill_readers_skips_unknown_groups(): void {
		// Topology has only firehose-workers, but we ask to kill job-workers.
		// Should not error — should be a no-op for the unknown group.
		$this->with_topology( [
			'firehose-workers' => [ 'num_partitions' => 1, 'topology' => '/x.php' ],
		] );

		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$s->kill_readers( [ 'never-existed' ] );

		// No error, no side effect.
		$this->assertFalse( is_dir( "{$this->tmp}/locks/never-existed.p0.lock.d" ) );
	}

	public function test_kill_readers_only_targets_existing_lock_dirs(): void {
		$this->with_topology( [
			'firehose-workers' => [ 'num_partitions' => 3, 'topology' => '/x.php' ],
		] );

		// Only p0 has a real lock dir.
		mkdir( "{$this->tmp}/locks/firehose-workers.p0.lock.d", 0755, true );
		file_put_contents( "{$this->tmp}/locks/firehose-workers.p0.lock.d/heartbeat", (string) getmypid() );

		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$s->kill_readers( [ 'firehose-workers' ] );

		// p0 has the flag.
		$this->assertTrue( Lock::is_restart_pending( "{$this->tmp}/locks/firehose-workers.p0.lock.d" ) );
		// p1, p2 don't — they didn't exist.
		$this->assertFalse( is_dir( "{$this->tmp}/locks/firehose-workers.p1.lock.d" ) );
		$this->assertFalse( is_dir( "{$this->tmp}/locks/firehose-workers.p2.lock.d" ) );
	}
}
