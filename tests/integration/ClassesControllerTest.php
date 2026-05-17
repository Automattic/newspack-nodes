<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Integration;

use Newspack_Nodes\Rest\ClassesController;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( ClassesController::class )]
class ClassesControllerTest extends TestCase {

	protected function setUp(): void {
		parent::setUp();
		$GLOBALS['_wp_test_registered_routes'] = [];
		$GLOBALS['_wp_test_current_user_can']  = [ 'manage_options' => true ];
	}

	protected function tearDown(): void {
		$GLOBALS['_wp_test_registered_routes'] = [];
		$GLOBALS['_wp_test_current_user_can']  = [];
		parent::tearDown();
	}

	// ── register_routes ────────────────────────────────────────────────────

	public function test_register_routes_registers_classes_get_route(): void {
		( new ClassesController() )->register_routes();
		$routes = $GLOBALS['_wp_test_registered_routes'];

		$this->assertCount( 1, $routes );
		$this->assertSame( 'newspack-nodes/v1', $routes[0]['namespace'] );
		$this->assertSame( '/classes', $routes[0]['route'] );
		$this->assertSame( 'GET', $routes[0]['args']['methods'] );
	}

	public function test_register_routes_attaches_permission_callback(): void {
		( new ClassesController() )->register_routes();
		$args = $GLOBALS['_wp_test_registered_routes'][0]['args'];

		$this->assertIsCallable( $args['permission_callback'] );
		$this->assertIsCallable( $args['callback'] );
	}

	// ── check_permission ───────────────────────────────────────────────────

	public function test_check_permission_allows_manage_options(): void {
		$GLOBALS['_wp_test_current_user_can']['manage_options'] = true;
		$this->assertTrue( ( new ClassesController() )->check_permission() );
	}

	public function test_check_permission_requires_manage_options(): void {
		$GLOBALS['_wp_test_current_user_can'] = [];
		$allow = ( new ClassesController() )->check_permission();
		$this->assertInstanceOf( \WP_Error::class, $allow );
		$this->assertSame( 'rest_forbidden', $allow->get_error_code() );
	}

