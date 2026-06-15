<?php
/**
 * PHPUnit bootstrap for the ai-newsletter example.
 *
 * The example lives at newspack-nodes/examples/example-ai-newsletter/, so the substrate
 * bootstrap is three dirs up (tests -> ai-newsletter -> examples -> newspack-nodes).
 * It loads Node, Message, Core, Command_Interpreter_Node, and the test helpers
 * (Tests\TestCase, Capture_Sink_Node, VerbHarness).
 *
 * @package Example_AI_Newsletter
 */

declare(strict_types=1);

require_once dirname( __DIR__, 3 ) . '/tests/bootstrap.php';

// Resolve `make_node Foo` to `Example_AI_Newsletter\Foo_Node`. Each test file
// require_once's the specific class it exercises (the example has no autoloader
// wired in the test process), so this only governs make_node name resolution.
\Newspack_Nodes\Command_Interpreter_Node::register_namespace( 'Example_AI_Newsletter\\' );
