<?php
/**
 * Tests for `wp nodes session issue|list|revoke`.
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
require_once \dirname( __DIR__ ) . '/Helpers/WPCLIUtilsStub.php';

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
		foreach ( [ '_test_wp_cli_lines', '_test_wp_cli_logs', '_test_wp_cli_errors', '_test_wp_cli_warns', '_test_wp_cli_success', '_test_wp_cli_tables' ] as $global ) {
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

	/** @return array<string,array<string,mixed>> Each listed session by handle. */
	private static function listed(): array {
		return \array_column( Sessions::listing(), null, 'handle' );
	}

	private function refusal( array $args ): string {
		try {
			( new Session_CLI_Command() )->issue( $args, [] );
		} catch ( \RuntimeException $e ) {
			$this->assertSame( [], $GLOBALS['_test_wp_cli_lines'], 'a refusal prints no credential' );
			$this->assertSame( [], Sessions::listing(), 'a refusal mints nothing' );
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
		$this->assertEqualsWithDelta( 5400, $record['ttl'], 5 );
	}

	public function test_the_session_is_listed_under_its_label(): void {
		( new Session_CLI_Command() )->issue( [ 'kea-claude-7731', 'tune', '5400' ], [] );

		[ $handle ] = \explode( '.', $GLOBALS['_test_wp_cli_lines'][0] );
		$this->assertSame( [ [ 'handle' => $handle, 'label' => 'kea-claude-7731', 'scope' => Capabilities::TUNE ] ], \array_map( static fn ( array $row ): array => \array_intersect_key( $row, [ 'handle' => 0, 'label' => 0, 'scope' => 0 ] ), Sessions::listing() ) );
	}

	public function test_role_and_ttl_default_to_manage_and_the_session_ttl(): void {
		( new Session_CLI_Command() )->issue( [ 'kea-claude-7731' ], [] );

		[ $handle ] = \explode( '.', $GLOBALS['_test_wp_cli_lines'][0] );
		$record     = Command_Auth::load_session_record( $handle );
		$this->assertSame( Capabilities::MANAGE, $record['scope'] );
		$this->assertEqualsWithDelta( Command_Auth::SESSION_TTL_S, $record['ttl'], 5 );
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

	public function test_a_user_holding_no_role_is_refused(): void {
		$GLOBALS['_wp_test_current_user_can'] = [];

		$this->assertStringContainsString( 'holds no Newspack Nodes role', $this->refusal( [ 'kea-claude-7731', 'read' ] ) );
	}

	public function test_a_store_that_will_not_open_is_refused_naming_why(): void {
		$GLOBALS['wpdb'] = null;

		try {
			( new Session_CLI_Command() )->issue( [ 'kea-claude-7731', 'tune', '5400' ], [] );
			$this->fail( 'expected a refusal' );
		} catch ( \RuntimeException $e ) {
			$this->assertStringContainsString( 'wpdb backend needs $wpdb', $e->getMessage() );
		}
		$this->assertCount( 1, $GLOBALS['_test_wp_cli_errors'] );
		$this->assertSame( [], $GLOBALS['_test_wp_cli_lines'], 'a refusal prints no credential' );
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

	/** Refusal message a `list` or `revoke` raised through `WP_CLI::error()`. */
	private function cli_error( \Closure $run ): string {
		try {
			$run( new Session_CLI_Command() );
		} catch ( \RuntimeException $e ) {
			$this->assertSame( [], $GLOBALS['_test_wp_cli_success'], 'a refusal reports no success' );
			$this->assertCount( 1, $GLOBALS['_test_wp_cli_errors'] );
			return $GLOBALS['_test_wp_cli_errors'][0];
		}
		$this->fail( 'expected a refusal' );
	}

	public function test_list_as_json_carries_every_listed_fact_and_never_the_secret(): void {
		$session = Sessions::issue( 'tieke-8840', Capabilities::TUNE, 7200 );

		( new Session_CLI_Command() )->list_( [], [ 'format' => 'json' ] );

		$table = $GLOBALS['_test_wp_cli_tables'][0];
		$this->assertSame( 'json', $table['format'] );
		$this->assertSame( Sessions::listing(), $table['items'] );
		$this->assertSame( $session['handle'], $table['items'][0]['handle'] );
		$this->assertSame( 'tieke-8840', $table['items'][0]['label'] );
		$this->assertSame( [ 'handle', 'label', 'scope', 'created', 'expires' ], $table['fields'] );
		$this->assertStringNotContainsString( $session['secret'], (string) \wp_json_encode( $GLOBALS['_test_wp_cli_tables'] ) );
		$this->assertStringNotContainsString( $session['secret'], \implode( "\n", $GLOBALS['_test_wp_cli_lines'] ) );
	}

	/**
	 * A label cut at MAX_LABEL never splits a character: 63 bytes then a
	 * two-byte 'é' keeps the 63 and drops the 'é' whole, so the stored label
	 * stays UTF-8 and the JSON listing encodes it.
	 */
	public function test_a_label_cut_inside_a_character_round_trips_through_the_json_listing(): void {
		$stem = \str_repeat( 'kea', 21 );
		Sessions::issue( $stem . 'é', Capabilities::READ, 3300 );

		( new Session_CLI_Command() )->list_( [], [ 'format' => 'json' ] );

		$items = $GLOBALS['_test_wp_cli_tables'][0]['items'];
		$this->assertSame( $stem, $items[0]['label'] );
		$this->assertSame( $stem, \json_decode( \json_encode( $items, \JSON_THROW_ON_ERROR ), true )[0]['label'] );
	}

	public function test_list_as_a_table_reads_the_times_in_utc(): void {
		$session = Sessions::issue( 'hihi-8840', Capabilities::READ, 7200 );
		$row     = self::listed()[ $session['handle'] ];

		( new Session_CLI_Command() )->list_( [], [] );

		$table = $GLOBALS['_test_wp_cli_tables'][0];
		$this->assertSame( 'table', $table['format'] );
		$this->assertEquals(
			[
				'handle'  => $session['handle'],
				'label'   => 'hihi-8840',
				'scope'   => Capabilities::READ,
				'created' => \gmdate( 'Y-m-d H:i:s', $row['created'] ) . ' UTC',
				'expires' => \gmdate( 'Y-m-d H:i:s', $row['expires'] ) . ' UTC',
			],
			$table['items'][0]
		);
		$this->assertStringNotContainsString( $session['secret'], \implode( "\n", $GLOBALS['_test_wp_cli_lines'] ) );
	}

	public function test_list_of_nothing_prints_the_header_alone(): void {
		( new Session_CLI_Command() )->list_( [], [ 'format' => 'json' ] );

		$this->assertSame( [], $GLOBALS['_test_wp_cli_tables'][0]['items'] );
	}

	public function test_list_refuses_a_store_that_will_not_open_naming_why(): void {
		$GLOBALS['wpdb'] = null;

		$this->assertStringContainsString( 'wpdb backend needs $wpdb', $this->cli_error( static fn ( $cli ) => $cli->list_( [], [] ) ) );
		$this->assertSame( [], $GLOBALS['_test_wp_cli_tables'] );
	}

	public function test_revoke_by_handle_kills_the_key_and_reports_it(): void {
		$doomed    = Sessions::issue( 'moho-8840', Capabilities::TUNE, 900 );
		$bystander = Sessions::issue( 'titipounamu-8840', Capabilities::READ, 900 );

		( new Session_CLI_Command() )->revoke( [ $doomed['handle'] ], [] );

		$this->assertSame( [ "Revoked {$doomed['handle']}." ], $GLOBALS['_test_wp_cli_success'] );
		$this->assertNull( Command_Auth::load_session_record( $doomed['handle'] ) );
		$this->assertSame( [ $bystander['handle'] ], \array_keys( self::listed() ) );
	}

	public function test_revoke_of_a_label_naming_two_sessions_fails_naming_both(): void {
		$first  = Sessions::issue( 'kokako-8840', Capabilities::READ, 900 );
		$second = Sessions::issue( 'kokako-8840', Capabilities::TUNE, 900 );

		$message = $this->cli_error( static fn ( $cli ) => $cli->revoke( [ 'kokako-8840' ], [] ) );

		$this->assertStringStartsWith( 'no session with handle kokako-8840; the label kokako-8840 names ', $message );
		$this->assertStringContainsString( $first['handle'], $message );
		$this->assertStringContainsString( $second['handle'], $message );
		$this->assertCount( 2, Sessions::listing(), 'naming a label revokes nothing' );
	}

	public function test_revoke_of_a_handle_no_session_holds_fails(): void {
		$this->assertSame(
			'no session with handle nsh-absent-8840',
			$this->cli_error( static fn ( $cli ) => $cli->revoke( [ 'nsh-absent-8840' ], [] ) )
		);
	}

	public function test_revoke_fails_when_the_store_does_not_answer(): void {
		$session = Sessions::issue( 'koekoea-8840', Capabilities::READ, 900 );
		$GLOBALS['wpdb']->deny['DELETE FROM `wp_newspack_nodes_table`'] = 'Lock wait timeout 8840';

		$this->assertSame(
			"session store did not answer; {$session['handle']} may still be live",
			$this->cli_error( static fn ( $cli ) => $cli->revoke( [ $session['handle'] ], [] ) )
		);
		$this->assertArrayHasKey( $session['handle'], self::listed() );
	}
}
