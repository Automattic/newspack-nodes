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
 * Worker-boot scope: a Shell loading a topology fails the load on a refused
 * statement, after every other statement ran; a REPL prints the refusal.
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

	public function test_command_node_missing_verb_fails_the_load(): void {
		$shell = $this->boot_shell();

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'usage: cmd <path> <verb>' );
		$shell->eval_script( "make_node Echo telemetry_sprocket\ncommand_node telemetry_sprocket\n" );
	}

	public function test_var_division_by_zero_fails_the_load_and_keeps_the_value(): void {
		$shell = $this->boot_shell();

		$e = $this->caught(
			fn () => $shell->eval_script( "var beat_interval = 7331\nvar beat_interval /= 0\n" ),
			'a refused assignment must fail the load'
		);
		$this->assertStringContainsString( 'var: division by zero', $e->getMessage() );
		$this->assertSame( '7331', Core::$var['beat_interval'], 'the refused operation leaves the stale value' );
	}

	public function test_every_refused_statement_runs_and_raises_together(): void {
		$shell = $this->boot_shell();

		try {
			$shell->eval_script( "command_node alpha_widget\nvar sprocket_count = 6152\ncommand_node beta_widget\n" );
			$this->fail( 'refused statements must fail the load' );
		} catch ( \Newspack_Nodes\Failures $e ) {
			$this->assertCount( 2, $e->all() );
		}
		$this->assertSame( '6152', Core::$var['sprocket_count'], 'the statement between the refusals ran' );
		$this->assertSame( [], $this->emitted, 'a refusal is raised, not printed' );
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
