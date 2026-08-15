<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Capabilities;
use Newspack_Nodes\Tests\TestCase;

/**
 * The third role (`tune`) and the session-scope CEILING.
 *
 * A scope never grants: it can only subtract from what the authenticated user
 * could already do. With no scope active the map alone decides, exactly as
 * before.
 */
#[CoversClass( Capabilities::class )]
class CapabilitiesScopeTest extends TestCase {

	protected function tearDown(): void {
		$GLOBALS['_wp_test_current_user_can'] = [];
		$GLOBALS['_wp_actions']               = [];
		Capabilities::$session_scope          = null;
		parent::tearDown();
	}

	public function test_tune_defaults_to_manage_options_and_is_filterable(): void {
		$this->assertSame( 'manage_options', Capabilities::cap_for( Capabilities::TUNE ) );

		add_filter(
			'newspack_nodes/capability_map',
			static fn ( array $map ): array => [ 'tune' => 'edit_pages' ] + $map
		);
		$this->assertSame( 'edit_pages', Capabilities::cap_for( Capabilities::TUNE ) );
		$this->assertSame( 'manage_options', Capabilities::cap_for( Capabilities::MANAGE ) );
	}

	public function test_the_ladder_orders_read_below_tune_below_manage(): void {
		$this->assertTrue( Capabilities::scope_covers( Capabilities::MANAGE, Capabilities::TUNE ) );
		$this->assertTrue( Capabilities::scope_covers( Capabilities::TUNE, Capabilities::READ ) );
		$this->assertTrue( Capabilities::scope_covers( Capabilities::READ, Capabilities::READ ) );
		$this->assertFalse( Capabilities::scope_covers( Capabilities::READ, Capabilities::TUNE ) );
		$this->assertFalse( Capabilities::scope_covers( Capabilities::TUNE, Capabilities::MANAGE ) );
	}

	public function test_an_unknown_scope_covers_nothing(): void {
		$this->assertFalse( Capabilities::scope_covers( 'wizard', Capabilities::READ ) );
	}

	public function test_a_read_scope_ceilings_an_administrator(): void {
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => true ];
		Capabilities::$session_scope          = Capabilities::READ;

		$this->assertTrue( Capabilities::can( Capabilities::READ ) );
		$this->assertFalse( Capabilities::can( Capabilities::TUNE ) );
		$this->assertFalse( Capabilities::can( Capabilities::MANAGE ) );
	}

	public function test_a_tune_scope_admits_tune_and_refuses_manage(): void {
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => true ];
		Capabilities::$session_scope          = Capabilities::TUNE;

		$this->assertTrue( Capabilities::can( Capabilities::TUNE ) );
		$this->assertFalse( Capabilities::can( Capabilities::MANAGE ) );
	}

	public function test_a_scope_is_a_ceiling_not_a_grant(): void {
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => false ];
		Capabilities::$session_scope          = Capabilities::MANAGE;

		$this->assertFalse( Capabilities::can( Capabilities::READ ) );
		$this->assertFalse( Capabilities::can( Capabilities::MANAGE ) );
	}

	public function test_no_scope_leaves_the_map_alone(): void {
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => true ];
		Capabilities::$session_scope          = null;

		$this->assertTrue( Capabilities::can( Capabilities::MANAGE ) );
		$this->assertTrue( Capabilities::can( Capabilities::TUNE ) );
	}
}
