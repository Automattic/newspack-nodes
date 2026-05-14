<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Integration;

use Newspack_Nodes\Rest\TopologiesController;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Topology_Registry;

class TopologiesControllerGetOneTest extends TestCase {

	private string $stock;
	private string $user;

	protected function setUp(): void {
		parent::setUp();
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => true ];

		$this->stock = $this->make_temp_dir( 'a5b-stock-' );
		$this->user  = $this->make_temp_dir( 'a5b-user-' );
		\file_put_contents(
			"{$this->stock}/stock-only.tsl",
			"make_node Echo e\n"
		);
		\file_put_contents(
			"{$this->user}/user-shadow.tsl",
			"make_node Tee t\n"
		);
		// Same name in both — user copy should win.
		\file_put_contents(
			"{$this->stock}/shadowed.tsl",
			"make_node Echo stock-version\n"
		);
		\file_put_contents(
			"{$this->user}/shadowed.tsl",
			"make_node Echo user-version\n"
		);

		Topology_Registry::reset();
		Topology_Registry::register_stock_dir( $this->stock );
		Topology_Registry::set_user_dir( $this->user );
	}

	protected function tearDown(): void {
		$this->rmdir_recursive( $this->stock );
		$this->rmdir_recursive( $this->user );
		parent::tearDown();
	}

	private function request_for( string $name ): \WP_REST_Request {
		$req = new \WP_REST_Request( 'GET', "/newspack-nodes/v1/topologies/{$name}" );
		$req->set_url_params( [ 'name' => $name ] );
		return $req;
	}

	public function test_returns_stock_body(): void {
		$resp = ( new TopologiesController() )->get_topology(
			$this->request_for( 'stock-only' )
		);
		$this->assertSame( 200, $resp->get_status() );
		$body = $resp->get_data();
		$this->assertSame( 'stock-only', $body['name'] );
		$this->assertSame( 'stock', $body['source'] );
		$this->assertSame( "make_node Echo e\n", $body['tsl'] );
	}

	public function test_returns_user_body(): void {
		$body = ( new TopologiesController() )
			->get_topology( $this->request_for( 'user-shadow' ) )
			->get_data();
		$this->assertSame( 'user', $body['source'] );
		$this->assertSame( "make_node Tee t\n", $body['tsl'] );
	}

	public function test_user_shadows_stock_in_body_returned(): void {
		$body = ( new TopologiesController() )
			->get_topology( $this->request_for( 'shadowed' ) )
			->get_data();
		$this->assertSame( 'both', $body['source'] );
		$this->assertSame( "make_node Echo user-version\n", $body['tsl'] );
	}

	public function test_404_for_unknown_name(): void {
		$resp = ( new TopologiesController() )->get_topology(
			$this->request_for( 'no-such-topology' )
		);
		$this->assertSame( 404, $resp->get_status() );
		$this->assertSame( 'not_found', $resp->get_data()['code'] );
	}

	public function test_rejects_invalid_name(): void {
		$resp = ( new TopologiesController() )->get_topology(
			$this->request_for( '../bad' )
		);
		$this->assertSame( 400, $resp->get_status() );
		$this->assertSame( 'invalid_name', $resp->get_data()['code'] );
	}
}
