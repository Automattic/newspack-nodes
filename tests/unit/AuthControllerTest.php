<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Rest\Auth_Controller;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use Newspack_Nodes\Command_Auth;
use Newspack_Nodes\Core;

#[CoversClass( Auth_Controller::class )]
class AuthControllerTest extends TestCase {

	private ?\Memcached $prev_memd = null;

	protected function setUp(): void {
		parent::setUp();
		$this->prev_memd = Core::$memd;
		Core::$memd      = new InMemoryMemcached();
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => true ];
		$GLOBALS['_wp_test_is_multisite']     = false;
		$GLOBALS['_wp_test_is_main_site']     = true;
	}

	protected function tearDown(): void {
		$GLOBALS['_wp_test_current_user_can'] = [];
		$GLOBALS['_wp_test_is_multisite']     = false;
		$GLOBALS['_wp_test_is_main_site']     = true;
		Core::$memd                           = $this->prev_memd;
		parent::tearDown();
	}

	public function test_issues_a_session_whose_key_resolves_by_its_handle(): void {
		$body = ( new Auth_Controller() )->issue( new \WP_REST_Request() );

		$this->assertSame(
			$body['key'],
			( Command_Auth::load_session_record( $body['handle'] )['key'] ?? null ),
			'the issued key must be the one the verifier will resolve'
		);
		$this->assertSame( Command_Auth::SESSION_TTL_S, $body['expires_in'] );
	}

	/** The response is the only place the key is ever disclosed; nothing else may ride along. */
	public function test_the_response_carries_only_the_session_fields(): void {
		$body = ( new Auth_Controller() )->issue( new \WP_REST_Request() );

		$this->assertSame( [ 'expires_in', 'handle', 'key', 'now', 'scope' ], $this->sorted_keys( $body ) );
	}

	public function test_a_main_site_manage_options_user_is_permitted(): void {
		$this->assertTrue( ( new Auth_Controller() )->check_permission( new \WP_REST_Request() ) );
	}

	/**
	 * Bootstrap::register_rest_routes() drives this too, but #[CoversClass] there
	 * credits Bootstrap — the route shape has to be asserted from here to count.
	 */
	public function test_it_registers_one_post_route_behind_its_permission_gate(): void {
		$GLOBALS['_wp_test_registered_routes'] = [];

		( new Auth_Controller() )->register_routes();

		$routes = $GLOBALS['_wp_test_registered_routes'];
		$this->assertCount( 1, $routes );
		$this->assertSame( 'newspack-nodes/v1', $routes[0]['namespace'] );
		$this->assertSame( '/auth', $routes[0]['route'] );
		$this->assertSame( 'POST', $routes[0]['args']['methods'] );
		$this->assertSame(
			'check_permission',
			$routes[0]['args']['permission_callback'][1],
			'the route must not be reachable without the gate'
		);
	}

	public function test_a_user_without_manage_options_is_refused(): void {
		$GLOBALS['_wp_test_current_user_can'] = [ 'edit_posts' => true ];

		$this->assertNotTrue( ( new Auth_Controller() )->check_permission( new \WP_REST_Request() ) );
	}

	/**
	 * The fleet is network-global — locks, IPC and logs carry no blog namespace —
	 * so a subsite admin must not mint a session against the main site's fleet.
	 * Spawn_Controller enforces this; the audit found the other routes do not.
	 */
	public function test_a_multisite_subsite_is_refused(): void {
		$GLOBALS['_wp_test_is_multisite'] = true;
		$GLOBALS['_wp_test_is_main_site'] = false;

		$result = ( new Auth_Controller() )->check_permission( new \WP_REST_Request() );

		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 'newspack_nodes_not_fleet_site', $result->get_error_code() );
	}

	/** @param array<string,mixed> $body */
	private function sorted_keys( array $body ): array {
		$keys = \array_keys( $body );
		\sort( $keys );
		return $keys;
	}
}
