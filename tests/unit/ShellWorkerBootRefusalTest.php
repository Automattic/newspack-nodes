<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Shell_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\Capture_Stdout_Node;
use Newspack_Nodes\Tests\TestCase;

/**
 * Worker-boot scope: `_stdout` is registered ONLY by `wp nodes cli`, so a
 * topology load has no such node. A refusal must still reach an operator.
 */
#[CoversClass( Shell_Node::class )]
class ShellWorkerBootRefusalTest extends TestCase {

	/** @var list<string> */
	private array $emitted = [];

	protected function setUp(): void {
		parent::setUp();
		$this->emitted = [];
		Core::set_stderr_handler(
			function ( string $text ): void {
				$this->emitted[] = $text;
			}
		);
	}

	/** A Shell wired the way Topology_Loader wires one at worker boot. */
	private function boot_shell(): Shell_Node {
		$shell = new Shell_Node();
		$shell->sink( new Capture_Sink_Node() );
		$shell->want_reply( false );
		$shell->fatal_errors( true );
		return $shell;
	}

	public function test_command_node_missing_verb_is_reported_at_worker_boot(): void {
		$shell = $this->boot_shell();

		$shell->eval_script( "make_node Echo telemetry_sprocket\ncommand_node telemetry_sprocket\n" );

		$this->assertStringContainsString(
			'usage: cmd <path> <verb>',
			\implode( '', $this->emitted ),
			'a TSL statement skipped at worker boot must leave a trace'
		);
	}

	public function test_var_division_by_zero_is_reported_at_worker_boot(): void {
		$shell = $this->boot_shell();

		$shell->eval_script( "var beat_interval = 7331\nvar beat_interval /= 0\n" );

		$this->assertStringContainsString( 'var: division by zero', \implode( '', $this->emitted ) );
		$this->assertSame( '7331', Core::$var['beat_interval'], 'the refused operation leaves the stale value' );
	}

	public function test_a_repeated_refusal_is_rate_limited(): void {
		$shell = $this->boot_shell();

		$shell->eval_script( "command_node alpha_widget\ncommand_node beta_widget\n" );

		$this->assertCount( 1, $this->emitted, 'identical refusals must not flood the log' );
	}

	public function test_a_repl_refusal_reaches_stdout_and_is_not_double_printed(): void {
		$capture = new Capture_Stdout_Node();
		$capture->name( '_stdout' );
		$shell = new Shell_Node();
		$shell->sink( new Capture_Sink_Node() );

		$shell->eval_script( "command_node telemetry_sprocket\n" );

		$this->assertStringContainsString(
			'usage: cmd <path> <verb>',
			\implode( '', \array_column( $capture->captured, Message::VALUE ) )
		);
		$this->assertSame( [], $this->emitted, 'with a terminal attached the refusal goes there and nowhere else' );
	}
}
