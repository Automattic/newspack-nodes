<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Rest\Spawn_Controller;
use Newspack_Nodes\Supervisor;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Spawn_Controller::class )]
class SpawnControllerTest extends TestCase {
	private Supervisor $supervisor;
	private Spawn_Controller $controller;

	protected function setUp(): void {
		parent::setUp();
		$GLOBALS['_wp_test_registered_routes'] = [];
		$GLOBALS['_wp_actions']                = [];
		$GLOBALS['_wp_test_transients']        = [];
		$GLOBALS['_wp_test_current_user_can']  = [];
		$GLOBALS['_wp_test_valid_nonces']      = [];
		$GLOBALS['_wp_test_current_user_id']   = 0;
		$this->supervisor = new Supervisor( '/tmp', 'NONCE_SALT_FOR_TEST' );
		$this->controller = new Spawn_Controller( $this->supervisor );
	}

	protected function tearDown(): void {
		$GLOBALS['_wp_test_registered_routes'] = [];
		$GLOBALS['_wp_actions']                = [];
		$GLOBALS['_wp_test_transients']        = [];
		$GLOBALS['_wp_test_current_user_can']  = [];
		$GLOBALS['_wp_test_valid_nonces']      = [];
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
		$token = $this->supervisor->generate_spawn_token( \time() );
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
		// — supervisor manages its own MIN_SPAWN_INTERVAL_S.
		$token = $this->supervisor->generate_spawn_token( \time() );
		$req   = $this->make_request( [ 'nonce' => $token ] );

		$this->assertTrue( $this->controller->check_permission( $req ) );
		$this->assertTrue( $this->controller->check_permission( $req ) );
		$this->assertTrue( $this->controller->check_permission( $req ) );
	}

	// ── validate_worker_type ──────────────────────────────────────────────

