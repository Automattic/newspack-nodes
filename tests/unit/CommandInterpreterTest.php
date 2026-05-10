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

	public function test_ls_default_mode_shows_only_siblings(): void {
		// Default mode = nodes whose sink IS this CI.
		CommandInterpreter::register_class( 'CaptureSink', CaptureSink::class );
		$ci = new CommandInterpreter();
		$ci->name( '_command_interpreter' );

		// alice + bob auto-sink to _command_interpreter via make_node.
		$ci->execute( 'make_node CaptureSink alice' );
		$ci->execute( 'make_node CaptureSink bob' );

		// Wire bob → alice so bob's sink is no longer the CI.
		$ci->execute( 'set_sink bob alice' );

		$out = $ci->execute( 'ls' );
		$this->assertStringContainsString( 'alice', $out );
		$this->assertStringNotContainsString( 'bob', $out, 'ls without -a hides nodes whose sink is not this CI' );
	}

	public function test_ls_dash_a_shows_all_nodes(): void {
		CommandInterpreter::register_class( 'CaptureSink', CaptureSink::class );
		$ci = new CommandInterpreter();
		$ci->name( '_command_interpreter' );

		$ci->execute( 'make_node CaptureSink alice' );
		$ci->execute( 'make_node CaptureSink bob' );
		$ci->execute( 'set_sink bob alice' );

		$out = $ci->execute( 'ls -a' );
		$this->assertStringContainsString( 'alice', $out );
		$this->assertStringContainsString( 'bob', $out );
		$this->assertStringContainsString( '_command_interpreter', $out );
	}

	public function test_ls_dash_a_with_glob_filters_by_regex(): void {
		CommandInterpreter::register_class( 'CaptureSink', CaptureSink::class );
		$ci = new CommandInterpreter();
		$ci->name( '_command_interpreter' );

		$ci->execute( 'make_node CaptureSink alice' );
		$ci->execute( 'make_node CaptureSink alex' );
		$ci->execute( 'make_node CaptureSink bob' );

		$out = $ci->execute( 'ls -a ^al' );
		$this->assertStringContainsString( 'alice', $out );
		$this->assertStringContainsString( 'alex', $out );
		$this->assertStringNotContainsString( 'bob', $out );
	}

	public function test_ls_with_node_name_shows_nodes_sinking_into_it(): void {
		CommandInterpreter::register_class( 'CaptureSink', CaptureSink::class );
		$ci = new CommandInterpreter();
		$ci->name( '_command_interpreter' );

		$ci->execute( 'make_node CaptureSink hub' );
		$ci->execute( 'make_node CaptureSink leaf1' );
		$ci->execute( 'make_node CaptureSink leaf2' );
		$ci->execute( 'set_sink leaf1 hub' );
		$ci->execute( 'set_sink leaf2 hub' );

		$out = $ci->execute( 'ls hub' );
		$this->assertStringContainsString( 'leaf1', $out );
		$this->assertStringContainsString( 'leaf2', $out );
		$this->assertStringNotContainsString( 'hub' . "\n", "$out\n", 'hub itself is NOT listed (its sink is the CI, not hub)' );
	}

	public function test_ls_with_unknown_name_returns_error(): void {
		$ci = new CommandInterpreter();
		$ci->name( '_command_interpreter' );

		$out = $ci->execute( 'ls nonexistent' );
		$this->assertStringContainsString( "can't find node", $out );
	}

	public function test_ls_dash_c_shows_count_column(): void {
		CommandInterpreter::register_class( 'CaptureSink', CaptureSink::class );
		$ci = new CommandInterpreter();
		$ci->name( '_command_interpreter' );

		$ci->execute( 'make_node CaptureSink alice' );

		$out = $ci->execute( 'ls -c' );
		$this->assertStringContainsString( 'COUNT', $out );
		$this->assertStringContainsString( 'NAME', $out );
		$this->assertStringContainsString( 'alice', $out );
	}

	public function test_help_no_args_lists_commands(): void {
		// Listing uses canonical names per Tachikoma convention — aliases like
		// `ls` and `dump` are documented in their canonical entry's help text.
		$ci = new CommandInterpreter();
		$ci->name( '_command_interpreter' );

		$out = $ci->execute( 'help' );
		$this->assertStringContainsString( 'list_nodes', $out );
		$this->assertStringContainsString( 'help', $out );
		$this->assertStringContainsString( 'make_node', $out );
		$this->assertStringContainsString( 'dump_node', $out );
		$this->assertStringContainsString( 'ping', $out );
	}

	public function test_help_alias_resolves_to_canonical_topic(): void {
		// `help ls` should return list_nodes' help text.
		$ci = new CommandInterpreter();
		$ci->name( '_command_interpreter' );

		$out = $ci->execute( 'help dump' );
		$this->assertStringContainsString( 'dump_node', $out );
		$this->assertStringContainsString( 'alias: dump', $out );
	}

	public function test_help_topic_returns_help_text(): void {
		$ci = new CommandInterpreter();
		$ci->name( '_command_interpreter' );

		$out = $ci->execute( 'help ls' );
		$this->assertStringContainsString( 'list_nodes', $out );
		$this->assertStringContainsString( '-c show', $out );
	}

	public function test_help_unknown_topic_returns_error(): void {
		$ci = new CommandInterpreter();
		$ci->name( '_command_interpreter' );

		$out = $ci->execute( 'help nonsense' );
		$this->assertStringContainsString( 'no such topic', $out );
	}

	public function test_dump_node_shows_internal_state(): void {
		CommandInterpreter::register_class( 'CaptureSink', CaptureSink::class );
		$ci = new CommandInterpreter();
		$ci->name( '_command_interpreter' );

		$ci->execute( 'make_node CaptureSink alice' );

		$out = $ci->execute( 'dump_node alice' );
		$this->assertStringContainsString( '"name"', $out );
		$this->assertStringContainsString( 'alice', $out );
		$this->assertStringContainsString( '"sink"', $out );
		$this->assertStringContainsString( '_command_interpreter', $out );
	}

	public function test_dump_alias_works(): void {
		CommandInterpreter::register_class( 'CaptureSink', CaptureSink::class );
		$ci = new CommandInterpreter();
		$ci->name( '_command_interpreter' );

		$ci->execute( 'make_node CaptureSink alice' );

		$out = $ci->execute( 'dump alice' );
		$this->assertStringContainsString( 'alice', $out );
	}

	public function test_dump_node_with_keys_filters_output(): void {
		CommandInterpreter::register_class( 'CaptureSink', CaptureSink::class );
		$ci = new CommandInterpreter();
		$ci->name( '_command_interpreter' );

		$ci->execute( 'make_node CaptureSink alice' );

		$out = $ci->execute( 'dump_node alice name' );
		$this->assertStringContainsString( '"name"', $out );
		$this->assertStringContainsString( 'alice', $out );
		$this->assertStringNotContainsString( '"sink"', $out, 'unrequested keys are filtered out' );
	}

	public function test_dump_node_unknown_node_returns_error(): void {
		$ci = new CommandInterpreter();
		$ci->name( '_command_interpreter' );

		$out = $ci->execute( 'dump_node nonexistent' );
		$this->assertStringContainsString( "can't find node", $out );
	}

	public function test_dump_node_unknown_key_returns_error(): void {
		CommandInterpreter::register_class( 'CaptureSink', CaptureSink::class );
		$ci = new CommandInterpreter();
		$ci->name( '_command_interpreter' );

		$ci->execute( 'make_node CaptureSink alice' );

		$out = $ci->execute( 'dump_node alice no_such_key' );
		$this->assertStringContainsString( "can't find key", $out );
	}

	public function test_TM_PING_with_empty_TO_bounces_to_FROM(): void {
		// Mirrors Tachikoma CommandInterpreter.pm:94-96. When CI receives
		// TM_PING with empty TO (i.e., addressed to itself after _router peeled),
		// it sets TO=FROM and forwards via sink so the message walks the
		// breadcrumb trail back to the originator.
		$ci = new CommandInterpreter();
		$ci->name( '_command_interpreter' );

		$downstream = new CaptureSink();
		$ci->sink( $downstream );

		$msg                       = Message::new_message();
		$msg[ Message::TYPE ]      = Message::TM_PING;
		$msg[ Message::FROM ]      = '_responder/12345';
		$msg[ Message::VALUE ]     = '1234567890.123456';
		$ci->fill( $msg );

		$this->assertCount( 1, $downstream->captured );
		$bounced = $downstream->captured[0];
		$this->assertSame( Message::TM_PING, $bounced[ Message::TYPE ] );
		$this->assertSame( '_responder/12345', $bounced[ Message::TO ], 'TM_PING bounce sets TO=FROM' );
		$this->assertSame( '1234567890.123456', $bounced[ Message::VALUE ], 'payload preserved' );
	}

	public function test_TM_PING_with_non_empty_TO_does_not_bounce(): void {
		// TM_PING with TO set (e.g., transiting through this CI on the way to
		// somewhere else) just forwards normally — only the destination CI
		// (where TO arrives empty after _router peels) does the bounce.
		$ci = new CommandInterpreter();
		$ci->name( '_command_interpreter' );

		$downstream = new CaptureSink();
		$ci->sink( $downstream );

		$msg                  = Message::new_message();
		$msg[ Message::TYPE ] = Message::TM_PING;
		$msg[ Message::FROM ] = '_responder/12345';
		$msg[ Message::TO ]   = 'some_other_node';
		$ci->fill( $msg );

		$this->assertCount( 1, $downstream->captured );
		$forwarded = $downstream->captured[0];
		$this->assertSame( 'some_other_node', $forwarded[ Message::TO ], 'TO preserved on transit' );
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
