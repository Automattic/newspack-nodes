<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\DataProvider;
use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Cache_Backend;
use Newspack_Nodes\Config;
use Newspack_Nodes\Core;
use Newspack_Nodes\Health_Checks;
use Newspack_Nodes\Internal_Request_Token;
use Newspack_Nodes\Rest\Health_Cache_Controller;
use Newspack_Nodes\Tests\TestCase;

#[CoversClass( Health_Cache_Controller::class )]
class HealthCacheControllerTest extends TestCase {

	private const SALT = 'CACHE_ROUTE_SALT_8843';

	protected function setUp(): void {
		parent::setUp();
		$GLOBALS['_wp_test_registered_routes'] = [];
		$GLOBALS['_wp_test_is_multisite']      = false;
		$GLOBALS['_wp_test_is_main_site']      = true;
	}

	protected function tearDown(): void {
		Health_Cache_Controller::$clock        = null;
		Bootstrap::$spawn_coordinator_factory         = null;
		Cache_Backend::$apcu_usable            = static fn (): bool => false;
		$GLOBALS['_wp_test_registered_routes'] = [];
		$GLOBALS['_wp_test_is_multisite']      = false;
		$GLOBALS['_wp_test_is_main_site']      = true;
		parent::tearDown();
	}

	private function controller( int $now ): Health_Cache_Controller {
		Health_Cache_Controller::$clock = static fn (): int => $now;
		return new Health_Cache_Controller( self::SALT );
	}

	private function request( mixed $token = null ): \WP_REST_Request {
		$request = new \WP_REST_Request( 'POST', '/newspack-nodes/v1/health/cache' );
		if ( null !== $token ) {
			$request->set_param( 'token', $token );
		}
		return $request;
	}

	public function test_health_cache_controller_class_exists(): void {
		$this->assertTrue(
			\class_exists( 'Newspack_Nodes\\Rest\\Health_Cache_Controller' )
		);
	}

	public function test_registers_only_the_post_cache_health_route(): void {
		$controller = new Health_Cache_Controller( self::SALT );
		$controller->register_routes();

		$this->assertCount( 1, $GLOBALS['_wp_test_registered_routes'] );
		$route = $GLOBALS['_wp_test_registered_routes'][0];

		$this->assertSame( 'newspack-nodes/v1', $route['namespace'] );
		$this->assertSame( '/health/cache', $route['route'] );
		$this->assertSame( 'POST', $route['args']['methods'] );
		$this->assertSame( [ 'token' ], \array_keys( $route['args']['args'] ) );
		$this->assertSame( [ $controller, 'probe' ], $route['args']['callback'] );
		$this->assertSame( [ $controller, 'check_permission' ], $route['args']['permission_callback'] );
	}

	public function test_empty_nonce_salt_fails_loudly(): void {
		$this->expectException( \InvalidArgumentException::class );
		new Health_Cache_Controller( '' );
	}

