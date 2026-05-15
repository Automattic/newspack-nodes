<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Config;
use Newspack_Nodes\Rest\LayoutsController;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( LayoutsController::class )]
class LayoutsControllerTest extends TestCase {

	private string $base_dir;
	private LayoutsController $controller;

	protected function setUp(): void {
		parent::setUp();
		$GLOBALS['_wp_test_registered_routes'] = [];
		$GLOBALS['_wp_actions']                = [];
		$GLOBALS['_wp_options']                = [];
		$GLOBALS['_wp_test_current_user_can']  = [];
		$GLOBALS['_wp_test_valid_nonces']      = [];

		$this->base_dir = $this->make_temp_dir( 'layouts-ctrl-' );
		$this->use_base_dir( $this->base_dir );

		$this->controller = new LayoutsController();
	}

	protected function tearDown(): void {
		$this->rmdir_recursive( $this->base_dir );
		$GLOBALS['_wp_test_current_user_can'] = [];
		$GLOBALS['_wp_test_valid_nonces']     = [];
		// Restore env var to the bootstrap baseline so tests that follow
		// (and rely on the default test config) aren't pointed at the
		// per-test temp config file we just deleted.
		\putenv(
			'LOCAL_NEWSPACK_NODES_CONF=' . \dirname( __DIR__ ) . '/newspack-nodes-test-config.php'
		);
		Config::reset();
		parent::tearDown();
	}

	private function make_get_request( string $name ): \WP_REST_Request {
		$req = new \WP_REST_Request( 'GET', "/newspack-nodes/v1/layouts/{$name}" );
		$req->set_param( 'name', $name );
		return $req;
	}

	private function make_post_request( string $name, string $body, bool $with_nonce = true ): \WP_REST_Request {
		$req = new \WP_REST_Request( 'POST', "/newspack-nodes/v1/layouts/{$name}" );
		$req->set_param( 'name', $name );
		$req->set_body( $body );
		if ( $with_nonce ) {
			$req->set_header( 'X-WP-Nonce', 'valid-nonce' );
		}
		return $req;
	}

	private function authorize_write(): void {
		$GLOBALS['_wp_test_current_user_can']['manage_options']               = true;
		$GLOBALS['_wp_test_valid_nonces'][ LayoutsController::NONCE_ACTION ] = 'valid-nonce';
	}

	// ── register_routes ────────────────────────────────────────────────────

	public function test_register_routes_registers_get_and_post(): void {
		$this->controller->register_routes();
		$routes = $GLOBALS['_wp_test_registered_routes'];

		$this->assertCount( 2, $routes );
		$this->assertSame( 'newspack-nodes/v1', $routes[0]['namespace'] );
		$this->assertSame( '/layouts/(?P<name>[a-zA-Z0-9_-]+)', $routes[0]['route'] );
		$this->assertSame( 'GET', $routes[0]['args']['methods'] );
		$this->assertSame( 'POST', $routes[1]['args']['methods'] );
	}

	public function test_register_routes_attaches_permission_callbacks(): void {
		$this->controller->register_routes();
		$routes = $GLOBALS['_wp_test_registered_routes'];

		$this->assertIsCallable( $routes[0]['args']['permission_callback'] );
		$this->assertIsCallable( $routes[1]['args']['permission_callback'] );
		$this->assertIsCallable( $routes[0]['args']['callback'] );
		$this->assertIsCallable( $routes[1]['args']['callback'] );
	}

	// ── check_read_permission ─────────────────────────────────────────────

	public function test_check_read_permission_allows_manage_options(): void {
		$GLOBALS['_wp_test_current_user_can']['manage_options'] = true;
		$this->assertTrue( $this->controller->check_read_permission() );
	}

