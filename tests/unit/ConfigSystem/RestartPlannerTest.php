<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit\ConfigSystem;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Config;
use Newspack_Nodes\Failures;
use Newspack_Nodes\Config_System\Restart_Planner;
use Newspack_Nodes\Lock_Node;
use Newspack_Nodes\Topology_Registry;
use Newspack_Nodes\Worker_Should_Stop;
use Newspack_Nodes\Tests\TestCase;

#[CoversClass( Restart_Planner::class )]
class RestartPlannerTest extends TestCase {

	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		Topology_Registry::reset();
		$this->tmp = $this->stock_topology_dir( 'restart-planner-' );
		// Active set = these topologies (1 partition each, except multipart=3).
		// Config memoizes the overlay in load_config(), so invalidate it after
		// writing the option.
		\update_option( 'newspack_nodes_topologies', [ 'combined', 'aggregator', 'job-worker', 'multipart' ] );
		Config::reset();
		$this->write_tsl( 'combined', "make_node Partition requests:partition <config:logs_dir>/requests.p<partition> 1 2 0\nmake_node Tee fanout\n" );
		$this->write_tsl( 'aggregator', "make_node Topic firehose:topic <config:logs_dir>/firehose.p{partition} 1 1 2 0\n" );
		$this->write_tsl( 'job-worker', "make_node Consumer jobintake:consumer <config:logs_dir>/jobintake.p<partition> <config:offsets_dir>/ji.p<partition>\nmake_node Job_Worker job-worker\n" );
		// 3-partition topology with a node type (Echo) unique to it, so a save
		// classified for Echo restarts only multipart and fans out over .p0-.p2.
		$this->write_tsl( 'multipart', "var num_partitions = 3\nmake_node Echo relay\n" );
	}

	protected function tearDown(): void {
		\delete_option( 'newspack_nodes_topologies' );
		Config::reset();
		Topology_Registry::reset();
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	public function test_empty_classification_resolves_to_nothing(): void {
		$this->assertSame( [], Restart_Planner::topologies_for( [] ) );
	}

	public function test_all_resolves_to_every_active_topology(): void {
		$this->assertEqualsCanonicalizing(
			[ 'combined', 'aggregator', 'job-worker', 'multipart' ],
			\array_keys( Restart_Planner::topologies_for( 'all' ) )
		);
	}

	public function test_node_type_matches_only_topologies_with_that_node(): void {
		// Partition lives in combined; Topic in aggregator → geometry restarts both, not job-worker.
		$this->assertEqualsCanonicalizing(
			[ 'combined', 'aggregator' ],
			\array_keys( Restart_Planner::topologies_for( [ 'Partition', 'Topic', 'Log' ] ) )
		);
		// Tee only in combined.
		$this->assertSame( [ 'combined' ], \array_keys( Restart_Planner::topologies_for( [ 'Tee' ] ) ) );
		// Job_Worker only in job-worker.
		$this->assertSame( [ 'job-worker' ], \array_keys( Restart_Planner::topologies_for( [ 'Job_Worker' ] ) ) );
	}

	public function test_a_vault_groups_child_type_matches_its_topology(): void {
		$this->seed_vault_servers( [ 'tw9' => [ 'url' => 'https://tw9.example', 'group' => 'tw-edge' ] ] );
		$this->write_tsl( 'pull-lab', "make_node Vault_Group firehose Remote_Source tw-edge <config:offsets_dir>/<topology>.{id} <config:deadletter_dir>/<topology>.{id} firehose.p<partition>:next\n" );
		\update_option( 'newspack_nodes_topologies', [ 'combined', 'pull-lab' ] );
		Config::reset();

		$this->assertSame( [ 'pull-lab' ], \array_keys( Restart_Planner::topologies_for( [ 'Remote_Source' ] ) ) );
	}

	public function test_unknown_node_type_resolves_to_nothing(): void {
		$this->assertSame( [], Restart_Planner::topologies_for( [ 'No_Such_Node' ] ) );
	}

	public function test_request_restarts_touches_only_live_lock_dirs(): void {
		$base  = $this->make_temp_dir( 'kea-7713-base-' );
		$locks = "{$base}/locks";
		\mkdir( "{$locks}/combined.p0.lock.d", 0777, true );
		$touched = Restart_Planner::request_restarts( [ 'Tee' ], $base );
		$this->assertSame( [ 'combined' ], $touched );
		$this->assertFileExists( "{$locks}/combined.p0.lock.d/" . Lock_Node::RESTART_FLAG );
		$this->rmdir_recursive( $base );
	}

	public function test_request_restarts_fans_out_over_every_partition(): void {
		// multipart declares `var num_partitions = 3` → touch .p0/.p1/.p2, not .p3.
		$base  = $this->make_temp_dir( 'kea-7713-base-' );
		$locks = "{$base}/locks";
		\mkdir( "{$locks}/multipart.p0.lock.d", 0777, true );
		\mkdir( "{$locks}/multipart.p1.lock.d", 0777, true );
		\mkdir( "{$locks}/multipart.p2.lock.d", 0777, true );
		$touched = Restart_Planner::request_restarts( [ 'Echo' ], $base );
		$this->assertSame( [ 'multipart' ], $touched );
		$this->assertFileExists( "{$locks}/multipart.p0.lock.d/" . Lock_Node::RESTART_FLAG );
		$this->assertFileExists( "{$locks}/multipart.p1.lock.d/" . Lock_Node::RESTART_FLAG );
		$this->assertFileExists( "{$locks}/multipart.p2.lock.d/" . Lock_Node::RESTART_FLAG );
		$this->assertDirectoryDoesNotExist( "{$locks}/multipart.p3.lock.d" );
		$this->rmdir_recursive( $base );
	}

	public function test_request_reloads_covers_every_active_topology_and_partition(): void {
		// Unclassified by design: every worker alive holds a Config cache frozen
		// at boot, whatever the saved field's restart classification says.
		$base  = $this->make_temp_dir( 'kea-7713-base-' );
		$locks = "{$base}/locks";
		\mkdir( "{$locks}/combined.p0.lock.d", 0777, true );
		\mkdir( "{$locks}/job-worker.p0.lock.d", 0777, true );
		for ( $p = 0; $p < 3; $p++ ) {
			\mkdir( "{$locks}/multipart.p{$p}.lock.d", 0777, true );
		}

		$touched = Restart_Planner::request_reloads( $base );

		$this->assertEqualsCanonicalizing( [ 'combined', 'aggregator', 'job-worker', 'multipart' ], $touched );
		$this->assertFileExists( "{$locks}/combined.p0.lock.d/" . Lock_Node::RELOAD_FLAG );
		$this->assertFileExists( "{$locks}/job-worker.p0.lock.d/" . Lock_Node::RELOAD_FLAG );
		for ( $p = 0; $p < 3; $p++ ) {
			$this->assertFileExists( "{$locks}/multipart.p{$p}.lock.d/" . Lock_Node::RELOAD_FLAG );
		}
		$this->assertFileDoesNotExist( "{$locks}/combined.p0.lock.d/" . Lock_Node::RESTART_FLAG, 're-read, never recycle' );
		$this->rmdir_recursive( $base );
	}

	public function test_an_unreadable_topology_spares_the_rest_and_raises_after_them(): void {
		// One broken .tsl must not stop every restart: the readable topologies
		// are signalled first, and the one that would not parse escapes after.
		$this->write_tsl( 'fractured', "make_node Echo twin-4471\nmake_node Null twin-4471\n" );
		\update_option( 'newspack_nodes_topologies', [ 'combined', 'fractured', 'multipart' ] );
		Config::reset();
		$base  = $this->make_temp_dir( 'kea-7713-base-' );
		$locks = "{$base}/locks";
		foreach ( [ 'combined.p0', 'fractured.p0', 'multipart.p0', 'multipart.p1', 'multipart.p2' ] as $slot ) {
			\mkdir( "{$locks}/{$slot}.lock.d", 0777, true );
		}

		$thrown = null;
		try {
			Restart_Planner::request_restarts( [ 'Echo', 'Tee' ], $base );
		} catch ( \RuntimeException $e ) {
			$thrown = $e;
		}

		$this->assertNotNull( $thrown, 'the unreadable topology is raised' );
		$this->assertFileExists( "{$locks}/combined.p0.lock.d/" . Lock_Node::RESTART_FLAG );
		$this->assertFileExists( "{$locks}/multipart.p2.lock.d/" . Lock_Node::RESTART_FLAG );
		$this->assertFileDoesNotExist( "{$locks}/fractured.p0.lock.d/" . Lock_Node::RESTART_FLAG );
		$this->rmdir_recursive( $base );
	}

	public function test_topologies_for_raises_an_unreadable_topology(): void {
		$this->write_tsl( 'fractured', "make_node Echo twin-4471\nmake_node Null twin-4471\n" );
		\update_option( 'newspack_nodes_topologies', [ 'combined', 'fractured' ] );
		Config::reset();

		$this->expectException( \RuntimeException::class );
		Restart_Planner::topologies_for( [ 'Tee' ] );
	}

	public function test_plan_restarts_the_classification_and_reloads_every_live_worker(): void {
		// The one settings-save recipe: recycle what the classification names,
		// tell every other live worker to re-read its boot-frozen config cache.
		$base = $this->make_temp_dir( 'plan-base-' );
		$this->use_base_dir( $base );
		$locks = "{$base}/locks";
		\mkdir( "{$locks}/combined.p0.lock.d", 0777, true );
		\mkdir( "{$locks}/job-worker.p0.lock.d", 0777, true );

		$restarted = Restart_Planner::plan( [ 'Tee' ] );

		$this->assertSame( [ 'combined' ], $restarted );
		$this->assertFileExists( "{$locks}/combined.p0.lock.d/" . Lock_Node::RESTART_FLAG );
		$this->assertFileDoesNotExist( "{$locks}/job-worker.p0.lock.d/" . Lock_Node::RESTART_FLAG );
		$this->assertFileExists( "{$locks}/combined.p0.lock.d/" . Lock_Node::RELOAD_FLAG );
		$this->assertFileExists( "{$locks}/job-worker.p0.lock.d/" . Lock_Node::RELOAD_FLAG );
		$this->rmdir_recursive( $base );
	}

	public function test_plan_propagates_a_failure_to_resolve_the_base_directory(): void {
		// The option row is already written: a save whose signal never landed
		// must say so rather than report a recycle no worker will see. A null
		// byte is what Config::ensure_path() refuses outright.
		$conf = $this->make_temp_dir( 'plan-conf-' ) . '/bad-base-dir.php';
		\file_put_contents( $conf, "<?php\nreturn [ 'base_directory' => \"/tmp/kea\\0-7713\" ];\n" );
		\putenv( 'LOCAL_NEWSPACK_NODES_CONF=' . $conf );
		Config::reset();

		$this->expectException( \RuntimeException::class );
		Restart_Planner::plan( 'all' );
	}

	/**
	 * A `{base}/locks` planted as a symlink would carry every flag a settings
	 * save writes into the directory it names. The save refuses loudly, and
	 * the redirected tree receives nothing.
	 */
	public function test_plan_refuses_a_symlinked_locks_directory(): void {
		$base = $this->make_temp_dir( 'kea-7713-plan-' );
		\mkdir( "{$base}/elsewhere-4471/combined.p0.lock.d", 0700, true );
		// A symlink AT the leaf is what Config::ensure_path() refuses outright.
		\symlink( "{$base}/elsewhere-4471", "{$base}/locks" );

		$thrown = null;
		try {
			$this->use_base_dir( $base );
			Restart_Planner::plan( 'all' );
		} catch ( \RuntimeException $e ) {
			$thrown = $e;
		} finally {
			$flagged = \file_exists( "{$base}/elsewhere-4471/combined.p0.lock.d/" . Lock_Node::RESTART_FLAG );
			// Unlink first: rmdir_recursive walks INTO a symlinked directory.
			\unlink( "{$base}/locks" );
			$this->rmdir_recursive( $base );
		}
		$this->assertNotNull( $thrown, 'an unusable locks directory must reach the caller' );
		$this->assertStringContainsString( "Path {$base}/locks resolves to", $thrown->getMessage() );
		$this->assertStringContainsString( 'symlink or path traversal detected', $thrown->getMessage() );
		$this->assertFalse( $flagged, 'no flag may land through the planted link' );
	}

	public function test_a_failed_flag_write_spares_its_siblings_and_then_raises(): void {
		// p1 refuses the write; p0 and p2 must still hear, and p1 must be named.
		$base  = $this->make_temp_dir( 'kea-7713-base-' );
		$locks = "{$base}/locks";
		for ( $p = 0; $p < 3; $p++ ) {
			\mkdir( "{$locks}/multipart.p{$p}.lock.d", 0777, true );
		}
		\chmod( "{$locks}/multipart.p1.lock.d", 0555 );

		$thrown = null;
		try {
			Restart_Planner::request_restarts( [ 'Echo' ], $base );
		} catch ( \RuntimeException $e ) {
			$thrown = $e;
		} finally {
			\chmod( "{$locks}/multipart.p1.lock.d", 0755 );
		}

		$this->assertNotNull( $thrown, 'the failed signal must propagate' );
		$this->assertStringContainsString( 'multipart.p1.lock.d', $thrown->getMessage() );
		$this->assertFileExists( "{$locks}/multipart.p0.lock.d/" . Lock_Node::RESTART_FLAG );
		$this->assertFileExists( "{$locks}/multipart.p2.lock.d/" . Lock_Node::RESTART_FLAG );
		$this->rmdir_recursive( $base );
	}

	public function test_every_failed_flag_write_is_raised_together(): void {
		$base  = $this->make_temp_dir( 'kea-7713-base-' );
		$locks = "{$base}/locks";
		for ( $p = 0; $p < 3; $p++ ) {
			\mkdir( "{$locks}/multipart.p{$p}.lock.d", 0777, true );
		}
		\chmod( "{$locks}/multipart.p0.lock.d", 0555 );
		\chmod( "{$locks}/multipart.p2.lock.d", 0555 );

		$thrown = null;
		try {
			Restart_Planner::request_reloads( $base );
		} catch ( Failures $e ) {
			$thrown = $e;
		} finally {
			\chmod( "{$locks}/multipart.p0.lock.d", 0755 );
			\chmod( "{$locks}/multipart.p2.lock.d", 0755 );
		}

		$this->assertNotNull( $thrown, 'two failed signals raise as one Failures' );
		$this->assertCount( 2, $thrown->all() );
		$this->assertFileExists( "{$locks}/multipart.p1.lock.d/" . Lock_Node::RELOAD_FLAG );
		$this->rmdir_recursive( $base );
	}

	public function test_plan_lets_a_cooperative_stop_escape_its_best_effort_catch(): void {
		// ADR-14: `cmd_set` reaches plan() from inside a worker's interpreter,
		// so the broad catch must not swallow the stop signal.
		$base = $this->make_temp_dir( 'plan-base-' );
		$this->use_base_dir( $base );
		\add_filter(
			'newspack_nodes/topologies',
			static function (): array {
				throw new Worker_Should_Stop( 'restart requested' );
			}
		);

		try {
			$this->expectException( Worker_Should_Stop::class );
			Restart_Planner::plan( 'all' );
		} finally {
			$this->rmdir_recursive( $base );
		}
	}

	/**
	 * Count catalog builds while $run executes.
	 *
	 * @param callable():mixed $run Code under measurement.
	 */
	private function catalog_builds( callable $run ): int {
		$builds = 0;
		\add_filter(
			'newspack_nodes/topologies',
			static function ( array $t ) use ( &$builds ): array {
				++$builds;
				return $t;
			},
			99
		);
		$run();
		return $builds;
	}

	public function test_an_empty_restart_builds_no_catalog(): void {
		// plan() hands every `[]`-classified save to request_restarts().
		$base = $this->make_temp_dir( 'kea-7713-base-' );
		$this->assertSame( 0, $this->catalog_builds( static fn () => Restart_Planner::request_restarts( [], $base ) ) );
		$this->rmdir_recursive( $base );
	}

	public function test_a_reload_builds_the_catalog_once(): void {
		// The counts ride on the active entries the name lookup already built.
		$base = $this->make_temp_dir( 'kea-7713-base-' );
		$this->assertSame( 1, $this->catalog_builds( static fn () => Restart_Planner::request_reloads( $base ) ) );
		$this->rmdir_recursive( $base );
	}

	public function test_request_reloads_is_a_no_op_off_the_fleet_site(): void {
		// The fleet is network-global; a subsite must not touch the main site's
		// lock dirs, exactly as request_restarts() refuses to.
		$base  = $this->make_temp_dir( 'kea-7713-base-' );
		$locks = "{$base}/locks";
		\mkdir( "{$locks}/combined.p0.lock.d", 0777, true );
		$GLOBALS['_wp_test_is_multisite']  = true;
		$GLOBALS['_wp_test_is_main_site']  = false;

		try {
			$this->assertSame( [], Restart_Planner::request_reloads( $base ) );
			$this->assertFileDoesNotExist( "{$locks}/combined.p0.lock.d/" . Lock_Node::RELOAD_FLAG );
		} finally {
			unset( $GLOBALS['_wp_test_is_multisite'], $GLOBALS['_wp_test_is_main_site'] );
			$this->rmdir_recursive( $base );
		}
	}
}
