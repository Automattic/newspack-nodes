<?php
declare(strict_types=1);

require_once dirname( __DIR__ ) . '/includes/class-insights-ci-demo-node.php';
require_once dirname( __DIR__ ) . '/example-ai-newsletter.php';

use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Tests\TestCase;

final class InsightsMountTest extends TestCase {

	private function base_interpreter(): Command_Interpreter_Node {
		$base = new Command_Interpreter_Node();
		$base->name( '_command_interpreter' );
		return $base;
	}

	public function test_mount_callback_registers_insights_ci(): void {
		// The plugin exposes its mount as a named function so it's testable without WP hooks.
		\Example_AI_Newsletter\mount_insights_ci( $this->base_interpreter() );
		$this->assertInstanceOf( \Example_AI_Newsletter\Insights_CI_Demo_Node::class, Core::node( 'insights-demo' ) );
	}

	public function test_mount_is_idempotent(): void {
		$base = $this->base_interpreter();
		\Example_AI_Newsletter\mount_insights_ci( $base );
		// A second call (same request) must no-op, not throw on the 'insights-demo' name collision.
		\Example_AI_Newsletter\mount_insights_ci( $base );
		$this->assertInstanceOf( \Example_AI_Newsletter\Insights_CI_Demo_Node::class, Core::node( 'insights-demo' ) );
	}
}
