<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Capabilities;
use Newspack_Nodes\Command_Auth;
use Newspack_Nodes\Core;
use Newspack_Nodes\Oauth_Server;
use Newspack_Nodes\Oauth_Store;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use Newspack_Nodes\Tests\Helpers\Sqlite_Wpdb;
use Newspack_Nodes\Tests\TestCase;

/**
 * The authorization server's documents, registration and token grants, as
 * plain functions over arrays: what each answers with, status and body.
 */
#[CoversClass( Oauth_Server::class )]
final class OauthServerTest extends TestCase {

	private const T0 = 1790030000;

	private const HOME = 'https://kea.example';

	private const RESOURCE = 'https://kea.example/wp-json/kea-logger/v1/mcp';

	private const REDIRECT = 'http://127.0.0.1:4410/callback';

	private const VERIFIER = 'kea-verifier-4410-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789';

	private const USER = 7746;

	/** The user signed in when the token request arrives; no one, on a real one. */
	private const CALLER = 31;

	private const DAY = 86400;

	private Sqlite_Wpdb $db;

	private int $at = self::T0;

	protected function setUp(): void {
		parent::setUp();
		$this->db                             = $this->use_wpdb_sessions();
		Core::$memd                           = new InMemoryMemcached();
		Core::$clock                          = fn (): float => (float) $this->at;
		$_SERVER['HTTPS']                     = 'on';
		$GLOBALS['_wp_test_home_url']         = self::HOME;
		$GLOBALS['_wp_test_current_user_id']  = self::CALLER;
		$GLOBALS['_wp_test_current_user_can'] = [];
		$GLOBALS['_wp_test_user_caps']        = [ self::USER => [ 'edit_others_posts' => true, 'edit_posts' => true ] ];
		\add_filter(
			'newspack_nodes/capability_map',
			static fn ( array $map ): array => [
				Capabilities::READ   => 'edit_posts',
				Capabilities::TUNE   => 'edit_others_posts',
				Capabilities::MANAGE => 'manage_options',
			] + $map
		);
		\add_filter( 'newspack_nodes/oauth_resources', static fn (): array => [ self::RESOURCE ] );
	}

	protected function tearDown(): void {
		unset( $_SERVER['HTTPS'], $GLOBALS['_wp_test_home_url'] );
		Core::$memd = null;
		parent::tearDown();
	}

	private static function challenge( string $verifier ): string {
		return \rtrim( \strtr( \base64_encode( \hash( 'sha256', $verifier, true ) ), '+/', '-_' ), '=' );
	}

	private static function client(): string {
		return Oauth_Store::register_client( 'Kea Desk 4410', [ self::REDIRECT, 'https://claude.ai/api/mcp/auth_callback' ] )['id'];
	}

	/** A code approved for `$client` with tune, as the approval page issues it. */
	private static function code( string $client, string $scope = Capabilities::TUNE ): string {
		return Oauth_Store::issue_code(
			[
				'client'       => $client,
				'redirect_uri' => self::REDIRECT,
				'challenge'    => self::challenge( self::VERIFIER ),
				'resource'     => self::RESOURCE,
				'user'         => self::USER,
				'scope'        => $scope,
				'name'         => 'Tui laptop',
			]
		);
	}

	/** @return array<string,string> */
	private static function exchange( string $client, string $code, array $over = [] ): array {
		return $over + [
			'grant_type'    => 'authorization_code',
			'client_id'     => $client,
			'code'          => $code,
			'redirect_uri'  => self::REDIRECT,
			'code_verifier' => self::VERIFIER,
			'resource'      => self::RESOURCE,
		];
	}

	/** @return array<string,string> */
	private static function refresh( string $client, string $refresh, array $over = [] ): array {
		return $over + [
			'grant_type'    => 'refresh_token',
			'client_id'     => $client,
			'refresh_token' => $refresh,
			'resource'      => self::RESOURCE,
		];
	}

	private function assert_error( int $status, string $error, array $answer, string $message = '' ): void {
		$this->assertSame( $status, $answer['status'], $message );
		$this->assertSame( $error, $answer['body']['error'] ?? null, $message );
		$this->assertIsString( $answer['body']['error_description'] ?? null, $message );
	}

