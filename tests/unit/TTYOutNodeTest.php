<?php
/**
 * TTY_Out_Node: prompt-aware terminal writer — Stdout_Node plus readline/ANSI redraw.
 *
 * @package Newspack_Nodes
 */

declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Message;
use Newspack_Nodes\Shell_Node;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\TTY_Out_Node;

#[CoversClass( TTY_Out_Node::class )]
class TTYOutNodeTest extends TestCase {

	public function test_async_write_redraws_prompt_under_readline_mode(): void {
		$mem   = \fopen( 'php://memory', 'r+' );
		$node  = new TTY_Out_Node( $mem, true ); // force tty
		$shell = new Shell_Node();
		$shell->prompt = '/x> ';
		$node->set_shell( $shell );
		$node->set_readline_mode( true );
		$node->mark_prompt_displayed();
		$m = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$m[ Message::VALUE ] = "async line\n";
		$node->fill( $m );
		\rewind( $mem );
		$this->assertSame( "\r\033[2Kasync line\n/x> ", \stream_get_contents( $mem ) );
	}

	public function test_no_shell_falls_back_to_bare_parent_write(): void {
		$mem  = \fopen( 'php://memory', 'r+' );
		$node = new TTY_Out_Node( $mem, true ); // force tty, but no shell set
		$node->mark_prompt_displayed();
		$m = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$m[ Message::VALUE ] = 'plain line';
		$node->fill( $m );
		\rewind( $mem );
		$this->assertSame( 'plain line', \stream_get_contents( $mem ) );
	}

	public function test_async_write_non_readline_mode_uses_save_and_restore_cursor(): void {
		$mem   = \fopen( 'php://memory', 'r+' );
		$node  = new TTY_Out_Node( $mem, true ); // force tty
		$shell = new Shell_Node();
		$shell->prompt = '/x> ';
		$node->set_shell( $shell );
		$node->mark_prompt_displayed();
		$m = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$m[ Message::VALUE ] = "async line\n";
		$node->fill( $m );
		\rewind( $mem );
		$this->assertSame( "\033[s\r\033[2Kasync line\n/x> \033[u", \stream_get_contents( $mem ) );
	}

	public function test_constructor_falls_back_to_posix_detection_when_force_tty_is_null(): void {
		// force_tty=null exercises the posix_isatty() detection branch. A memory
		// stream is never a TTY, so async writes must fall back to the plain parent
		// write (no ANSI save/redraw) even with a prompt up and a shell set.
		$mem   = \fopen( 'php://memory', 'r+' );
		$node  = new TTY_Out_Node( $mem, null );
		$shell = new Shell_Node();
		$shell->prompt = '/x> ';
		$node->set_shell( $shell );
		$node->mark_prompt_displayed();
		$m = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$m[ Message::VALUE ] = 'plain line';
		$node->fill( $m );
		\rewind( $mem );
		$this->assertSame( 'plain line', \stream_get_contents( $mem ) );
	}

	public function test_a_partial_line_does_not_redraw_the_prompt(): void {
		// `print foo` emits no terminator, so the cursor stays on the line and
		// the prompt must not be re-issued behind it (Tachikoma parity).
		$mem   = \fopen( 'php://memory', 'r+' );
		$node  = new TTY_Out_Node( $mem, true );
		$shell = new Shell_Node();
		$shell->prompt = '/x> ';
		$node->set_shell( $shell );
		$node->set_readline_mode( true );
		$node->mark_prompt_displayed();
		$m = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$m[ Message::VALUE ] = 'foo';
		$node->fill( $m );
		\rewind( $mem );
		$this->assertSame( "\r\033[2Kfoo", \stream_get_contents( $mem ) );
	}

	public function test_write_prompt_writes_the_prompt_and_marks_it_displayed(): void {
		$mem  = \fopen( 'php://memory', 'r+' );
		$node = new TTY_Out_Node( $mem, false );
		$this->assertFalse( $node->prompt_displayed );
		$node->write_prompt( '/x> ' );
		\rewind( $mem );
		$this->assertSame( '/x> ', \stream_get_contents( $mem ) );
		$this->assertTrue( $node->prompt_displayed );
	}

	// ── control characters in the payload and in the prompt ───────────────

	public function test_redraw_renders_payload_escapes_while_keeping_its_own_ansi(): void {
		// force_tty reaches the redraw path: the node's own save/wipe/restore
		// sandwich has to survive, and only the arriving text is rendered.
		$mem   = \fopen( 'php://memory', 'r+' );
		$node  = new TTY_Out_Node( $mem, true );
		$shell = new Shell_Node();
		$shell->prompt = '/quarry> ';
		$node->set_shell( $shell );
		$node->mark_prompt_displayed();
		$m = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$m[ Message::VALUE ] = "GET /\x1B]0;pwned\x07 4419\n";
		$node->fill( $m );
		\rewind( $mem );
		$this->assertSame(
			"\033[s\r\033[2KGET /\033[7m<1B>\033[27m]0;pwned\033[7m<07>\033[27m 4419\n/quarry> \033[u",
			\stream_get_contents( $mem )
		);
	}

