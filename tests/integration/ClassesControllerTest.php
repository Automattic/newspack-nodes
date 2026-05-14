<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Integration;

use Newspack_Nodes\Rest\ClassesController;
use Newspack_Nodes\Tests\TestCase;

class ClassesControllerTest extends TestCase {

	protected function setUp(): void {
		parent::setUp();
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => true ];
	}

	public function test_get_classes_returns_one_entry_per_visible_class(): void {
		$body = ( new ClassesController() )
			->get_classes( new \WP_REST_Request() )
			->get_data();

		$this->assertArrayHasKey( 'classes', $body );
		$this->assertNotEmpty( $body['classes'] );
		foreach ( $body['classes'] as $entry ) {
			$this->assertArrayHasKey( 'shell_name', $entry );
			$this->assertArrayHasKey( 'fqcn',       $entry );
			$this->assertArrayHasKey( 'category',   $entry );
			$this->assertArrayHasKey( 'ctor',       $entry );
			$this->assertArrayHasKey( 'verbs',      $entry );
			$this->assertNotSame( 'Hidden', $entry['category'] );
		}
	}

	public function test_get_classes_excludes_hidden_category(): void {
		$body = ( new ClassesController() )
			->get_classes( new \WP_REST_Request() )
			->get_data();
		$shell_names = \array_column( $body['classes'], 'shell_name' );
		$this->assertNotContains(
			'CommandInterpreter',
			$shell_names,
			'CommandInterpreter is plumbing — should be Hidden category'
		);
	}

	public function test_response_includes_formatters_array(): void {
		\Newspack_Nodes\Formatters::reset();
		\Newspack_Nodes\Formatters::register( 'foo', static fn () => null );
		\Newspack_Nodes\Formatters::register( 'bar', static fn () => null );
		$body = ( new ClassesController() )
			->get_classes( new \WP_REST_Request() )
			->get_data();
		$this->assertArrayHasKey( 'formatters', $body );
		$this->assertSame( [ 'bar', 'foo' ], $body['formatters'] );
	}

	public function test_check_permission_requires_manage_options(): void {
		$GLOBALS['_wp_test_current_user_can'] = [];
		$allow = ( new ClassesController() )->check_permission();
		$this->assertInstanceOf( \WP_Error::class, $allow );
		$this->assertSame( 'rest_forbidden', $allow->get_error_code() );
	}
}