	/** The live session an access token names, checked against its secret. */
	private function session_of( string $access_token ): array {
		[ $handle, $secret ] = \explode( '.', $access_token );
		$record              = Command_Auth::load_session_record( $handle );
		$this->assertNotNull( $record, 'the access token names a live session' );
		$this->assertSame( $secret, $record['key'] );
		return $record + [ 'handle' => $handle ];
	}

	public function test_authorization_metadata_names_s256_and_both_grants(): void {
		$GLOBALS['_wp_test_home_url'] = self::HOME . '/';

		$this->assertSame(
			[
				'issuer'                                => self::HOME,
				'authorization_endpoint'                => \admin_url( 'admin.php?page=newspack-nodes-authorize' ),
				'token_endpoint'                        => \rest_url( 'newspack-nodes/v1/oauth/token' ),
				'registration_endpoint'                 => \rest_url( 'newspack-nodes/v1/oauth/register' ),
				'response_types_supported'              => [ 'code' ],
				'grant_types_supported'                 => [ 'authorization_code', 'refresh_token' ],
				'code_challenge_methods_supported'      => [ 'S256' ],
				'token_endpoint_auth_methods_supported' => [ 'none' ],
				'scopes_supported'                      => [ Capabilities::READ, Capabilities::TUNE ],
			],
			Oauth_Server::authorization_metadata()
		);
	}

	public function test_resource_metadata_only_for_a_declared_resource(): void {
		$this->assertSame(
			[
				'resource'                 => self::RESOURCE,
				'authorization_servers'    => [ self::HOME ],
				'scopes_supported'         => [ Capabilities::READ, Capabilities::TUNE ],
				'bearer_methods_supported' => [ 'header' ],
			],
			Oauth_Server::resource_metadata( self::RESOURCE )
		);
		$this->assertNull( Oauth_Server::resource_metadata( 'https://kea.example/wp-json/kea-other/v1/mcp' ) );
		$this->assertSame(
			'https://kea.example/.well-known/oauth-protected-resource/wp-json/kea-logger/v1/mcp',
			Oauth_Server::resource_metadata_url( self::RESOURCE )
		);
	}

	/** A filter that answers garbage declares nothing, rather than fataling. */
	public function test_a_filter_answering_no_list_declares_no_resource(): void {
		\add_filter( 'newspack_nodes/oauth_resources', static fn (): string => self::RESOURCE );

		$this->assertNull( Oauth_Server::resource_metadata( self::RESOURCE ) );
	}

	public function test_well_known_paths_answer_json_and_others_pass_through(): void {
		$this->assertSame(
			[
				'status' => 200,
				'body'   => Oauth_Server::authorization_metadata(),
			],
			Oauth_Server::well_known( '.well-known/oauth-authorization-server' )
		);
		$this->assertSame(
			[
				'status' => 200,
				'body'   => Oauth_Server::resource_metadata( self::RESOURCE ),
			],
			Oauth_Server::well_known( '.well-known/oauth-protected-resource/wp-json/kea-logger/v1/mcp' )
		);
		foreach ( [ '.well-known/oauth-protected-resource/wp-json/kea-other/v1/mcp', '.well-known/oauth-protected-resource' ] as $undeclared ) {
			$this->assert_error( 404, 'invalid_target', Oauth_Server::well_known( $undeclared ) ?? [ 'status' => 0 ], $undeclared );
		}
		foreach ( [ '', 'about-kea', '.well-known/acme-challenge/kea', '.well-known/oauth-protected-resourcekea', 'wp-json/kea-logger/v1/mcp' ] as $other ) {
			$this->assertNull( Oauth_Server::well_known( $other ), "'{$other}' passes through" );
		}
	}