	public function test_check_permission_rejects_when_capability_false(): void {
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => false ];
		$allow = ( new ClassesController() )->check_permission();
		$this->assertInstanceOf( \WP_Error::class, $allow );
		$this->assertSame( 'rest_forbidden', $allow->get_error_code() );
	}

	// ── get_classes ────────────────────────────────────────────────────────

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

	public function test_get_classes_returns_200_status(): void {
		$response = ( new ClassesController() )
			->get_classes( new \WP_REST_Request() );

		$this->assertInstanceOf( \WP_REST_Response::class, $response );
		$this->assertSame( 200, $response->get_status() );
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

	public function test_get_classes_sorts_by_category_then_shell_name(): void {
		$body = ( new ClassesController() )
			->get_classes( new \WP_REST_Request() )
			->get_data();

		$classes = $body['classes'];
		$pairs   = \array_map(
			static fn ( $c ) => [ $c['category'], $c['shell_name'] ],
			$classes
		);
		$sorted  = $pairs;
		\usort( $sorted, static fn ( $a, $b ) => $a <=> $b );
		$this->assertSame( $sorted, $pairs );
	}

	public function test_get_classes_entries_include_requests_key(): void {
		// The schema includes a 'requests' key by default — even if empty.
		$body = ( new ClassesController() )
			->get_classes( new \WP_REST_Request() )
			->get_data();
		foreach ( $body['classes'] as $entry ) {
			$this->assertArrayHasKey( 'requests', $entry );
			$this->assertArrayHasKey( 'description', $entry );
			$this->assertIsArray( $entry['ctor'] );
			$this->assertIsArray( $entry['verbs'] );
			$this->assertIsArray( $entry['requests'] );
		}
	}

	public function test_get_classes_passes_through_port_flags(): void {
		// `accepts_fill` and `has_target` drive the schematic renderer's
		// per-class IN/OUT port visibility. The controller must surface
		// them so the React canvas can read them off the catalog.
		$body = ( new ClassesController() )
			->get_classes( new \WP_REST_Request() )
			->get_data();
		$by_shell = [];
		foreach ( $body['classes'] as $entry ) {
			$by_shell[ $entry['shell_name'] ] = $entry;
			$this->assertArrayHasKey( 'accepts_fill', $entry );
			$this->assertArrayHasKey( 'has_target', $entry );
			$this->assertIsBool( $entry['accepts_fill'] );
			$this->assertIsBool( $entry['has_target'] );
		}
		// Spot-check the four classes whose ports differ from the default.
		$this->assertFalse( $by_shell['Tail']['accepts_fill'] );
		$this->assertTrue( $by_shell['Tail']['has_target'] );
		$this->assertFalse( $by_shell['Consumer']['accepts_fill'] );
		$this->assertTrue( $by_shell['Consumer']['has_target'] );
		$this->assertTrue( $by_shell['Partition']['accepts_fill'] );
		$this->assertFalse( $by_shell['Partition']['has_target'] );
		$this->assertTrue( $by_shell['Log']['accepts_fill'] );
		$this->assertFalse( $by_shell['Log']['has_target'] );
	}

	public function test_get_classes_skips_classes_without_node_schema(): void {
		// Register a stub class with NO node_schema() method. It must be
		// silently skipped — not surfaced in the response, not crashed on.
		\Newspack_Nodes\CommandInterpreter::register_class(
			'TestNoSchemaShim',
			ClassesControllerTestNoSchemaShim::class
		);
		$body = ( new ClassesController() )
			->get_classes( new \WP_REST_Request() )
			->get_data();
		$shell_names = \array_column( $body['classes'], 'shell_name' );
		$this->assertNotContains( 'TestNoSchemaShim', $shell_names );
	}

	public function test_get_classes_uses_unknown_category_when_missing(): void {
		// Register a class whose schema omits 'category' — defaults to
		// 'Unknown' per the controller's `?? 'Unknown'` fallback. This
		// also covers the missing-description / missing-ctor / missing-verbs
		// fallback branches.
		\Newspack_Nodes\CommandInterpreter::register_class(
			'TestUnknownCategoryShim',
			ClassesControllerTestUnknownCategoryShim::class
		);
		$body = ( new ClassesController() )
			->get_classes( new \WP_REST_Request() )
			->get_data();

		$found = null;
		foreach ( $body['classes'] as $entry ) {
			if ( 'TestUnknownCategoryShim' === $entry['shell_name'] ) {
				$found = $entry;
				break;
			}
		}
		$this->assertNotNull( $found );
		$this->assertSame( 'Unknown', $found['category'] );
		$this->assertSame( '', $found['description'] );
		$this->assertSame( [], $found['ctor'] );
		$this->assertSame( [], $found['verbs'] );
		$this->assertSame( [], $found['requests'] );
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

	public function test_response_formatters_is_empty_when_none_registered(): void {
		\Newspack_Nodes\Formatters::reset();
		$body = ( new ClassesController() )
			->get_classes( new \WP_REST_Request() )
			->get_data();
		$this->assertSame( [], $body['formatters'] );
	}

	public function test_response_formatters_sorted_alphabetically(): void {
		\Newspack_Nodes\Formatters::reset();
		\Newspack_Nodes\Formatters::register( 'zeta', static fn () => null );
		\Newspack_Nodes\Formatters::register( 'alpha', static fn () => null );
		\Newspack_Nodes\Formatters::register( 'mu', static fn () => null );
		$body = ( new ClassesController() )
			->get_classes( new \WP_REST_Request() )
			->get_data();
		$this->assertSame( [ 'alpha', 'mu', 'zeta' ], $body['formatters'] );
	}
}

/**
 * Stub class without a node_schema() method — exercises the
 * `method_exists($fqcn, 'node_schema')` skip branch in get_classes().
 */
final class ClassesControllerTestNoSchemaShim {
	// Intentionally empty — no node_schema method.
}

/**
 * Stub class whose schema omits every optional key — exercises the
 * `?? 'Unknown' / ?? '' / ?? []` fallbacks in get_classes().
 */
final class ClassesControllerTestUnknownCategoryShim {
	public static function node_schema(): array {
		// Omit category, description, ctor, verbs, requests entirely.
		return [];
	}
}
