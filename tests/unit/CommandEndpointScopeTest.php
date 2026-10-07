<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Capabilities;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Rest\HTTP_In_Node;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use Newspack_Nodes\Tests\TestCase;

/**
 * The endpoint door and the base interpreter's roles.
 *
 * The door demands READ, the least any verb needs, so a read- or tune-scoped
 * caller reaches the verbs its role covers. The base interpreter's vocabulary
 * builds and rewires the graph and declares no role, so `dispatch()` holds
 * every verb of it at MANAGE but the read-only builtins (ADR-26).
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

		Core::$memd = new InMemoryMemcached();

		$this->assertTrue( ( new HTTP_In_Node() )->check_permission( new \WP_REST_Request() ) );
	}

	public function test_the_door_still_refuses_a_caller_holding_nothing(): void {
		$this->relax_read();
		$GLOBALS['_wp_test_current_user_can'] = [ 'edit_pages' => false, 'manage_options' => false ];

		$node = new HTTP_In_Node();
		$this->assertFalse( $node->check_permission( new \WP_REST_Request() ) );
	}

	public function test_a_worker_interpreter_dispatches_without_a_user(): void {
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => false ];

		$router = new Router_Node();
		$router->name( '_router' );
		$ci = new Command_Interpreter_Node();
		$ci->name( 'worker:ci' );
		$ci->sink( $router );

		$this->assertIsString( $ci->dispatch( 'uptime' ) );
		$this->assertInstanceOf( \Newspack_Nodes\Node::class, $ci->make_node( 'Node', 'worker:kea' ) );
		$this->assertStringContainsString( 'worker:kea', $ci->dispatch( 'list_nodes', [ '-a' ] ), 'no user is current, so the unscoped command runs at MANAGE' );
	}

	public function test_the_graph_vocabulary_refuses_a_logged_in_caller_below_manage(): void {
		$this->relax_read();
		$GLOBALS['_wp_test_current_user_id']  = 4133;
		$GLOBALS['_wp_test_current_user_can'] = [ 'edit_pages' => true, 'manage_options' => false ];

		$ci = new Command_Interpreter_Node();
		$ci->name( 'request:ci' );

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessageMatches( '/permission denied/' );
		$ci->dispatch( 'make_node' );
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

		$this->expectException( \RuntimeException::class );
		$ci->dispatch( 'make_node' );
	}

	/**
	 * The role is per-verb, not a whole-table pin: every dashboard on the site
	 * drives a read-only builtin through this same interpreter, so a blanket
	 * MANAGE would make the lowered door buy the read surface nothing.
	 */
	public function test_a_read_only_caller_still_reaches_the_read_builtins(): void {
		$this->relax_read();
		$GLOBALS['_wp_test_current_user_id']  = 4133;
		$GLOBALS['_wp_test_current_user_can'] = [ 'edit_pages' => true, 'manage_options' => false ];

		$router = new Router_Node();
		$router->name( '_router' );
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );
		$ci->sink( $router );

		$this->assertIsString( $ci->dispatch( 'uptime' ) );
		$this->assertIsString( $ci->dispatch( 'list_nodes' ) );
	}
}
