<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit\ConfigSystem;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Config;
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
		$this->tmp = $this->make_temp_dir( 'restart-planner-' );
		Topology_Registry::register_stock_dir( $this->tmp );
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

	private function write_tsl( string $name, string $contents ): void {
		\file_put_contents( "{$this->tmp}/{$name}.tsl", $contents );
	}

	public function test_empty_classification_resolves_to_nothing(): void {
		$this->assertSame( [], Restart_Planner::topologies_for( [] ) );
	}

	public function test_all_resolves_to_every_active_topology(): void {
		$this->assertEqualsCanonicalizing(
			[ 'combined', 'aggregator', 'job-worker', 'multipart' ],
			Restart_Planner::topologies_for( 'all' )
		);
	}

	public function test_node_type_matches_only_topologies_with_that_node(): void {
		// Partition lives in combined; Topic in aggregator → geometry restarts both, not job-worker.
		$this->assertEqualsCanonicalizing(
			[ 'combined', 'aggregator' ],
			Restart_Planner::topologies_for( [ 'Partition', 'Topic', 'Log' ] )
		);
		// Tee only in combined.
		$this->assertSame( [ 'combined' ], Restart_Planner::topologies_for( [ 'Tee' ] ) );
		// Job_Worker only in job-worker.
		$this->assertSame( [ 'job-worker' ], Restart_Planner::topologies_for( [ 'Job_Worker' ] ) );
	}

	public function test_unknown_node_type_resolves_to_nothing(): void {
		$this->assertSame( [], Restart_Planner::topologies_for( [ 'No_Such_Node' ] ) );
	}

	public function test_request_restarts_touches_only_live_lock_dirs(): void {
		$locks = $this->make_temp_dir( 'locks-' );
		\mkdir( "{$locks}/combined.p0.lock.d", 0777, true );
		$touched = Restart_Planner::request_restarts( [ 'Tee' ], $locks );
		$this->assertSame( [ 'combined' ], $touched );
		$this->assertFileExists( "{$locks}/combined.p0.lock.d/" . Lock_Node::RESTART_FLAG );
		$this->rmdir_recursive( $locks );
	}

	public function test_request_restarts_fans_out_over_every_partition(): void {
		// multipart declares `var num_partitions = 3` → touch .p0/.p1/.p2, not .p3.
		$locks = $this->make_temp_dir( 'locks-' );
		\mkdir( "{$locks}/multipart.p0.lock.d", 0777, true );
		\mkdir( "{$locks}/multipart.p1.lock.d", 0777, true );
		\mkdir( "{$locks}/multipart.p2.lock.d", 0777, true );
		$touched = Restart_Planner::request_restarts( [ 'Echo' ], $locks );
		$this->assertSame( [ 'multipart' ], $touched );
		$this->assertFileExists( "{$locks}/multipart.p0.lock.d/" . Lock_Node::RESTART_FLAG );
		$this->assertFileExists( "{$locks}/multipart.p1.lock.d/" . Lock_Node::RESTART_FLAG );
		$this->assertFileExists( "{$locks}/multipart.p2.lock.d/" . Lock_Node::RESTART_FLAG );
		$this->assertDirectoryDoesNotExist( "{$locks}/multipart.p3.lock.d" );
		$this->rmdir_recursive( $locks );
	}

	public function test_request_reloads_covers_every_active_topology_and_partition(): void {
		// Unclassified by design: every worker alive holds a Config cache frozen
		// at boot, whatever the saved field's restart classification says.
		$locks = $this->make_temp_dir( 'locks-' );
		\mkdir( "{$locks}/combined.p0.lock.d", 0777, true );
		\mkdir( "{$locks}/job-worker.p0.lock.d", 0777, true );
		for ( $p = 0; $p < 3; $p++ ) {
			\mkdir( "{$locks}/multipart.p{$p}.lock.d", 0777, true );
		}

		$touched = Restart_Planner::request_reloads( $locks );

		$this->assertEqualsCanonicalizing( [ 'combined', 'aggregator', 'job-worker', 'multipart' ], $touched );
		$this->assertFileExists( "{$locks}/combined.p0.lock.d/" . Lock_Node::RELOAD_FLAG );
		$this->assertFileExists( "{$locks}/job-worker.p0.lock.d/" . Lock_Node::RELOAD_FLAG );
		for ( $p = 0; $p < 3; $p++ ) {
			$this->assertFileExists( "{$locks}/multipart.p{$p}.lock.d/" . Lock_Node::RELOAD_FLAG );
		}
		$this->assertFileDoesNotExist( "{$locks}/combined.p0.lock.d/" . Lock_Node::RESTART_FLAG, 're-read, never recycle' );
		$this->rmdir_recursive( $locks );
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

	public function test_plan_swallows_a_failure_to_resolve_the_locks_directory(): void {
		// Best-effort by contract: the next worker generation reads the new
		// config regardless, so a save must not fatal on an unusable locks dir.
		$base = $this->make_temp_dir( 'plan-base-' );
		\mkdir( "{$base}/elsewhere", 0777, true );
		// A symlink AT the leaf is what Config::ensure_path() refuses outright.
		\symlink( "{$base}/elsewhere", "{$base}/locks" );

		try {
			$this->use_base_dir( $base );
			$this->assertSame( [], Restart_Planner::plan( 'all' ) );
		} finally {
			// Unlink first: rmdir_recursive walks INTO a symlinked directory.
			\unlink( "{$base}/locks" );
			$this->rmdir_recursive( $base );
		}
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

	public function test_request_reloads_is_a_no_op_off_the_fleet_site(): void {
		// The fleet is network-global; a subsite must not touch the main site's
		// lock dirs, exactly as request_restarts() refuses to.
		$locks = $this->make_temp_dir( 'locks-' );
		\mkdir( "{$locks}/combined.p0.lock.d", 0777, true );
		$GLOBALS['_wp_test_is_multisite']  = true;
		$GLOBALS['_wp_test_is_main_site']  = false;

		try {
			$this->assertSame( [], Restart_Planner::request_reloads( $locks ) );
			$this->assertFileDoesNotExist( "{$locks}/combined.p0.lock.d/" . Lock_Node::RELOAD_FLAG );
		} finally {
			unset( $GLOBALS['_wp_test_is_multisite'], $GLOBALS['_wp_test_is_main_site'] );
			$this->rmdir_recursive( $locks );
		}
	}
}
