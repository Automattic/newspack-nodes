<?php
/**
 * Tests for `wp nodes session issue <label> [<role>] [<ttl>]`.
 *
 * The verb prints a Bearer credential for `$( … )` capture, so stdout holds
 * the credential and nothing else; every refusal goes to stderr through
 * `WP_CLI::error()` before a session is minted.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Capabilities;
use Newspack_Nodes\Command_Auth;
use Newspack_Nodes\Core;
use Newspack_Nodes\Roles;
use Newspack_Nodes\Session_CLI_Command;
use Newspack_Nodes\Sessions;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use Newspack_Nodes\Tests\TestCase;

require_once \dirname( __DIR__, 2 ) . '/includes/cli/class-session-cli-command.php';
require_once \dirname( __DIR__ ) . '/Helpers/WPCLIStub.php';

#[CoversClass( Session_CLI_Command::class )]
class SessionCliCommandTest extends TestCase {

	/** Distinct from 0, the shim's default user. */
	private const USER = 7731;

	private ?\Memcached $prev_memd = null;

	protected function setUp(): void {
		parent::setUp();
		$this->use_wpdb();
		$this->prev_memd = Core::$memd;
		Core::$memd      = new InMemoryMemcached();
		foreach ( [ '_test_wp_cli_lines', '_test_wp_cli_logs', '_test_wp_cli_errors', '_test_wp_cli_warns', '_test_wp_cli_success' ] as $global ) {
			$GLOBALS[ $global ] = [];
		}
		$GLOBALS['_wp_test_current_user_id']  = self::USER;
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => true ];
	}

	protected function tearDown(): void {
		Roles::uninstall();
		unset( $GLOBALS['_wp_test_current_user_id'] );
		$GLOBALS['_wp_test_current_user_can'] = [];
		Core::$memd                           = $this->prev_memd;
		parent::tearDown();
	}

	private function refusal( array $args ): string {
		try {
			( new Session_CLI_Command() )->issue( $args, [] );
		} catch ( \RuntimeException $e ) {
			$this->assertSame( [], $GLOBALS['_test_wp_cli_lines'], 'a refusal prints no credential' );
			$this->assertSame( [], Sessions::all(), 'a refusal mints nothing' );
			return $e->getMessage();
		}
		$this->fail( 'expected a refusal' );
	}

	public function test_stdout_is_exactly_the_bearer_credential(): void {
		( new Session_CLI_Command() )->issue( [ 'kea-claude-7731', 'tune', '5400' ], [] );

		$this->assertCount( 1, $GLOBALS['_test_wp_cli_lines'] );
		$this->assertMatchesRegularExpression( '/^[0-9a-f]{32}\.[0-9a-f]{64}$/D', $GLOBALS['_test_wp_cli_lines'][0] );
		$this->assertSame( [], $GLOBALS['_test_wp_cli_logs'] );
		$this->assertSame( [], $GLOBALS['_test_wp_cli_success'] );
	}

	public function test_the_session_acts_as_the_current_user_with_the_requested_role(): void {
		( new Session_CLI_Command() )->issue( [ 'kea-claude-7731', 'tune', '5400' ], [] );

		[ $handle, $secret ] = \explode( '.', $GLOBALS['_test_wp_cli_lines'][0] );
		$record              = Command_Auth::load_session_record( $handle );
		$this->assertSame( $secret, $record['key'] );
		$this->assertSame( self::USER, $record['user'] );
		$this->assertSame( Capabilities::TUNE, $record['scope'] );
		$this->assertEqualsWithDelta( \time() + 5400, $record['expires'], 5 );
	}

	public function test_the_session_is_listed_under_its_label(): void {
		( new Session_CLI_Command() )->issue( [ 'kea-claude-7731', 'tune', '5400' ], [] );

		[ $handle ] = \explode( '.', $GLOBALS['_test_wp_cli_lines'][0] );
		$this->assertSame( [ $handle ], Sessions::handles_labelled( 'kea-claude-7731' ) );
		$this->assertSame( Capabilities::TUNE, Sessions::all()[ $handle ]['scope'] );
	}

	public function test_role_and_ttl_default_to_manage_and_the_session_ttl(): void {
		( new Session_CLI_Command() )->issue( [ 'kea-claude-7731' ], [] );

		[ $handle ] = \explode( '.', $GLOBALS['_test_wp_cli_lines'][0] );
		$record     = Command_Auth::load_session_record( $handle );
		$this->assertSame( Capabilities::MANAGE, $record['scope'] );
		$this->assertEqualsWithDelta( \time() + Command_Auth::SESSION_TTL_S, $record['expires'], 5 );
	}

	public function test_no_current_user_is_refused_naming_the_user_flag(): void {
		$GLOBALS['_wp_test_current_user_id'] = 0;

		$this->assertStringContainsString( '--user=<login>', $this->refusal( [ 'kea-claude-7731' ] ) );
	}

	public function test_a_role_the_user_does_not_hold_is_refused_naming_the_highest_held(): void {
		Roles::install();
		$GLOBALS['_wp_test_current_user_can'] = [
			Roles::CAP_READ => true,
			Roles::CAP_TUNE => true,
		];

		$message = $this->refusal( [ 'kea-claude-7731', 'manage' ] );

		$this->assertStringContainsString( 'manage', $message );
		$this->assertStringContainsString( 'tune', $message );
	}

	public function test_an_unknown_role_is_refused(): void {
		$this->assertStringContainsString( 'unknown role: quokka', $this->refusal( [ 'kea-claude-7731', 'quokka' ] ) );
	}

	public function test_a_ttl_below_the_minimum_is_refused_naming_the_bounds(): void {
		$message = $this->refusal( [ 'kea-claude-7731', 'read', (string) ( Command_Auth::SESSION_TTL_MIN_S - 1 ) ] );

		$this->assertStringContainsString( (string) Command_Auth::SESSION_TTL_MIN_S, $message );
		$this->assertStringContainsString( (string) Command_Auth::SESSION_TTL_MAX_S, $message );
	}

	public function test_a_ttl_above_the_maximum_is_refused(): void {
		$this->assertStringContainsString(
			(string) Command_Auth::SESSION_TTL_MAX_S,
			$this->refusal( [ 'kea-claude-7731', 'read', (string) ( Command_Auth::SESSION_TTL_MAX_S + 1 ) ] )
		);
	}

	public function test_a_non_integer_ttl_is_refused(): void {
		$this->assertStringContainsString( '90m', $this->refusal( [ 'kea-claude-7731', 'read', '90m' ] ) );
	}

	public function test_an_empty_label_is_refused(): void {
		$this->assertStringContainsString( 'label', $this->refusal( [ '  ' ] ) );
	}

	public function test_a_missing_label_is_refused(): void {
		$this->assertStringContainsString( 'label', $this->refusal( [] ) );
	}
}