	/** WordPress trims the request path, so a declared trailing slash must not hide a resource. */
	public function test_a_resource_declared_with_a_trailing_slash_is_served(): void {
		$slashed = 'https://kea.example/wp-json/kea-slash/v1/mcp/';
		\add_filter( 'newspack_nodes/oauth_resources', static fn ( array $resources ): array => [ ...$resources, $slashed ] );

		$this->assertSame( 'https://kea.example/.well-known/oauth-protected-resource/wp-json/kea-slash/v1/mcp', Oauth_Server::resource_metadata_url( $slashed ) );
		$this->assertSame(
			[
				'status' => 200,
				'body'   => Oauth_Server::resource_metadata( $slashed ),
			],
			Oauth_Server::well_known( '.well-known/oauth-protected-resource/wp-json/kea-slash/v1/mcp' )
		);
	}

	public function test_plain_http_is_refused(): void {
		$this->assertNull( Oauth_Server::refuse_insecure() );

		unset( $_SERVER['HTTPS'] );
		$this->assert_error( 400, 'invalid_request', Oauth_Server::refuse_insecure() ?? [ 'status' => 0 ] );
	}

	public function test_registration_returns_a_public_client(): void {
		$answer = Oauth_Server::register(
			[
				'client_name'                => 'Kea Desk 4410',
				'redirect_uris'              => [ self::REDIRECT ],
				'token_endpoint_auth_method' => 'none',
				'grant_types'                => [ 'authorization_code', 'refresh_token' ],
			],
			'203.0.113.44'
		);

		$this->assertSame( 201, $answer['status'] );
		$body = $answer['body'];
		$this->assertMatchesRegularExpression( '/^[0-9a-f]{32}$/D', $body['client_id'] );
		$this->assertSame(
			[
				'client_id'                  => $body['client_id'],
				'client_id_issued_at'        => self::T0,
				'client_name'                => 'Kea Desk 4410',
				'redirect_uris'              => [ self::REDIRECT ],
				'token_endpoint_auth_method' => 'none',
				'grant_types'                => [ 'authorization_code', 'refresh_token' ],
				'response_types'             => [ 'code' ],
			],
			$body
		);
		$this->assertArrayNotHasKey( 'client_secret', $body );
		$this->assertSame( 'Kea Desk 4410', Oauth_Store::client( $body['client_id'] )['name'] ?? null );
	}

	/** The answer is what the store kept: a list of URIs, the name as cleaned. */
	public function test_registration_answers_with_what_the_store_kept(): void {
		$this->at = self::T0 + 23;

		$answer = Oauth_Server::register(
			[
				'client_name'   => '<b>Kea</b>   Desk 4410',
				'redirect_uris' => [ 'kea' => self::REDIRECT ],
			],
			'203.0.113.44'
		);

		$this->assertSame( 201, $answer['status'] );
		$kept = Oauth_Store::client( $answer['body']['client_id'] );
		$this->assertSame( [ 'Kea Desk 4410', [ self::REDIRECT ], self::T0 + 23 ], [ $kept['name'], $kept['redirect_uris'], $kept['created'] ] );
		$this->assertSame( [ $kept['name'], $kept['redirect_uris'], $kept['created'] ], [ $answer['body']['client_name'], $answer['body']['redirect_uris'], $answer['body']['client_id_issued_at'] ] );
	}

	public function test_registration_refuses_a_client_that_is_not_public(): void {
		$answer = Oauth_Server::register(
			[
				'client_name'                => 'Kea Desk 4410',
				'redirect_uris'              => [ self::REDIRECT ],
				'token_endpoint_auth_method' => 'client_secret_basic',
			],
			'203.0.113.44'
		);

		$this->assert_error( 400, 'invalid_client_metadata', $answer );
	}

	public function test_registration_refuses_a_redirect_neither_https_nor_loopback(): void {
		foreach ( [ [ 'http://kea.example/cb' ], 'https://claude.ai/cb', [] ] as $uris ) {
			$answer = Oauth_Server::register(
				[
					'client_name'   => 'Kea Desk 4410',
					'redirect_uris' => $uris,
				],
				'203.0.113.44'
			);
			$this->assert_error( 400, 'invalid_redirect_uri', $answer, \wp_json_encode( $uris ) );
		}
		$this->assert_error( 400, 'invalid_client_metadata', Oauth_Server::register( [ 'redirect_uris' => [ self::REDIRECT ] ], '203.0.113.44' ), 'a client names itself' );
	}