	public function test_readline_redraw_renders_a_carriage_return_in_the_payload(): void {
		$mem   = \fopen( 'php://memory', 'r+' );
		$node  = new TTY_Out_Node( $mem, true );
		$shell = new Shell_Node();
		$shell->prompt = '/quarry> ';
		$node->set_shell( $shell );
		$node->set_readline_mode( true );
		$node->mark_prompt_displayed();
		$m = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$m[ Message::VALUE ] = "denied\rgranted\n";
		$node->fill( $m );
		\rewind( $mem );
		$this->assertSame(
			"\r\033[2Kdenied\033[7m<0D>\033[27mgranted\n/quarry> ",
			\stream_get_contents( $mem )
		);
	}

	public function test_redraw_renders_an_escape_in_a_worker_set_prompt(): void {
		// `Dumper_Node::fill()` writes `$shell->prompt` from a worker's `prompt`
		// response, so the re-issued prompt is untrusted text too.
		$mem   = \fopen( 'php://memory', 'r+' );
		$node  = new TTY_Out_Node( $mem, true );
		$shell = new Shell_Node();
		$shell->prompt = "/quarry\x1B[31m> ";
		$node->set_shell( $shell );
		$node->set_readline_mode( true );
		$node->mark_prompt_displayed();
		$m = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$m[ Message::VALUE ] = "marl 8802\n";
		$node->fill( $m );
		\rewind( $mem );
		$this->assertSame(
			"\r\033[2Kmarl 8802\n/quarry<1B>[31m> ",
			\stream_get_contents( $mem )
		);
	}

	public function test_write_prompt_renders_an_escape_in_a_worker_set_prompt(): void {
		$mem  = \fopen( 'php://memory', 'r+' );
		$node = new TTY_Out_Node( $mem, false );
		$node->write_prompt( "/quarry\x1B[2J> " );
		\rewind( $mem );
		$this->assertSame( '/quarry<1B>[2J> ', \stream_get_contents( $mem ) );
	}

	public function test_write_prompt_leaves_the_prompt_bare_on_a_terminal(): void {
		// The prompt is chrome, redrawn on every async write, so its rendered
		// tokens are never reverse-videoed — one prompt, one plain appearance.
		$mem  = \fopen( 'php://memory', 'r+' );
		$node = new TTY_Out_Node( $mem, true );
		$node->write_prompt( "/sump\x9B2J> " );
		\rewind( $mem );
		$this->assertSame( '/sump<9B>2J> ', \stream_get_contents( $mem ) );
	}

	public function test_redraw_prompt_matches_the_appearance_readline_drew(): void {
		// TTY_In_Node::install_handler() hands readline a bare-rendered prompt;
		// a redraw that reverse-videoed it would make the prompt flicker between
		// two looks on every forced redisplay.
		$mem   = \fopen( 'php://memory', 'r+' );
		$node  = new TTY_Out_Node( $mem, true );
		$shell = new Shell_Node();
		$shell->prompt = "/sump\x9B2J> ";
		$node->set_shell( $shell );
		$node->set_readline_mode( true );
		$node->mark_prompt_displayed();
		$m = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$m[ Message::VALUE ] = "graben 4419\n";
		$node->fill( $m );
		\rewind( $mem );
		$this->assertSame(
			"\r\033[2Kgraben 4419\n/sump<9B>2J> ",
			\stream_get_contents( $mem )
		);
	}

	public function test_plain_path_renders_escapes_with_no_ansi_off_a_terminal(): void {
		$mem  = \fopen( 'php://memory', 'r+' );
		$node = new TTY_Out_Node( $mem, false );
		$m    = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$m[ Message::VALUE ] = "marl\x1B[2J8802";
		$node->fill( $m );
		\rewind( $mem );
		$this->assertSame( 'marl<1B>[2J8802', \stream_get_contents( $mem ) );
	}

	public function test_redraw_leaves_a_tab_in_the_payload_alone(): void {
		$mem   = \fopen( 'php://memory', 'r+' );
		$node  = new TTY_Out_Node( $mem, true );
		$shell = new Shell_Node();
		$shell->prompt = '/quarry> ';
		$node->set_shell( $shell );
		$node->set_readline_mode( true );
		$node->mark_prompt_displayed();
		$m = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$m[ Message::VALUE ] = "quarry\tp4419\n";
		$node->fill( $m );
		\rewind( $mem );
		$this->assertSame( "\r\033[2Kquarry\tp4419\n/quarry> ", \stream_get_contents( $mem ) );
	}
}