	public function test_check_read_permission_rejects_without_capability(): void {
		$GLOBALS['_wp_test_current_user_can'] = [];
		$result = $this->controller->check_read_permission();
		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 'rest_forbidden', $result->get_error_code() );
	}

	// ── check_write_permission ────────────────────────────────────────────

	public function test_check_write_permission_accepts_capability_plus_header_nonce(): void {
		$this->authorize_write();
		$req = $this->make_post_request( 'foo', '{}' );
		$this->assertTrue( $this->controller->check_write_permission( $req ) );
	}

	public function test_check_write_permission_accepts_save_nonce_param(): void {
		$this->authorize_write();
		// Use a param instead of header — controller reads save_nonce first.
		$req = $this->make_post_request( 'foo', '{}', false );
		$req->set_param( 'save_nonce', 'valid-nonce' );
		$this->assertTrue( $this->controller->check_write_permission( $req ) );
	}

	public function test_check_write_permission_rejects_without_capability(): void {
		$GLOBALS['_wp_test_current_user_can'] = [];
		$req    = $this->make_post_request( 'foo', '{}' );
		$result = $this->controller->check_write_permission( $req );
		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 'rest_forbidden', $result->get_error_code() );
	}

	public function test_check_write_permission_rejects_missing_nonce(): void {
		$GLOBALS['_wp_test_current_user_can']['manage_options'] = true;
		$req    = $this->make_post_request( 'foo', '{}', false );
		$result = $this->controller->check_write_permission( $req );
		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 'rest_forbidden', $result->get_error_code() );
	}

	public function test_check_write_permission_rejects_invalid_nonce(): void {
		$GLOBALS['_wp_test_current_user_can']['manage_options'] = true;
		// Register a nonce but send a different value.
		$GLOBALS['_wp_test_valid_nonces'][ LayoutsController::NONCE_ACTION ] = 'real-nonce';
		$req = $this->make_post_request( 'foo', '{}', false );
		$req->set_header( 'X-WP-Nonce', 'bogus-nonce' );
		$result = $this->controller->check_write_permission( $req );
		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 'rest_forbidden', $result->get_error_code() );
	}

	// ── get_layout ────────────────────────────────────────────────────────

	public function test_get_layout_rejects_invalid_name(): void {
		$req      = $this->make_get_request( 'bad name!' );
		$response = $this->controller->get_layout( $req );
		$this->assertInstanceOf( \WP_REST_Response::class, $response );
		$this->assertSame( 400, $response->get_status() );
		$data = $response->get_data();
		$this->assertSame( 'invalid_name', $data['code'] );
	}

	public function test_get_layout_rejects_name_with_slash(): void {
		$req      = $this->make_get_request( 'a/b' );
		$response = $this->controller->get_layout( $req );
		$this->assertSame( 400, $response->get_status() );
		$this->assertSame( 'invalid_name', $response->get_data()['code'] );
	}

	public function test_get_layout_returns_null_positions_when_missing(): void {
		$req      = $this->make_get_request( 'never-saved' );
		$response = $this->controller->get_layout( $req );
		$this->assertSame( 200, $response->get_status() );
		$data = $response->get_data();
		$this->assertSame( 'never-saved', $data['name'] );
		$this->assertNull( $data['positions'] );
	}

	public function test_get_layout_returns_saved_positions(): void {
		\mkdir( "{$this->base_dir}/layouts", 0755, true );
		// Use non-whole floats so json_encode/json_decode round-trips them
		// as floats (whole floats lose type round-tripping through JSON).
		$payload = [ 'positions' => [ 'node_a' => [ 10.5, 20.25 ], 'node_b' => [ 0, 0 ] ] ];
		\file_put_contents(
			"{$this->base_dir}/layouts/saved.layout",
			\json_encode( $payload )
		);

		$req      = $this->make_get_request( 'saved' );
		$response = $this->controller->get_layout( $req );

		$this->assertSame( 200, $response->get_status() );
		$data = $response->get_data();
		$this->assertSame( 'saved', $data['name'] );
		// get_layout returns positions as decoded from JSON without re-casting.
		$this->assertSame(
			[ 'node_a' => [ 10.5, 20.25 ], 'node_b' => [ 0, 0 ] ],
			$data['positions']
		);
	}

	public function test_get_layout_returns_null_when_json_is_invalid(): void {
		\mkdir( "{$this->base_dir}/layouts", 0755, true );
		\file_put_contents( "{$this->base_dir}/layouts/garbage.layout", '{not json}' );

		$req      = $this->make_get_request( 'garbage' );
		$response = $this->controller->get_layout( $req );

		$this->assertSame( 200, $response->get_status() );
		$data = $response->get_data();
		$this->assertSame( 'garbage', $data['name'] );
		$this->assertNull( $data['positions'] );
	}

	public function test_get_layout_returns_null_when_positions_missing(): void {
		\mkdir( "{$this->base_dir}/layouts", 0755, true );
		\file_put_contents(
			"{$this->base_dir}/layouts/no-positions.layout",
			\json_encode( [ 'something_else' => true ] )
		);

		$req      = $this->make_get_request( 'no-positions' );
		$response = $this->controller->get_layout( $req );

		$this->assertSame( 200, $response->get_status() );
		$this->assertNull( $response->get_data()['positions'] );
	}

	// ── save_layout ───────────────────────────────────────────────────────

	public function test_save_layout_rejects_invalid_name(): void {
		$req      = $this->make_post_request(
			'bad name!',
			\json_encode( [ 'positions' => [] ] )
		);
		$response = $this->controller->save_layout( $req );
		$this->assertSame( 400, $response->get_status() );
		$this->assertSame( 'invalid_name', $response->get_data()['code'] );
	}

	public function test_save_layout_rejects_body_too_large(): void {
		// 64 KiB + 1 byte payload — controller uses strlen($body) > MAX_BODY_BYTES.
		$too_big = \str_repeat( 'a', 65537 );
		$req     = $this->make_post_request( 'big', $too_big );
		$response = $this->controller->save_layout( $req );

		$this->assertSame( 413, $response->get_status() );
		$this->assertSame( 'body_too_large', $response->get_data()['code'] );
	}

	public function test_save_layout_rejects_non_json_body(): void {
		$req      = $this->make_post_request( 'foo', 'not-json' );
		$response = $this->controller->save_layout( $req );
		$this->assertSame( 400, $response->get_status() );
		$this->assertSame( 'invalid_body', $response->get_data()['code'] );
	}

	public function test_save_layout_rejects_body_missing_positions(): void {
		$req      = $this->make_post_request(
			'foo',
			\json_encode( [ 'wrong_key' => true ] )
		);
		$response = $this->controller->save_layout( $req );
		$this->assertSame( 400, $response->get_status() );
		$this->assertSame( 'invalid_body', $response->get_data()['code'] );
	}

	public function test_save_layout_rejects_positions_not_array(): void {
		$req      = $this->make_post_request(
			'foo',
			\json_encode( [ 'positions' => 'oops' ] )
		);
		$response = $this->controller->save_layout( $req );
		$this->assertSame( 400, $response->get_status() );
		$this->assertSame( 'invalid_body', $response->get_data()['code'] );
	}

	public function test_save_layout_writes_clean_positions_and_returns_201(): void {
		$payload = [
			'positions' => [
				'node_a' => [ 10.5, 20.5 ],
				'node_b' => [ -3, 7.25 ],
			],
		];
		$req      = $this->make_post_request( 'happy', \json_encode( $payload ) );
		$response = $this->controller->save_layout( $req );

		$this->assertSame( 201, $response->get_status() );
		$data = $response->get_data();
		$this->assertSame( 'happy', $data['name'] );
		$this->assertSame( "{$this->base_dir}/layouts/happy.layout", $data['path'] );
		// In-memory response holds (float)-3 == -3.0 from the controller's cast.
		$this->assertSame(
			[
				'node_a' => [ 10.5, 20.5 ],
				'node_b' => [ -3.0, 7.25 ],
			],
			$data['positions']
		);

		// On-disk round-trip: json_encode normalizes -3.0 -> -3 (int) so use
		// loose equality. We've already asserted exact types above.
		$on_disk = \json_decode( \file_get_contents( $data['path'] ), true );
		$this->assertEquals(
			[ 'node_a' => [ 10.5, 20.5 ], 'node_b' => [ -3, 7.25 ] ],
			$on_disk['positions']
		);
	}

	public function test_save_layout_creates_layouts_dir_if_missing(): void {
		$this->assertDirectoryDoesNotExist( "{$this->base_dir}/layouts" );

		$req = $this->make_post_request(
			'first',
			\json_encode( [ 'positions' => [ 'n' => [ 1, 2 ] ] ] )
		);
		$response = $this->controller->save_layout( $req );

		$this->assertSame( 201, $response->get_status() );
		$this->assertDirectoryExists( "{$this->base_dir}/layouts" );
	}

	public function test_save_layout_drops_non_string_id_entries(): void {
		// Numeric keys flow through as ints — controller checks is_string().
		$payload = [
			'positions' => [
				'keep_me' => [ 1, 2 ],
				42        => [ 3, 4 ], // integer ID — dropped.
			],
		];
		$req      = $this->make_post_request( 'mixed', \json_encode( $payload ) );
		$response = $this->controller->save_layout( $req );

		$this->assertSame( 201, $response->get_status() );
		$clean = $response->get_data()['positions'];
		$this->assertArrayHasKey( 'keep_me', $clean );
		$this->assertArrayNotHasKey( '42', $clean );
		$this->assertArrayNotHasKey( 42, $clean );
	}

	public function test_save_layout_drops_id_with_invalid_characters(): void {
		$payload = [
			'positions' => [
				'good_node'   => [ 1, 2 ],
				'bad node!'   => [ 3, 4 ], // space + ! not in allowed regex.
				'also/bad'    => [ 5, 6 ],
			],
		];
		$req      = $this->make_post_request( 'idchars', \json_encode( $payload ) );
		$response = $this->controller->save_layout( $req );

		$this->assertSame( 201, $response->get_status() );
		$clean = $response->get_data()['positions'];
		$this->assertArrayHasKey( 'good_node', $clean );
		$this->assertArrayNotHasKey( 'bad node!', $clean );
		$this->assertArrayNotHasKey( 'also/bad', $clean );
	}

	public function test_save_layout_drops_non_array_position(): void {
		$payload = [
			'positions' => [
				'good' => [ 1, 2 ],
				'bad'  => 'not-an-array',
			],
		];
		$req      = $this->make_post_request( 'nonarr', \json_encode( $payload ) );
		$response = $this->controller->save_layout( $req );

		$this->assertSame( 201, $response->get_status() );
		$clean = $response->get_data()['positions'];
		$this->assertArrayHasKey( 'good', $clean );
		$this->assertArrayNotHasKey( 'bad', $clean );
	}

	public function test_save_layout_drops_position_with_too_few_coordinates(): void {
		$payload = [
			'positions' => [
				'good' => [ 1, 2 ],
				'bad'  => [ 1 ], // count < 2 — dropped.
				'also' => [],
			],
		];
		$req      = $this->make_post_request( 'short', \json_encode( $payload ) );
		$response = $this->controller->save_layout( $req );

		$this->assertSame( 201, $response->get_status() );
		$clean = $response->get_data()['positions'];
		$this->assertArrayHasKey( 'good', $clean );
		$this->assertArrayNotHasKey( 'bad', $clean );
		$this->assertArrayNotHasKey( 'also', $clean );
	}

	public function test_save_layout_drops_non_finite_coordinates(): void {
		// JSON can't directly express NaN/Inf, so feed raw values that the
		// (float) cast turns infinite. Strings like "Infinity" become 0.0
		// when cast, which IS finite, so use a value whose float cast is
		// not finite via division-style abuse. Easiest: use INF literal in
		// the encoded JSON via a hand-built payload that uses very large
		// numeric strings — but those cast to finite. The controller's
		// is_finite check actually protects against PHP floats already
		// infinite; to exercise it we hand-construct the parsed payload
		// path by sending positions where the (float) cast yields INF
		// via PHP_INT_MAX-style multipliers. A reliable way: ship an
		// array entry whose JSON parses to a very large float (>1e308)
		// expressed as "1e500".
		$body = '{"positions":{"good":[1,2],"bad_inf":["1e500",2],"bad_inf2":[3,"-1e500"]}}';
		$req       = $this->make_post_request( 'inf', $body );
		$response  = $this->controller->save_layout( $req );

		$this->assertSame( 201, $response->get_status() );
		$clean = $response->get_data()['positions'];
		$this->assertArrayHasKey( 'good', $clean );
		$this->assertArrayNotHasKey( 'bad_inf', $clean );
		$this->assertArrayNotHasKey( 'bad_inf2', $clean );
	}

	public function test_save_layout_coerces_extra_array_elements_ignored(): void {
		// Position array with 3+ elements — only first 2 are read.
		$payload = [
			'positions' => [
				'three' => [ 1, 2, 3, 4 ],
			],
		];
		$req      = $this->make_post_request( 'extra', \json_encode( $payload ) );
		$response = $this->controller->save_layout( $req );

		$this->assertSame( 201, $response->get_status() );
		$this->assertSame( [ 1.0, 2.0 ], $response->get_data()['positions']['three'] );
	}

	public function test_save_layout_persists_round_trip_via_get_layout(): void {
		// End-to-end: save then get returns what we saved.
		$payload = [
			'positions' => [
				'alpha' => [ 100.5, 200.25 ],
				'beta'  => [ -50.5, 75.25 ],
			],
		];
		$post     = $this->make_post_request( 'roundtrip', \json_encode( $payload ) );
		$response = $this->controller->save_layout( $post );
		$this->assertSame( 201, $response->get_status() );

		$get  = $this->make_get_request( 'roundtrip' );
		$read = $this->controller->get_layout( $get );

		$this->assertSame( 200, $read->get_status() );
		// Non-whole floats survive json_encode/json_decode as floats.
		$this->assertSame(
			[ 'alpha' => [ 100.5, 200.25 ], 'beta' => [ -50.5, 75.25 ] ],
			$read->get_data()['positions']
		);
	}

	public function test_save_layout_accepts_dotted_and_colon_node_ids(): void {
		// node_ids like `requests:partition:config` and `firehose.in` should
		// survive the sanitization regex.
		$payload = [
			'positions' => [
				'requests:partition:config' => [ 1, 2 ],
				'firehose.in'               => [ 3, 4 ],
				'node-with-dash'            => [ 5, 6 ],
				'node_with_underscore'      => [ 7, 8 ],
			],
		];
		$req      = $this->make_post_request( 'compound', \json_encode( $payload ) );
		$response = $this->controller->save_layout( $req );

		$this->assertSame( 201, $response->get_status() );
		$clean = $response->get_data()['positions'];
		$this->assertCount( 4, $clean );
	}

	public function test_save_layout_accepts_empty_positions(): void {
		$req      = $this->make_post_request(
			'empty',
			\json_encode( [ 'positions' => new \stdClass() ] )
		);
		// JSON object with no keys decodes to [] in PHP; controller still
		// accepts that as a valid (empty) positions map.
		$response = $this->controller->save_layout( $req );
		$this->assertSame( 201, $response->get_status() );
		$this->assertSame( [], $response->get_data()['positions'] );
	}

	public function test_save_layout_accepts_max_size_body(): void {
		// MAX_BODY_BYTES is 65536 — body exactly at the limit must succeed.
		// Build a JSON payload of exact byte size.
		$prefix = '{"positions":{"n":[1,2],"_pad":"';
		$suffix = '"}}';
		$padlen = 65536 - \strlen( $prefix ) - \strlen( $suffix );
		$body   = $prefix . \str_repeat( 'x', $padlen ) . $suffix;
		$this->assertSame( 65536, \strlen( $body ) );

		$req      = $this->make_post_request( 'maxsize', $body );
		$response = $this->controller->save_layout( $req );
		$this->assertSame( 201, $response->get_status() );
	}

	public function test_get_layout_only_returns_positions_subkey(): void {
		// Even if the saved file has extra top-level keys, the response only
		// surfaces `positions`.
		\mkdir( "{$this->base_dir}/layouts", 0755, true );
		\file_put_contents(
			"{$this->base_dir}/layouts/extra.layout",
			\json_encode( [
				'positions' => [ 'n' => [ 1, 2 ] ],
				'secret'    => 'leaked?',
			] )
		);

		$req      = $this->make_get_request( 'extra' );
		$response = $this->controller->get_layout( $req );

		$data = $response->get_data();
		$this->assertArrayHasKey( 'positions', $data );
		$this->assertArrayNotHasKey( 'secret', $data );
	}
}
