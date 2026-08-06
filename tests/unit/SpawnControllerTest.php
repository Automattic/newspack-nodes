<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Rest\Spawn_Controller;
use Newspack_Nodes\Spawn_Coordinator;
use Newspack_Nodes\Tests\TestCase;

#[CoversClass( Spawn_Controller::class )]
class SpawnControllerTest extends TestCase {
	private Spawn_Coordinator $fleet;
	private Spawn_Controller $controller;

	protected function setUp(): void {
		parent::setUp();
		$GLOBALS['_wp_test_registered_routes'] = [];
		$GLOBALS['_wp_actions']                = [];
		$GLOBALS['_wp_test_transients']        = [];
		$GLOBALS['_wp_test_current_user_can']  = [];
		$GLOBALS['_wp_test_valid_nonces']      = [];
		$GLOBALS['_wp_test_current_user_id']   = 0;
		Bootstrap::$fleet_enabled_override = null;
		Bootstrap::$spawn_coordinator_factory          = null;
		unset( $GLOBALS['_wp_options']['newspack_nodes_topologies'] );
		\Newspack_Nodes\Config::reset();
		$this->fleet = new Spawn_Coordinator( '/tmp', 'NONCE_SALT_FOR_TEST' );
		$this->controller = new Spawn_Controller( $this->fleet );
	}

	protected function tearDown(): void {
		$GLOBALS['_wp_test_registered_routes'] = [];
		$GLOBALS['_wp_actions']                = [];
		$GLOBALS['_wp_test_transients']        = [];
		$GLOBALS['_wp_test_current_user_can']  = [];
		$GLOBALS['_wp_test_valid_nonces']      = [];
		unset( $GLOBALS['_wp_options']['newspack_nodes_topologies'] );
		\Newspack_Nodes\Config::reset();
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

	private function with_topology( array $topologies ): void {
		\add_filter( 'newspack_nodes/topologies', function () use ( $topologies ) {
			return $topologies;
		} );
		// Catalog registration no longer activates a topology; declare the
		// catalogued names as the active operator overlay so validation/spawn
		// (which gate on get_topologies()) honor them.
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = \array_keys( $topologies );
		\Newspack_Nodes\Config::reset();
	}

	// ── spawn throttle ─────────────────────────────────────────────────────

	public function test_spawn_rejects_a_respawn_inside_the_throttle_window(): void {
		// The endpoint is the ONE gate every spawn crosses (fleet tick,
		// self_respawn, external UI). A crash-on-boot worker self-respawning as
		// fast as FPM forks must be rejected here — the coordinator's own
		// is_recently_spawned check never sees the self-respawn path.
		$this->with_topology( [
			'burnout' => [ 'num_partitions' => 2, 'topology' => '/x.php' ],
		] );
		$fired = 0;
		\add_action( 'newspack_nodes/spawn_worker', function () use ( &$fired ): void {
			++$fired;
		} );
		$req = $this->make_request( [
			'type'      => 'burnout',
			'partition' => 1,
			'nonce'     => $this->fleet->generate_spawn_token( \time() ),
		] );

		$first = $this->controller->spawn( $req );
		$this->assertInstanceOf( \WP_REST_Response::class, $first );
		$this->assertSame( 1, $fired );

		$second = $this->controller->spawn( $req );
		$this->assertInstanceOf( \WP_Error::class, $second, 'a respawn 0s later must be throttled' );
		$this->assertSame( 'spawn_throttled', $second->get_error_code() );
		$this->assertSame( 1, $fired, 'the throttled spawn must not reach spawn_worker' );
	}

	// ── register_routes ────────────────────────────────────────────────────

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

	public function test_register_routes_attaches_validate_worker_type(): void {
		$this->controller->register_routes();
		$args = $GLOBALS['_wp_test_registered_routes'][0]['args']['args'];
		$this->assertIsCallable( $args['type']['validate_callback'] );
	}

	// ── check_permission: HMAC path (internal) ────────────────────────────

	public function test_check_permission_rejects_empty_nonce(): void {
		$req    = $this->make_request( [ 'nonce' => '' ] );
		$result = $this->controller->check_permission( $req );
		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 'invalid_token', $result->get_error_code() );
	}

