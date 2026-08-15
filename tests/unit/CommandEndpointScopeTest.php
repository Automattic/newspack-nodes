<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Capabilities;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Rest\HTTP_In_Node;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\Tests\TestCase;

/**
 * The endpoint door and the base interpreter's authority floor.
 *
 * `/command` used to demand MANAGE before any verb check ran, so a read- or
 * tune-scoped caller was refused at the door and the aggregator had to be an
 * administrator. The door drops to the floor every verb needs; the base
 * interpreter — whose vocabulary builds and rewires the graph and declares no
 * per-verb roles — keeps demanding MANAGE, pinned by the controller.
 */
#[CoversClass( HTTP_In_Node::class )]
#[CoversClass( Command_Interpreter_Node::class )]
class CommandEndpointScopeTest extends TestCase {

	protected function setUp(): void {
		parent::setUp();
		$GLOBALS['_wp_actions'] = [];
	}

	protected function tearDown(): void {
		$GLOBALS['_wp_test_current_user_can'] = [];
		$GLOBALS['_wp_actions']               = [];
		Capabilities::$session_scope          = null;
		parent::tearDown();
	}

	/** `read` filtered to a capability no default resolves to. */
	private function relax_read(): void {
		add_filter(
			'newspack_nodes/capability_map',
			static fn ( array $map ): array => [ 'read' => 'edit_pages' ] + $map
		);
	}

	public function test_the_door_admits_a_read_only_caller(): void {
		$this->relax_read();
		$GLOBALS['_wp_test_current_user_can'] = [ 'edit_pages' => true, 'manage_options' => false ];

		$node                              = new HTTP_In_Node();
		HTTP_In_Node::$rate_limit_disabled = true;

		$this->assertTrue( $node->check_permission( new \WP_REST_Request() ) );
	}

	public function test_the_door_still_refuses_a_caller_holding_nothing(): void {
		$this->relax_read();
		$GLOBALS['_wp_test_current_user_can'] = [ 'edit_pages' => false, 'manage_options' => false ];

		$node = new HTTP_In_Node();
		$this->assertFalse( $node->check_permission( new \WP_REST_Request() ) );
	}

	public function test_an_unpinned_interpreter_dispatches_without_a_user(): void {
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => false ];

		$router = new Router_Node();
		$router->name( '_router' );
		$ci = new Command_Interpreter_Node();
		$ci->name( 'worker:ci' );
		$ci->sink( $router );

		$this->assertNull(
			$ci->required_capability,
			'a worker loading its own topology has no current user to check'
		);
		$this->assertIsString( $ci->dispatch( 'uptime' ) );
	}

	public function test_a_pinned_interpreter_refuses_a_caller_below_its_floor(): void {
		$this->relax_read();
		$GLOBALS['_wp_test_current_user_can'] = [ 'edit_pages' => true, 'manage_options' => false ];

		$ci = new Command_Interpreter_Node();
		$ci->name( 'request:ci' );
		$ci->required_capability = Capabilities::MANAGE;

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessageMatches( '/permission denied/' );
		$ci->dispatch( 'make_node' );
	}

	public function test_the_controller_pins_the_request_scope_base_interpreter(): void {
		$router = new Router_Node();
		$router->name( '_router' );
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );
		$ci->sink( $router );

		$node   = new HTTP_In_Node();
		$method = new \ReflectionMethod( HTTP_In_Node::class, 'ensure_request_graph' );
		$method->invoke( $node );

		$this->assertSame(
			Capabilities::MANAGE,
			$ci->required_capability,
			'graph-building verbs must not fall through the lowered door'
		);
	}

	/**
	 * A tune-scoped session may not reach `make_node` even while its holder is
	 * an administrator — the two gates compose.
	 */
	public function test_a_tune_scope_cannot_reach_the_graph_vocabulary(): void {
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => true ];
		Capabilities::$session_scope          = Capabilities::TUNE;

		$ci = new Command_Interpreter_Node();
		$ci->name( 'request:ci2' );
		$ci->required_capability = Capabilities::MANAGE;

		$this->expectException( \RuntimeException::class );
		$ci->dispatch( 'make_node' );
	}

	/**
	 * The floor is per-verb, not a whole-table pin: every dashboard on the site
	 * drives a read-only builtin through this same interpreter, so a blanket
	 * MANAGE would make the lowered door buy the read surface nothing.
	 */
	public function test_a_read_only_caller_still_reaches_the_read_builtins(): void {
		$this->relax_read();
		$GLOBALS['_wp_test_current_user_can'] = [ 'edit_pages' => true, 'manage_options' => false ];

		$router = new Router_Node();
		$router->name( '_router' );
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );
		$ci->sink( $router );
		$ci->required_capability = Capabilities::MANAGE;

		$this->assertIsString( $ci->dispatch( 'uptime' ) );
		$this->assertIsString( $ci->dispatch( 'list_nodes' ) );
	}
}