	public function test_multisite_subsite_is_rejected_before_token_validation(): void {
		$GLOBALS['_wp_test_is_multisite'] = true;
		$GLOBALS['_wp_test_is_main_site'] = false;

		$result = $this->controller( 2_000_027 )->check_permission( $this->request() );

		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 'newspack_nodes_not_fleet_site', $result->get_error_code() );
		$this->assertSame( 403, $result->get_error_data()['status'] );
	}

	public function test_missing_health_token_is_rejected(): void {
		$result = $this->controller( 2_000_027 )->check_permission( $this->request() );

		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 'invalid_health_token', $result->get_error_code() );
		$this->assertSame( 403, $result->get_error_data()['status'] );
	}

	#[DataProvider( 'malformed_health_tokens' )]
	public function test_malformed_health_token_is_rejected_without_echoing_it( mixed $token ): void {
		$result = $this->controller( 2_000_027 )->check_permission( $this->request( $token ) );

		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 'invalid_health_token', $result->get_error_code() );
		$this->assertSame( 403, $result->get_error_data()['status'] );
		if ( \is_string( $token ) && '' !== $token ) {
			$this->assertStringNotContainsString( $token, $result->get_error_message() );
		}
	}

	public static function malformed_health_tokens(): iterable {
		yield 'empty' => [ '' ];
		yield 'too short' => [ \str_repeat( 'a', 63 ) ];
		yield 'too long' => [ \str_repeat( 'b', 65 ) ];
		yield 'uppercase' => [ \str_repeat( 'C', 64 ) ];
		yield 'non-hex' => [ \str_repeat( 'g', 64 ) ];
		yield 'array' => [ [ 'not-a-token' ] ];
		yield 'integer' => [ 8_843 ];
	}

	public function test_current_and_previous_health_tokens_are_accepted_without_runtime_dependencies(): void {
		Core::$memd                       = null;
		Cache_Backend::$apcu_usable       = static fn (): bool => throw new \RuntimeException( 'cache accessed' );
		Bootstrap::$spawn_coordinator_factory    = static fn (): \Newspack_Nodes\Spawn_Coordinator => throw new \RuntimeException( 'spawn coordinator constructed' );
		$config_dir                       = $this->make_temp_dir( 'health-route-token-8843-' );
		$config_file                      = $config_dir . '/refused.php';
		\file_put_contents(
			$config_file,
			"<?php\nreturn [ 'base_directory' => '/root/newspack-nodes-refused-route-8843' ];\n"
		);
		\putenv( 'LOCAL_NEWSPACK_NODES_CONF=' . $config_file );
		Config::reset();
		$now = 2_000_027;

		foreach ( [ $now, $now - Internal_Request_Token::WINDOW_S ] as $issued_at ) {
			$token = Internal_Request_Token::generate(
				Internal_Request_Token::PURPOSE_HEALTH_CACHE,
				$issued_at,
				self::SALT
			);

			$this->assertTrue( $this->controller( $now )->check_permission( $this->request( $token ) ) );
		}
	}

	#[DataProvider( 'invalid_health_token_windows' )]
	public function test_expired_and_future_health_tokens_are_rejected( int $issued_at ): void {
		$now   = 2_000_027;
		$token = Internal_Request_Token::generate(
			Internal_Request_Token::PURPOSE_HEALTH_CACHE,
			$issued_at,
			self::SALT
		);

		$result = $this->controller( $now )->check_permission( $this->request( $token ) );

		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 'invalid_health_token', $result->get_error_code() );
		$this->assertSame( 403, $result->get_error_data()['status'] );
	}

	public static function invalid_health_token_windows(): iterable {
		yield 'expired' => [ 2_000_027 - ( 2 * Internal_Request_Token::WINDOW_S ) ];
		yield 'future' => [ 2_000_027 + Internal_Request_Token::WINDOW_S ];
	}

	public function test_spawn_token_cannot_authorize_the_health_route(): void {
		$now   = 2_000_027;
		$token = Internal_Request_Token::generate(
			Internal_Request_Token::PURPOSE_SPAWN,
			$now,
			self::SALT
		);

		$result = $this->controller( $now )->check_permission( $this->request( $token ) );

		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 'invalid_health_token', $result->get_error_code() );
		$this->assertSame( 403, $result->get_error_data()['status'] );
	}

	public function test_probe_returns_the_canonical_critical_result_as_http_200_without_caller_data(): void {
		Core::$memd                 = null;
		Cache_Backend::$apcu_usable = static fn (): bool => false;
		$request                    = $this->request();
		$request->set_param( 'key', 'CALLER_CACHE_KEY_8843' );
		$request->set_param( 'value', 'CALLER_CACHE_VALUE_8843' );
		$expected = Health_Checks::cache_backend();

		$response = $this->controller( 2_000_027 )->probe( $request );

		$this->assertSame( 200, $response->get_status() );
		$this->assertSame( $expected, $response->get_data() );
		$this->assertSame( Health_Checks::STATUS_CRITICAL, $response->get_data()['status'] );
		$encoded = (string) \wp_json_encode( $response->get_data() );
		$this->assertStringNotContainsString( 'CALLER_CACHE_KEY_8843', $encoded );
		$this->assertStringNotContainsString( 'CALLER_CACHE_VALUE_8843', $encoded );
	}
}