	public function test_check_permission_rejects_invalid_nonce_no_caps(): void {
		$req    = $this->make_request( [ 'nonce' => 'totally-bogus-nonce' ] );
		$result = $this->controller->check_permission( $req );
		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 'invalid_token', $result->get_error_code() );
	}

	public function test_check_permission_accepts_valid_hmac_token(): void {
		$token = $this->fleet->generate_spawn_token( \time() );
		$req   = $this->make_request( [ 'nonce' => $token ] );
		$this->assertTrue( $this->controller->check_permission( $req ) );
	}

	// ── check_permission: capability + wp-nonce path (external) ───────────

	public function test_check_permission_accepts_capability_plus_wp_nonce(): void {
		// Stub: user has manage_options AND a valid wp_nonce for our action.
		$GLOBALS['_wp_test_current_user_can']['manage_options']                      = true;
		$GLOBALS['_wp_test_valid_nonces'][ Spawn_Controller::NONCE_ACTION ]            = 'wp-nonce-abc';

		$req    = $this->make_request( [ 'nonce' => 'wp-nonce-abc' ] );
		$result = $this->controller->check_permission( $req );
		$this->assertTrue( $result );
	}

	public function test_check_permission_rejects_capability_without_nonce(): void {
		$GLOBALS['_wp_test_current_user_can']['manage_options'] = true;
		// No nonce registered for our action.
		$req    = $this->make_request( [ 'nonce' => 'wp-nonce-bad' ] );
		$result = $this->controller->check_permission( $req );
		$this->assertInstanceOf( \WP_Error::class, $result );
	}

	public function test_check_permission_rejects_nonce_without_capability(): void {
		$GLOBALS['_wp_test_valid_nonces'][ Spawn_Controller::NONCE_ACTION ] = 'wp-nonce-abc';
		$GLOBALS['_wp_test_current_user_can']['manage_options']            = false;
		$req    = $this->make_request( [ 'nonce' => 'wp-nonce-abc' ] );
		$result = $this->controller->check_permission( $req );
		$this->assertInstanceOf( \WP_Error::class, $result );
	}

	public function test_check_permission_rate_limits_rapid_external_calls(): void {
		// Two rapid valid external calls — second one must be rate-limited.
		$GLOBALS['_wp_test_current_user_can']['manage_options']            = true;
		$GLOBALS['_wp_test_valid_nonces'][ Spawn_Controller::NONCE_ACTION ] = 'wp-nonce-abc';

		$req = $this->make_request( [ 'nonce' => 'wp-nonce-abc' ] );

		$this->assertTrue( $this->controller->check_permission( $req ) );

		$result = $this->controller->check_permission( $req );
		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 'rate_limited', $result->get_error_code() );
	}

	public function test_hmac_path_does_not_consume_rate_limit(): void {
		// Internal HMAC requests must NOT trip the per-user 2s rate limit
		// — fleet manages its own MIN_SPAWN_INTERVAL_S.
		$token = $this->fleet->generate_spawn_token( \time() );
		$req   = $this->make_request( [ 'nonce' => $token ] );

		$this->assertTrue( $this->controller->check_permission( $req ) );
		$this->assertTrue( $this->controller->check_permission( $req ) );
		$this->assertTrue( $this->controller->check_permission( $req ) );
	}

	// ── validate_worker_type ──────────────────────────────────────────────

	public function test_validate_worker_type_rejects_the_reconcile_label(): void {
		// There is no fleet process; `fleet` is just an unknown type.
		$this->assertFalse( $this->controller->validate_worker_type( 'fleet' ) );
	}

	public function test_validate_worker_type_accepts_topology_type(): void {
		$this->with_topology( [
			'firehose-workers' => [ 'num_partitions' => 2, 'topology' => '/x.php' ],
		] );
		$this->assertTrue( $this->controller->validate_worker_type( 'firehose-workers' ) );
	}

	public function test_validate_worker_type_rejects_unknown_type(): void {
		$this->with_topology( [
			'firehose-workers' => [ 'num_partitions' => 2, 'topology' => '/x.php' ],
		] );
		$this->assertFalse( $this->controller->validate_worker_type( 'evil-class-name' ) );
	}

	public function test_validate_worker_type_rejects_empty_string(): void {
		$this->assertFalse( $this->controller->validate_worker_type( '' ) );
	}

	public function test_validate_worker_type_rejects_non_string(): void {
		$this->assertFalse( $this->controller->validate_worker_type( 123 ) );
	}

	// ── validate_partition ────────────────────────────────────────────────

	public function test_validate_partition_accepts_in_range(): void {
		$this->with_topology( [
			'firehose-workers' => [ 'num_partitions' => 4, 'topology' => '/x.php' ],
		] );
		$this->assertTrue( $this->controller->validate_partition( 'firehose-workers', 0 ) );
		$this->assertTrue( $this->controller->validate_partition( 'firehose-workers', 3 ) );
	}

	public function test_validate_partition_rejects_out_of_range(): void {
		$this->with_topology( [
			'firehose-workers' => [ 'num_partitions' => 4, 'topology' => '/x.php' ],
		] );
		$this->assertFalse( $this->controller->validate_partition( 'firehose-workers', 4 ) );
		$this->assertFalse( $this->controller->validate_partition( 'firehose-workers', 99 ) );
	}

	public function test_validate_partition_rejects_negative(): void {
		$this->with_topology( [
			'firehose-workers' => [ 'num_partitions' => 4, 'topology' => '/x.php' ],
		] );
		$this->assertFalse( $this->controller->validate_partition( 'firehose-workers', -1 ) );
	}

	public function test_validate_partition_rejects_above_max_partitions(): void {
		$this->with_topology( [
			'huge' => [ 'num_partitions' => 9999, 'topology' => '/x.php' ],
		] );
		// Even with malformed topology, MAX_PARTITIONS still caps.
		$this->assertFalse( $this->controller->validate_partition( 'huge', 16 ) );
		$this->assertFalse( $this->controller->validate_partition( 'huge', 100 ) );
	}

	// ── spawn dispatch ────────────────────────────────────────────────────

	public function test_spawn_returns_400_on_out_of_range_partition(): void {
		$this->with_topology( [
			'firehose-workers' => [ 'num_partitions' => 2, 'topology' => '/x.php' ],
		] );
		$req = $this->make_request( [
			'type'      => 'firehose-workers',
			'partition' => 5,
			'nonce'     => $this->fleet->generate_spawn_token( \time() ),
		] );
		$result = $this->controller->spawn( $req );
		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 'invalid_partition', $result->get_error_code() );
	}

	public function test_spawn_fires_action_for_topology_worker(): void {
		$this->with_topology( [
			'firehose-workers' => [ 'num_partitions' => 4, 'topology' => '/x.php' ],
		] );
		$captured = null;
		\add_action(
			'newspack_nodes/spawn_worker',
			function ( string $type, int $partition ) use ( &$captured ): void {
				$captured = [ 'type' => $type, 'partition' => $partition ];
			}
		);

		$req = $this->make_request( [
			'type'      => 'firehose-workers',
			'partition' => 2,
			'nonce'     => $this->fleet->generate_spawn_token( \time() ),
		] );
		$this->controller->spawn( $req );

		$this->assertNotNull( $captured );
		$this->assertSame( 'firehose-workers', $captured['type'] );
		$this->assertSame( 2, $captured['partition'] );
	}

	public function test_spawn_sets_server_context_vars(): void {
		$this->with_topology( [
			'flame-builder' => [ 'num_partitions' => 4, 'topology' => '/x.php' ],
		] );
		$req = $this->make_request( [
			'type'      => 'flame-builder',
			'partition' => 2,
			'nonce'     => $this->fleet->generate_spawn_token( \time() ),
		] );
		$this->controller->spawn( $req );

		$this->assertSame( 'flame-builder', $_SERVER['NEWSPACK_NODES_WORKER_TYPE'] );
		$this->assertSame( '2', $_SERVER['NEWSPACK_NODES_WORKER_PARTITION'] );
	}

	public function test_spawn_returns_200_for_topology_worker(): void {
		$this->with_topology( [
			'firehose-workers' => [ 'num_partitions' => 1, 'topology' => '/x.php' ],
		] );
		$req = $this->make_request( [
			'type'      => 'firehose-workers',
			'partition' => 0,
			'nonce'     => $this->fleet->generate_spawn_token( \time() ),
		] );
		$response = $this->controller->spawn( $req );
		$this->assertInstanceOf( \WP_REST_Response::class, $response );
		$this->assertSame( 200, $response->get_status() );
		$data = $response->get_data();
		$this->assertTrue( $data['spawned'] );
		$this->assertSame( 'firehose-workers', $data['type'] );
		$this->assertSame( 0, $data['partition'] );
	}
}
