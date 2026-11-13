<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Capabilities;
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
		$this->use_base_dir( $this->make_temp_dir( 'auth-sessions-' ) );
		$this->prev_memd = Core::$memd;
		Core::$memd      = new InMemoryMemcached();
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => true ];
		$GLOBALS['_wp_test_is_multisite']     = false;
		// A REST request carries a login; the gate refuses anonymous.
		$GLOBALS['_wp_test_current_user_id'] = 4127;
		$GLOBALS['_wp_test_is_main_site']     = true;
	}

	protected function tearDown(): void {
		$GLOBALS['_wp_test_current_user_can']   = [];
		$GLOBALS['_wp_test_current_user_login'] = '';
		$GLOBALS['_wp_test_is_multisite']       = false;
		$GLOBALS['_wp_test_is_main_site']       = true;
		Core::$memd                             = $this->prev_memd;
		\Newspack_Nodes\Config::reset();
		parent::tearDown();
	}

	/**
	 * `/auth` is where an excluded administrator would otherwise obtain a
	 * signing key scoped to their own capabilities — manage, on a site that has
	 * not filtered the map — and every signed command follows from it.
	 */
	public function test_an_administrator_the_allowlist_excludes_is_issued_no_role(): void {
		\update_option( 'newspack_nodes_allowed_users', [ 'quill', 'mercator' ] );
		\Newspack_Nodes\Config::reset();
		$GLOBALS['_wp_test_current_user_id']    = 4471;
		$GLOBALS['_wp_test_current_user_login'] = 'redshank';

		$this->assertTrue( ( new Auth_Controller() )->check_permission( new \WP_REST_Request() ) );
		$this->assertSame( Capabilities::NONE, ( new Auth_Controller() )->issue( new \WP_REST_Request() )['scope'] );
	}

	public function test_an_administrator_the_allowlist_names_is_permitted(): void {
		\update_option( 'newspack_nodes_allowed_users', [ 'quill', 'mercator' ] );
		\Newspack_Nodes\Config::reset();
		$GLOBALS['_wp_test_current_user_login'] = 'quill';

		$this->assertTrue( ( new Auth_Controller() )->check_permission( new \WP_REST_Request() ) );
	}

	public function test_issues_a_session_whose_key_resolves_by_its_handle(): void {
		$body = ( new Auth_Controller() )->issue( new \WP_REST_Request() );

		$this->assertSame(
			$body['secret'],
			( Command_Auth::load_session_record( $body['handle'] )['key'] ?? null ),
			'the issued key must be the one the verifier will resolve'
		);
		$this->assertSame( Command_Auth::SESSION_TTL_S, $body['expires_in'] );
	}

	/** The response is the only place the key is ever disclosed; nothing else may ride along. */
	public function test_the_response_carries_only_the_session_fields(): void {
		$body = ( new Auth_Controller() )->issue( new \WP_REST_Request() );

		$this->assertSame( [ 'expires_in', 'handle', 'now', 'scope', 'secret' ], $this->sorted_keys( $body ) );
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

	/** The gate asks for a login before any capability. */
	public function test_anonymous_is_refused(): void {
		$GLOBALS['_wp_test_current_user_id']  = 0;
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => true, 'edit_posts' => true ];

		$this->assertFalse( ( new Auth_Controller() )->check_permission( new \WP_REST_Request() ) );
	}

	public function test_a_signed_in_user_without_a_role_is_permitted(): void {
		$GLOBALS['_wp_test_current_user_id']  = 6603;
		$GLOBALS['_wp_test_current_user_can'] = [ 'edit_posts' => true ];

		$this->assertTrue( ( new Auth_Controller() )->check_permission( new \WP_REST_Request() ) );
	}

	/**
	 * A user holding no substrate role gets a `none` session: it covers no
	 * role on the ladder, so only a `wp:` command their own capability
	 * reaches will run under it.
	 */
	public function test_auth_issues_none_scope_below_every_role(): void {
		$GLOBALS['_wp_test_current_user_id']  = 6603;
		$GLOBALS['_wp_test_current_user_can'] = [ 'edit_posts' => true, 'read' => true ];

		$body = ( new Auth_Controller() )->issue( new \WP_REST_Request() );

		$this->assertSame( Capabilities::NONE, $body['scope'] );
		$this->assertSame( Capabilities::NONE, Command_Auth::load_session_record( $body['handle'] )['scope'] ?? null );
		foreach ( [ Capabilities::READ, Capabilities::TUNE, Capabilities::MANAGE ] as $role ) {
			$this->assertFalse( Capabilities::scope_covers( $body['scope'], $role ), $role );
		}
	}

	/** A labelled session is for a CLI, an MCP client or a hub, none of which a `none` scope serves. */
	public function test_a_labelled_request_from_a_user_without_a_role_is_refused(): void {
		$GLOBALS['_wp_test_current_user_id']  = 6603;
		$GLOBALS['_wp_test_current_user_can'] = [ 'edit_posts' => true ];

		$result = ( new Auth_Controller() )->issue( $this->labelled( 'kea laptop' ) );

		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 403, $result->get_error_data()['status'] );
	}

	private function labelled( string $label ): \WP_REST_Request {
		$req = new \WP_REST_Request();
		$req->set_param( 'label', $label );
		return $req;
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

	// ── check_permission: the per-user mint budget ────────────────────────

	/** How many of `$calls` mint gates admit, the cache's clock pinned. */
	private function admitted_mints( int $calls ): int {
		$admitted = 0;
		for ( $i = 0; $i < $calls; $i++ ) {
			if ( true === ( new Auth_Controller() )->check_permission( new \WP_REST_Request() ) ) {
				++$admitted;
			}
		}
		return $admitted;
	}

	/** Pin the cache's expiry clock, the window's only clock. */
	private function pin_cache_clock(): void {
		$memd        = new InMemoryMemcached();
		$memd->clock = static fn (): int => 1_700_000_000;
		Core::$memd  = $memd;
	}

	public function test_over_budget_mints_answer_429(): void {
		$this->pin_cache_clock();
		$GLOBALS['_wp_test_current_user_id'] = 6603;
		\add_filter( 'newspack_nodes/auth_rate_limit', static fn (): int => 3 );

		$this->assertSame( 3, $this->admitted_mints( 3 ) );
		$result = ( new Auth_Controller() )->check_permission( new \WP_REST_Request() );

		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 'rate_limited', $result->get_error_code() );
		$this->assertSame( 429, $result->get_error_data()['status'] );
	}

	public function test_the_mint_budget_defaults_to_its_constant(): void {
		$this->pin_cache_clock();
		$GLOBALS['_wp_test_current_user_id'] = 6603;

		$this->assertSame( Auth_Controller::RATE_LIMIT_BURST, $this->admitted_mints( Auth_Controller::RATE_LIMIT_BURST + 4 ) );
	}

	/** A mint holds its slot for the whole minute, and frees it once the minute ends. */
	public function test_the_mint_window_holds_a_spent_budget_for_its_minute(): void {
		$now         = 1_700_000_000;
		$memd        = new InMemoryMemcached();
		$memd->clock = static function () use ( &$now ): int {
			return $now;
		};
		Core::$memd                          = $memd;
		$GLOBALS['_wp_test_current_user_id'] = 6603;
		\add_filter( 'newspack_nodes/auth_rate_limit', static fn (): int => 2 );
		$this->assertSame( 2, $this->admitted_mints( 2 ) );

		foreach ( [ 2, 58 ] as $at ) {
			$now    = 1_700_000_000 + $at;
			$result = ( new Auth_Controller() )->check_permission( new \WP_REST_Request() );
			$this->assertInstanceOf( \WP_Error::class, $result, "still spent at +{$at} s" );
			$this->assertSame( 429, $result->get_error_data()['status'] );
		}

		$now = 1_700_000_000 + 61;
		$this->assertTrue( ( new Auth_Controller() )->check_permission( new \WP_REST_Request() ), 'admitted again at +61 s' );
	}

	public function test_the_mint_budget_is_per_user(): void {
		$this->pin_cache_clock();
		\add_filter( 'newspack_nodes/auth_rate_limit', static fn (): int => 2 );
		$GLOBALS['_wp_test_current_user_id'] = 6603;
		$this->admitted_mints( 3 );

		$GLOBALS['_wp_test_current_user_id'] = 6604;
		$this->assertSame( 2, $this->admitted_mints( 3 ) );
	}

	/** Anonymous is refused before the budget, so a flood spends no user's slots. */
	public function test_anonymous_spends_no_mint_slot(): void {
		$this->pin_cache_clock();
		\add_filter( 'newspack_nodes/auth_rate_limit', static fn (): int => 2 );
		$GLOBALS['_wp_test_current_user_id'] = 0;
		$this->admitted_mints( 5 );

		$GLOBALS['_wp_test_current_user_id'] = 6603;
		$this->assertSame( 2, $this->admitted_mints( 3 ) );
	}

	/** A dead cache must not lock editors out, so the gate admits and warns. */
	public function test_a_host_with_no_shared_cache_admits_mints_and_warns(): void {
		Core::$memd                          = null;
		$GLOBALS['_wp_test_current_user_id'] = 6603;
		\add_filter( 'newspack_nodes/auth_rate_limit', static fn (): int => 2 );
		$lines = [];
		Core::set_stderr_handler( static function ( string $text ) use ( &$lines ): void {
			$lines[] = $text;
		} );

		$this->assertSame( 5, $this->admitted_mints( 5 ) );
		$this->assertNotEmpty( \array_filter( $lines, static fn ( string $line ): bool => \str_contains( $line, '/auth rate limit unavailable' ) ) );
	}
}