	public function test_registration_is_rate_limited(): void {
		$metadata = [
			'client_name'   => 'Kea Desk 4410',
			'redirect_uris' => [ self::REDIRECT ],
		];
		for ( $i = 1; $i <= 10; $i++ ) {
			$this->assertSame( 201, Oauth_Server::register( $metadata, '203.0.113.44' )['status'], "registration {$i}" );
		}

		$this->assert_error( 429, 'rate_limited', Oauth_Server::register( $metadata, '203.0.113.44' ) );
		$this->assertSame( 201, Oauth_Server::register( $metadata, '198.51.100.7' )['status'], 'the budget is per address' );
	}

	/** Like the MCP door, a door no cache can meter is refused, never left open. */
	public function test_an_unmetered_registration_is_refused(): void {
		Core::$memd = null;

		$answer = Oauth_Server::register(
			[
				'client_name'   => 'Kea Desk 4410',
				'redirect_uris' => [ self::REDIRECT ],
			],
			'203.0.113.44'
		);

		$this->assert_error( 503, 'rate_limit_unavailable', $answer );
	}

	public function test_a_code_exchange_needs_the_exact_redirect_and_verifier(): void {
		$client = self::client();

		$this->assert_error( 400, 'invalid_grant', Oauth_Server::token( self::exchange( $client, self::code( $client ), [ 'code_verifier' => self::VERIFIER . 'x' ] ) ), 'a wrong verifier' );
		$this->assert_error( 400, 'invalid_grant', Oauth_Server::token( self::exchange( $client, self::code( $client ), [ 'redirect_uri' => 'https://claude.ai/api/mcp/auth_callback' ] ) ), 'another registered redirect' );
		$this->assert_error( 400, 'invalid_grant', Oauth_Server::token( self::exchange( $client, self::code( $client ), [ 'redirect_uri' => self::REDIRECT . '/' ] ) ), 'a near redirect' );

		$code = self::code( $client );
		$good = Oauth_Server::token( self::exchange( $client, $code ) );

		$this->assertSame( 200, $good['status'] );
		$this->assertSame( [ 'access_token', 'token_type', 'expires_in', 'refresh_token', 'scope' ], \array_keys( $good['body'] ) );
		$this->assertSame( 'Bearer', $good['body']['token_type'] );
		$this->assertSame( 3600, $good['body']['expires_in'] );
		$this->assertSame( Capabilities::TUNE, $good['body']['scope'] );
		$this->assertMatchesRegularExpression( '/^[0-9a-f]{64}$/D', $good['body']['refresh_token'] );
		$session = $this->session_of( $good['body']['access_token'] );
		$this->assertSame( Capabilities::TUNE, $session['scope'] );
		$this->assertSame( self::USER, $session['user'] );
		$this->assertSame( self::RESOURCE, $session['resource'] );
		$this->assertSame( 'Tui laptop', $session['label'] );
		$this->assertSame( [ $session['grant'] ], \array_column( Oauth_Store::grants(), 'grant' ) );
		$this->assertSame( self::CALLER, \get_current_user_id(), 'the caller is signed back in' );

		$this->assert_error( 400, 'invalid_grant', Oauth_Server::token( self::exchange( $client, $code ) ), 'a reused code' );
		$this->assertCount( 1, Oauth_Store::grants(), 'a refused exchange opens no grant' );
	}

	public function test_a_code_is_spent_by_the_client_it_was_issued_to(): void {
		$client = self::client();
		$code   = self::code( $client );

		$this->assert_error( 400, 'invalid_grant', Oauth_Server::token( self::exchange( self::client(), $code ) ) );
		$this->assert_error( 400, 'invalid_grant', Oauth_Server::token( self::exchange( $client, $code ) ), 'the refusal spent the code' );
	}

	public function test_a_resource_the_code_was_not_issued_for_is_refused(): void {
		$client = self::client();

		$answer = Oauth_Server::token( self::exchange( $client, self::code( $client ), [ 'resource' => 'https://kea.example/wp-json/kea-other/v1/mcp' ] ) );

		$this->assert_error( 400, 'invalid_grant', $answer );
		$this->assertSame( [], Oauth_Store::grants() );
	}

