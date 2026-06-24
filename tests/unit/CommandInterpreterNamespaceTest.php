<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Echo_Node;
use Newspack_Nodes\Tee_Node;
use Newspack_Nodes\Rest\Classes_CI_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\Helpers\VerbHarness;
use Newspack_Nodes\Tests\TestCase;

class CommandInterpreterNamespaceTest extends TestCase {

	protected function tearDown(): void {
		VerbHarness::reset();
		parent::tearDown();
	}

	public function test_register_namespace_is_listed(): void {
		Command_Interpreter_Node::register_namespace( 'Newspack_Nodes\\' );
		$this->assertContains( 'Newspack_Nodes\\', Command_Interpreter_Node::registered_namespaces() );
	}

	public function test_make_node_resolves_substrate_node_via_prefix(): void {
		Command_Interpreter_Node::register_namespace( 'Newspack_Nodes\\' );
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$node = $interpreter->make_node( 'Tee', 't' );
		$this->assertInstanceOf( Tee_Node::class, $node );
	}

	public function test_make_node_resolves_test_double_via_tests_prefix(): void {
		// Registered in tests/bootstrap.php — `Newspack_Nodes\Tests\` prefix +
		// `Capture_Sink` + `_Node` = `Newspack_Nodes\Tests\Capture_Sink_Node`.
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$node = $interpreter->make_node( 'Capture_Sink', 'alice' );
		$this->assertInstanceOf( Capture_Sink_Node::class, $node );
	}

	public function test_make_node_unknown_type_returns_null(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		$this->assertNull( $interpreter->make_node( 'No_Such_Type', 'x' ) );
	}

	public function test_make_node_abstract_node_subclass_returns_null_not_fatal(): void {
		// Service_CI_Node is an abstract Node subclass that resolves under the
		// Newspack_Nodes\ prefix; make_node must return null, not fatal trying
		// to instantiate the abstract class.
		Command_Interpreter_Node::register_namespace( 'Newspack_Nodes\\' );
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		$this->assertNull( $interpreter->make_node( 'Service_CI', 'x' ) );
	}

	public function test_resolve_class_returns_fqcn_for_known_type(): void {
		Command_Interpreter_Node::register_namespace( 'Newspack_Nodes\\' );
		$this->assertSame( Tee_Node::class, Command_Interpreter_Node::resolve_class( 'Tee' ) );
	}

	public function test_resolve_class_resolves_bare_node(): void {
		Command_Interpreter_Node::register_namespace( 'Newspack_Nodes\\' );
		$this->assertSame( \Newspack_Nodes\Node::class, Command_Interpreter_Node::resolve_class( 'Node' ) );
	}

	public function test_resolve_class_returns_null_for_unknown_type(): void {
		$this->assertNull( Command_Interpreter_Node::resolve_class( 'No_Such_Type' ) );
	}

	public function test_resolve_class_skips_abstract_match_for_a_concrete_one(): void {
		// When the same `<Type>_Node` is abstract under an earlier-scanned prefix
		// and concrete under a later one, resolve_class must skip the abstract and
		// return the concrete FQCN — otherwise make_node sees the abstract and
		// returns null (the old loop `continue`d past abstract matches).
		require_once \dirname( __DIR__ ) . '/Helpers/fixtures/class-abstract-probe-node.php';
		require_once \dirname( __DIR__ ) . '/Helpers/fixtures/class-concrete-probe-node.php';

		$ref      = new \ReflectionProperty( Command_Interpreter_Node::class, 'namespaces' );
		$ref->setAccessible( true );
		$snapshot = $ref->getValue();
		try {
			// Abstract prefix registered FIRST so the buggy resolver hits it first.
			Command_Interpreter_Node::register_namespace( 'Newspack_Nodes\\Tests\\Fixtures\\AbstractProbe\\' );
			Command_Interpreter_Node::register_namespace( 'Newspack_Nodes\\Tests\\Fixtures\\ConcreteProbe\\' );

			$this->assertSame(
				\Newspack_Nodes\Tests\Fixtures\ConcreteProbe\Probe_Node::class,
				Command_Interpreter_Node::resolve_class( 'Probe' )
			);
		} finally {
			$ref->setValue( null, $snapshot );
		}
	}

	public function test_shell_name_for_strips_node_suffix(): void {
		$echo = new Echo_Node();
		$this->assertSame( 'Echo', Command_Interpreter_Node::shell_name_for( $echo ) );

		$capture = new Capture_Sink_Node();
		$this->assertSame( 'Capture_Sink', Command_Interpreter_Node::shell_name_for( $capture ) );
	}

	public function test_classes_ci_list_includes_registered_substrate_nodes(): void {
		// `list` is gated by the Service_CI base; grant the cap to exercise it.
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => true ];
		$result = VerbHarness::fire( new Classes_CI_Node(), 'classes', 'list' );

		$this->assertIsArray( $result );
		$shell_names = \array_column( $result['classes'], 'shell_name' );
		$this->assertContains( 'Echo', $shell_names );
		$this->assertContains( 'Tee', $shell_names );

		// SSE_Out_Node is a pure HTTP response writer inheriting Node's empty
		// category — it is NOT a palette participant and must not be listed.
		$this->assertNotContains( 'SSE_Out', $shell_names );

		// Each row carries an inlined schema with a real (non-Hidden, non-empty) category.
		foreach ( $result['classes'] as $row ) {
			$this->assertArrayHasKey( 'category', $row );
			$this->assertNotSame( 'Hidden', $row['category'] );
			$this->assertNotSame( '', $row['category'] );
			$this->assertArrayHasKey( 'commands', $row );
		}
	}
}
