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
		$this->assertArrayNotHasKey( 'payload', $msg[ Message::VALUE ] );
		$this->assertTrue( $msg[ Message::LOCAL ] );
		// Default (interactive) Shell wants its reply — no TM_NOREPLY.
		$this->assertSame( 0, $msg[ Message::TYPE ] & Message::TM_NOREPLY );
	}

	public function test_send_command_stamps_noreply_when_reply_unwanted(): void {
		$shell = new Shell_Node();
		$sink  = new Capture_Sink_Node();
		$shell->sink( $sink );
		$shell->want_reply( false );

		$shell->send_command( 'some/path', 'connect_node', 'a b' );

		$msg = $sink->captured[0];
		$this->assertSame( Message::TM_NOREPLY, $msg[ Message::TYPE ] & Message::TM_NOREPLY );
		$this->assertSame( Message::TM_COMMAND, $msg[ Message::TYPE ] & Message::TM_COMMAND );
	}
}