	public function test_a_code_exchange_missing_a_field_is_an_invalid_request(): void {
		$client = self::client();
		foreach ( [ 'code', 'redirect_uri', 'code_verifier', 'resource' ] as $field ) {
			$params = self::exchange( $client, self::code( $client ) );
			unset( $params[ $field ] );
			$this->assert_error( 400, 'invalid_request', Oauth_Server::token( $params ), $field );
		}
		$this->assert_error( 400, 'invalid_request', Oauth_Server::token( [ 'grant_type' => 'refresh_token', 'client_id' => $client ] ), 'refresh_token' );
	}

	public function test_a_registration_the_store_refuses_answers_503(): void {
		$this->db->deny['INSERT IGNORE'] = 'Deadlock found 4410';

		$answer = Oauth_Server::register( [ 'client_name' => 'Kea Desk 4410', 'redirect_uris' => [ self::REDIRECT ] ], '203.0.113.44' );

		$this->db->deny = [];
		$this->assert_error( 503, 'temporarily_unavailable', $answer );
		$this->assertStringNotContainsString( '4410', (string) $answer['body']['error_description'] );
	}

	public function test_an_unknown_client_answers_401_invalid_client(): void {
		$client = self::client();
		$code   = self::code( $client );

		foreach ( [ 'feedfacefeedfacefeedfacefeedface', '', "kea\n4410" ] as $unknown ) {
			$this->assert_error( 401, 'invalid_client', Oauth_Server::token( self::exchange( $unknown, $code ) ), \json_encode( $unknown ) );
			$this->assert_error( 401, 'invalid_client', Oauth_Server::token( self::refresh( $unknown, 'kea' ) ), \json_encode( $unknown ) );
		}
		$this->assertSame( 200, Oauth_Server::token( self::exchange( $client, $code ) )['status'], 'an unknown client spends no code' );
	}

	public function test_an_unsupported_grant_type_is_named(): void {
		$client = self::client();

		$this->assert_error( 400, 'unsupported_grant_type', Oauth_Server::token( [ 'grant_type' => 'client_credentials', 'client_id' => $client ] ) );
		$this->assert_error( 400, 'invalid_request', Oauth_Server::token( [ 'client_id' => $client ] ) );
	}

	public function test_token_requests_are_rate_limited_per_client(): void {
		$client = self::client();
		for ( $i = 1; $i <= 30; $i++ ) {
			$this->assert_error( 400, 'invalid_grant', Oauth_Server::token( self::refresh( $client, "kea-{$i}" ) ), "request {$i}" );
		}

		$this->assert_error( 429, 'rate_limited', Oauth_Server::token( self::refresh( $client, 'kea-31' ) ) );
		$this->assert_error( 400, 'invalid_grant', Oauth_Server::token( self::refresh( self::client(), 'kea-31' ) ), 'another client has its own budget' );
	}

	public function test_an_unmetered_token_request_is_refused(): void {
		$client     = self::client();
		Core::$memd = null;

		$this->assert_error( 503, 'rate_limit_unavailable', Oauth_Server::token( self::exchange( $client, self::code( $client ) ) ) );
	}

	public function test_a_store_outage_answers_503_and_names_nothing_of_it(): void {
		$client                         = self::client();
		$code                           = self::code( $client );
		$this->db->deny['INSERT IGNORE'] = 'Deadlock found 4410';

		$answer = Oauth_Server::token( self::exchange( $client, $code ) );

		$this->assert_error( 503, 'temporarily_unavailable', $answer );
		$this->assertStringNotContainsString( '4410', (string) \wp_json_encode( $answer ) );
	}