	public function test_validate_worker_type_accepts_supervisor(): void {
		$this->assertTrue( $this->controller->validate_worker_type( 'supervisor' ) );
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

	public function test_validate_partition_supervisor_requires_zero(): void {
		$this->assertTrue( $this->controller->validate_partition( 'supervisor', 0 ) );
		$this->assertFalse( $this->controller->validate_partition( 'supervisor', 1 ) );
		$this->assertFalse( $this->controller->validate_partition( 'supervisor', 5 ) );
	}

	// ── spawn dispatch ────────────────────────────────────────────────────

	public function test_spawn_returns_400_on_out_of_range_partition(): void {
		$this->with_topology( [
			'firehose-workers' => [ 'num_partitions' => 2, 'topology' => '/x.php' ],
		] );
		$req = $this->make_request( [
			'type'      => 'firehose-workers',
			'partition' => 5,
			'nonce'     => $this->supervisor->generate_spawn_token( \time() ),
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
			'nonce'     => $this->supervisor->generate_spawn_token( \time() ),
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
			'nonce'     => $this->supervisor->generate_spawn_token( \time() ),
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
			'nonce'     => $this->supervisor->generate_spawn_token( \time() ),
		] );
		$response = $this->controller->spawn( $req );
		$this->assertInstanceOf( \WP_REST_Response::class, $response );
		$this->assertSame( 200, $response->get_status() );
		$data = $response->get_data();
		$this->assertTrue( $data['spawned'] );
		$this->assertSame( 'firehose-workers', $data['type'] );
		$this->assertSame( 0, $data['partition'] );
	}

	// ── supervisor-as-worker dispatch ─────────────────────────────────────

	public function test_spawn_supervisor_runs_supervisor_synchronously(): void {
		// Disable logging so Supervisor::run() exits early in check_config()
		// before touching any locks. We just want to verify the dispatch
		// path; Supervisor's tick loop has its own tests.
		\add_filter( 'newspack_nodes/enable_logging', fn() => false );

		$req = $this->make_request( [
			'type'      => 'supervisor',
			'partition' => 0,
			'nonce'     => $this->supervisor->generate_spawn_token( \time() ),
		] );
		$response = $this->controller->spawn( $req );

		$this->assertInstanceOf( \WP_REST_Response::class, $response );
		$this->assertSame( 200, $response->get_status() );

		$data = $response->get_data();
		$this->assertTrue( $data['spawned'] );
		$this->assertSame( 'supervisor', $data['type'] );
		$this->assertSame( 0, $data['partition'] );
		$this->assertArrayHasKey( 'result', $data );
	}

	// ── sanitize_worker_result (type-based projection) ────────────────────

	public function test_sanitize_worker_result_keeps_status_and_numeric_fields(): void {
		$result = [
			'status'             => 'completed',
			'entries_processed'  => 1234,
			'requests_complete'  => 7,
			'requests_pending'   => 2,
			'flames_written'     => 11,
			'jobs_processed'     => 89,
			'memory_usage'       => 999, // arbitrary numeric counter now surfaces (type-based, not name-whitelisted)
			// non-numeric / nested fields that must NOT propagate:
			'stack_trace'        => 'Fatal at /var/www/secret.php:99',
			'error'              => 'database creds invalid',
			'_internal_state'    => [ 'private' => 'data' ],
		];

		$safe = $this->controller->sanitize_worker_result( $result );

		$this->assertSame( 'completed', $safe['status'] );
		$this->assertSame( 1234, $safe['entries_processed'] );
		$this->assertSame( 7, $safe['requests_complete'] );
		$this->assertSame( 2, $safe['requests_pending'] );
		$this->assertSame( 11, $safe['flames_written'] );
		$this->assertSame( 89, $safe['jobs_processed'] );
		$this->assertSame( 999, $safe['memory_usage'] );

		$this->assertArrayNotHasKey( 'stack_trace', $safe );
		$this->assertArrayNotHasKey( 'error', $safe );
		$this->assertArrayNotHasKey( '_internal_state', $safe );
	}

	public function test_sanitize_worker_result_surfaces_arbitrary_numeric_counter(): void {
		// A non-ELN plugin's worker counter must survive — this was stripped by
		// the old SAFE_RESULT_FIELDS name whitelist.
		$safe = $this->controller->sanitize_worker_result(
			[ 'status' => 'done', 'custom_counter' => '7', 'entries_processed' => 3 ]
		);
		$this->assertSame( 'done', $safe['status'] );
		$this->assertSame( 7, $safe['custom_counter'] );
		$this->assertSame( 3, $safe['entries_processed'] );
	}

	public function test_sanitize_worker_result_drops_non_numeric_and_bad_keys(): void {
		$safe = $this->controller->sanitize_worker_result(
			[ 'status' => 'ok', 'trace' => '/var/secret/path', 'nested' => [ 1, 2 ], 'bad key!' => 5 ]
		);
		$this->assertArrayNotHasKey( 'trace', $safe );
		$this->assertArrayNotHasKey( 'nested', $safe );
		$this->assertArrayNotHasKey( 'bad key!', $safe );
	}

	public function test_sanitize_worker_result_caps_field_count(): void {
		$big = [ 'status' => 'ok' ];
		for ( $i = 0; $i < 100; $i++ ) {
			$big[ "f{$i}" ] = $i;
		}
		// status + at most 32 numeric counters.
		$this->assertLessThanOrEqual( 33, \count( $this->controller->sanitize_worker_result( $big ) ) );
	}

	public function test_sanitize_worker_result_skips_non_numeric_fields(): void {
		$result = [
			'status'            => 'completed',
			'entries_processed' => 'banana', // non-numeric
		];
		$safe = $this->controller->sanitize_worker_result( $result );
		$this->assertArrayNotHasKey( 'entries_processed', $safe );
	}

	public function test_sanitize_worker_result_handles_non_array(): void {
		$this->assertSame( [ 'status' => 'unknown' ], $this->controller->sanitize_worker_result( null ) );
		$this->assertSame( [ 'status' => 'unknown' ], $this->controller->sanitize_worker_result( 'string' ) );
	}

	public function test_sanitize_worker_result_defaults_status_to_unknown(): void {
		$safe = $this->controller->sanitize_worker_result( [ 'entries_processed' => 5 ] );
		$this->assertSame( 'unknown', $safe['status'] );
	}

	public function test_sanitize_worker_result_coerces_numeric_strings_to_int(): void {
		$result = [
			'status'            => 'completed',
			'entries_processed' => '42', // numeric string is acceptable
		];
		$safe = $this->controller->sanitize_worker_result( $result );
		$this->assertSame( 42, $safe['entries_processed'] );
	}
}
