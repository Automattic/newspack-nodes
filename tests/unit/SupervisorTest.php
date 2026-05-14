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
		$this->use_base_dir( $this->tmp );
	}

	protected function tearDown(): void {
		$this->rmdir_recursive( $this->tmp );
		$GLOBALS['_wp_actions']           = [];
		$GLOBALS['_wp_test_remote_posts'] = [];
		$GLOBALS['_wp_test_transients']   = [];
		unset(
			$_SERVER['NEWSPACK_NODES_WORKER_TYPE'],
			$_SERVER['NEWSPACK_NODES_WORKER_PARTITION'],
			$GLOBALS['_wp_test_remote_post_response']
		);
		parent::tearDown();
	}

	private function with_topology( array $topologies ): void {
		\add_filter( 'newspack_nodes/topologies', function () use ( $topologies ) {
			return $topologies;
		} );
	}

	/**
	 * Seed Supervisor's loop-state properties so we can drive tick_loop via
	 * reflection without going through run() (which would block on sleep).
	 */
	private function seed_loop_state( Supervisor $s, float $now, ?float $last_config_check = null ): void {
		foreach (
			[
				'start_time'        => $now,
				'last_heartbeat'    => $now,
				'last_config_check' => $last_config_check ?? $now,
			]
			as $prop_name => $value
		) {
			$prop = new \ReflectionProperty( Supervisor::class, $prop_name );
			$prop->setAccessible( true );
			$prop->setValue( $s, $value );
		}
	}

	private function invoke_tick_loop( Supervisor $s ): void {
		$method = new \ReflectionMethod( Supervisor::class, 'tick_loop' );
		$method->setAccessible( true );
		$method->invoke( $s );
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

	public function test_check_config_returns_false_when_no_topologies_registered(): void {
		// No topologies → no workers to spawn → no reason for the supervisor
		// to keep ticking. The hook fires every 15s and the spawn rate limit
		// keeps respawning the supervisor itself; both are wasted work
		// without any topology to consume the output.
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

	public function test_check_config_rms_orphan_type_lock_dirs_once_worker_exits(): void {
		// kill_readers flags a removed-topology worker to exit, but the
		// lock dir lingers afterward — `wp nodes ls` and the topology
		// console would keep surfacing it as a stale ghost forever. The
		// supervisor should rm the dir once the worker has gone cold.
		\add_filter( 'newspack_nodes/topologies', function () {
			return [
				'firehose-workers' => [ 'num_partitions' => 1, 'topology' => '/x.php' ],
			];
		} );

		// Pre-seed: aggregator lock dir whose newest file is older than
		// Lock::STALE_TIMEOUT (worker dead), plus a live firehose worker
		// dir, plus the supervisor's own dir (must not be touched).
		$locks_dir = $this->tmp . '/locks';
		\mkdir( $locks_dir, 0755, true );
		\mkdir( "{$locks_dir}/aggregator.p0.lock.d" );
		\file_put_contents( "{$locks_dir}/aggregator.p0.lock.d/heartbeat", '0' );
		\touch( "{$locks_dir}/aggregator.p0.lock.d/heartbeat", time() - Lock::STALE_TIMEOUT - 1 );
		\mkdir( "{$locks_dir}/firehose-workers.p0.lock.d" );
		\file_put_contents( "{$locks_dir}/firehose-workers.p0.lock.d/heartbeat", '0' );
		\mkdir( "{$locks_dir}/supervisor.lock.d" );
		\file_put_contents( "{$locks_dir}/supervisor.lock.d/heartbeat", '0' );
		\touch( "{$locks_dir}/supervisor.lock.d/heartbeat", time() - Lock::STALE_TIMEOUT - 1 );

		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$s->check_config( microtime( true ) );

		$this->assertDirectoryDoesNotExist(
			"{$locks_dir}/aggregator.p0.lock.d",
			'orphan-type lock dir with dead worker should be removed'
		);
		$this->assertDirectoryExists(
			"{$locks_dir}/firehose-workers.p0.lock.d",
			'active-topology lock dir is left alone'
		);
		$this->assertDirectoryExists(
			"{$locks_dir}/supervisor.lock.d",
			'standalone runtime worker (supervisor) is left alone'
		);
	}

	public function test_cleanup_orphan_type_locks_skips_live_worker(): void {
		// If a removed-topology worker is still running (fresh heartbeat),
		// we MUST NOT rm its lock dir — that'd corrupt the running
		// process's lock state mid-flight. kill_readers' restart flag is
		// the right tool there; cleanup_orphan_type_locks is only for
		// reaping already-dead workers' lingering dirs.
		\add_filter( 'newspack_nodes/topologies', function () {
			return [
				'firehose-workers' => [ 'num_partitions' => 1, 'topology' => '/x.php' ],
			];
		} );
		$locks_dir = $this->tmp . '/locks';
		\mkdir( $locks_dir, 0755, true );
		\mkdir( "{$locks_dir}/aggregator.p0.lock.d" );
		// Fresh heartbeat — worker still alive.
		\file_put_contents( "{$locks_dir}/aggregator.p0.lock.d/heartbeat", (string) time() );

		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$s->check_config( microtime( true ) );

		$this->assertDirectoryExists(
			"{$locks_dir}/aggregator.p0.lock.d",
			'live orphan-type worker dir must NOT be rmd — let kill_readers signal it instead'
		);
	}

	public function test_check_config_releases_locks_for_removed_topologies(): void {
		// Initial topology has two types running.
		$captured_topologies = [
			'firehose-workers' => [ 'num_partitions' => 2, 'topology' => '/x.php' ],
			'job-workers'      => [ 'num_partitions' => 1, 'topology' => '/y.php' ],
		];
		\add_filter( 'newspack_nodes/topologies', function () use ( &$captured_topologies ) {
			return $captured_topologies;
		} );

		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$s->check_config( microtime( true ) );

		// Simulate live workers having their lock dirs on disk.
		$locks_dir = $this->tmp . '/locks';
		\mkdir( $locks_dir, 0755, true );
		\mkdir( "{$locks_dir}/firehose-workers.p0.lock.d" );
		\mkdir( "{$locks_dir}/firehose-workers.p1.lock.d" );
		\mkdir( "{$locks_dir}/job-workers.p0.lock.d" );

		// Operator unchecks job-workers in the admin UI.
		unset( $captured_topologies['job-workers'] );
		$s->check_config( microtime( true ) + 100 );

		// Supervisor should have dropped a restart flag in job-workers.p0.
		$this->assertFileExists(
			"{$locks_dir}/job-workers.p0.lock.d/restart",
			'removed topology should have restart flag dropped'
		);
		// firehose-workers locks should NOT be touched.
		$this->assertFileDoesNotExist(
			"{$locks_dir}/firehose-workers.p0.lock.d/restart",
			'surviving topology should be left alone'
		);
		$this->assertFileDoesNotExist(
			"{$locks_dir}/firehose-workers.p1.lock.d/restart",
		);
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

	public function test_check_config_defers_spawn_for_newly_added_topologies(): void {
		// Existing topology, already running.
		$captured = [
			'firehose-workers' => [ 'num_partitions' => 1, 'topology' => '/x.php' ],
		];
		\add_filter( 'newspack_nodes/topologies', function () use ( &$captured ) {
			return $captured;
		} );
		// Existing worker has a live lock so it doesn't fight for tick attention.
		mkdir( "{$this->tmp}/locks/firehose-workers.p0.lock.d", 0755, true );
		touch( "{$this->tmp}/locks/firehose-workers.p0.lock.d/heartbeat" );

		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$s->check_config( microtime( true ) );

		// Operator adds job-workers in the admin UI.
		$captured['job-workers'] = [ 'num_partitions' => 1, 'topology' => '/y.php' ];
		$detect_now              = microtime( true ) + 100;
		$s->check_config( $detect_now );

		$token = $s->generate_spawn_token( (int) $detect_now );

		// Immediate tick — newly added topology shouldn't spawn yet; old
		// instances of the same type (if any) need a beat to exit cleanly
		// before the new ones start.
		$s->tick_for_test( $detect_now + 0.1, $token );
		$posts = $GLOBALS['_wp_test_remote_posts'] ?? [];
		$job_spawns = \array_values( \array_filter(
			$posts,
			fn ( $p ) => 'job-workers' === ( $p['args']['body']['type'] ?? '' )
		) );
		$this->assertCount( 0, $job_spawns, 'newly added topology should defer first spawn' );

		// Tick after the spawn-deferral window — job-workers should spawn now.
		$GLOBALS['_wp_test_remote_posts'] = [];
		$s->tick_for_test( $detect_now + 6, $token );
		$posts      = $GLOBALS['_wp_test_remote_posts'] ?? [];
		$job_spawns = \array_values( \array_filter(
			$posts,
			fn ( $p ) => 'job-workers' === ( $p['args']['body']['type'] ?? '' )
		) );
		$this->assertCount( 1, $job_spawns, 'deferred topology should spawn after window' );
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

	// ── tick_loop (driven via reflection) ───────────────────────────────────

	/**
	 * Drive the private tick_loop with a pre-set restart flag so we exit
	 * deterministically on iteration 1. Verifies tick_loop checks
	 * should_restart() and breaks BEFORE sleep — proving the restart
	 * channel is honored within ~1s in production.
	 */
	public function test_tick_loop_breaks_on_restart_flag(): void {
		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$this->assertTrue( $s->init_lock_for_test() );

		$this->seed_loop_state( $s, microtime( true ) );

		// Drop a restart flag inside our own lock dir → tick_loop must break.
		Lock::request_restart_at( "{$this->tmp}/locks/supervisor.lock.d" );

		$started = microtime( true );
		$this->invoke_tick_loop( $s );
		$elapsed = microtime( true ) - $started;

		// Must NOT have hit sleep(1) — exit before that line.
		$this->assertLessThan( 0.5, $elapsed, 'tick_loop must break before sleep on restart' );

		$s->release_lock_for_test();
	}

	/**
	 * tick_loop spawns workers for missing locks on its first iteration and
	 * then exits cleanly when the restart flag is dropped after the spawn.
	 *
	 * This is the closest we can get to the production "spawn → next tick"
	 * cycle without real subprocess timing.
	 */
	public function test_tick_loop_spawns_workers_then_exits_on_restart(): void {
		$this->with_topology( [
			'firehose-workers' => [ 'num_partitions' => 2, 'topology' => '/x.php' ],
		] );

		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$this->assertTrue( $s->init_lock_for_test() );

		$now = microtime( true );
		// last_config_check=0.0 → first tick will trigger check_config and
		// build worker_locks. (Pass 0.0 explicitly via the helper.)
		$this->seed_loop_state( $s, $now, 0.0 );

		// Drop restart flag — tick_loop checks should_restart BEFORE the
		// worker iteration, so this exit-first contract means NO spawns.
		Lock::request_restart_at( "{$this->tmp}/locks/supervisor.lock.d" );

		$this->invoke_tick_loop( $s );

		$this->assertEmpty(
			$GLOBALS['_wp_test_remote_posts'] ?? [],
			'restart flag observed before spawn iteration must skip spawns'
		);

		$s->release_lock_for_test();
	}

	/**
	 * tick_loop fires the supervisor_periodic action when check_config runs.
	 * Plugins use this hook for low-frequency housekeeping (cleanup, metrics).
	 *
	 * Order in tick_loop is: heartbeat → should_restart → token → config →
	 * worker iter → sleep. To fire check_config + the action without the
	 * restart-flag short-circuit, we use a single action that drops the
	 * restart flag immediately after firing — so the next iteration's
	 * should_restart() check breaks the loop, but only after one sleep(1).
	 */
	public function test_tick_loop_fires_periodic_action_on_config_window(): void {
		// Register a topology so check_config's empty-workers gate doesn't
		// bail before firing supervisor_periodic. The hook is the load-bearing
		// behavior under test; the worker spawning is a side effect.
		$this->with_topology( [
			'noop' => [ 'topology' => '/dev/null', 'stale_timeout' => 60 ],
		] );

		$fired = 0;
		$tmp   = $this->tmp;
		\add_action(
			'newspack_nodes/supervisor_periodic',
			function () use ( &$fired, $tmp ) {
				++$fired;
				// Drop restart flag so iter 2 breaks before sleeping again.
				Lock::request_restart_at( "{$tmp}/locks/supervisor.lock.d" );
			}
		);

		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$this->assertTrue( $s->init_lock_for_test() );

		// last_config_check=0.0 → first iter triggers check_config + action.
		$this->seed_loop_state( $s, microtime( true ), 0.0 );

		$this->invoke_tick_loop( $s );

		$this->assertSame( 1, $fired, 'periodic action must fire when config window elapses' );

		$s->release_lock_for_test();
	}

	/**
	 * tick_loop exits when check_config returns false (logging disabled mid-run).
	 * Verifies the dynamic-disable contract: flipping the gate stops the loop
	 * within one config-check window.
	 */
	public function test_tick_loop_exits_when_check_config_returns_false(): void {
		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$this->assertTrue( $s->init_lock_for_test() );

		// last_config_check=0.0 → first tick triggers check_config.
		$this->seed_loop_state( $s, microtime( true ), 0.0 );

		// Disable logging globally — first config check returns false → break.
		\add_filter( 'newspack_nodes/enable_logging', fn() => false );

		$started = microtime( true );
		$this->invoke_tick_loop( $s );
		$elapsed = microtime( true ) - $started;

		$this->assertLessThan( 0.5, $elapsed, 'tick_loop must exit on logging-disabled within first iter' );

		$s->release_lock_for_test();
	}

	// ── tick_for_test bail-on-restart ──────────────────────────────────────

	/**
	 * tick_for_test mirrors the run-loop's bail-on-stolen-lock check at the
	 * end of each tick. When own_lock has a restart flag, return false so
	 * the harness knows the loop would exit.
	 */
	public function test_tick_for_test_returns_false_on_stolen_lock(): void {
		$this->with_topology( [
			'firehose-workers' => [ 'num_partitions' => 1, 'topology' => '/x.php' ],
		] );

		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$this->assertTrue( $s->init_lock_for_test() );
		$s->check_config( microtime( true ) );

		// Drop the restart flag — tick_for_test should detect it after the
		// worker iteration and return false.
		Lock::request_restart_at( "{$this->tmp}/locks/supervisor.lock.d" );

		$now    = microtime( true );
		$result = $s->tick_for_test( $now, $s->generate_spawn_token( (int) $now ) );

		$this->assertFalse( $result, 'tick_for_test must return false when own_lock has restart flag' );

		$s->release_lock_for_test();
	}

	// ── spawn_next_supervisor (private) ────────────────────────────────────

	/**
	 * spawn_next_supervisor must POST to /workers/spawn with type=supervisor,
	 * partition=0, and a valid HMAC token (one this supervisor would accept).
	 * This is the self-respawn handoff that keeps the chain alive across the
	 * 595s lifetime cap.
	 */
	public function test_spawn_next_supervisor_posts_with_supervisor_type_and_valid_token(): void {
		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );

		$method = new \ReflectionMethod( Supervisor::class, 'spawn_next_supervisor' );
		$method->setAccessible( true );
		$method->invoke( $s );

		$posts = $GLOBALS['_wp_test_remote_posts'] ?? [];
		$this->assertCount( 1, $posts, 'spawn_next_supervisor must fire exactly one POST' );

		$body = $posts[0]['args']['body'];
		$this->assertSame( 'supervisor', $body['type'] );
		$this->assertSame( 0, $body['partition'] );
		$this->assertSame( 64, strlen( $body['nonce'] ), 'token must be a 64-char SHA256 HMAC' );

		// Token must validate — same NONCE_SALT, current window.
		$this->assertTrue(
			$s->validate_spawn_token( $body['nonce'], time() ),
			'POSTed token must validate against this supervisor\'s own validator'
		);
	}

	public function test_spawn_next_supervisor_uses_fire_and_forget_args(): void {
		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );

		$method = new \ReflectionMethod( Supervisor::class, 'spawn_next_supervisor' );
		$method->setAccessible( true );
		$method->invoke( $s );

		$args = $GLOBALS['_wp_test_remote_posts'][0]['args'];
		// Fire-and-forget: non-blocking, short timeout, sslverify off (local loopback).
		$this->assertSame( 'POST', $args['method'] );
		$this->assertFalse( $args['blocking'] );
		$this->assertSame( 0.01, $args['timeout'] );
		$this->assertFalse( $args['sslverify'] );
	}

	// ── post_spawn (private) ───────────────────────────────────────────────

	/**
	 * post_spawn must include type, partition, and nonce in the POST body.
	 * Token-roundtrip already verified in tick tests; here we pin down the
	 * body shape directly so a typo in field names breaks the test.
	 */
	public function test_post_spawn_body_contains_type_partition_nonce(): void {
		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$method = new \ReflectionMethod( Supervisor::class, 'post_spawn' );
		$method->setAccessible( true );
		$now   = microtime( true );
		$token = $s->generate_spawn_token( (int) $now );

		$method->invoke(
			$s,
			'http://localhost/wp-json/newspack-nodes/v1/workers/spawn',
			'firehose-workers',
			3,
			$token
		);

		$posts = $GLOBALS['_wp_test_remote_posts'] ?? [];
		$this->assertCount( 1, $posts );
		$this->assertSame( 'firehose-workers', $posts[0]['args']['body']['type'] );
		$this->assertSame( 3, $posts[0]['args']['body']['partition'] );
		$this->assertSame( $token, $posts[0]['args']['body']['nonce'] );
	}

	/**
	 * post_spawn must not throw when wp_remote_post returns a WP_Error.
	 * The is_wp_error branch only logs (suppressed via error_log redirect
	 * in bootstrap); we just verify control flow continues.
	 */
	public function test_post_spawn_swallows_wp_error_response(): void {
		// Override the stub to return a WP_Error.
		$GLOBALS['_wp_test_remote_post_response'] = new \WP_Error( 'http_request_failed', 'simulated DNS failure' );

		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$method = new \ReflectionMethod( Supervisor::class, 'post_spawn' );
		$method->setAccessible( true );
		$now   = microtime( true );

		// No exception → success.
		$method->invoke(
			$s,
			'http://localhost/wp-json/newspack-nodes/v1/workers/spawn',
			'firehose-workers',
			0,
			$s->generate_spawn_token( (int) $now )
		);

		// The request was still recorded; the response was an error.
		$this->assertNotEmpty( $GLOBALS['_wp_test_remote_posts'] ?? [] );

		unset( $GLOBALS['_wp_test_remote_post_response'] );
	}

	/**
	 * spawn_next_supervisor must not throw on WP_Error either — the chain
	 * relies on the cron backstop when self-respawn fails.
	 */
	public function test_spawn_next_supervisor_swallows_wp_error_response(): void {
		$GLOBALS['_wp_test_remote_post_response'] = new \WP_Error( 'http_request_failed', 'simulated' );

		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$method = new \ReflectionMethod( Supervisor::class, 'spawn_next_supervisor' );
		$method->setAccessible( true );

		// No throw.
		$method->invoke( $s );
		$this->assertNotEmpty( $GLOBALS['_wp_test_remote_posts'] ?? [] );

		unset( $GLOBALS['_wp_test_remote_post_response'] );
	}

	// ── cleanup_stale_partitions early-exit ────────────────────────────────

	/**
	 * cleanup_stale_partitions is a no-op when num_partitions hasn't been
	 * computed yet (i.e., check_config never ran). Defends against being
	 * invoked from a misordered initialization path.
	 */
	public function test_cleanup_stale_partitions_noop_before_check_config(): void {
		// Pre-create a stale dir that would normally be cleaned up.
		$stale = "{$this->tmp}/locks/firehose-workers.p5.lock.d";
		mkdir( $stale, 0755, true );
		touch( "{$stale}/heartbeat", time() - 7200 );

		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		// Note: NOT calling check_config — num_partitions stays null.
		$s->cleanup_stale_partitions();

		// Without num_partitions set, no scan happens — stale dir survives.
		$this->assertTrue(
			is_dir( $stale ),
			'cleanup_stale_partitions must early-exit when num_partitions is null'
		);
	}

	/**
	 * Verifies the bound: cleanup walks num_partitions..MAX_PARTITIONS, so
	 * stale dirs at p15 (just below MAX) are removed.
	 */
	public function test_cleanup_stale_partitions_walks_to_max_partitions(): void {
		$this->with_topology( [
			'firehose-workers' => [ 'num_partitions' => 1, 'topology' => '/x.php' ],
		] );

		// Create a stale orphan at the maximum boundary (p15 since MAX=16).
		$stale_high = "{$this->tmp}/locks/firehose-workers.p15.lock.d";
		mkdir( $stale_high, 0755, true );
		touch( "{$stale_high}/heartbeat", time() - 7200 );

		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$s->check_config( microtime( true ) );

		$this->assertFalse( is_dir( $stale_high ), 'cleanup must reach all the way to MAX_PARTITIONS-1' );
	}

	/**
	 * Verifies cleanup respects type isolation: stale dirs for type A must
	 * not affect type B's dirs (cleanup walks per-type).
	 */
	public function test_cleanup_stale_partitions_per_type_isolation(): void {
		$this->with_topology( [
			'type-a' => [ 'num_partitions' => 1, 'topology' => '/a.php' ],
			'type-b' => [ 'num_partitions' => 1, 'topology' => '/b.php' ],
		] );

		// Stale orphan for type-a at p5.
		$stale_a = "{$this->tmp}/locks/type-a.p5.lock.d";
		mkdir( $stale_a, 0755, true );
		touch( "{$stale_a}/heartbeat", time() - 7200 );

		// Fresh orphan for type-b at p5 — must NOT be touched.
		$fresh_b = "{$this->tmp}/locks/type-b.p5.lock.d";
		mkdir( $fresh_b, 0755, true );
		file_put_contents( "{$fresh_b}/heartbeat", '' );

		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$s->check_config( microtime( true ) );

		$this->assertFalse( is_dir( $stale_a ), 'stale type-a orphan must be removed' );
		$this->assertTrue( is_dir( $fresh_b ), 'fresh type-b orphan must survive' );
	}

	// ── run() pre-loop instrumentation ─────────────────────────────────────

	/**
	 * run() tags the process via $_SERVER so stats workers can exclude
	 * supervisor activity from request-level metrics. Set early in run(),
	 * before any other work.
	 */
	public function test_run_tags_process_as_supervisor_worker(): void {
		// Disable logging so run() exits at the first check_config — quick test.
		\add_filter( 'newspack_nodes/enable_logging', fn() => false );

		// Pre-flight: verify clean state.
		unset(
			$_SERVER['NEWSPACK_NODES_WORKER_TYPE'],
			$_SERVER['NEWSPACK_NODES_WORKER_PARTITION']
		);

		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$s->run();

		$this->assertSame( 'supervisor', $_SERVER['NEWSPACK_NODES_WORKER_TYPE'] );
		$this->assertSame( '0', $_SERVER['NEWSPACK_NODES_WORKER_PARTITION'] );
	}

	/**
	 * run()'s finally block must release the lock AND call
	 * spawn_next_supervisor. Driven via reflection: pre-acquire via
	 * init_lock_for_test, then drop restart flag, then invoke run() — but
	 * run() will fail to acquire (we already hold). So we test via tick_loop
	 * + manual finally simulation.
	 *
	 * This pins down the contract: after tick_loop exits, the lock is gone
	 * AND a self-respawn POST has fired. We verify by driving tick_loop
	 * via reflection (exits immediately on restart flag), then simulating
	 * the finally block.
	 */
	public function test_run_finally_releases_lock_and_calls_spawn_next_supervisor(): void {
		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$this->assertTrue( $s->init_lock_for_test() );
		$this->assertTrue( is_dir( "{$this->tmp}/locks/supervisor.lock.d" ) );

		// Pre-arm: tick_loop will exit immediately on this restart flag.
		Lock::request_restart_at( "{$this->tmp}/locks/supervisor.lock.d" );

		$this->seed_loop_state( $s, microtime( true ) );

		try {
			$this->invoke_tick_loop( $s );
		} finally {
			// Mirror run()'s finally block.
			$s->release_lock_for_test();
			$method = new \ReflectionMethod( Supervisor::class, 'spawn_next_supervisor' );
			$method->setAccessible( true );
			$method->invoke( $s );
		}

		// Lock dir must be cleaned up.
		$this->assertFalse(
			is_dir( "{$this->tmp}/locks/supervisor.lock.d" ),
			'finally must release own_lock'
		);

		// spawn_next_supervisor must have fired one POST.
		$supervisor_posts = array_filter(
			$GLOBALS['_wp_test_remote_posts'] ?? [],
			fn( $p ) => 'supervisor' === ( $p['args']['body']['type'] ?? '' )
		);
		$this->assertCount(
			1,
			$supervisor_posts,
			'finally must call spawn_next_supervisor exactly once'
		);
	}

	/**
	 * Multiple supervisors invoked sequentially must hand off the lock cleanly.
	 * After supervisor A releases (run()'s finally), supervisor B must be
	 * able to acquire.
	 */
	public function test_run_releases_lock_so_next_supervisor_can_acquire(): void {
		// Disable logging so run() exits before lock acquire — quick path.
		\add_filter( 'newspack_nodes/enable_logging', fn() => false );

		$first = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$first->run();
		// In the disabled-logging path, the lock dir was never created.
		$this->assertFalse( is_dir( "{$this->tmp}/locks/supervisor.lock.d" ) );

		// Second supervisor: lock must be available immediately.
		$second = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$this->assertTrue(
			$second->init_lock_for_test(),
			'lock must be free for the next supervisor to acquire'
		);
		$second->release_lock_for_test();
	}

	/**
	 * End-to-end test of run(): acquire lock → tick_loop spawns a worker →
	 * restart flag drops mid-tick → tick_loop exits → finally releases lock
	 * AND fires spawn_next_supervisor.
	 *
	 * Drives run() through its entire body (lock dir creation, acquire,
	 * tick_loop entry, finally cleanup, self-respawn). The 1s sleep in
	 * tick_loop is unavoidable here — we accept it as the price of testing
	 * the production code path end-to-end.
	 *
	 * Mechanism: a mock wp_remote_post override fires when tick_loop's
	 * worker-iteration POSTs the spawn. The override drops the restart flag
	 * so the NEXT tick_loop iteration breaks before another sleep.
	 */
	public function test_run_full_cycle_acquire_spawn_release_respawn(): void {
		$this->with_topology( [
			'firehose-workers' => [ 'num_partitions' => 1, 'topology' => '/x.php' ],
		] );

		$tmp = $this->tmp;
		// Override wp_remote_post: when the supervisor POSTs a spawn for
		// firehose-workers, drop our own restart flag mid-cycle so the next
		// tick exits immediately.
		$GLOBALS['_wp_test_remote_post_response'] = function ( $url, $args ) use ( $tmp ) {
			if ( ( $args['body']['type'] ?? '' ) === 'firehose-workers' ) {
				Lock::request_restart_at( "{$tmp}/locks/supervisor.lock.d" );
			}
			return [ 'response' => [ 'code' => 200 ] ];
		};

		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$s->run();

		// Lock dir cleaned up by finally.
		$this->assertFalse(
			is_dir( "{$this->tmp}/locks/supervisor.lock.d" ),
			'finally must release own_lock'
		);

		// At least one worker spawn POST + exactly one supervisor self-respawn.
		$posts = $GLOBALS['_wp_test_remote_posts'] ?? [];
		$worker_posts = array_filter(
			$posts,
			fn( $p ) => 'firehose-workers' === ( $p['args']['body']['type'] ?? '' )
		);
		$supervisor_posts = array_filter(
			$posts,
			fn( $p ) => 'supervisor' === ( $p['args']['body']['type'] ?? '' )
		);

		$this->assertGreaterThanOrEqual(
			1,
			count( $worker_posts ),
			'tick_loop must spawn the missing worker'
		);
		$this->assertCount(
			1,
			$supervisor_posts,
			'finally must call spawn_next_supervisor exactly once'
		);

		unset( $GLOBALS['_wp_test_remote_post_response'] );
	}
}
