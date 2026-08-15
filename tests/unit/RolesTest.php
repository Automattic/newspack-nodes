<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Capabilities;
use Newspack_Nodes\Roles;
use Newspack_Nodes\Tests\TestCase;

/**
 * The granular capability migration.
 *
 * Until an operator opts in, all three roles resolve `manage_options` and
 * nothing changes. Opting in swaps the map to real capabilities and grants
 * them to administrators in the same step, so the switch cannot leave the
 * people who were already administrators locked out.
 */
#[CoversClass( Roles::class )]
class RolesTest extends TestCase {

	protected function setUp(): void {
		parent::setUp();
		$GLOBALS['_wp_test_roles'] = [
			'administrator' => [ 'name' => 'Administrator', 'capabilities' => [ 'manage_options' => true ] ],
		];
	}

	protected function tearDown(): void {
		\delete_option( Roles::OPTION );
		$GLOBALS['_wp_test_roles']            = [];
		$GLOBALS['_wp_test_current_user_can'] = [];
		$GLOBALS['_wp_actions']               = [];
		parent::tearDown();
	}

	public function test_the_map_stays_manage_options_until_it_is_installed(): void {
		$this->assertFalse( Roles::granular() );
		$this->assertSame( 'manage_options', Capabilities::cap_for( Capabilities::READ ) );
		$this->assertSame( 'manage_options', Capabilities::cap_for( Capabilities::TUNE ) );
		$this->assertSame( 'manage_options', Capabilities::cap_for( Capabilities::MANAGE ) );
	}

	public function test_installing_swaps_the_map_to_real_capabilities(): void {
		Roles::install();

		$this->assertTrue( Roles::granular() );
		$this->assertSame( Roles::CAP_READ, Capabilities::cap_for( Capabilities::READ ) );
		$this->assertSame( Roles::CAP_TUNE, Capabilities::cap_for( Capabilities::TUNE ) );
		$this->assertSame( Roles::CAP_MANAGE, Capabilities::cap_for( Capabilities::MANAGE ) );
	}

	public function test_installing_grants_all_three_to_administrators(): void {
		Roles::install();

		$admin = $GLOBALS['_wp_test_roles']['administrator']['capabilities'] ?? [];
		$this->assertTrue( $admin[ Roles::CAP_READ ] ?? false );
		$this->assertTrue( $admin[ Roles::CAP_TUNE ] ?? false );
		$this->assertTrue( $admin[ Roles::CAP_MANAGE ] ?? false );
	}

	/**
	 * Access does not only come from `administrator`. A custom Ops role holding
	 * manage_options must not be locked out by a migration billed as
	 * non-breaking.
	 */
	public function test_installing_grants_every_role_that_already_had_access(): void {
		$GLOBALS['_wp_test_roles']['ops'] = [
			'name'         => 'Ops',
			'capabilities' => [ 'manage_options' => true ],
		];
		$GLOBALS['_wp_test_roles']['author'] = [
			'name'         => 'Author',
			'capabilities' => [ 'edit_posts' => true ],
		];

		Roles::install();

		$this->assertTrue( $GLOBALS['_wp_test_roles']['ops']['capabilities'][ Roles::CAP_MANAGE ] ?? false );
		$this->assertArrayNotHasKey(
			Roles::CAP_MANAGE,
			$GLOBALS['_wp_test_roles']['author']['capabilities'],
			'a role that could not reach the substrate does not gain access'
		);
	}

	public function test_uninstalling_revokes_from_every_role_it_granted(): void {
		$GLOBALS['_wp_test_roles']['ops'] = [
			'name'         => 'Ops',
			'capabilities' => [ 'manage_options' => true ],
		];
		Roles::install();
		Roles::uninstall();

		$this->assertArrayNotHasKey( Roles::CAP_MANAGE, $GLOBALS['_wp_test_roles']['ops']['capabilities'] );
		$this->assertArrayNotHasKey( Roles::CAP_MANAGE, $GLOBALS['_wp_test_roles']['administrator']['capabilities'] );
	}

	public function test_the_hub_role_holds_read_and_tune_and_nothing_else(): void {
		Roles::install();

		$caps = $GLOBALS['_wp_test_roles'][ Roles::HUB_ROLE ]['capabilities'] ?? [];
		$this->assertTrue( $caps[ Roles::CAP_READ ] ?? false );
		$this->assertTrue( $caps[ Roles::CAP_TUNE ] ?? false );
		$this->assertArrayNotHasKey(
			Roles::CAP_MANAGE,
			$caps,
			'the aggregator must not be able to restart the fleet or read the vault'
		);
		$this->assertArrayNotHasKey( 'manage_options', $caps );
		$this->assertArrayNotHasKey( 'edit_posts', $caps );
	}

	public function test_uninstalling_puts_the_map_back(): void {
		Roles::install();
		Roles::uninstall();

		$this->assertFalse( Roles::granular() );
		$this->assertSame( 'manage_options', Capabilities::cap_for( Capabilities::MANAGE ) );
		$this->assertArrayNotHasKey( Roles::HUB_ROLE, $GLOBALS['_wp_test_roles'] );
	}

	public function test_a_site_filter_still_wins_over_the_granular_defaults(): void {
		Roles::install();
		add_filter(
			'newspack_nodes/capability_map',
			static fn ( array $map ): array => [ 'read' => 'edit_pages' ] + $map
		);

		$this->assertSame( 'edit_pages', Capabilities::cap_for( Capabilities::READ ) );
		$this->assertSame( Roles::CAP_MANAGE, Capabilities::cap_for( Capabilities::MANAGE ) );
	}

	public function test_install_is_idempotent(): void {
		Roles::install();
		Roles::install();

		$this->assertTrue( Roles::granular() );
		$this->assertCount( 2, $GLOBALS['_wp_test_roles'][ Roles::HUB_ROLE ]['capabilities'] );
	}
}
