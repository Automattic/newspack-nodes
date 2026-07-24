<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Supervisor;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * The multisite stance: the fleet is network-global. Locks, IPC, and logs
 * are filesystem-flat with no blog namespace, so only the main site runs
 * the supervisor / spawns workers; subsites no-op loud.
 */
#[CoversClass( Bootstrap::class )]
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

	public function test_supervisor_run_no_ops_on_a_subsite(): void {
		$GLOBALS['_wp_test_is_multisite'] = true;
		$GLOBALS['_wp_test_is_main_site'] = false;
		$tmp = $this->make_temp_dir( 'newspack-msguard-' );

		$supervisor = new Supervisor( $tmp, 'salt-xyz' );
		$supervisor->run();

		$this->assertDirectoryDoesNotExist( "{$tmp}/locks", 'a subsite supervisor must return before touching the filesystem' );
	}
}
