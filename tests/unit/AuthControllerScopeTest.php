<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Cache_Backend;
use Newspack_Nodes\Capabilities;
use Newspack_Nodes\Command_Auth;
use Newspack_Nodes\Core;
use Newspack_Nodes\Rest\Auth_Controller;
use Newspack_Nodes\Sessions;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use Newspack_Nodes\Tests\TestCase;

/**
 * `/auth` issues SCOPED sessions, and the scope it hands out is clamped to
 * what the authenticating user actually holds — so a listing can be read as
 * the truth about a session's authority rather than as its request.
 */
#[CoversClass( Auth_Controller::class )]
class AuthControllerScopeTest extends TestCase {

	private ?\Memcached $prev_memd = null;

	protected function setUp(): void {
		parent::setUp();
		$this->prev_memd = Core::$memd;
		Core::$memd      = new InMemoryMemcached();
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => true ];
	}

	protected function tearDown(): void {
		$GLOBALS['_wp_test_current_user_can'] = [];
		$GLOBALS['_wp_actions']               = [];
		Cache_Backend::$apcu_usable           = static fn (): bool => false;
		Capabilities::$session_scope          = null;
		Core::$memd                           = $this->prev_memd;
		parent::tearDown();
	}

	private function request( array $params = [] ): \WP_REST_Request {
		$req = new \WP_REST_Request();
		foreach ( $params as $key => $value ) {
			$req->set_param( $key, $value );
		}
		return $req;
	}

	public function test_a_scopeless_request_still_gets_an_unrestricted_session(): void {
		$body = ( new Auth_Controller() )->issue( $this->request() );

		$this->assertSame( Capabilities::MANAGE, $body['scope'] );
		$this->assertSame( Capabilities::MANAGE, ( Command_Auth::load_session_record( $body['handle'] )['scope'] ?? null ) );
	}

	public function test_a_requested_scope_is_honoured(): void {
		$body = ( new Auth_Controller() )->issue( $this->request( [ 'scope' => Capabilities::TUNE ] ) );

		$this->assertSame( Capabilities::TUNE, $body['scope'] );
		$this->assertSame( Capabilities::TUNE, ( Command_Auth::load_session_record( $body['handle'] )['scope'] ?? null ) );
	}

	public function test_a_scope_is_clamped_to_what_the_minting_user_holds(): void {
		add_filter(
			'newspack_nodes/capability_map',
			static fn ( array $map ): array => [ 'read' => 'edit_pages' ] + $map
		);
		$GLOBALS['_wp_test_current_user_can'] = [ 'edit_pages' => true, 'manage_options' => false ];

		$body = ( new Auth_Controller() )->issue( $this->request( [ 'scope' => Capabilities::MANAGE ] ) );

		$this->assertSame(
			Capabilities::READ,
			$body['scope'],
			'a session must never claim more authority than its minter'
		);
	}

	public function test_an_unknown_scope_is_refused(): void {
		$result = ( new Auth_Controller() )->issue( $this->request( [ 'scope' => 'wizard' ] ) );

		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 'invalid_scope', $result->get_error_code() );
	}

	public function test_a_read_only_user_may_mint(): void {
		add_filter(
			'newspack_nodes/capability_map',
			static fn ( array $map ): array => [ 'read' => 'edit_pages' ] + $map
		);
		$GLOBALS['_wp_test_current_user_can'] = [ 'edit_pages' => true, 'manage_options' => false ];

		$this->assertTrue( ( new Auth_Controller() )->check_permission( $this->request() ) );
	}

	public function test_a_user_holding_nothing_may_not_mint(): void {
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => false ];

		$this->assertFalse( ( new Auth_Controller() )->check_permission( $this->request() ) );
	}

	public function test_a_labelled_session_is_listed_in_the_directory(): void {
		$body = ( new Auth_Controller() )->issue(
			$this->request( [ 'scope' => Capabilities::TUNE, 'label' => 'laptop mcp' ] )
		);

		$rows = Sessions::all();
		$this->assertArrayHasKey( $body['handle'], $rows );
		$this->assertSame( 'laptop mcp', $rows[ $body['handle'] ]['label'] );
		$this->assertSame( Capabilities::TUNE, $rows[ $body['handle'] ]['scope'] );
		$this->assertTrue( $rows[ $body['handle'] ]['live'] );
	}

	public function test_a_requested_ttl_is_bounded(): void {
		$body = ( new Auth_Controller() )->issue( $this->request( [ 'ttl' => 99999999 ] ) );

		$this->assertSame( Command_Auth::SESSION_TTL_MAX_S, $body['expires_in'] );
	}
}
