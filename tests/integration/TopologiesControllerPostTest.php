<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Integration;

use Newspack_Nodes\Config;
use Newspack_Nodes\Rest\TopologiesController;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Topology_Registry;

class TopologiesControllerPostTest extends TestCase {

	private string $stock;
	private string $user;

	protected function setUp(): void {
		parent::setUp();
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => true ];
		$GLOBALS['_wp_test_valid_nonces']     = [
			TopologiesController::NONCE_ACTION => 'valid-nonce',
		];
		$GLOBALS['_wp_options']               = [];
		Config::reset();

		$this->stock = $this->make_temp_dir( 'a4-post-stock-' );
		$this->user  = $this->make_temp_dir( 'a4-post-user-' );
		\file_put_contents( "{$this->stock}/stock-name.tsl", "make_node Echo e\n" );

		Topology_Registry::reset();
		Topology_Registry::register_stock_dir( $this->stock );
		Topology_Registry::set_user_dir( $this->user );
	}

	protected function tearDown(): void {
		$this->rmdir_recursive( $this->stock );
		$this->rmdir_recursive( $this->user );
		parent::tearDown();
	}

	private function make_request( string $name, string $body, bool $with_nonce = true ): \WP_REST_Request {
		$req = new \WP_REST_Request( 'POST', "/newspack-nodes/v1/topologies/{$name}" );
		$req->set_url_params( [ 'name' => $name ] );
		$req->set_body( $body );
		if ( $with_nonce ) {
			$req->set_header( 'X-WP-Nonce', 'valid-nonce' );
		}
		return $req;
	}

	public function test_writes_user_tsl_and_returns_201(): void {
		$req  = $this->make_request( 'new-one', "make_node Echo e\nconnect_node e other\n" );
		$resp = ( new TopologiesController() )->save_topology( $req );

		$this->assertSame( 201, $resp->get_status() );
		$body = $resp->get_data();
		$this->assertSame( 'new-one', $body['name'] );
		$this->assertFileExists( $body['path'] );
		$this->assertFalse( $body['shadows_stock'] );
		$this->assertSame( [], $body['restarted_fleets'] );
	}

	public function test_writes_user_copy_when_shadowing_stock(): void {
		$req  = $this->make_request( 'stock-name', "make_node Echo overridden\n" );
		$resp = ( new TopologiesController() )->save_topology( $req );

		$this->assertSame( 201, $resp->get_status() );
		$body = $resp->get_data();
		$this->assertTrue( $body['shadows_stock'] );
		$this->assertStringContainsString( $this->user, $body['path'] );
		$this->assertStringContainsString( 'overridden', \file_get_contents( $body['path'] ) );
	}

	public function test_rejects_invalid_name(): void {
		$req  = $this->make_request( '../bad', "make_node Echo e\n" );
		$resp = ( new TopologiesController() )->save_topology( $req );

		$this->assertSame( 400, $resp->get_status() );
		$this->assertSame( 'invalid_name', $resp->get_data()['code'] );
	}

	public function test_rejects_oversized_body(): void {
		$req  = $this->make_request( 'big', \str_repeat( "# pad\n", 20000 ) );
		$resp = ( new TopologiesController() )->save_topology( $req );

		$this->assertSame( 413, $resp->get_status() );
		$this->assertSame( 'body_too_large', $resp->get_data()['code'] );
	}

	public function test_rejects_forbidden_verb_with_line_number(): void {
		$req  = $this->make_request( 'bad-verb', "make_node Echo e\nif foo\n" );
		$resp = ( new TopologiesController() )->save_topology( $req );

		$this->assertSame( 400, $resp->get_status() );
		$body = $resp->get_data();
		$this->assertSame( 'validation_failed', $body['code'] );
		$this->assertSame( 2, $body['line_number'] );
	}

	public function test_check_write_permission_rejects_missing_nonce(): void {
		$req   = $this->make_request( 'x', "make_node Echo e\n", false );
		$allow = ( new TopologiesController() )->check_write_permission( $req );
		$this->assertInstanceOf( \WP_Error::class, $allow );
		$this->assertSame( 'rest_forbidden', $allow->get_error_code() );
	}

	public function test_active_name_triggers_restart_action(): void {
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'active-name' ];
		Config::reset();

		$restarted = [];
		$hook = static function ( string $fleet ) use ( &$restarted ): void {
			$restarted[] = $fleet;
		};
		\add_action( 'newspack_nodes/restart_fleet', $hook );

		$req  = $this->make_request( 'active-name', "make_node Echo e\n" );
		$resp = ( new TopologiesController() )->save_topology( $req );

		$this->assertSame( 201, $resp->get_status() );
		$this->assertSame( [ 'active-name' ], $restarted );
		$this->assertSame( [ 'active-name' ], $resp->get_data()['restarted_fleets'] );

		\remove_action( 'newspack_nodes/restart_fleet', $hook );
	}
}