	public function test_a_refresh_mints_a_new_session_and_rotates(): void {
		$client = self::client();
		$first  = Oauth_Server::token( self::exchange( $client, self::code( $client ) ) )['body'];

		$this->at = self::T0 + 3000;
		$second   = Oauth_Server::token( self::refresh( $client, $first['refresh_token'] ) );

		$this->assertSame( 200, $second['status'] );
		$this->assertSame( Capabilities::TUNE, $second['body']['scope'] );
		$this->assertSame( 3600, $second['body']['expires_in'] );
		$this->assertNotSame( $first['refresh_token'], $second['body']['refresh_token'] );
		$old = $this->session_of( $first['access_token'] );
		$new = $this->session_of( $second['body']['access_token'] );
		$this->assertNotSame( $old['handle'], $new['handle'] );
		$this->assertSame( [ self::USER, Capabilities::TUNE, self::RESOURCE, $old['grant'] ], [ $new['user'], $new['scope'], $new['resource'], $new['grant'] ] );
		$this->assertSame( self::CALLER, \get_current_user_id(), 'the caller is signed back in' );

		$this->at = self::T0 + 3000 + 61;
		$this->assert_error( 400, 'invalid_grant', Oauth_Server::token( self::refresh( $client, $first['refresh_token'] ) ), 'a spent token' );
		$this->assertNull( Command_Auth::load_session_record( $new['handle'] ), 'reuse after the grace revokes the grant' );
	}

	/** A retry inside the grace is checked as a first refresh is. */
	public function test_a_refresh_retried_within_the_grace_is_still_checked(): void {
		$client   = self::client();
		$other    = self::client();
		$first    = Oauth_Server::token( self::exchange( $client, self::code( $client ) ) )['body'];
		$this->at = self::T0 + 10;
		$second   = Oauth_Server::token( self::refresh( $client, $first['refresh_token'] ) );

		$this->at = self::T0 + 40;

		$this->assert_error( 400, 'invalid_grant', Oauth_Server::token( self::refresh( $other, $first['refresh_token'] ) ), 'another client' );
		$this->assert_error( 400, 'invalid_grant', Oauth_Server::token( self::refresh( $client, $first['refresh_token'], [ 'resource' => 'https://kea.example/wp-json/kea-other/v1/mcp' ] ) ), 'another resource' );
		$retry = Oauth_Server::token( self::refresh( $client, $first['refresh_token'] ) );
		$this->assertSame( 200, $retry['status'] );
		$this->assertSame( $second['body'], $retry['body'], 'the honest retry gets the same pair' );
	}

	/** Without a resource the grant's own binds the session; another is refused. */
	public function test_a_refresh_naming_another_resource_or_client_is_refused(): void {
		$client = self::client();
		$first  = Oauth_Server::token( self::exchange( $client, self::code( $client ) ) )['body'];

		$this->assert_error( 400, 'invalid_grant', Oauth_Server::token( self::refresh( $client, $first['refresh_token'], [ 'resource' => 'https://kea.example/wp-json/kea-other/v1/mcp' ] ) ) );
		$this->assert_error( 400, 'invalid_grant', Oauth_Server::token( self::refresh( self::client(), $first['refresh_token'] ) ) );

		$params = self::refresh( $client, $first['refresh_token'] );
		unset( $params['resource'] );
		$answer = Oauth_Server::token( $params );
		$this->assertSame( 200, $answer['status'], 'the refused refreshes spent nothing' );
		$this->assertSame( self::RESOURCE, $this->session_of( $answer['body']['access_token'] )['resource'] );
	}

	public function test_a_refresh_lives_no_longer_than_its_grant(): void {
		$client = self::client();
		$first  = Oauth_Server::token( self::exchange( $client, self::code( $client ) ) )['body'];

		$this->at = self::T0 + 30 * self::DAY - 600;
		$last     = Oauth_Server::token( self::refresh( $client, $first['refresh_token'] ) );

		$this->assertSame( 600, $last['body']['expires_in'] );
	}

