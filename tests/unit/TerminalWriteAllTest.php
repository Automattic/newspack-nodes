<?php
/**
 * Every terminal write lands whole on a stream that takes only part of it per
 * call, the way a non-blocking pty does when its buffer is full.
 *
 * On a pty, fd 0 and fd 1 share one open file description, so the O_NONBLOCK
 * that `Stdin_Node` sets on STDIN lands on STDOUT too, and a single `fwrite`
 * there returns the short count the pty buffer took. Every value here is
 * 40,000 bytes against a 12,288-byte buffer, so each write is refused
 * several times before it lands.
 *
 * @package Newspack_Nodes
 */

declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Message;
use Newspack_Nodes\Shell_Node;
use Newspack_Nodes\Stdout_Node;
use Newspack_Nodes\Tests\Pty_Stream_Wrapper;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\TTY_Out_Node;

require_once \dirname( __DIR__ ) . '/Helpers/PtyStreamWrapper.php';

#[CoversClass( Stdout_Node::class )]
#[CoversClass( TTY_Out_Node::class )]
class TerminalWriteAllTest extends TestCase {

	private const PTY_BUFFER = 12288;

	private const VALUE_SIZE = 40000;

	protected function setUp(): void {
		parent::setUp();
		Pty_Stream_Wrapper::reset( self::PTY_BUFFER );
	}

	protected function tearDown(): void {
		Pty_Stream_Wrapper::unregister();
		parent::tearDown();
	}

	/** A 40,000-byte value whose bytes vary, so a dropped or reordered chunk shows. */
	private function value( string $suffix = '' ): string {
		$body = \str_repeat( '0123456789abcdef', \intdiv( self::VALUE_SIZE, 16 ) );
		return \substr( $body, 0, self::VALUE_SIZE - \strlen( $suffix ) ) . $suffix;
	}

	/** @return resource */
	private function pty() {
		return Pty_Stream_Wrapper::open( self::VALUE_SIZE );
	}

	private function message( string $value ): array {
		$m = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$m[ Message::VALUE ] = $value;
		return $m;
	}

	public function test_stdout_fill_lands_every_byte_past_a_refused_write(): void {
		$node  = new Stdout_Node( $this->pty(), true );
		$value = $this->value();
		$node->fill( $this->message( $value ) );
		$this->assertSame( $value, Pty_Stream_Wrapper::written() );
		$this->assertGreaterThan( 0, Pty_Stream_Wrapper::$selects );
	}

	public function test_stdout_write_raw_lands_every_byte_past_a_refused_write(): void {
		$node  = new Stdout_Node( $this->pty(), true );
		$value = $this->value();
		$node->write_raw( $value );
		$this->assertSame( $value, Pty_Stream_Wrapper::written() );
		$this->assertGreaterThan( 0, Pty_Stream_Wrapper::$selects );
	}

	public function test_tty_out_readline_redraw_lands_every_byte_past_a_refused_write(): void {
		$node          = new TTY_Out_Node( $this->pty(), true );
		$shell         = new Shell_Node();
		$shell->prompt = '/x> ';
		$node->set_shell( $shell );
		$node->set_readline_mode( true );
		$node->mark_prompt_displayed();
		$value = $this->value( "\n" );
		$node->fill( $this->message( $value ) );
		$this->assertSame( "\r\033[2K" . $value . '/x> ', Pty_Stream_Wrapper::written() );
		$this->assertGreaterThan( 0, Pty_Stream_Wrapper::$selects );
	}

	public function test_tty_out_cursor_redraw_lands_every_byte_past_a_refused_write(): void {
		$node          = new TTY_Out_Node( $this->pty(), true );
		$shell         = new Shell_Node();
		$shell->prompt = '/x> ';
		$node->set_shell( $shell );
		$node->mark_prompt_displayed();
		$value = $this->value( "\n" );
		$node->fill( $this->message( $value ) );
		$this->assertSame( "\033[s\r\033[2K" . $value . "/x> \033[u", Pty_Stream_Wrapper::written() );
		$this->assertGreaterThan( 0, Pty_Stream_Wrapper::$selects );
	}

	public function test_tty_out_write_prompt_lands_every_byte_past_a_refused_write(): void {
		$node   = new TTY_Out_Node( $this->pty(), true );
		$prompt = $this->value( '> ' );
		$node->write_prompt( $prompt );
		$this->assertSame( $prompt, Pty_Stream_Wrapper::written() );
		$this->assertGreaterThan( 0, Pty_Stream_Wrapper::$selects );
		$this->assertTrue( $node->prompt_displayed );
	}

	public function test_stdout_write_survives_a_signal_during_its_wait(): void {
		// A real non-blocking descriptor, a real full buffer, a real EINTR:
		// select(2) is never restarted by a signal handler, and
		// Event_Framework installs SIGTERM and SIGINT handlers through
		// pcntl_signal, so a signal during the wait must not cost the tail.
		if ( ! \function_exists( 'pcntl_fork' ) ) {
			$this->markTestSkipped( 'pcntl is not loaded' );
		}
		[ $writer, $reader ] = \stream_socket_pair( \STREAM_PF_UNIX, \STREAM_SOCK_STREAM, 0 );
		\stream_set_blocking( $writer, false );
		$prefill = 0;
		do {
			$landed   = (int) \fwrite( $writer, \str_repeat( 'p', 65536 ) );
			$prefill += $landed;
		} while ( $landed > 0 );

		\pcntl_signal( \SIGUSR1, static function (): void {} );
		$child = \pcntl_fork();
		if ( 0 === $child ) {
			// Signal the parent mid-wait, then drain the prefill so the wait ends.
			for ( $i = 0; $i < 5; $i++ ) {
				\usleep( 10000 );
				\posix_kill( \posix_getppid(), \SIGUSR1 );
			}
			// recvfrom rather than fread: fread buffers 8192 bytes past the
			// count asked for, and those would die here with the child.
			for ( $drained = 0; $drained < $prefill; $drained += \strlen( $chunk ) ) {
				$chunk = (string) \stream_socket_recvfrom( $reader, $prefill - $drained );
			}
			\posix_kill( \posix_getpid(), \SIGKILL );
		}

		$node  = new Stdout_Node( $writer, true );
		$value = $this->value();
		$node->fill( $this->message( $value ) );

		\pcntl_waitpid( $child, $status );
		\pcntl_signal( \SIGUSR1, \SIG_DFL );
		\stream_set_blocking( $reader, false );
		$this->assertSame( $value, (string) \stream_get_contents( $reader ) );
	}

	public function test_stdout_write_gives_up_on_a_failed_write_rather_than_spinning(): void {
		Pty_Stream_Wrapper::$fail_after_refusal = true;
		$node  = new Stdout_Node( $this->pty(), true );
		$value = $this->value();
		$node->fill( $this->message( $value ) );
		$this->assertSame( \substr( $value, 0, self::PTY_BUFFER ), Pty_Stream_Wrapper::written() );
		$this->assertSame( 1, Pty_Stream_Wrapper::$refusals );
		$this->assertSame( 0, Pty_Stream_Wrapper::$selects );
	}
}
