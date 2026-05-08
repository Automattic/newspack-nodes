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

	public function test_set_sink_wires_one_node_to_another(): void {
		CommandInterpreter::register_class( 'CaptureSink', CaptureSink::class );
		$ci = new CommandInterpreter();
		$ci->name( '_command_interpreter' );

		$ci->execute( 'make_node CaptureSink alice' );
		$ci->execute( 'make_node CaptureSink bob' );
		$ci->execute( 'set_sink alice bob' );

		$this->assertSame( Core::node( 'bob' ), Core::node( 'alice' )->sink() );
	}

	public function test_connect_node_sets_target(): void {
		CommandInterpreter::register_class( 'CaptureSink', CaptureSink::class );
		$ci = new CommandInterpreter();
		$ci->name( '_command_interpreter' );

		$ci->execute( 'make_node CaptureSink alice' );
		$ci->execute( 'make_node CaptureSink bob' );
		$ci->execute( 'connect_node alice bob' );

		$this->assertSame( 'bob', Core::node( 'alice' )->target() );
	}

	public function test_disconnect_node_clears_target(): void {
		CommandInterpreter::register_class( 'CaptureSink', CaptureSink::class );
		$ci = new CommandInterpreter();
		$ci->name( '_command_interpreter' );

		$ci->execute( 'make_node CaptureSink alice' );
		$ci->execute( 'make_node CaptureSink bob' );
		$ci->execute( 'connect_node alice bob' );
		$ci->execute( 'disconnect_node alice' );

		$this->assertSame( '', Core::node( 'alice' )->target() );
	}

	public function test_ls_returns_node_table(): void {
		CommandInterpreter::register_class( 'CaptureSink', CaptureSink::class );
		$ci = new CommandInterpreter();
		$ci->name( '_command_interpreter' );

		$ci->execute( 'make_node CaptureSink alice' );
		$ci->execute( 'make_node CaptureSink bob' );

		$out = $ci->execute( 'ls' );
		$this->assertStringContainsString( 'alice', $out );
		$this->assertStringContainsString( 'bob', $out );
	}

	public function test_dump_config_round_trips_full_graph(): void {
		CommandInterpreter::register_class( 'CaptureSink', CaptureSink::class );
		$ci = new CommandInterpreter();
		$ci->name( '_command_interpreter' );

		$ci->execute( 'make_node CaptureSink alice' );
		$ci->execute( 'make_node CaptureSink bob' );
		$ci->execute( 'connect_node alice bob' );

		$dump = $ci->execute( 'dump_config' );
		$this->assertStringContainsString( 'make_node CaptureSink alice', $dump );
		$this->assertStringContainsString( 'make_node CaptureSink bob', $dump );
		$this->assertStringContainsString( 'connect_node alice bob', $dump );
		// alice's sink is _command_interpreter (auto-default) — should NOT be emitted.
		$this->assertStringNotContainsString( 'set_sink alice', $dump );
	}
}
