<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Rest\SpawnController;
use Newspack_Nodes\Supervisor;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( SpawnController::class )]
class SpawnControllerTest extends TestCase {
	private Supervisor $supervisor;
	private SpawnController $controller;

	protected function setUp(): void {
		parent::setUp();
		$GLOBALS['_wp_test_registered_routes'] = [];
		$GLOBALS['_wp_actions']                = [];
		$this->supervisor = new Supervisor( '/tmp', 'NONCE_SALT_FOR_TEST' );
		$this->controller = new SpawnController( $this->supervisor );
	}

	protected function tearDown(): void {
		$GLOBALS['_wp_test_registered_routes'] = [];
		$GLOBALS['_wp_actions']                = [];
		unset(
			$_SERVER['NEWSPACK_NODES_WORKER_TYPE'],
			$_SERVER['NEWSPACK_NODES_WORKER_PARTITION']
		);
		parent::tearDown();
	}

	private function make_request( array $params = [] ): \WP_REST_Request {
		$req = new \WP_REST_Request( 'POST' );
		foreach ( $params as $k => $v ) {
			$req->set_param( $k, $v );
		}
		return $req;
	}

	public function test_register_routes_registers_spawn_route(): void {
		$this->controller->register_routes();
		$routes = $GLOBALS['_wp_test_registered_routes'];
		$this->assertCount( 1, $routes );
		$this->assertSame( 'newspack-nodes/v1', $routes[0]['namespace'] );
		$this->assertSame( '/workers/spawn', $routes[0]['route'] );
		$this->assertSame( 'POST', $routes[0]['args']['methods'] );
	}

	public function test_register_routes_declares_required_params(): void {
		$this->controller->register_routes();
		$args = $GLOBALS['_wp_test_registered_routes'][0]['args']['args'];
		$this->assertTrue( $args['type']['required'] );
		$this->assertTrue( $args['partition']['required'] );
		$this->assertTrue( $args['nonce']['required'] );
	}

	public function test_check_permission_rejects_empty_nonce(): void {
		$req    = $this->make_request( [ 'nonce' => '' ] );
		$result = $this->controller->check_permission( $req );
		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 'invalid_token', $result->get_error_code() );
	}

	public function test_check_permission_rejects_invalid_nonce(): void {
		$req    = $this->make_request( [ 'nonce' => 'totally-bogus-nonce' ] );
		$result = $this->controller->check_permission( $req );
		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 'invalid_token', $result->get_error_code() );
	}

	public function test_check_permission_accepts_valid_token(): void {
		$token = $this->supervisor->generate_spawn_token( \time() );
		$req   = $this->make_request( [ 'nonce' => $token ] );
		$this->assertTrue( $this->controller->check_permission( $req ) );
	}

	public function test_spawn_returns_200_response(): void {
		$req      = $this->make_request( [
			'type'      => 'firehose-workers',
			'partition' => 0,
			'nonce'     => $this->supervisor->generate_spawn_token( \time() ),
		] );
		$response = $this->controller->spawn( $req );
		$this->assertInstanceOf( \WP_REST_Response::class, $response );
		$this->assertSame( 200, $response->get_status() );
		$this->assertSame( [ 'spawned' => true ], $response->get_data() );
	}

	public function test_spawn_fires_spawn_worker_action(): void {
		$captured = null;
		\add_action(
			'newspack_nodes/spawn_worker',
			function ( string $type, int $partition ) use ( &$captured ): void {
				$captured = [ 'type' => $type, 'partition' => $partition ];
			}
		);

		$req = $this->make_request( [
			'type'      => 'job-workers',
			'partition' => 3,
			'nonce'     => $this->supervisor->generate_spawn_token( \time() ),
		] );
		$this->controller->spawn( $req );

		$this->assertNotNull( $captured );
		$this->assertSame( 'job-workers', $captured['type'] );
		$this->assertSame( 3, $captured['partition'] );
	}

	public function test_spawn_sets_server_context_vars(): void {
		$req = $this->make_request( [
			'type'      => 'flame-builder',
			'partition' => 2,
			'nonce'     => $this->supervisor->generate_spawn_token( \time() ),
		] );
		$this->controller->spawn( $req );

		$this->assertSame( 'flame-builder', $_SERVER['NEWSPACK_NODES_WORKER_TYPE'] );
		$this->assertSame( '2', $_SERVER['NEWSPACK_NODES_WORKER_PARTITION'] );
	}
}
