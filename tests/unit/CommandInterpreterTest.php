<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\CommandInterpreter;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Tests\CaptureSink;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( CommandInterpreter::class )]
class CommandInterpreterTest extends TestCase {
	public function test_make_node_creates_named_node_in_registry(): void {
		// Register CaptureSink in the class table so `make_node CaptureSink ...` works.
		CommandInterpreter::register_class( 'CaptureSink', CaptureSink::class );

		$ci = new CommandInterpreter();
		$ci->name( '_command_interpreter' );

		$ci->execute( 'make_node CaptureSink alice' );

		$node = Core::node( 'alice' );
		$this->assertNotNull( $node );
		$this->assertInstanceOf( CaptureSink::class, $node );
	}

	public function test_make_node_auto_sinks_new_node_into_command_interpreter(): void {
		CommandInterpreter::register_class( 'CaptureSink', CaptureSink::class );

		$ci = new CommandInterpreter();
		$ci->name( '_command_interpreter' );

		$ci->execute( 'make_node CaptureSink bob' );
		$bob = Core::node( 'bob' );

		$this->assertSame( $ci, $bob->sink() );
	}

	public function test_make_node_returns_ok_string(): void {
		CommandInterpreter::register_class( 'CaptureSink', CaptureSink::class );
		$ci = new CommandInterpreter();
		$ci->name( '_command_interpreter' );

		$result = $ci->execute( 'make_node CaptureSink alice' );
		$this->assertSame( 'ok', $result );
	}

	public function test_command_interpreter_forwards_non_commands_to_sink(): void {
		$ci = new CommandInterpreter();
		$ci->name( '_command_interpreter' );

		$downstream = new CaptureSink();
		$ci->sink( $downstream );

		$msg                  = Message::new_message();
		$msg[ Message::TYPE ] = Message::TM_BYTESTREAM;
		$ci->fill( $msg );

		$this->assertCount( 1, $downstream->captured );
	}

	public function test_command_interpreter_executes_TM_COMMAND(): void {
		CommandInterpreter::register_class( 'CaptureSink', CaptureSink::class );

		$ci = new CommandInterpreter();
		$ci->name( '_command_interpreter' );

		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_COMMAND;
		$msg[ Message::VALUE ] = \json_encode(
			[
				'name'      => 'make_node',
				'arguments' => 'CaptureSink alice',
				'payload'   => '',
			]
		);
		$ci->fill( $msg );

		$this->assertNotNull( Core::node( 'alice' ) );
	}
}
