<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Integration;

use Newspack_Nodes\Config;
use Newspack_Nodes\Rest\TopologiesController;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Topology_Registry;

class TopologiesControllerGetTest extends TestCase {

	private string $stock;
	private string $user;

	protected function setUp(): void {
		parent::setUp();
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => true ];
		$GLOBALS['_wp_actions']               = [];
		$GLOBALS['_wp_options']               = [];
		Config::reset();
		\add_filter(
			'newspack_nodes/topologies',
			static function ( array $topologies ): array {
				$topologies['stock-only'] = [
					'topology'       => 'stock-only',
					'num_partitions' => 1,
					'stale_timeout'  => 60,
				];
				return $topologies;
			}
		);

		$this->stock = $this->make_temp_dir( 'a4-get-stock-' );
		$this->user  = $this->make_temp_dir( 'a4-get-user-' );
		\file_put_contents( "{$this->stock}/stock-only.tsl", "make_node Echo e\n" );
		\file_put_contents( "{$this->stock}/shadowed.tsl",   "make_node Echo s\n" );
		\file_put_contents( "{$this->user}/user-only.tsl",   "make_node Echo u\n" );
		\file_put_contents( "{$this->user}/shadowed.tsl",    "make_node Echo o\n" );

		Topology_Registry::reset();
		Topology_Registry::register_stock_dir( $this->stock );
		Topology_Registry::set_user_dir( $this->user );
	}

	protected function tearDown(): void {
		$this->rmdir_recursive( $this->stock );
		$this->rmdir_recursive( $this->user );
		parent::tearDown();
	}

	public function test_lists_stock_user_and_both_with_active_flag(): void {
		$body = ( new TopologiesController() )
			->get_topologies( new \WP_REST_Request() )
			->get_data();

		$by_name = [];
		foreach ( $body['topologies'] as $t ) {
			$by_name[ $t['name'] ] = $t;
		}

		$this->assertSame( 'stock', $by_name['stock-only']['source'] );
		$this->assertTrue( $by_name['stock-only']['active'] );

		$this->assertSame( 'user', $by_name['user-only']['source'] );
		$this->assertFalse( $by_name['user-only']['active'] );

		$this->assertSame( 'both', $by_name['shadowed']['source'] );
		$this->assertFalse( $by_name['shadowed']['active'] );

		$this->assertSame( $this->user, $body['user_dir'] );
	}

	public function test_check_read_permission_requires_manage_options(): void {
		$GLOBALS['_wp_test_current_user_can'] = [];
		$allow = ( new TopologiesController() )->check_read_permission();
		$this->assertInstanceOf( \WP_Error::class, $allow );
		$this->assertSame( 'rest_forbidden', $allow->get_error_code() );
	}
}
