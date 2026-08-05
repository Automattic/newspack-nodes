<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\CLI;
use Newspack_Nodes\Config_System\Restart_Planner;
use Newspack_Nodes\Supervisor;
use Newspack_Nodes\Tests\TestCase;

/**
 * The multisite stance: the fleet is network-global. Locks, IPC, and logs
 * are filesystem-flat with no blog namespace, so only the main site runs
 * the supervisor / spawns workers; subsites no-op loud.
 */
#[CoversClass( Bootstrap::class )]
#[CoversClass( CLI::class )]
#[CoversClass( Restart_Planner::class )]
#[CoversClass( Supervisor::class )]
class MultisiteGuardTest extends TestCase {

	protected function tearDown(): void {
		unset( $GLOBALS['_wp_test_is_multisite'], $GLOBALS['_wp_test_is_main_site'] );
		parent::tearDown();
	}

	public function test_single_site_is_always_the_fleet_site(): void {
		$GLOBALS['_wp_test_is_multisite'] = false;
		$this->assertTrue( Bootstrap::fleet_site() );
	}

	public function test_multisite_main_site_runs_the_fleet(): void {
		$GLOBALS['_wp_test_is_multisite'] = true;
		$GLOBALS['_wp_test_is_main_site'] = true;
		$this->assertTrue( Bootstrap::fleet_site() );
	}

	public function test_multisite_subsite_does_not(): void {
		$GLOBALS['_wp_test_is_multisite'] = true;
		$GLOBALS['_wp_test_is_main_site'] = false;
		$this->assertFalse( Bootstrap::fleet_site() );
	}

	/** Declare one active topology so the main-site baseline is non-empty. */
	private function seed_active_topology( string $name ): void {
		\add_filter( 'newspack_nodes/topologies', static function ( $topologies ) use ( $name ) {
			$topologies[ $name ] = [ 'num_partitions' => 1, 'topology' => "/path/{$name}.tsl" ];
			return $topologies;
		} );
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ $name ];
		\Newspack_Nodes\Config::reset();
	}

	/**
	 * A settings save on a SUBSITE must not restart the main site's fleet. The
	 * lock tree carries no blog namespace and `base_directory` falls back to the
	 * same shipped default, so an ungated save reaches the real workers.
	 */
	public function test_settings_save_does_not_restart_the_fleet_from_a_subsite(): void {
		$this->seed_active_topology( 'msguard-topology-6641' );
		$tmp      = $this->make_temp_dir( 'newspack-msguard-planner-' );
		$lock_dir = "{$tmp}/msguard-topology-6641.p0.lock.d";
		\mkdir( $lock_dir, 0700, true );

		$GLOBALS['_wp_test_is_multisite'] = true;
		$GLOBALS['_wp_test_is_main_site'] = true;
		$this->assertSame(
			[ 'msguard-topology-6641' ],
			Restart_Planner::request_restarts( 'all', $tmp ),
			'baseline: the main site does restart the fleet'
		);
		\unlink( "{$lock_dir}/restart" );

		$GLOBALS['_wp_test_is_main_site'] = false;
		$this->assertSame( [], Restart_Planner::request_restarts( 'all', $tmp ) );
		$this->assertFileDoesNotExist( "{$lock_dir}/restart" );
	}

	/** Same boundary for the explicit restart path (ELN's Flush Cache reaches it). */
	public function test_restart_workers_does_nothing_from_a_subsite(): void {
		$tmp      = $this->make_temp_dir( 'newspack-msguard-cli-' );
		$workers  = [ [ 'type' => 'msguard-worker-8807', 'partition' => 0 ] ];
		$lock_dir = "{$tmp}/locks/msguard-worker-8807.p0.lock.d";
		\mkdir( $lock_dir, 0700, true );

		$GLOBALS['_wp_test_is_multisite'] = true;
		$GLOBALS['_wp_test_is_main_site'] = true;
		$this->assertSame( 1, ( new CLI( $tmp ) )->restart_workers( $workers ), 'baseline: the main site restarts' );
		\unlink( "{$lock_dir}/restart" );

		$GLOBALS['_wp_test_is_main_site'] = false;
		$this->assertSame( 0, ( new CLI( $tmp ) )->restart_workers( $workers ) );
		$this->assertFileDoesNotExist( "{$lock_dir}/restart" );
	}

	public function test_supervisor_run_no_ops_on_a_subsite(): void {
		$GLOBALS['_wp_test_is_multisite'] = true;
		$GLOBALS['_wp_test_is_main_site'] = false;
		$tmp = $this->make_temp_dir( 'newspack-msguard-' );

		$supervisor = new Supervisor( $tmp, 'salt-xyz' );
		$supervisor->run();

		$this->assertDirectoryDoesNotExist( "{$tmp}/locks", 'a subsite supervisor must return before touching the filesystem' );
	}
}
