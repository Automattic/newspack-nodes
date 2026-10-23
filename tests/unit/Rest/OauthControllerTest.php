<?php
namespace Newspack_Nodes\Tests\Unit\Rest;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Core;
use Newspack_Nodes\Oauth_Server;
use Newspack_Nodes\Oauth_Store;
use Newspack_Nodes\Rest\HTTP_In_Node;
use Newspack_Nodes\Rest\Oauth_Controller;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use Newspack_Nodes\Tests\TestCase;

/**
 * The OAuth doors: two REST routes and the `.well-known` documents a
 * `parse_request` handler answers before WordPress routes the request.
 */
#[CoversClass( Oauth_Controller::class )]
final class OauthControllerTest extends TestCase {

	private const RESOURCE = 'https://kea.example/wp-json/kea-logger/v1/mcp';

	private const METADATA = [
		'client_name'   => 'Kea Desk 4410',
		'redirect_uris' => [ 'http://127.0.0.1:4410/callback' ],
	];

	/** How many times the request would have ended. */
	private int $exits = 0;

	protected function setUp(): void {
		parent::setUp();
		$this->use_wpdb_sessions();
		Core::$memd                         = new InMemoryMemcached();
		$_SERVER['HTTPS']                   = 'on';
		$_SERVER['REMOTE_ADDR']             = '203.0.113.44';
		$GLOBALS['_wp_test_home_url']       = 'https://kea.example';
		$GLOBALS['_wp_test_status_headers'] = [];
		\add_filter( 'newspack_nodes/oauth_resources', static fn (): array => [ self::RESOURCE ] );
		Oauth_Controller::$exit = function (): void {
			++$this->exits;
		};
	}

	protected function tearDown(): void {
		Oauth_Controller::$exit = null;
		unset( $_SERVER['HTTPS'], $_SERVER['REMOTE_ADDR'], $GLOBALS['_wp_test_home_url'] );
		Core::$memd = null;
		parent::tearDown();
	}

	/** A registration as a client sends one: a JSON body. */
	private static function registration( array $metadata ): \WP_REST_Request {
		$req = new \WP_REST_Request( 'POST' );
		$req->set_header( 'Content-Type', 'application/json' );
		$req->set_body( (string) \wp_json_encode( $metadata ) );
		return $req;
	}

	/** A token request as a client sends one: a form-encoded body. */
	private static function token_request( array $params ): \WP_REST_Request {
		$req = new \WP_REST_Request( 'POST' );
		$req->set_body_params( $params );
		return $req;
	}

	private static function wp( string $request ): \WP {
		$wp          = new \WP();
		$wp->request = $request;
		return $wp;
	}

	/**
	 * What one `.well-known` request sends: status, decoded body, exits.
	 *
	 * @return array{status:int|null,body:mixed,exits:int}
	 */
	private function serve( string $request ): array {
		$GLOBALS['_wp_test_status_headers'] = [];
		$this->exits                        = 0;
		\ob_start();
		Oauth_Controller::serve_well_known( self::wp( $request ) );
		$body = (string) \ob_get_clean();
		return [
			'status' => $GLOBALS['_wp_test_status_headers'][0] ?? null,
			'body'   => '' === $body ? null : \json_decode( $body, true ),
			'exits'  => $this->exits,
		];
	}

	public function test_it_registers_two_post_routes_behind_the_fleet_gate(): void {
		$GLOBALS['_wp_test_registered_routes'] = [];

		( new Oauth_Controller() )->register_routes();

		$routes = $GLOBALS['_wp_test_registered_routes'];
		$this->assertSame( [ '/oauth/register', '/oauth/token' ], \array_column( $routes, 'route' ) );
		foreach ( $routes as $route ) {
			$this->assertSame( HTTP_In_Node::REST_NAMESPACE, $route['namespace'] );
			$this->assertSame( 'POST', $route['args']['methods'] );
			$this->assertSame( 'check_permission', $route['args']['permission_callback'][1] );
		}
	}

	/** Anyone may register or exchange a code; a subsite runs no fleet to sign into. */
	public function test_the_doors_open_to_anyone_on_the_fleet_site_alone(): void {
		$this->assertTrue( ( new Oauth_Controller() )->check_permission() );

		$GLOBALS['_wp_test_is_multisite'] = true;
		$GLOBALS['_wp_test_is_main_site'] = false;
		$refused                          = ( new Oauth_Controller() )->check_permission();

		$this->assertInstanceOf( \WP_Error::class, $refused );
		$this->assertSame( 403, $refused->get_error_data()['status'] ?? null );
	}

	public function test_a_registration_answers_201_uncached_and_meters_the_callers_address(): void {
		$response = ( new Oauth_Controller() )->register( self::registration( self::METADATA ) );

		$this->assertSame( 201, $response->get_status() );
		$this->assertSame( 'Kea Desk 4410', Oauth_Store::client( $response->get_data()['client_id'] )['name'] ?? null );
		$this->assertSame( 'no-store', $response->get_headers()['Cache-Control'] ?? null );
		for ( $i = 2; $i <= 10; $i++ ) {
			( new Oauth_Controller() )->register( self::registration( self::METADATA ) );
		}
		$this->assertSame( 429, ( new Oauth_Controller() )->register( self::registration( self::METADATA ) )->get_status() );
		$_SERVER['REMOTE_ADDR'] = '198.51.100.7';
		$this->assertSame( 201, ( new Oauth_Controller() )->register( self::registration( self::METADATA ) )->get_status() );
	}

