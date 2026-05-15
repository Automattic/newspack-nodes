<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Config;
use Newspack_Nodes\Rest\TopologiesController;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Topology_Registry;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * Unit tests for TopologiesController. Complement the integration tests
 * in tests/integration/TopologiesController*Test.php by exercising the
 * uncovered methods (delete_topology, register_routes) plus edge cases
 * across save / get / permission paths.
 */
#[CoversClass( TopologiesController::class )]
class TopologiesControllerTest extends TestCase {

	private string $stock;
	private string $user;

	protected function setUp(): void {
		parent::setUp();
		$GLOBALS['_wp_test_registered_routes'] = [];
		$GLOBALS['_wp_test_current_user_can']  = [ 'manage_options' => true ];
		$GLOBALS['_wp_test_valid_nonces']      = [
			TopologiesController::NONCE_ACTION => 'valid-nonce',
		];
		$GLOBALS['_wp_options'] = [];
		$GLOBALS['_wp_actions'] = [];
		Config::reset();
		Topology_Registry::reset();

		$this->stock = $this->make_temp_dir( 'topologies-ctrl-stock-' );
		$this->user  = $this->make_temp_dir( 'topologies-ctrl-user-' );
		Topology_Registry::register_stock_dir( $this->stock );
		Topology_Registry::set_user_dir( $this->user );
	}

	protected function tearDown(): void {
		$GLOBALS['_wp_test_registered_routes'] = [];
		$GLOBALS['_wp_test_current_user_can']  = [];
		$GLOBALS['_wp_test_valid_nonces']      = [];
		$GLOBALS['_wp_actions']                = [];
		$this->rmdir_recursive( $this->stock );
		$this->rmdir_recursive( $this->user );
		parent::tearDown();
	}

	private function make_request( string $name = '', string $body = '', bool $with_nonce = true, string $method = 'POST' ): \WP_REST_Request {
		$req = new \WP_REST_Request( $method );
		if ( '' !== $name ) {
			$req->set_param( 'name', $name );
			$req->set_url_params( [ 'name' => $name ] );
		}
		if ( '' !== $body ) {
			$req->set_body( $body );
		}
		if ( $with_nonce ) {
			$req->set_header( 'X-WP-Nonce', 'valid-nonce' );
		}
		return $req;
	}

	// ── register_routes ────────────────────────────────────────────────────

	public function test_register_routes_registers_four_routes(): void {
		( new TopologiesController() )->register_routes();
		$routes = $GLOBALS['_wp_test_registered_routes'];
		// GET /topologies, POST /topologies/{name}, GET /topologies/{name}, DELETE /topologies/{name}.
		$this->assertCount( 4, $routes );
	}

	public function test_register_routes_namespace_is_v1(): void {
		( new TopologiesController() )->register_routes();
		foreach ( $GLOBALS['_wp_test_registered_routes'] as $route ) {
			$this->assertSame( 'newspack-nodes/v1', $route['namespace'] );
		}
	}

	public function test_register_routes_list_endpoint_is_get(): void {
		( new TopologiesController() )->register_routes();
		$list = $GLOBALS['_wp_test_registered_routes'][0];
		$this->assertSame( '/topologies', $list['route'] );
		$this->assertSame( 'GET', $list['args']['methods'] );
	}

	public function test_register_routes_save_endpoint_is_post_with_name_param(): void {
		( new TopologiesController() )->register_routes();
		$save = $GLOBALS['_wp_test_registered_routes'][1];
		$this->assertSame( '/topologies/(?P<name>[a-zA-Z0-9_-]+)', $save['route'] );
		$this->assertSame( 'POST', $save['args']['methods'] );
	}

	public function test_register_routes_get_one_endpoint_is_get_with_name_param(): void {
		( new TopologiesController() )->register_routes();
		$get = $GLOBALS['_wp_test_registered_routes'][2];
		$this->assertSame( '/topologies/(?P<name>[a-zA-Z0-9_-]+)', $get['route'] );
		$this->assertSame( 'GET', $get['args']['methods'] );
	}

