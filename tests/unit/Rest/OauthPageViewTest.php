<?php
namespace Newspack_Nodes\Tests\Unit\Rest;

use PHPUnit\Framework\Attributes\CoversNothing;
use PHPUnit\Framework\Attributes\PreserveGlobalState;
use PHPUnit\Framework\Attributes\RunInSeparateProcess;
use Newspack_Nodes\Oauth_Server;
use Newspack_Nodes\Rest\Oauth_Controller;
use Newspack_Nodes\Tests\TestCase;

/**
 * The plugin file's `parse_request` hook runs on every page view, so it tests
 * the path before it loads either OAuth class.
 */
#[CoversNothing]
final class OauthPageViewTest extends TestCase {

	#[RunInSeparateProcess]
	#[PreserveGlobalState( false )]
	public function test_a_page_view_loads_no_oauth_class(): void {
		$this->assertFalse( \class_exists( Oauth_Controller::class, false ), 'precondition: a fresh process' );
		[ $hook ] = $GLOBALS['_wp_actions']['parse_request'] ?? [ null ];
		$this->assertIsCallable( $hook );

		foreach ( [ 'kea-news/2026/10/a-page', '.well-known/acme-challenge/kea', '' ] as $request ) {
			$wp          = new \WP();
			$wp->request = $request;
			$hook( $wp );
		}

		$this->assertFalse( \class_exists( Oauth_Controller::class, false ) );
		$this->assertFalse( \class_exists( Oauth_Server::class, false ) );
	}
}
