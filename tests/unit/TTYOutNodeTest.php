<?php
/**
 * TTY_Out_Node: prompt-aware terminal writer — Stdout_Node plus readline/ANSI redraw.
 *
 * @package Newspack_Nodes
 */

declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Message;
use Newspack_Nodes\Shell_Node;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\TTY_Out_Node;
use PHPUnit\Framework\Attributes\CoversClass;

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
		$m[ Message::VALUE ] = 'async line';
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
		$this->assertSame( "plain line\n", \stream_get_contents( $mem ) );
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
		$m[ Message::VALUE ] = 'async line';
		$node->fill( $m );
		\rewind( $mem );
		$this->assertSame( "\033[s\r\033[2Kasync line\n/x> \033[u", \stream_get_contents( $mem ) );
	}
}