	public function test_register_routes_delete_endpoint_uses_write_permission(): void {
		( new TopologiesController() )->register_routes();
		$delete = $GLOBALS['_wp_test_registered_routes'][3];
		$this->assertSame( '/topologies/(?P<name>[a-zA-Z0-9_-]+)', $delete['route'] );
		$this->assertSame( 'DELETE', $delete['args']['methods'] );
		// Write permission callback for state-mutating endpoints.
		$callback = $delete['args']['permission_callback'];
		$this->assertIsArray( $callback );
		$this->assertSame( 'check_write_permission', $callback[1] );
	}

	// ── check_read_permission ──────────────────────────────────────────────

	public function test_check_read_permission_grants_when_user_has_manage_options(): void {
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => true ];
		$result = ( new TopologiesController() )->check_read_permission();
		$this->assertTrue( $result );
	}

	public function test_check_read_permission_denies_when_user_lacks_capability(): void {
		$GLOBALS['_wp_test_current_user_can'] = [];
		$result = ( new TopologiesController() )->check_read_permission();
		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 'rest_forbidden', $result->get_error_code() );
		$this->assertSame( 403, $result->get_error_data()['status'] ?? 0 );
	}

	public function test_check_read_permission_denies_when_user_can_returns_false_explicitly(): void {
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => false ];
		$result = ( new TopologiesController() )->check_read_permission();
		$this->assertInstanceOf( \WP_Error::class, $result );
	}

	// ── check_write_permission ─────────────────────────────────────────────

	public function test_check_write_permission_accepts_save_nonce_param_over_header(): void {
		// Custom `save_nonce` param wins over X-WP-Nonce header so apiFetch's
		// auto-injected wp_rest header doesn't shadow our per-action token.
		$req = new \WP_REST_Request( 'POST' );
		$req->set_param( 'save_nonce', 'valid-nonce' );
		// Inject a different header value — must be ignored.
		$req->set_header( 'X-WP-Nonce', 'something-else' );
		$result = ( new TopologiesController() )->check_write_permission( $req );
		$this->assertTrue( $result );
	}

	public function test_check_write_permission_falls_back_to_header_when_param_absent(): void {
		$req = $this->make_request();
		$result = ( new TopologiesController() )->check_write_permission( $req );
		$this->assertTrue( $result );
	}

	public function test_check_write_permission_rejects_empty_nonce(): void {
		$req = $this->make_request( '', '', false );
		$result = ( new TopologiesController() )->check_write_permission( $req );
		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 'rest_forbidden', $result->get_error_code() );
	}

	public function test_check_write_permission_rejects_invalid_nonce(): void {
		$req = new \WP_REST_Request( 'POST' );
		$req->set_header( 'X-WP-Nonce', 'wrong-nonce' );
		$result = ( new TopologiesController() )->check_write_permission( $req );
		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 'rest_forbidden', $result->get_error_code() );
	}

	public function test_check_write_permission_fails_when_user_lacks_capability(): void {
		// Capability check (via check_read_permission) runs FIRST and short-circuits.
		$GLOBALS['_wp_test_current_user_can'] = [];
		$req = $this->make_request();
		$result = ( new TopologiesController() )->check_write_permission( $req );
		$this->assertInstanceOf( \WP_Error::class, $result );
	}

	// ── delete_topology ────────────────────────────────────────────────────

	public function test_delete_topology_rejects_invalid_name(): void {
		$req  = $this->make_request( '../bad', '', true, 'DELETE' );
		$resp = ( new TopologiesController() )->delete_topology( $req );
		$this->assertSame( 400, $resp->get_status() );
		$this->assertSame( 'invalid_name', $resp->get_data()['code'] );
	}

	public function test_delete_topology_rejects_name_with_dot(): void {
		$req  = $this->make_request( 'with.dot', '', true, 'DELETE' );
		$resp = ( new TopologiesController() )->delete_topology( $req );
		$this->assertSame( 400, $resp->get_status() );
	}

	public function test_delete_topology_returns_404_when_no_user_file_exists(): void {
		// Stock-only — user dir empty.
		\file_put_contents( "{$this->stock}/stock-only.tsl", "make_node Echo e\n" );
		$req  = $this->make_request( 'stock-only', '', true, 'DELETE' );
		$resp = ( new TopologiesController() )->delete_topology( $req );
		$this->assertSame( 404, $resp->get_status() );
		$this->assertSame( 'not_user_topology', $resp->get_data()['code'] );
	}

	public function test_delete_topology_returns_404_when_user_dir_unconfigured(): void {
		Topology_Registry::set_user_dir( '' );
		$req  = $this->make_request( 'anything', '', true, 'DELETE' );
		$resp = ( new TopologiesController() )->delete_topology( $req );
		$this->assertSame( 404, $resp->get_status() );
		$this->assertSame( 'no_user_dir', $resp->get_data()['code'] );
	}

	public function test_delete_topology_removes_user_file_and_returns_path(): void {
		$path = "{$this->user}/my-topology.tsl";
		\file_put_contents( $path, "make_node Echo e\n" );

		$req  = $this->make_request( 'my-topology', '', true, 'DELETE' );
		$resp = ( new TopologiesController() )->delete_topology( $req );

		$this->assertSame( 200, $resp->get_status() );
		$body = $resp->get_data();
		$this->assertSame( 'my-topology', $body['name'] );
		$this->assertSame( $path, $body['deleted'] );
		$this->assertFileDoesNotExist( $path );
	}

	public function test_delete_topology_reports_stock_fallback_when_stock_copy_exists(): void {
		\file_put_contents( "{$this->stock}/shadowed.tsl", "make_node Echo s\n" );
		\file_put_contents( "{$this->user}/shadowed.tsl",  "make_node Echo u\n" );

		$req  = $this->make_request( 'shadowed', '', true, 'DELETE' );
		$resp = ( new TopologiesController() )->delete_topology( $req );

		$this->assertSame( 200, $resp->get_status() );
		$this->assertTrue( $resp->get_data()['stock_fallback'] );
	}

	public function test_delete_topology_reports_no_stock_fallback_when_user_only(): void {
		\file_put_contents( "{$this->user}/user-only.tsl", "make_node Echo u\n" );

		$req  = $this->make_request( 'user-only', '', true, 'DELETE' );
		$resp = ( new TopologiesController() )->delete_topology( $req );

		$this->assertSame( 200, $resp->get_status() );
		$this->assertFalse( $resp->get_data()['stock_fallback'] );
	}

	// ── get_topology — uncovered branches ──────────────────────────────────

	public function test_get_topology_rejects_invalid_name_with_special_chars(): void {
		$req  = $this->make_request( '../etc/passwd', '', true, 'GET' );
		$resp = ( new TopologiesController() )->get_topology( $req );
		$this->assertSame( 400, $resp->get_status() );
		$this->assertSame( 'invalid_name', $resp->get_data()['code'] );
	}

	public function test_get_topology_returns_404_for_unknown_name(): void {
		$req  = $this->make_request( 'does-not-exist', '', true, 'GET' );
		$resp = ( new TopologiesController() )->get_topology( $req );
		$this->assertSame( 404, $resp->get_status() );
		$this->assertSame( 'not_found', $resp->get_data()['code'] );
	}

	/**
	 * `Topology_Registry::resolve()` uses `is_file()`, not `file_exists()`,
	 * so a directory at `{stock|user}/{name}.tsl/` is filtered at the
	 * source — the controller takes the `null → not_found` branch instead
	 * of `file_get_contents` returning `""` (PHP 8.0+'s behavior on a
	 * directory path) and landing on a 200-OK with an empty body.
	 */
	public function test_get_topology_returns_404_when_path_is_a_directory(): void {
		\mkdir( "{$this->stock}/is-a-dir.tsl" );
		$req  = $this->make_request( 'is-a-dir', '', true, 'GET' );
		$resp = ( new TopologiesController() )->get_topology( $req );
		$this->assertSame( 404, $resp->get_status() );
		$this->assertSame( 'not_found', $resp->get_data()['code'] );
	}

	public function test_get_topology_reports_stock_source_when_only_stock(): void {
		\file_put_contents( "{$this->stock}/stock-only.tsl", "make_node Echo e\n" );
		$req  = $this->make_request( 'stock-only', '', true, 'GET' );
		$body = ( new TopologiesController() )->get_topology( $req )->get_data();
		$this->assertSame( 'stock', $body['source'] );
		$this->assertSame( "make_node Echo e\n", $body['tsl'] );
	}

	public function test_get_topology_reports_user_source_when_only_user(): void {
		\file_put_contents( "{$this->user}/user-only.tsl", "make_node Tee t\n" );
		$req  = $this->make_request( 'user-only', '', true, 'GET' );
		$body = ( new TopologiesController() )->get_topology( $req )->get_data();
		$this->assertSame( 'user', $body['source'] );
	}

	public function test_get_topology_reports_both_source_when_user_shadows_stock(): void {
		\file_put_contents( "{$this->stock}/dual.tsl", "make_node Echo stock\n" );
		\file_put_contents( "{$this->user}/dual.tsl",  "make_node Echo user\n" );
		$req  = $this->make_request( 'dual', '', true, 'GET' );
		$body = ( new TopologiesController() )->get_topology( $req )->get_data();
		$this->assertSame( 'both', $body['source'] );
		// User copy wins on body.
		$this->assertSame( "make_node Echo user\n", $body['tsl'] );
	}

	// ── get_topologies (list) edge cases ───────────────────────────────────

	public function test_get_topologies_returns_empty_list_when_no_topologies(): void {
		$body = ( new TopologiesController() )
			->get_topologies( new \WP_REST_Request() )
			->get_data();
		$this->assertSame( [], $body['topologies'] );
		$this->assertSame( $this->user, $body['user_dir'] );
	}

	public function test_get_topologies_sorts_entries_alphabetically(): void {
		\file_put_contents( "{$this->stock}/zeta.tsl",  "make_node Echo z\n" );
		\file_put_contents( "{$this->stock}/alpha.tsl", "make_node Echo a\n" );
		\file_put_contents( "{$this->stock}/middle.tsl", "make_node Echo m\n" );

		$body  = ( new TopologiesController() )
			->get_topologies( new \WP_REST_Request() )
			->get_data();
		$names = \array_column( $body['topologies'], 'name' );
		$this->assertSame( [ 'alpha', 'middle', 'zeta' ], $names );
	}

	public function test_get_topologies_marks_active_when_in_resolved_filter(): void {
		\file_put_contents( "{$this->stock}/active-one.tsl", "make_node Echo a\n" );
		\file_put_contents( "{$this->stock}/inactive.tsl",   "make_node Echo i\n" );
		\add_filter(
			'newspack_nodes/topologies',
			static function ( array $topologies ): array {
				$topologies['active-one'] = [
					'topology'       => 'active-one',
					'num_partitions' => 1,
					'stale_timeout'  => 60,
				];
				return $topologies;
			}
		);

		$body = ( new TopologiesController() )
			->get_topologies( new \WP_REST_Request() )
			->get_data();
		$by_name = \array_column( $body['topologies'], null, 'name' );
		$this->assertTrue( $by_name['active-one']['active'] );
		$this->assertFalse( $by_name['inactive']['active'] );
	}

	public function test_get_topologies_includes_frontmatter(): void {
		\file_put_contents(
			"{$this->stock}/with-vars.tsl",
			"var num_partitions = 4\nvar stale_timeout = 120\nmake_node Echo e\n"
		);
		$body  = ( new TopologiesController() )
			->get_topologies( new \WP_REST_Request() )
			->get_data();
		$entry = $body['topologies'][0];
		$this->assertSame( 'with-vars', $entry['name'] );
		$this->assertSame( '4',   $entry['frontmatter']['num_partitions'] );
		$this->assertSame( '120', $entry['frontmatter']['stale_timeout'] );
	}

	// ── save_topology — uncovered branches ─────────────────────────────────

	public function test_save_topology_rejects_invalid_name(): void {
		$req  = $this->make_request( 'bad.name', "make_node Echo e\n" );
		$resp = ( new TopologiesController() )->save_topology( $req );
		$this->assertSame( 400, $resp->get_status() );
		$this->assertSame( 'invalid_name', $resp->get_data()['code'] );
	}

	public function test_save_topology_rejects_body_at_64kib_plus_one_byte(): void {
		$body = \str_repeat( '#', 65537 );
		$req  = $this->make_request( 'large', $body );
		$resp = ( new TopologiesController() )->save_topology( $req );
		$this->assertSame( 413, $resp->get_status() );
		$this->assertSame( 'body_too_large', $resp->get_data()['code'] );
	}

	public function test_save_topology_accepts_body_at_exactly_64kib(): void {
		$body = \str_repeat( "# pad\n", \intdiv( 64 * 1024, 6 ) );
		$this->assertLessThanOrEqual( 65536, \strlen( $body ) );
		$req  = $this->make_request( 'edge-size', $body );
		$resp = ( new TopologiesController() )->save_topology( $req );
		$this->assertSame( 201, $resp->get_status() );
	}

	public function test_save_topology_rejects_forbidden_verb_reports_line_number(): void {
		$req  = $this->make_request( 'bad-verb', "make_node Echo e\nmake_node Tee t\nif foo\n" );
		$resp = ( new TopologiesController() )->save_topology( $req );
		$this->assertSame( 400, $resp->get_status() );
		$body = $resp->get_data();
		$this->assertSame( 'validation_failed', $body['code'] );
		$this->assertSame( 3, $body['line_number'] );
		$this->assertStringContainsString( "forbidden verb 'if'", $body['message'] );
	}

	public function test_save_topology_reports_validation_error_on_unterminated_continuation(): void {
		$req  = $this->make_request( 'cont-fail', "make_node Echo e \\" );
		$resp = ( new TopologiesController() )->save_topology( $req );
		$this->assertSame( 400, $resp->get_status() );
		$this->assertSame( 'validation_failed', $resp->get_data()['code'] );
	}

	public function test_save_topology_returns_500_when_user_dir_unconfigured(): void {
		Topology_Registry::set_user_dir( '' );
		$req  = $this->make_request( 'whatever', "make_node Echo e\n" );
		$resp = ( new TopologiesController() )->save_topology( $req );
		$this->assertSame( 500, $resp->get_status() );
		$this->assertSame( 'user_dir_unconfigured', $resp->get_data()['code'] );
	}

	public function test_save_topology_creates_user_dir_when_missing(): void {
		$nested = $this->user . '/deeper/even-deeper';
		Topology_Registry::set_user_dir( $nested );

		$req  = $this->make_request( 'auto-mkdir', "make_node Echo e\n" );
		$resp = ( new TopologiesController() )->save_topology( $req );

		$this->assertSame( 201, $resp->get_status() );
		$this->assertDirectoryExists( $nested );
		$this->assertFileExists( $nested . '/auto-mkdir.tsl' );
	}

	public function test_save_topology_emits_correct_path_and_shadow_state(): void {
		\file_put_contents( "{$this->stock}/shadow-me.tsl", "make_node Echo stock\n" );
		$req  = $this->make_request( 'shadow-me', "make_node Echo override\n" );
		$resp = ( new TopologiesController() )->save_topology( $req );

		$body = $resp->get_data();
		$this->assertSame( 201, $resp->get_status() );
		$this->assertSame( "{$this->user}/shadow-me.tsl", $body['path'] );
		$this->assertTrue( $body['shadows_stock'] );
		// File contents on disk match the body we sent.
		$this->assertSame(
			"make_node Echo override\n",
			\file_get_contents( $body['path'] )
		);
	}

	public function test_save_topology_does_not_fire_restart_for_inactive_topology(): void {
		\file_put_contents( "{$this->stock}/dormant.tsl", "make_node Echo e\n" );
		$fired = [];
		\add_action( 'newspack_nodes/restart_fleet', static function ( string $f ) use ( &$fired ): void {
			$fired[] = $f;
		} );

		$req  = $this->make_request( 'dormant', "make_node Echo e\n" );
		$resp = ( new TopologiesController() )->save_topology( $req );

		$this->assertSame( 201, $resp->get_status() );
		$this->assertSame( [], $resp->get_data()['restarted_fleets'] );
		$this->assertSame( [], $fired );
	}

	public function test_save_topology_accepts_save_nonce_param_only(): void {
		// Confirm the save_nonce-only auth path round-trips through save_topology.
		$req = new \WP_REST_Request( 'POST' );
		$req->set_param( 'name', 'param-only' );
		$req->set_param( 'save_nonce', 'valid-nonce' );
		$req->set_url_params( [ 'name' => 'param-only' ] );
		$req->set_body( "make_node Echo e\n" );

		$allow = ( new TopologiesController() )->check_write_permission( $req );
		$this->assertTrue( $allow );

		$resp = ( new TopologiesController() )->save_topology( $req );
		$this->assertSame( 201, $resp->get_status() );
	}

	// ── save_topology — 500 paths for mkdir / file_put_contents failures ───

	public function test_save_topology_returns_500_when_user_dir_mkdir_fails(): void {
		// Force `@mkdir($user_dir, 0700, true)` to fail by nesting the user
		// dir under a regular file (not a directory). Recursive mkdir can't
		// traverse a file, so it fails; `is_dir` stays false post-mkdir;
		// controller returns user_dir_unwritable. uid-independent (works
		// the same as root or non-root since the failure is a file-vs-dir
		// type error, not a permission error).
		$blocker = $this->user . '/i-am-a-file';
		\file_put_contents( $blocker, 'regular file, not a directory' );
		Topology_Registry::set_user_dir( $blocker . '/child' );

		$req  = $this->make_request( 'whatever', "make_node Echo e\n" );
		$resp = ( new TopologiesController() )->save_topology( $req );

		$this->assertSame( 500, $resp->get_status() );
		$body = $resp->get_data();
		$this->assertSame( 'user_dir_unwritable', $body['code'] );
		$this->assertStringContainsString( $blocker . '/child', $body['message'] );
	}

	public function test_save_topology_returns_500_when_file_put_contents_fails(): void {
		// Force `file_put_contents($path, $body)` to fail by pre-creating a
		// DIRECTORY at the target file path. is_dir($user_dir) is true so
		// the mkdir branch is skipped; file_put_contents on a directory
		// returns false → write_failed 500. Independent of uid.
		\mkdir( "{$this->user}/conflict.tsl", 0755, true );

		// The controller's file_put_contents() call is NOT @-suppressed
		// (Lock.php is; TopologiesController is not). Install a no-op
		// error handler so the deliberately-triggered "is a directory"
		// E_WARNING is swallowed before PHPUnit's handler can surface
		// it as a test-warning. The controller still observes the false
		// return value and emits the 500 we assert on below.
		\set_error_handler( static fn ( int $err, string $msg ): bool => true, \E_WARNING );
		try {
			$req  = $this->make_request( 'conflict', "make_node Echo e\n" );
			$resp = ( new TopologiesController() )->save_topology( $req );
		} finally {
			\restore_error_handler();
		}

		$this->assertSame( 500, $resp->get_status() );
		$body = $resp->get_data();
		$this->assertSame( 'write_failed', $body['code'] );
		$this->assertStringContainsString( "{$this->user}/conflict.tsl", $body['message'] );
	}

}