	/** RFC 7591 registers from a JSON body; a query string registers nothing. */
	public function test_a_registration_in_the_query_string_is_refused(): void {
		$req = new \WP_REST_Request( 'POST' );
		$req->set_query_params( self::METADATA );

		$response = ( new Oauth_Controller() )->register( $req );

		$this->assertSame( 400, $response->get_status() );
		$this->assertSame( 'invalid_client_metadata', $response->get_data()['error'] ?? null );
	}

	public function test_a_token_answer_is_never_cached(): void {
		$response = ( new Oauth_Controller() )->token(
			self::token_request(
				[
					'grant_type' => 'refresh_token',
					'client_id'  => 'feedfacefeedfacefeedfacefeedface',
				]
			)
		);

		$this->assertSame( 401, $response->get_status() );
		$this->assertSame( 'invalid_client', $response->get_data()['error'] ?? null );
		$this->assertSame( 'no-store', $response->get_headers()['Cache-Control'] ?? null );
		$this->assertSame( 'no-cache', $response->get_headers()['Pragma'] ?? null );
	}

	/** A credential in a URL lands in access logs, so the token endpoint reads the body alone. */
	public function test_token_credentials_in_the_query_string_are_refused(): void {
		$client = Oauth_Store::register_client( 'Kea Desk 4410', self::METADATA['redirect_uris'] )['id'];
		$req    = new \WP_REST_Request( 'POST' );
		$req->set_query_params(
			[
				'grant_type'    => 'refresh_token',
				'client_id'     => $client,
				'refresh_token' => \str_repeat( 'ab', 32 ),
			]
		);
		$req->set_body_params( [ 'client_id' => $client ] );

		$response = ( new Oauth_Controller() )->token( $req );

		$this->assertSame( 400, $response->get_status() );
		$this->assertSame( 'invalid_request', $response->get_data()['error'] ?? null );
		$this->assertSame( 'A token request names its grant_type.', $response->get_data()['error_description'] ?? null );
	}

	public function test_both_doors_refuse_plain_http(): void {
		unset( $_SERVER['HTTPS'] );

		$registered = ( new Oauth_Controller() )->register( self::registration( self::METADATA ) );
		$token      = ( new Oauth_Controller() )->token( self::token_request( [ 'grant_type' => 'refresh_token' ] ) );

		foreach ( [ $registered, $token ] as $response ) {
			$this->assertSame( 400, $response->get_status() );
			$this->assertSame( 'invalid_request', $response->get_data()['error'] ?? null );
		}
		$this->assertSame( [], Core::$memd->keys(), 'nothing was metered or stored' );
	}

	public function test_well_known_paths_answer_json_and_others_pass_through(): void {
		foreach ( [ 'about-kea', '.well-known/acme-challenge/kea' ] as $other ) {
			$this->assertSame(
				[
					'status' => null,
					'body'   => null,
					'exits'  => 0,
				],
				$this->serve( $other ),
				"'{$other}' is WordPress's"
			);
		}

		$this->assertSame(
			[
				'status' => 200,
				'body'   => Oauth_Server::authorization_metadata(),
				'exits'  => 1,
			],
			$this->serve( '.well-known/oauth-authorization-server' )
		);
		$this->assertSame(
			[
				'status' => 200,
				'body'   => Oauth_Server::resource_metadata( self::RESOURCE ),
				'exits'  => 1,
			],
			$this->serve( '.well-known/oauth-protected-resource/wp-json/kea-logger/v1/mcp' )
		);
		$undeclared = $this->serve( '.well-known/oauth-protected-resource/wp-json/kea-other/v1/mcp' );
		$this->assertSame( [ 404, 'invalid_target', 1 ], [ $undeclared['status'], $undeclared['body']['error'] ?? null, $undeclared['exits'] ] );
	}

	public function test_a_well_known_document_is_refused_over_plain_http(): void {
		unset( $_SERVER['HTTPS'] );

		$sent = $this->serve( '.well-known/oauth-authorization-server' );

		$this->assertSame( [ 400, 'invalid_request', 1 ], [ $sent['status'], $sent['body']['error'] ?? null, $sent['exits'] ] );
	}

	public function test_a_subsite_leaves_the_well_known_paths_to_wordpress(): void {
		$GLOBALS['_wp_test_is_multisite'] = true;
		$GLOBALS['_wp_test_is_main_site'] = false;

		$this->assertSame( 0, $this->serve( '.well-known/oauth-authorization-server' )['exits'] );
	}

	/** The plugin file's `parse_request` hook hands an OAuth path to the controller. */
	public function test_the_plugin_answers_well_known_paths_from_parse_request(): void {
		[ $hook ] = $GLOBALS['_wp_actions']['parse_request'] ?? [ null ];
		$this->assertIsCallable( $hook );

		\ob_start();
		$hook( self::wp( '.well-known/oauth-authorization-server' ) );
		$body = \json_decode( (string) \ob_get_clean(), true );

		$this->assertSame( Oauth_Server::authorization_metadata(), $body );
		$this->assertSame( 1, $this->exits );

		\ob_start();
		$hook( self::wp( '.well-known/oauth-protected-resource/wp-json/kea-logger/v1/mcp' ) );
		$body = \json_decode( (string) \ob_get_clean(), true );

		$this->assertSame( Oauth_Server::resource_metadata( self::RESOURCE ), $body );
		$this->assertSame( 2, $this->exits );
	}
}
