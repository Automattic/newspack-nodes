<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Message;
use Newspack_Nodes\Node_Names;
use Newspack_Nodes\Shell_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Shell_Node::class )]
class ShellSendCommandTest extends TestCase {

	public function test_send_command_builds_command_message_and_fills_sink(): void {
		// Thin wrapper that uses Node::command() (Task 1) to build the envelope,
		// stamps the Shell session's FROM/LOCAL provenance + the target TO,
		// and fills it through $this->sink. Mirrors Tachikoma's
		// Tachikoma::Nodes::Shell::send_command.
		$shell = new Shell_Node();
		$sink  = new Capture_Sink_Node();
		$shell->sink( $sink );

		$shell->send_command( 'some/path', 'connect_node', 'a b' );

		$this->assertCount( 1, $sink->captured );
		$msg = $sink->captured[0];
		$this->assertSame(
			Message::TM_COMMAND,
			$msg[ Message::TYPE ] & Message::TM_COMMAND
		);
		$this->assertSame( 'some/path', $msg[ Message::TO ] );
		$this->assertSame( Node_Names::OUTPUT . '/' . \getmypid(), $msg[ Message::FROM ] );
		$this->assertSame( 'connect_node', $msg[ Message::VALUE ]['name'] );
		$this->assertSame( 'a b', $msg[ Message::VALUE ]['arguments'] );
		$this->assertNull( $msg[ Message::VALUE ]['payload'] );
		$this->assertTrue( $msg[ Message::LOCAL ] );
		$this->assertNotSame( '', $msg[ Message::ID ] );
	}

	public function test_send_command_is_a_noop_without_sink(): void {
		// No sink configured: must not throw. Mirrors the `sink?->fill()`
		// guard in parse() so REPLs running before wiring stay safe.
		$shell = new Shell_Node();
		$shell->send_command( '', 'pwd', '' );
		$this->assertTrue( true );
	}
}
