<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Capabilities;
use Newspack_Nodes\Tests\TestCase;

/**
 * The capability model: two roles (read/manage) resolved through ONE
 * filterable map, both defaulting to manage_options — nothing changes
 * until a site filters `read` down to a lesser capability.
 */
#[CoversClass( Capabilities::class )]
class CapabilitiesTest extends TestCase {

	protected function tearDown(): void {
		$GLOBALS['_wp_test_current_user_can'] = [];
		$GLOBALS['_wp_actions']               = [];
		parent::tearDown();
	}

	public function test_both_roles_default_to_manage_options(): void {
		$this->assertSame( 'manage_options', Capabilities::cap_for( Capabilities::READ ) );
		$this->assertSame( 'manage_options', Capabilities::cap_for( Capabilities::MANAGE ) );
	}

	public function test_filter_relaxes_read_without_touching_manage(): void {
		add_filter(
			'newspack_nodes/capability_map',
			static fn ( array $map ): array => [ 'read' => 'edit_posts' ] + $map
		);
		$this->assertSame( 'edit_posts', Capabilities::cap_for( Capabilities::READ ) );
		$this->assertSame( 'manage_options', Capabilities::cap_for( Capabilities::MANAGE ) );
	}

	public function test_unknown_role_throws(): void {
		$this->expectException( \InvalidArgumentException::class );
		Capabilities::cap_for( 'admin-ish' );
	}

	public function test_garbage_filter_return_fails_closed(): void {
		add_filter( 'newspack_nodes/capability_map', static fn (): string => 'oops' );
		$this->expectException( \InvalidArgumentException::class );
		Capabilities::cap_for( Capabilities::READ );
	}

	public function test_require_passes_for_the_authorized(): void {
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => true ];
		Capabilities::require( Capabilities::MANAGE );
		$this->assertTrue( Capabilities::can( Capabilities::MANAGE ) );
	}

	public function test_require_throws_for_the_unauthorized(): void {
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => false ];
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessageMatches( '/permission denied/' );
		Capabilities::require( Capabilities::MANAGE );
	}

	public function test_can_honors_the_relaxed_read_cap(): void {
		add_filter(
			'newspack_nodes/capability_map',
			static fn ( array $map ): array => [ 'read' => 'edit_posts' ] + $map
		);
		$GLOBALS['_wp_test_current_user_can'] = [ 'edit_posts' => true, 'manage_options' => false ];
		$this->assertTrue( Capabilities::can( Capabilities::READ ) );
		$this->assertFalse( Capabilities::can( Capabilities::MANAGE ) );
	}

	/**
	 * `highest_held()` is what clamps a REQUESTED session scope to what the
	 * minting user can actually do: asking for `manage` as a tune-holder issues
	 * a `tune` session, so a listed scope states the truth rather than the ask.
	 */
	public function test_highest_held_is_the_top_role_the_user_holds(): void {
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => true ];
		$this->assertSame( Capabilities::MANAGE, Capabilities::highest_held() );
	}

	public function test_highest_held_is_capped_by_the_ceiling_it_is_given(): void {
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => true ];
		$this->assertSame(
			Capabilities::TUNE,
			Capabilities::highest_held( Capabilities::TUNE ),
			'a ceiling can only ever subtract'
		);
	}

	/** Holding none of them is a refusal, not an empty scope. */
	public function test_highest_held_is_null_when_the_user_holds_nothing(): void {
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => false ];
		$this->assertNull( Capabilities::highest_held() );
	}

	/**
	 * A map that answers with an empty capability would gate on `current_user_can( '' )`
	 * — true for nobody, or worse, silently true. It throws at the boundary instead.
	 */
	public function test_an_empty_capability_in_the_map_throws(): void {
		add_filter(
			'newspack_nodes/capability_map',
			static fn ( array $map ): array => [ 'tune' => '' ] + $map
		);
		$this->expectException( \InvalidArgumentException::class );
		Capabilities::cap_for( Capabilities::TUNE );
	}
}
