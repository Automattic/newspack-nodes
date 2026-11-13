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
		$GLOBALS['_wp_test_current_user_can']   = [];
		$GLOBALS['_wp_test_current_user_login'] = '';
		$GLOBALS['_wp_actions']                 = [];
		\Newspack_Nodes\Config::reset();
		parent::tearDown();
	}

	/**
	 * Seed the operator allowlist and the login `can()` will match against it.
	 * The logins are deliberately unlike every other fixture in the suite, so a
	 * test that passes did so on this seed rather than on a leaked one.
	 *
	 * @param list<string> $allowed Logins the operator listed.
	 * @param string       $login   The authenticated user's `user_login`.
	 */
	private function seed_allowlist( array $allowed, string $login ): void {
		\update_option( 'newspack_nodes_allowed_users', $allowed );
		\Newspack_Nodes\Config::reset();
		$GLOBALS['_wp_test_current_user_can']   = [ 'manage_options' => true ];
		$GLOBALS['_wp_test_current_user_login'] = $login;
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

	public function test_require_command_passes_a_logged_in_user_holding_the_role(): void {
		$GLOBALS['_wp_test_current_user_id']  = 7731;
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => true ];
		Capabilities::require_command( Capabilities::MANAGE );
		$this->assertTrue( Capabilities::can( Capabilities::MANAGE ) );
	}

	public function test_require_command_refuses_a_logged_in_user_lacking_the_role(): void {
		$GLOBALS['_wp_test_current_user_id']  = 7731;
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => false ];
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'permission denied: manage capability required' );
		Capabilities::require_command( Capabilities::MANAGE );
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
	// ---- allowed_users narrows the capability, not just the admin menu ----

	/**
	 * The finding: an administrator the operator deliberately kept out of
	 * `allowed_users` still held every role, so every REST permission callback
	 * and every gated command admitted them.
	 */
	public function test_can_refuses_a_capable_user_the_allowlist_excludes(): void {
		$this->seed_allowlist( [ 'quill', 'mercator' ], 'redshank' );

		$this->assertFalse( Capabilities::can( Capabilities::READ ) );
		$this->assertFalse( Capabilities::can( Capabilities::TUNE ) );
		$this->assertFalse( Capabilities::can( Capabilities::MANAGE ) );
		$this->assertNull( Capabilities::highest_held() );
	}

	public function test_can_admits_a_capable_user_the_allowlist_names(): void {
		$this->seed_allowlist( [ 'quill', 'mercator' ], 'mercator' );

		$this->assertTrue( Capabilities::can( Capabilities::READ ) );
		$this->assertTrue( Capabilities::can( Capabilities::MANAGE ) );
		$this->assertSame( Capabilities::MANAGE, Capabilities::highest_held() );
	}

	/** The shipped default: an empty list narrows nobody. */
	public function test_can_ignores_an_empty_allowlist(): void {
		$this->seed_allowlist( [], 'redshank' );

		$this->assertTrue( Capabilities::can( Capabilities::READ ) );
		$this->assertTrue( Capabilities::can( Capabilities::MANAGE ) );
	}

	/**
	 * WP-CLI without `--user`, a worker process and WP-Cron all run with no
	 * login. There is nothing for the list to narrow, so it does not apply —
	 * the capability check is the whole gate on that path.
	 */
	public function test_can_ignores_the_allowlist_with_no_logged_in_user(): void {
		$this->seed_allowlist( [ 'quill', 'mercator' ], '' );

		$this->assertTrue( Capabilities::can( Capabilities::MANAGE ) );
	}

	/**
	 * `can()` is reached from four REST permission callbacks and from
	 * `Auto_Tuner_Node::fill()`. A throw out of the allowlist read is an
	 * uncaught 500 in place of a 403 at the first, and an ADR-13 violation at
	 * the second, so an unreadable config fails the gate CLOSED and says so.
	 */
	public function test_can_fails_closed_when_the_config_cannot_be_read(): void {
		$previous = \getenv( 'LOCAL_NEWSPACK_NODES_CONF' );
		\putenv( 'LOCAL_NEWSPACK_NODES_CONF=/nonexistent-allowlist-conf-6712.php' );
		\Newspack_Nodes\Config::reset();
		\Newspack_Nodes\Core::$recent_log        = [];
		\Newspack_Nodes\Core::$recent_log_timers = [];
		$GLOBALS['_wp_test_current_user_can']   = [ 'manage_options' => true ];
		$GLOBALS['_wp_test_current_user_login'] = 'shearwater';

		try {
			$this->assertFalse(
				Capabilities::can( Capabilities::MANAGE ),
				'an unreadable config refuses the role rather than propagating'
			);
			$this->assertStringContainsString(
				'allowed_users',
				\implode( "\n", \Newspack_Nodes\Core::$recent_log ),
				'the refusal is reported, not silent'
			);
		} finally {
			\putenv( 'LOCAL_NEWSPACK_NODES_CONF=' . ( false === $previous ? '' : $previous ) );
			\Newspack_Nodes\Config::reset();
		}
	}

	/** A scalar `allowed_users` is a config typo, and must not fail open. */
	public function test_can_refuses_when_a_scalar_allowlist_names_someone_else(): void {
		\update_option( 'newspack_nodes_allowed_users', 'quill' );
		\Newspack_Nodes\Config::reset();
		$GLOBALS['_wp_test_current_user_can']   = [ 'manage_options' => true ];
		$GLOBALS['_wp_test_current_user_login'] = 'redshank';

		$this->assertFalse( Capabilities::can( Capabilities::MANAGE ) );
	}

	public function test_labelled_scopes_are_read_and_tune(): void {
		$this->assertSame( [ 'read', 'tune' ], Capabilities::LABELLED_SCOPES );
	}

	/**
	 * Every role on the ladder carries its own label, so appending one to
	 * `Oauth_Store::SCOPES` or `LABELLED_SCOPES` renders on every surface.
	 */
	public function test_every_role_on_the_ladder_has_its_own_label(): void {
		$ladder = ( new \ReflectionClassConstant( Capabilities::class, 'LADDER' ) )->getValue();
		$this->assertIsArray( $ladder );

		$this->assertSame(
			[
				Capabilities::READ   => 'See the dashboards and the logged traffic; change nothing.',
				Capabilities::TUNE   => 'See the dashboards and the logged traffic; change settings and application data.',
				Capabilities::MANAGE => 'See and change everything, the fleet and the credential vault included.',
			],
			\array_combine( $ladder, \array_map( [ Capabilities::class, 'label' ], $ladder ) )
		);
	}

	public function test_a_scope_off_the_ladder_has_no_label(): void {
		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( 'unknown capability role: none' );

		Capabilities::label( Capabilities::NONE );
	}

	// ---- a command may declare a WordPress capability ----

	/**
	 * A `wp:` declaration names a WordPress capability, which the user's own
	 * `current_user_can()` decides; a `none` session's ceiling does not
	 * subtract it, because it sits off the substrate's ladder.
	 */
	public function test_a_wp_capability_is_held_by_a_signed_in_user_holding_it(): void {
		$GLOBALS['_wp_test_current_user_id']  = 6603;
		$GLOBALS['_wp_test_current_user_can'] = [ 'edit_posts' => true, 'read' => true ];
		Capabilities::$session_scope          = Capabilities::NONE;

		$this->assertTrue( Capabilities::command_holds( 'wp:edit_posts' ) );
		Capabilities::require_command( 'wp:edit_posts' );
	}

	public function test_a_wp_capability_refuses_a_user_without_it(): void {
		$GLOBALS['_wp_test_current_user_id']  = 6603;
		$GLOBALS['_wp_test_current_user_can'] = [ 'read' => true, 'manage_options' => true ];

		$this->assertFalse( Capabilities::command_holds( 'wp:edit_posts' ) );
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'permission denied: edit_posts capability required' );
		Capabilities::require_command( 'wp:edit_posts' );
	}

	/** A worker has no user to ask, and no session ceiling stands in for one. */
	public function test_a_wp_capability_in_a_worker_is_refused(): void {
		$GLOBALS['_wp_test_current_user_id']  = 0;
		$GLOBALS['_wp_test_current_user_can'] = [ 'edit_posts' => true ];
		Capabilities::$session_scope          = null;

		$this->assertFalse( Capabilities::command_holds( 'wp:edit_posts' ) );
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'permission denied: edit_posts requires a signed-in user' );
		Capabilities::require_command( 'wp:edit_posts' );
	}

	/**
	 * `allowed_users` narrows the substrate's three roles; a WordPress
	 * capability is WordPress's to grant, so the list leaves it alone.
	 */
	public function test_the_allowlist_does_not_narrow_a_wp_capability(): void {
		$this->seed_allowlist( [ 'quill', 'mercator' ], 'redshank' );
		$GLOBALS['_wp_test_current_user_id']  = 6603;
		$GLOBALS['_wp_test_current_user_can'] = [ 'edit_posts' => true, 'manage_options' => true ];

		$this->assertTrue( Capabilities::command_holds( 'wp:edit_posts' ) );
		$this->assertFalse( Capabilities::command_holds( Capabilities::READ ) );
	}

	public function test_a_malformed_wp_capability_throws(): void {
		$GLOBALS['_wp_test_current_user_id'] = 6603;
		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( "invalid WordPress capability: 'Edit Posts'" );
		Capabilities::command_holds( 'wp:Edit Posts' );
	}

	/** A `none` session holds no role, whatever its user could otherwise do. */
	public function test_a_none_session_holds_no_role(): void {
		$GLOBALS['_wp_test_current_user_id']  = 6603;
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => true ];
		Capabilities::$session_scope          = Capabilities::NONE;

		foreach ( [ Capabilities::READ, Capabilities::TUNE, Capabilities::MANAGE ] as $role ) {
			$this->assertFalse( Capabilities::command_holds( $role ), $role );
		}
	}

	/**
	 * `can()` stays the role gate every REST callback and MCP listing asks;
	 * a `wp:` declaration is not a role, so it answers no under a ceiling.
	 */
	public function test_can_does_not_admit_a_wp_capability_under_a_ceiling(): void {
		$GLOBALS['_wp_test_current_user_id']  = 6603;
		$GLOBALS['_wp_test_current_user_can'] = [ 'edit_posts' => true, 'manage_options' => true ];
		Capabilities::$session_scope          = Capabilities::MANAGE;

		$this->assertFalse( Capabilities::can( 'wp:edit_posts' ) );
	}

	/**
	 * A labelled session serves a CLI, an MCP client or a hub, so its `read`
	 * or `tune` ceiling keeps its meaning: a `wp:` command refuses it, read or
	 * write, whatever its user holds.
	 */
	public function test_a_wp_capability_refuses_a_labelled_session(): void {
		$GLOBALS['_wp_test_current_user_id']  = 6603;
		$GLOBALS['_wp_test_current_user_can'] = [ 'edit_posts' => true, 'manage_options' => true ];
		Capabilities::$session_scope          = Capabilities::READ;
		Capabilities::$session_label          = 'kea cli';

		$this->assertFalse( Capabilities::command_holds( 'wp:edit_posts' ) );
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'permission denied: edit_posts refuses a labelled session' );
		Capabilities::require_command( 'wp:edit_posts' );
	}

	/** A role holder's unlabelled dashboard session runs a `wp:` command it holds. */
	public function test_an_unlabelled_role_session_runs_a_wp_command(): void {
		$GLOBALS['_wp_test_current_user_id']  = 6603;
		$GLOBALS['_wp_test_current_user_can'] = [ 'edit_posts' => true, 'manage_options' => true ];
		Capabilities::$session_scope          = Capabilities::MANAGE;
		Capabilities::$session_label          = '';

		$this->assertTrue( Capabilities::command_holds( 'wp:edit_posts' ) );
	}

	public function test_a_wp_capability_refuses_an_unverified_command(): void {
		$GLOBALS['_wp_test_current_user_id']  = 6603;
		$GLOBALS['_wp_test_current_user_can'] = [ 'edit_posts' => true ];
		Capabilities::$session_scope          = \Newspack_Nodes\Command_Auth::UNVERIFIED;

		$this->assertFalse( Capabilities::command_holds( 'wp:edit_posts' ) );
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'permission denied: edit_posts requires a verified command' );
		Capabilities::require_command( 'wp:edit_posts' );
	}
}
