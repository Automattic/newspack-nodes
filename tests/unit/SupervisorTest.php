<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Lock_Node;
use Newspack_Nodes\Log_Cleaner;
use Newspack_Nodes\Supervisor;
use Newspack_Nodes\Supervisor_Base;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\Medium;

#[Medium]
#[CoversClass( Supervisor::class )]
class SupervisorTest extends TestCase {
	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		$this->tmp                            = $this->make_temp_dir();
		$GLOBALS['_wp_actions']               = [];
		$GLOBALS['_test_outbound_posts']     = [];
		$GLOBALS['_wp_test_transients']       = [];
		Bootstrap::$supervisor_enabled_override = null;
		Bootstrap::$supervisor_factory          = null;
		$this->use_base_dir( $this->tmp );
		// Catalog registration alone no longer activates a topology — the active
		// set comes from the `topologies` config overlay. These tests drive the
		// active set purely through the catalog filter (none registers a stock
		// dir), so declare every type name they use as active; get_topologies()
		// then resolves to (catalog ∩ active), and a name dropped from the
		// catalog still drops from the active set (synthesize_entry returns null
		// for an unresolvable name). This preserves the add/remove-topology and
		// dropped-partition assertions verbatim.
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [
			'firehose-workers',
			'job-workers',
			'request-workers',
			'huge',
			'type-a',
			'type-b',
			'noop',
		];
		\Newspack_Nodes\Config::reset();
	}

	protected function tearDown(): void {
		$this->rmdir_recursive( $this->tmp );
		$GLOBALS['_wp_actions']           = [];
		$GLOBALS['_test_outbound_posts'] = [];
		$GLOBALS['_wp_test_transients']   = [];
		unset( $GLOBALS['_wp_options']['newspack_nodes_topologies'] );
		\Newspack_Nodes\Config::reset();
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
		Bootstrap::$supervisor_enabled_override = false;
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

	public function test_check_config_refuses_to_spawn_when_active_set_conflicts(): void {
		// Second line of defense behind the admin sanitizer: a config-FILE override
		// (LOCAL_NEWSPACK_NODES_CONF) can declare a conflicting active set the admin
		// UI never vetted. The supervisor must refuse to spawn ANY worker for a set
		// where two topologies write the same log, and say so loudly — better no
		// workers than two fleets corrupting the same partition.
		$stock = $this->make_temp_dir( 'supervisor-conflict-' );
		\file_put_contents( "{$stock}/combined.tsl", "make_node Partition requests:partition <config:logs_dir>/requests.log <partition>" );
		\file_put_contents( "{$stock}/rb.tsl", "make_node Partition requests:partition <config:logs_dir>/requests.log <partition>" );
		\Newspack_Nodes\Topology_Registry::reset();
		\Newspack_Nodes\Topology_Registry::register_stock_dir( $stock );
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'combined', 'rb' ];
		\Newspack_Nodes\Config::reset();
		\Newspack_Nodes\Core::$recent_log = [];

		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );

		$this->assertFalse( $s->check_config( microtime( true ) ), 'conflicting set must abort the supervisor' );
		$log = \implode( "\n", \Newspack_Nodes\Core::$recent_log );
		$this->assertStringContainsString( 'conflict', \strtolower( $log ), 'conflict must be logged loudly' );

		$this->rmdir_recursive( $stock );
		\Newspack_Nodes\Topology_Registry::reset();
	}

	// ── dirty-flag mechanism: signals Log_Cleaner that GC may be due ──────

	public function test_check_config_sets_logs_dirty_when_worker_dropped(): void {
		// First tick: two-type fleet. Second tick: one type. The drop
		// should set the `newspack_nodes_logs_dirty` option so Log_Cleaner
		// knows to scan on its next tick.
		$this->with_topology( [
			'firehose-workers' => [ 'num_partitions' => 1, 'topology' => '/x.php' ],
			'request-workers'  => [ 'num_partitions' => 1, 'topology' => '/y.php' ],
		] );
		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$s->check_config( microtime( true ) );
		$this->assertFalse( ! empty( $GLOBALS['_wp_options'][Log_Cleaner::LOGS_DIRTY_OPTION] ) );

		// Drop request-workers — only firehose-workers left.
		$GLOBALS['_wp_actions'] = [];
		$this->with_topology( [
			'firehose-workers' => [ 'num_partitions' => 1, 'topology' => '/x.php' ],
		] );
		$s->check_config( microtime( true ) + 1 );

		$this->assertTrue( ! empty( $GLOBALS['_wp_options'][Log_Cleaner::LOGS_DIRTY_OPTION] ) );
	}

	public function test_check_config_sets_logs_dirty_when_num_partitions_reduced(): void {
		// 2→1 partition drop: firehose-workers.p1 disappears from the fleet.
		$this->with_topology( [
			'firehose-workers' => [ 'num_partitions' => 2, 'topology' => '/x.php' ],
		] );
		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$s->check_config( microtime( true ) );
		$this->assertFalse( ! empty( $GLOBALS['_wp_options'][Log_Cleaner::LOGS_DIRTY_OPTION] ) );

		$GLOBALS['_wp_actions'] = [];
		$this->with_topology( [
			'firehose-workers' => [ 'num_partitions' => 1, 'topology' => '/x.php' ],
		] );
		$s->check_config( microtime( true ) + 1 );

		$this->assertTrue( ! empty( $GLOBALS['_wp_options'][Log_Cleaner::LOGS_DIRTY_OPTION] ) );
	}

	public function test_check_config_does_not_set_logs_dirty_when_unchanged(): void {
		$this->with_topology( [
			'firehose-workers' => [ 'num_partitions' => 1, 'topology' => '/x.php' ],
		] );
		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$s->check_config( microtime( true ) );
		$s->check_config( microtime( true ) + 1 );

		$this->assertFalse( ! empty( $GLOBALS['_wp_options'][Log_Cleaner::LOGS_DIRTY_OPTION] ) );
	}

	public function test_check_config_does_not_set_logs_dirty_when_worker_added(): void {
		// Pure addition (1→2 partitions, or new topology) does not orphan
		// anything — no cleanup needed.
		$this->with_topology( [
			'firehose-workers' => [ 'num_partitions' => 1, 'topology' => '/x.php' ],
		] );
		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$s->check_config( microtime( true ) );

		$GLOBALS['_wp_actions'] = [];
		$this->with_topology( [
			'firehose-workers' => [ 'num_partitions' => 2, 'topology' => '/x.php' ],
			'job-workers'      => [ 'num_partitions' => 1, 'topology' => '/y.php' ],
		] );
		$s->check_config( microtime( true ) + 1 );

		$this->assertFalse( ! empty( $GLOBALS['_wp_options'][Log_Cleaner::LOGS_DIRTY_OPTION] ) );
	}

	public function test_tick_loop_arms_log_cleaner_on_boot(): void {
		// Each supervisor process runs one cleanup pass on boot so on-disk
		// reality gets reconciled even when the fleet-shrink diff is empty
		// (e.g. a prior supervisor persisted the shrunk fleet_descriptors
		// before dying; pre-Log_Cleaner upgrade; manual `wp option` edits).
		// The arm fires once at the top of tick_loop, before the first
		// check_config call — Log_Cleaner picks it up on its next sweep.
		$this->with_topology( [
			'firehose-workers' => [ 'num_partitions' => 1, 'topology' => '/x.php' ],
		] );
		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );

		// Pre-seed FLEET_DESCRIPTORS to the current set so the existing
		// shrink-diff branch is a no-op — proves the arm comes from the
		// new lifecycle preamble, not the diff path.
		\update_option(
			Log_Cleaner::FLEET_DESCRIPTORS_OPTION,
			[ 'firehose-workers.p0' ]
		);

		// Seed loop state so tick_loop exits via MAX_SUPERVISOR_RUNTIME_S
		// on the first iteration (start_time well in the past) — we only
		// need the preamble to run.
		$this->assertTrue( $s->init_lock_for_test() );
		$this->seed_loop_state( $s, microtime( true ) - 1000.0 );
		$this->invoke_tick_loop( $s );

		$this->assertTrue(
			! empty( $GLOBALS['_wp_options'][ Log_Cleaner::LOGS_DIRTY_OPTION ] ),
			'tick_loop should arm Log_Cleaner once at boot'
		);
	}

	public function test_check_config_clamps_num_partitions_to_max(): void {
		$this->with_topology( [
			'huge' => [ 'num_partitions' => 9999, 'topology' => '/x.php' ],
		] );
		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );

		$s->check_config( microtime( true ) );

		$this->assertSame( Supervisor_Base::MAX_PARTITIONS, $s->num_partitions_for_test() );
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
		\touch( "{$locks_dir}/aggregator.p0.lock.d/heartbeat", time() - Lock_Node::STALE_TIMEOUT - 1 );
		\mkdir( "{$locks_dir}/firehose-workers.p0.lock.d" );
		\file_put_contents( "{$locks_dir}/firehose-workers.p0.lock.d/heartbeat", '0' );
		\mkdir( "{$locks_dir}/supervisor.lock.d" );
		\file_put_contents( "{$locks_dir}/supervisor.lock.d/heartbeat", '0' );
		\touch( "{$locks_dir}/supervisor.lock.d/heartbeat", time() - Lock_Node::STALE_TIMEOUT - 1 );

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

	public function test_check_config_releases_locks_for_dropped_partitions(): void {
		// Initial topology has firehose-workers running 2 partitions.
		$captured_topologies = [
			'firehose-workers' => [ 'num_partitions' => 2, 'topology' => '/x.php' ],
		];
		\add_filter( 'newspack_nodes/topologies', function () use ( &$captured_topologies ) {
			return $captured_topologies;
		} );

		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$s->check_config( microtime( true ) );

		// Simulate both partitions' lock dirs on disk.
		$locks_dir = $this->tmp . '/locks';
		\mkdir( $locks_dir, 0755, true );
		\mkdir( "{$locks_dir}/firehose-workers.p0.lock.d" );
		\mkdir( "{$locks_dir}/firehose-workers.p1.lock.d" );

		// Operator drops num_partitions from 2 to 1. The TYPE stays
		// active, but partition 1 should be flagged for restart-exit.
		// Without this, p1 keeps heartbeating forever (cleanup_stale_partitions
		// only catches heartbeat-cold dirs).
		$captured_topologies['firehose-workers']['num_partitions'] = 1;
		$s->check_config( microtime( true ) + 100 );

		$this->assertFileExists(
			"{$locks_dir}/firehose-workers.p1.lock.d/restart",
			'dropped partition should have restart flag dropped'
		);
		$this->assertFileDoesNotExist(
			"{$locks_dir}/firehose-workers.p0.lock.d/restart",
			'surviving partition should be left alone'
		);
	}

	public function test_check_config_grows_num_partitions_without_touching_existing_workers(): void {
		// Reverse of the shrink case: operator bumps num_partitions from 1
		// to 2. The existing p0 worker must be left alone (reconcile
		// recognizes p0 as in-fleet); p1 has no lock dir yet, so the
		// spawn loop will pick it up on its next iteration.
		$captured_topologies = [
			'firehose-workers' => [ 'num_partitions' => 1, 'topology' => '/x.php' ],
		];
		\add_filter( 'newspack_nodes/topologies', function () use ( &$captured_topologies ) {
			return $captured_topologies;
		} );

		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$s->check_config( microtime( true ) );

		$locks_dir = $this->tmp . '/locks';
		\mkdir( $locks_dir, 0755, true );
		\mkdir( "{$locks_dir}/firehose-workers.p0.lock.d" );
		\file_put_contents( "{$locks_dir}/firehose-workers.p0.lock.d/heartbeat", (string) time() );

		// Bump to 2.
		$captured_topologies['firehose-workers']['num_partitions'] = 2;
		$s->check_config( microtime( true ) + 100 );

		$this->assertFileDoesNotExist(
			"{$locks_dir}/firehose-workers.p0.lock.d/restart",
			'p0 (in fleet) must NOT receive a restart flag on growth'
		);
		$this->assertDirectoryExists(
			"{$locks_dir}/firehose-workers.p0.lock.d",
			'p0 lock dir must survive growth'
		);
	}

	public function test_check_config_releases_locks_for_orphan_partitions_at_cold_start(): void {
		// Fresh supervisor process (prev_num_partitions = null) inheriting
		// a p1 lock dir from a predecessor that was running with
		// num_partitions=2. Current config says 1, so p1 is orphaned.
		// State-free cleanup MUST flag it for restart-exit on the first
		// check_config tick — the supervisor has no in-memory record of
		// the previous fleet size to diff against.
		$this->with_topology( [
			'firehose-workers' => [ 'num_partitions' => 1, 'topology' => '/x.php' ],
		] );
		$locks_dir = $this->tmp . '/locks';
		\mkdir( $locks_dir, 0755, true );
		\mkdir( "{$locks_dir}/firehose-workers.p0.lock.d" );
		\mkdir( "{$locks_dir}/firehose-workers.p1.lock.d" );
		// Fresh heartbeat — looks live, not stale.
		\file_put_contents( "{$locks_dir}/firehose-workers.p1.lock.d/heartbeat", '' );

		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$s->check_config( microtime( true ) );

		$this->assertFileExists(
			"{$locks_dir}/firehose-workers.p1.lock.d/restart",
			'cold-start supervisor must still flag orphan partitions'
		);
		$this->assertFileDoesNotExist(
			"{$locks_dir}/firehose-workers.p0.lock.d/restart",
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

		$posts = $GLOBALS['_test_outbound_posts'] ?? [];
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
		$posts = $GLOBALS['_test_outbound_posts'] ?? [];
		$job_spawns = \array_values( \array_filter(
			$posts,
			fn ( $p ) => 'job-workers' === ( $p['args']['body']['type'] ?? '' )
		) );
		$this->assertCount( 0, $job_spawns, 'newly added topology should defer first spawn' );

		// Tick after the spawn-deferral window — job-workers should spawn now.
		$GLOBALS['_test_outbound_posts'] = [];
		$s->tick_for_test( $detect_now + 6, $token );
		$posts      = $GLOBALS['_test_outbound_posts'] ?? [];
		$job_spawns = \array_values( \array_filter(
			$posts,
			fn ( $p ) => 'job-workers' === ( $p['args']['body']['type'] ?? '' )
		) );
		$this->assertCount( 1, $job_spawns, 'deferred topology should spawn after window' );
	}

	public function test_tick_spawns_for_stale_lock(): void {
		// Lock dir exists but heartbeat is older than STALE_TIMEOUT —
		// previous holder crashed without releasing. Supervisor must
		// respawn, matching the worker_needs_spawn contract. Distinct
		// from `test_tick_spawns_for_missing_lock` (no dir at all) and
		// `test_tick_skips_workers_with_fresh_locks` (live worker).
		$this->with_topology( [
			'firehose-workers' => [ 'num_partitions' => 1, 'topology' => '/x.php' ],
		] );
		$lock_dir = "{$this->tmp}/locks/firehose-workers.p0.lock.d";
		mkdir( $lock_dir, 0755, true );
		touch( "{$lock_dir}/heartbeat", time() - Lock_Node::STALE_TIMEOUT - 5 );

		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$s->check_config( microtime( true ) );

		$now = microtime( true );
		$s->tick_for_test( $now, $s->generate_spawn_token( (int) $now ) );

		$posts = $GLOBALS['_test_outbound_posts'] ?? [];
		$this->assertCount( 1, $posts, 'stale lock should trigger respawn' );
		$this->assertSame( 'firehose-workers', $posts[0]['args']['body']['type'] );
		$this->assertSame( 0, (int) $posts[0]['args']['body']['partition'] );
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

		$this->assertEmpty( $GLOBALS['_test_outbound_posts'] ?? [] );
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
		$this->assertCount( 1, $GLOBALS['_test_outbound_posts'] ?? [] );

		// Second tick within rate-limit window: no spawn.
		$s->tick_for_test( $now + 5, $token );
		$this->assertCount( 1, $GLOBALS['_test_outbound_posts'] ?? [] );

		// Third tick after rate-limit window: spawns again (lock still missing).
		$s->tick_for_test( $now + 20, $token );
		$this->assertCount( 2, $GLOBALS['_test_outbound_posts'] ?? [] );
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
		$this->assertCount( 1, $GLOBALS['_test_outbound_posts'] ?? [] );

		// Fresh supervisor (cron backstop after crash, or self-respawn).
		$second = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$second->check_config( $now + 5 );
		$second->tick_for_test( $now + 5, $token );

		// No additional spawn — the persisted timestamp gates this.
		$this->assertCount(
			1,
			$GLOBALS['_test_outbound_posts'] ?? [],
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
		Bootstrap::$supervisor_enabled_override = false;
		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );

		$s->run();

		// No supervisor lock was created — exited at first check_config.
		$this->assertFalse( is_dir( "{$this->tmp}/locks/supervisor.lock.d" ) );
	}

	public function test_run_returns_when_another_supervisor_holds_lock(): void {
		// Pre-acquire the lock externally — run() should bail without
		// firing any spawns.
		$external_lock = new Lock_Node( "{$this->tmp}/locks/supervisor.lock.d", 60 );
		mkdir( "{$this->tmp}/locks", 0755, true );
		$this->assertTrue( $external_lock->acquire() );

		$this->with_topology( [
			'firehose-workers' => [ 'num_partitions' => 1, 'topology' => '/x.php' ],
		] );

		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$s->run();

		$this->assertEmpty(
			$GLOBALS['_test_outbound_posts'] ?? [],
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
			'fresh orphans within the cleanup grace period must survive'
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
				Lock_Node::is_restart_pending( "{$this->tmp}/locks/firehose-workers.p{$p}.lock.d" ),
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
		$this->assertTrue( Lock_Node::is_restart_pending( "{$this->tmp}/locks/firehose-workers.p0.lock.d" ) );
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
		Lock_Node::request_restart_at( "{$this->tmp}/locks/supervisor.lock.d" );

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
		Lock_Node::request_restart_at( "{$this->tmp}/locks/supervisor.lock.d" );

		$this->invoke_tick_loop( $s );

		$this->assertEmpty(
			$GLOBALS['_test_outbound_posts'] ?? [],
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
		// bail before firing supervisor_periodic. The hook is the
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
				Lock_Node::request_restart_at( "{$tmp}/locks/supervisor.lock.d" );
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
	 * tick_loop GCs orphan partition directories — `logs/*.log/p{N}/` and
	 * `offsets/*.p{N}/` where N >= num_partitions and no `*.p{N}.lock.d/`
	 * exists — once per check_config window. End-to-end: real filesystem,
	 * real Log_Cleaner, real check_config. Confirms the call is wired into
	 * the tick_loop, not just present somewhere in the class.
	 */
	public function test_tick_loop_cleans_orphan_partition_dirs_on_config_window(): void {
		// Register a single-partition topology so num_partitions resolves to 1.
		$this->with_topology( [
			'noop' => [ 'topology' => '/dev/null', 'num_partitions' => 1, 'stale_timeout' => 60 ],
		] );

		// Seed an orphan p1/ data dir + matching offsetlog dir (no lock dir → safe to clean).
		\mkdir( "{$this->tmp}/logs/firehose.log/p1", 0755, true );
		\file_put_contents( "{$this->tmp}/logs/firehose.log/p1/0.log", 'stale' );
		\mkdir( "{$this->tmp}/offsets/firehose.p1/p0", 0755, true );
		\file_put_contents( "{$this->tmp}/offsets/firehose.p1/p0/0.log", 'stale' );

		// Arm the dirty flag — in production, check_config sets it when
		// it detects a fleet shrink; this test exercises the cleanup
		// branch downstream of that, so we set the flag directly.
		\update_option( Log_Cleaner::LOGS_DIRTY_OPTION, '1' );

		// Periodic hook callback drops the restart flag so iter 2 breaks
		// the loop. Matches the pattern used by the other tick_loop tests.
		$tmp = $this->tmp;
		\add_action(
			'newspack_nodes/supervisor_periodic',
			function () use ( $tmp ) {
				Lock_Node::request_restart_at( "{$tmp}/locks/supervisor.lock.d" );
			}
		);

		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$this->assertTrue( $s->init_lock_for_test() );
		$this->seed_loop_state( $s, microtime( true ), 0.0 );

		$this->invoke_tick_loop( $s );

		$this->assertDirectoryDoesNotExist( "{$this->tmp}/logs/firehose.log/p1" );
		$this->assertDirectoryDoesNotExist( "{$this->tmp}/offsets/firehose.p1" );

		$s->release_lock_for_test();
	}

	/**
	 * tick_loop's GC must NOT touch p{N} dirs that still have a live lock —
	 * that's the "worker is still running, don't yank the rug" gate.
	 */
	public function test_tick_loop_skips_partition_dir_when_lock_dir_exists(): void {
		$this->with_topology( [
			'noop' => [ 'topology' => '/dev/null', 'num_partitions' => 1, 'stale_timeout' => 60 ],
		] );

		\mkdir( "{$this->tmp}/logs/firehose.log/p1", 0755, true );
		\file_put_contents( "{$this->tmp}/logs/firehose.log/p1/0.log", 'guarded' );
		\mkdir( "{$this->tmp}/locks/firehose-workers.p1.lock.d", 0755, true );
		\file_put_contents( "{$this->tmp}/locks/firehose-workers.p1.lock.d/heartbeat", (string) \getmypid() );
		\update_option( Log_Cleaner::LOGS_DIRTY_OPTION, '1' );

		$tmp = $this->tmp;
		\add_action(
			'newspack_nodes/supervisor_periodic',
			function () use ( $tmp ) {
				Lock_Node::request_restart_at( "{$tmp}/locks/supervisor.lock.d" );
			}
		);

		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$this->assertTrue( $s->init_lock_for_test() );
		$this->seed_loop_state( $s, microtime( true ), 0.0 );

		$this->invoke_tick_loop( $s );

		$this->assertDirectoryExists( "{$this->tmp}/logs/firehose.log/p1" );
		$this->assertFileExists( "{$this->tmp}/logs/firehose.log/p1/0.log" );

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
		Bootstrap::$supervisor_enabled_override = false;

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
		Lock_Node::request_restart_at( "{$this->tmp}/locks/supervisor.lock.d" );

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

		$posts = $GLOBALS['_test_outbound_posts'] ?? [];
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

		$args = $GLOBALS['_test_outbound_posts'][0]['args'];
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

		$posts = $GLOBALS['_test_outbound_posts'] ?? [];
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
		$this->assertNotEmpty( $GLOBALS['_test_outbound_posts'] ?? [] );

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
		$this->assertNotEmpty( $GLOBALS['_test_outbound_posts'] ?? [] );

		unset( $GLOBALS['_wp_test_remote_post_response'] );
	}

	// ── reconcile_lock_dirs early-exit ─────────────────────────────────────

	/**
	 * reconcile_lock_dirs is a no-op when called before check_config has
	 * populated `$active_types` — defends against mass-reaping live lock
	 * dirs if a misordered initialization path ever calls it cold.
	 */
	public function test_reconcile_lock_dirs_noop_before_check_config(): void {
		// Pre-create a stale dir that would normally be cleaned up.
		$stale = "{$this->tmp}/locks/firehose-workers.p5.lock.d";
		mkdir( $stale, 0755, true );
		touch( "{$stale}/heartbeat", time() - 7200 );

		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		// Note: NOT calling check_config — active_types stays [].
		$s->reconcile_lock_dirs();

		// Empty active_types must not be treated as "every dir is orphan".
		$this->assertTrue(
			is_dir( $stale ),
			'reconcile_lock_dirs must early-exit when active_types is empty'
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

	// ── steal-scratch reaping ──────────────────────────────────────────────

	/**
	 * Lock_Node's atomic steal renames the dir aside to `*.lock.d.stealing.*`
	 * and normally removes it microseconds later. A process killed mid-steal
	 * leaks that scratch dir, and nothing else reaps it. reconcile_lock_dirs
	 * sweeps aged scratch dirs (past STALE_TIMEOUT — well beyond any in-flight
	 * steal, so a live steal is never reaped).
	 */
	public function test_reconcile_reaps_aged_steal_scratch_dirs(): void {
		$this->with_topology( [
			'firehose-workers' => [ 'num_partitions' => 1, 'topology' => '/x.php' ],
		] );

		$leaked = "{$this->tmp}/locks/firehose-workers.p0.lock.d.stealing.12345.deadbeef";
		mkdir( $leaked, 0755, true );
		file_put_contents( "{$leaked}/heartbeat", '12345' );
		touch( $leaked, time() - ( \Newspack_Nodes\Lock_Node::STALE_TIMEOUT + 5 ) );

		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$s->check_config( microtime( true ) );

		$this->assertFalse( is_dir( $leaked ), 'aged steal-scratch dir must be reaped' );
	}

	/**
	 * A scratch dir younger than STALE_TIMEOUT may belong to an in-flight steal
	 * in another process — reconcile must NOT reap it.
	 */
	public function test_reconcile_spares_fresh_steal_scratch_dirs(): void {
		$this->with_topology( [
			'firehose-workers' => [ 'num_partitions' => 1, 'topology' => '/x.php' ],
		] );

		$fresh = "{$this->tmp}/locks/firehose-workers.p0.lock.d.stealing.999.cafe";
		mkdir( $fresh, 0755, true );
		// mtime ~now (default) — an in-flight steal.

		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$s->check_config( microtime( true ) );

		$this->assertTrue( is_dir( $fresh ), 'a fresh (in-flight) steal-scratch dir must survive' );
	}

	// ── run() pre-loop instrumentation ─────────────────────────────────────

	/**
	 * run() tags the process via $_SERVER so stats workers can exclude
	 * supervisor activity from request-level metrics. Set early in run(),
	 * before any other work.
	 */
	public function test_run_tags_process_as_supervisor_worker(): void {
		// Disable logging so run() exits at the first check_config — quick test.
		Bootstrap::$supervisor_enabled_override = false;

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
		Lock_Node::request_restart_at( "{$this->tmp}/locks/supervisor.lock.d" );

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
			$GLOBALS['_test_outbound_posts'] ?? [],
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
		Bootstrap::$supervisor_enabled_override = false;

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
				Lock_Node::request_restart_at( "{$tmp}/locks/supervisor.lock.d" );
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
		$posts = $GLOBALS['_test_outbound_posts'] ?? [];
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

	// HMAC token rejection: a token from a future window (clock skew) is
	// rejected too — only current OR previous window validates.
	public function test_validate_spawn_token_rejects_future_window(): void {
		$s = new Supervisor( '/tmp', 'NONCE_SALT_FOR_TEST' );
		// Token generated 20s in the FUTURE relative to validation moment.
		$future_token = $s->generate_spawn_token( 1000020 );
		$this->assertFalse(
			$s->validate_spawn_token( $future_token, 1000000 ),
			'future-window tokens must not validate'
		);
	}

	// Spec: SUPERVISOR_STALE_TIMEOUT pinned to 60s. Heartbeat fires at
	// stale/6 = ~10s intervals.
	public function test_supervisor_stale_timeout_constant(): void {
		$this->assertSame( 60, Supervisor::SUPERVISOR_STALE_TIMEOUT );
	}

	// New-type spawn deferral constant.
	public function test_new_type_spawn_delay_constant(): void {
		$this->assertSame( 5, Supervisor::NEW_TYPE_SPAWN_DELAY_S );
	}

	// tick_loop heartbeat refresh: the heartbeat slot is touched when
	// (now - last_heartbeat) >= STALE_TIMEOUT/6 (=10s).
	public function test_tick_loop_refreshes_heartbeat_when_window_elapsed(): void {
		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$this->assertTrue( $s->init_lock_for_test() );

		$now = microtime( true );
		$this->seed_loop_state( $s, $now );
		// Backdate last_heartbeat far into the past so the (>=10s) branch fires.
		$hb_prop = new \ReflectionProperty( Supervisor::class, 'last_heartbeat' );
		$hb_prop->setAccessible( true );
		$hb_prop->setValue( $s, $now - 100.0 );

		// Drop restart flag so tick_loop exits after the first iteration's
		// heartbeat refresh — before sleep().
		Lock_Node::request_restart_at( "{$this->tmp}/locks/supervisor.lock.d" );

		$this->invoke_tick_loop( $s );

		$new_hb = (float) $hb_prop->getValue( $s );
		$this->assertGreaterThan(
			$now - 1.0,
			$new_hb,
			'tick_loop must refresh last_heartbeat when the window has elapsed'
		);

		$s->release_lock_for_test();
	}

	// reconcile_lock_dirs idempotency: a second pass over a dir whose
	// restart flag is already present must NOT rewrite the file (spec
	// "skip rewriting if one's already dropped — every 15s tick stomps
	// the file otherwise, just wasted disk churn"). We verify by stamping
	// the existing flag's CONTENTS with a sentinel and checking it survives
	// the second reconcile.
	public function test_reconcile_lock_dirs_does_not_rewrite_existing_restart_flag(): void {
		$this->with_topology( [
			'firehose-workers' => [ 'num_partitions' => 1, 'topology' => '/x.php' ],
		] );

		$locks_dir = "{$this->tmp}/locks";
		mkdir( $locks_dir, 0755, true );
		$orphan_dir = "{$locks_dir}/firehose-workers.p1.lock.d";
		mkdir( $orphan_dir, 0755, true );
		// Fresh heartbeat so remove_stale_directory doesn't reap immediately.
		file_put_contents( "{$orphan_dir}/heartbeat", '' );

		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$s->check_config( microtime( true ) );

		$flag_path = "{$orphan_dir}/restart";
		$this->assertFileExists( $flag_path );

		// Stamp the flag with a sentinel that the supervisor's
		// request_restart_at would overwrite with `time()` if it were
		// called. A different sentinel proves no rewrite happened.
		file_put_contents( $flag_path, 'sentinel-do-not-overwrite' );

		// Second reconcile pass — must NOT rewrite the flag.
		$s->check_config( microtime( true ) + 100 );

		$this->assertSame(
			'sentinel-do-not-overwrite',
			file_get_contents( $flag_path ),
			'second reconcile must NOT rewrite the restart flag'
		);
	}

	// tick_for_test deferred-spawn clearing: when spawn_after[type]'s
	// deadline has elapsed, the entry must be unset after the spawn fires
	// — line 537 in source. Lets subsequent ticks proceed without the
	// deferral check.
	public function test_tick_for_test_clears_spawn_after_once_window_passes(): void {
		$this->with_topology( [
			'firehose-workers' => [ 'num_partitions' => 1, 'topology' => '/x.php' ],
		] );

		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$s->check_config( microtime( true ) );

		// Inject a spawn_after deferral in the past so the elapsed-window
		// path runs (rather than the not-yet-elapsed continue).
		$prop = new \ReflectionProperty( Supervisor::class, 'spawn_after' );
		$prop->setAccessible( true );
		$prop->setValue( $s, [ 'firehose-workers' => microtime( true ) - 1.0 ] );

		$now = microtime( true );
		$s->tick_for_test( $now, $s->generate_spawn_token( (int) $now ) );

		// Spawn should have fired AND the deferred entry should be cleared.
		$this->assertNotEmpty( $GLOBALS['_test_outbound_posts'] ?? [] );
		$this->assertArrayNotHasKey(
			'firehose-workers',
			$prop->getValue( $s ),
			'deferred key must be unset once window has elapsed'
		);
	}

	// ── cleanup_orphan_ipc (driven via reflection) ──────────────────────────

	private function seed_ipc_dir( string $type, int $partition ): string {
		$dir = "{$this->tmp}/ipc/{$type}.p{$partition}/output";
		\mkdir( $dir, 0755, true );
		\file_put_contents( "{$dir}/0.log", 'ipc data' );
		return "{$this->tmp}/ipc/{$type}.p{$partition}";
	}

	private function invoke_cleanup_orphan_ipc( Supervisor $s ): void {
		$method = new \ReflectionMethod( Supervisor::class, 'cleanup_orphan_ipc' );
		$method->setAccessible( true );
		$method->invoke( $s );
	}

	/**
	 * cleanup_orphan_ipc reaps ipc dirs for `{type}.p{N}` not in the active
	 * fleet (worker_locks), and leaves active ones alone. Active set comes
	 * from check_config's worker_locks build — no re-enumeration.
	 */
	public function test_cleanup_orphan_ipc_purges_inactive_topology(): void {
		$this->with_topology( [
			'firehose-workers' => [ 'num_partitions' => 1, 'topology' => '/x.php' ],
		] );
		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$s->check_config( microtime( true ) );

		$kept   = $this->seed_ipc_dir( 'firehose-workers', 0 );  // active -> kept
		$orphan = $this->seed_ipc_dir( 'aggregator', 0 );        // dead topology -> purged

		$this->invoke_cleanup_orphan_ipc( $s );

		$this->assertDirectoryExists( $kept );
		$this->assertDirectoryDoesNotExist( $orphan );
	}

	/**
	 * A live worker's lock for the orphan descriptor defers its own ipc reap —
	 * the worker may still be flushing through that dir.
	 */
	public function test_cleanup_orphan_ipc_skips_when_own_lock_held(): void {
		$this->with_topology( [
			'firehose-workers' => [ 'num_partitions' => 1, 'topology' => '/x.php' ],
		] );
		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$s->check_config( microtime( true ) );

		$orphan = $this->seed_ipc_dir( 'aggregator', 0 );
		\mkdir( "{$this->tmp}/locks/aggregator.p0.lock.d", 0755, true ); // straggler still running

		$this->invoke_cleanup_orphan_ipc( $s );

		$this->assertDirectoryExists( $orphan );
	}

	/**
	 * An UNRELATED descriptor's lock must NOT protect a dead topology's ipc
	 * dir — only the orphan's OWN lock defers it.
	 */
	public function test_cleanup_orphan_ipc_purges_despite_unrelated_lock(): void {
		$this->with_topology( [
			'firehose-workers' => [ 'num_partitions' => 1, 'topology' => '/x.php' ],
		] );
		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$s->check_config( microtime( true ) );

		$orphan = $this->seed_ipc_dir( 'aggregator', 0 );
		// Unrelated live worker at firehose-workers.p0 must NOT protect the dead topology's ipc dir.
		\mkdir( "{$this->tmp}/locks/firehose-workers.p0.lock.d", 0755, true );

		$this->invoke_cleanup_orphan_ipc( $s );

		$this->assertDirectoryDoesNotExist( $orphan );
	}

	/** A non-`.p{N}` dir under ipc/ is left alone (defensive: never reap a stray dir). */
	public function test_cleanup_orphan_ipc_leaves_non_partition_dirs_alone(): void {
		$this->with_topology( [
			'firehose-workers' => [ 'num_partitions' => 1, 'topology' => '/x.php' ],
		] );
		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$s->check_config( microtime( true ) );

		$stray = "{$this->tmp}/ipc/scratch";
		\mkdir( $stray, 0755, true );

		$this->invoke_cleanup_orphan_ipc( $s );

		$this->assertDirectoryExists( $stray );
	}

	// kill_readers MAX_PARTITIONS fallback: a type not in topology is
	// flagged across the full MAX_PARTITIONS range so any orphan dir is
	// cleaned up.
	public function test_kill_readers_uses_max_partitions_for_type_not_in_topology(): void {
		$this->with_topology( [
			'firehose-workers' => [ 'num_partitions' => 1, 'topology' => '/x.php' ],
		] );

		// Pre-create orphan lock dirs at partitions NOT covered by the
		// (empty) topology entry for 'orphan-type'.
		$locks_dir = "{$this->tmp}/locks";
		mkdir( $locks_dir, 0755, true );
		mkdir( "{$locks_dir}/orphan-type.p0.lock.d", 0755, true );
		mkdir( "{$locks_dir}/orphan-type.p3.lock.d", 0755, true );

		$s = new Supervisor( $this->tmp, 'NONCE_SALT_FOR_TEST' );
		$s->kill_readers( [ 'orphan-type' ] );

		// Both existing partitions get the restart flag — kill_readers
		// fell back to MAX_PARTITIONS so even p3 is reached.
		$this->assertTrue( Lock_Node::is_restart_pending( "{$locks_dir}/orphan-type.p0.lock.d" ) );
		$this->assertTrue( Lock_Node::is_restart_pending( "{$locks_dir}/orphan-type.p3.lock.d" ) );
	}
}
