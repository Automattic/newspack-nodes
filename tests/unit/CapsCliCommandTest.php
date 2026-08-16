<?php
/**
 * Tests for `wp nodes caps <status|install|uninstall>` and `wp nodes hub-user`.
 *
 * These two verbs are the operator half of `Roles`: one swaps the capability
 * map off `manage_options` onto three real capabilities, the other creates the
 * least-privilege user the log aggregator authenticates as. Both hand out or
 * take away authority, so what they refuse matters as much as what they do —
 * `hub-user` before `caps install` would mint a credential whose "narrow" role
 * still resolves to `manage_options`, which is the opposite of the point.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Capabilities;
use Newspack_Nodes\Caps_CLI_Command;
use Newspack_Nodes\Roles;
use Newspack_Nodes\Tests\TestCase;

require_once \dirname( __DIR__, 2 ) . '/includes/cli/class-caps-cli-command.php';
require_once \dirname( __DIR__ ) . '/Helpers/WPCLIStub.php';
require_once \dirname( __DIR__ ) . '/Helpers/WPCLIUtilsStub.php';

#[CoversClass( Caps_CLI_Command::class )]
class CapsCliCommandTest extends TestCase {

	private Caps_CLI_Command $command;

	protected function setUp(): void {
		parent::setUp();
		$this->command = new Caps_CLI_Command();
		foreach (
			[
				'_test_wp_cli_lines',
				'_test_wp_cli_errors',
				'_test_wp_cli_warns',
				'_test_wp_cli_success',
				'_test_wp_cli_tables',
				'_wp_test_users',
				'_wp_test_app_passwords',
				'_wp_test_roles',
			] as $global
		) {
			$GLOBALS[ $global ] = [];
		}
		unset(
			$GLOBALS['_wp_test_app_password_error'],
			$GLOBALS['_wp_test_insert_user_error'],
			$GLOBALS['_wp_test_unreadable_user']
		);
		Roles::uninstall();
	}

	protected function tearDown(): void {
		Roles::uninstall();
		$GLOBALS['_wp_test_users'] = [];
		parent::tearDown();
	}

	/** The table `caps status` prints, as `role => capability`. */
	private function printed_map(): array {
		$table = \end( $GLOBALS['_test_wp_cli_tables'] );
		return \array_column( $table['items'], 'capability', 'role' );
	}

	private function printed_lines(): string {
		return \implode( "\n", $GLOBALS['_test_wp_cli_lines'] );
	}

	public function test_status_reports_every_role_and_the_capability_it_resolves_to(): void {
		$this->command->caps( [], [] );

		$this->assertSame(
			[
				Capabilities::READ   => 'manage_options',
				Capabilities::TUNE   => 'manage_options',
				Capabilities::MANAGE => 'manage_options',
			],
			$this->printed_map(),
			'all three default to manage_options until install runs'
		);
		$this->assertStringContainsString( 'granular: no', $this->printed_lines() );
	}

	/** No argument means status: the reporting verb is the safe default. */
	public function test_no_action_is_status_and_changes_nothing(): void {
		$this->command->caps( [], [] );
		$this->assertFalse( Roles::granular() );
	}

	public function test_install_moves_the_roles_onto_real_capabilities(): void {
		$this->command->caps( [ 'install' ], [] );

		$this->assertTrue( Roles::granular() );
		$this->assertSame(
			[
				Capabilities::READ   => 'newspack_nodes_read',
				Capabilities::TUNE   => 'newspack_nodes_tune',
				Capabilities::MANAGE => 'newspack_nodes_manage',
			],
			$this->printed_map()
		);
		$this->assertStringContainsString( 'granular: yes', $this->printed_lines() );
		$this->assertNotEmpty( $GLOBALS['_test_wp_cli_success'] );
	}

	public function test_uninstall_puts_them_back_on_manage_options(): void {
		$this->command->caps( [ 'install' ], [] );
		$this->command->caps( [ 'uninstall' ], [] );

		$this->assertFalse( Roles::granular() );
		$this->assertSame( 'manage_options', $this->printed_map()[ Capabilities::MANAGE ] );
	}

	/** A typo must not silently report status as though it were the ask. */
	public function test_an_unknown_action_is_refused(): void {
		$this->expectException( \RuntimeException::class );
		$this->command->caps( [ 'enable' ], [] );
	}

	public function test_hub_user_needs_a_login(): void {
		$this->command->caps( [ 'install' ], [] );
		$this->expectException( \RuntimeException::class );
		$this->command->hub_user( [], [] );
	}

	/**
	 * Before `caps install` the hub role resolves to `manage_options`, so the
	 * credential this verb issues would hold everything. Refusing is the whole
	 * safety property.
	 */
	public function test_hub_user_refuses_before_the_capabilities_are_installed(): void {
		$this->expectException( \RuntimeException::class );
		$this->command->hub_user( [ 'nodes-hub' ], [] );
	}

	public function test_hub_user_creates_the_user_with_the_hub_role_and_one_password(): void {
		$this->command->caps( [ 'install' ], [] );

		$this->command->hub_user( [ 'nodes-hub' ], [] );

		$user = $GLOBALS['_wp_test_users']['nodes-hub'];
		$this->assertSame( [ Roles::HUB_ROLE ], $user['roles'] );
		$this->assertSame( 'nodes-hub@test.example', $user['email'], 'defaults to the site host' );
		$this->assertCount( 1, $GLOBALS['_wp_test_app_passwords'] );
		$this->assertSame( 'newspack-nodes hub', $GLOBALS['_wp_test_app_passwords'][0]['name'] );
		$this->assertStringContainsString( 'shown-once-password', $this->printed_lines() );
		$this->assertNotEmpty( $GLOBALS['_test_wp_cli_warns'], 'the password is shown once and says so' );
	}

	public function test_hub_user_takes_a_given_email_and_password_label(): void {
		$this->command->caps( [ 'install' ], [] );

		$this->command->hub_user(
			[ 'nodes-hub' ],
			[ 'email' => 'ops@example.test', 'name' => 'hub link 4471' ]
		);

		$this->assertSame( 'ops@example.test', $GLOBALS['_wp_test_users']['nodes-hub']['email'] );
		$this->assertSame( 'hub link 4471', $GLOBALS['_wp_test_app_passwords'][0]['name'] );
	}

	/**
	 * An aggregator that can also edit posts is not least-privilege, so an
	 * existing user is RE-ROLED rather than granted the hub role alongside
	 * whatever it already held.
	 */
	public function test_an_existing_user_is_re_roled_not_added_to(): void {
		$this->command->caps( [ 'install' ], [] );
		$GLOBALS['_wp_test_users']['editor-bob'] = [
			'ID'    => 7,
			'email' => 'bob@example.test',
			'roles' => [ 'editor' ],
		];

		$this->command->hub_user( [ 'editor-bob' ], [] );

		$this->assertSame( [ Roles::HUB_ROLE ], $GLOBALS['_wp_test_users']['editor-bob']['roles'] );
	}

	/** `--no-password` sets the role up without minting a credential. */
	public function test_no_password_creates_the_user_and_issues_nothing(): void {
		$this->command->caps( [ 'install' ], [] );

		$this->command->hub_user( [ 'nodes-hub' ], [ 'no-password' => true ] );

		$this->assertSame( [ Roles::HUB_ROLE ], $GLOBALS['_wp_test_users']['nodes-hub']['roles'] );
		$this->assertSame( [], $GLOBALS['_wp_test_app_passwords'] );
	}

	/**
	 * A host with application passwords disabled still gets its user; the
	 * credential is the operator's to create by hand, and saying so beats
	 * failing after the role is already set.
	 */
	public function test_a_refused_application_password_warns_rather_than_fails(): void {
		$this->command->caps( [ 'install' ], [] );
		$GLOBALS['_wp_test_app_password_error'] = true;

		$this->expectException( \RuntimeException::class );
		try {
			$this->command->hub_user( [ 'nodes-hub' ], [] );
		} finally {
			$this->assertSame( [ Roles::HUB_ROLE ], $GLOBALS['_wp_test_users']['nodes-hub']['roles'] );
		}
	}

	/** A refused creation says why, and leaves no half-made credential. */
	public function test_a_refused_user_creation_is_reported(): void {
		$this->command->caps( [ 'install' ], [] );
		$GLOBALS['_wp_test_insert_user_error'] = true;

		$this->expectException( \RuntimeException::class );
		try {
			$this->command->hub_user( [ 'nodes-hub' ], [] );
		} finally {
			$this->assertSame( [], $GLOBALS['_wp_test_app_passwords'] );
		}
	}

	/**
	 * Created but unreadable is the one state where the verb cannot continue:
	 * it has no user object to hang a password on, and inventing one would
	 * issue a credential nobody can trace.
	 */
	public function test_a_user_created_but_unreadable_stops_there(): void {
		$this->command->caps( [ 'install' ], [] );
		$GLOBALS['_wp_test_unreadable_user'] = true;

		$this->expectException( \RuntimeException::class );
		try {
			$this->command->hub_user( [ 'nodes-hub' ], [] );
		} finally {
			$this->assertSame( [], $GLOBALS['_wp_test_app_passwords'] );
		}
	}
}