	public function test_a_refresh_for_a_user_who_lost_the_scope_is_refused(): void {
		$client = self::client();
		$first  = Oauth_Server::token( self::exchange( $client, self::code( $client ) ) )['body'];
		$grant  = $this->session_of( $first['access_token'] )['grant'];

		$GLOBALS['_wp_test_user_caps'][ self::USER ] = [ 'edit_posts' => true ];
		$GLOBALS['_wp_test_current_user_can']        = [ 'edit_others_posts' => true, 'edit_posts' => true, 'manage_options' => true ];
		$answer = Oauth_Server::token( self::refresh( $client, $first['refresh_token'] ) );

		$this->assert_error( 400, 'invalid_grant', $answer );
		$this->assertNull( Oauth_Store::grant( $grant ), 'the grant is revoked' );
		$this->assertNull( Command_Auth::load_session_record( \explode( '.', $first['access_token'] )[0] ), 'with every session it minted' );
		$this->assertSame( self::CALLER, \get_current_user_id(), 'the caller is signed back in' );
	}

	/** The operator's `allowed_users` list is asked as the grant's user. */
	public function test_a_refresh_for_a_user_the_operator_list_omits_is_refused(): void {
		$client                          = self::client();
		$first                           = Oauth_Server::token( self::exchange( $client, self::code( $client ) ) )['body'];
		$grant                           = $this->session_of( $first['access_token'] )['grant'];
		$GLOBALS['_wp_test_user_logins'] = [
			self::USER   => 'tui-4410',
			self::CALLER => 'kea-admin',
		];
		\update_option( 'newspack_nodes_allowed_users', [ 'kea-admin' ] );
		\Newspack_Nodes\Config::reset();

		$this->assert_error( 400, 'invalid_grant', Oauth_Server::token( self::refresh( $client, $first['refresh_token'] ) ) );
		$this->assertNull( Oauth_Store::grant( $grant ), 'the grant is revoked' );
	}

	/** A store that fails once the grant is open leaves no grant behind. */
	public function test_a_store_outage_after_the_grant_opens_revokes_it(): void {
		$client = self::client();
		$code   = self::code( $client );
		\add_filter(
			'newspack_nodes/capability_map',
			function ( array $map ): array {
				$this->db->deny['INSERT IGNORE'] = 'Deadlock found 4410';
				return $map;
			}
		);

		$answer = Oauth_Server::token( self::exchange( $client, $code ) );

		$this->db->deny = [];
		$this->assert_error( 503, 'temporarily_unavailable', $answer );
		$this->assertSame( [], Oauth_Store::grants() );
	}

	/** The approver is checked again when the code is spent, a minute after approval at most. */
	public function test_a_code_for_a_user_who_lost_the_scope_opens_no_grant(): void {
		$client                                      = self::client();
		$GLOBALS['_wp_test_user_caps'][ self::USER ] = [ 'edit_posts' => true ];

		$this->assert_error( 400, 'invalid_grant', Oauth_Server::token( self::exchange( $client, self::code( $client ) ) ) );
		$this->assertSame( [], Oauth_Store::grants() );
	}

	/** The page and the mint ask one question: does the user hold this scope's own capability? */
	public function test_can_grant_asks_each_scope_its_own_capability(): void {
		\add_filter( 'newspack_nodes/capability_map', static fn ( array $map ): array => [ Capabilities::READ => 'kea_read_4410' ] + $map );
		$GLOBALS['_wp_test_current_user_id'] = self::USER;

		$this->assertTrue( Oauth_Server::can_grant( Capabilities::TUNE ) );
		$this->assertFalse( Oauth_Server::can_grant( Capabilities::READ ), 'tune held does not stand in for read' );

		$GLOBALS['_wp_test_user_caps'][ self::USER ]['manage_options'] = true;
		$this->assertFalse( Oauth_Server::can_grant( Capabilities::MANAGE ), 'outside Oauth_Store::SCOPES' );
	}

	/** A code whose scope OAuth may not grant opens no grant. */
	public function test_a_code_for_a_scope_oauth_cannot_grant_opens_no_grant(): void {
		$client                                      = self::client();
		$GLOBALS['_wp_test_user_caps'][ self::USER ] = [ 'manage_options' => true, 'edit_others_posts' => true, 'edit_posts' => true ];

		$this->assert_error( 400, 'invalid_grant', Oauth_Server::token( self::exchange( $client, self::code( $client, Capabilities::MANAGE ) ) ) );
		$this->assertSame( [], Oauth_Store::grants() );
	}
}
