<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit\ConfigSystem;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Config;
use Newspack_Nodes\Config_System\Restart_Planner;
use Newspack_Nodes\Lock_Node;
use Newspack_Nodes\Topology_Registry;
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

	public function test_supervisor_only_and_empty_resolve_to_nothing(): void {
		$this->assertSame( [], Restart_Planner::topologies_for( 'supervisor_only' ) );
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
