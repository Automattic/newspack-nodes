<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
use Newspack_Nodes\Dumper;
use Newspack_Nodes\Message;
use Newspack_Nodes\Shell;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Dumper::class )]
class DumperTest extends TestCase {

	/** @return array{0:Dumper, 1:resource, 2:resource} */
	private function fresh(): array {
		$out    = \fopen( 'php://memory', 'w+' );
		$err    = \fopen( 'php://memory', 'w+' );
		$dumper = new Dumper( $out, $err );
		return [ $dumper, $out, $err ];
	}

	private function read_all( $stream ): string {
		\rewind( $stream );
		return \stream_get_contents( $stream );
	}

	public function test_TM_PING_prints_round_trip_time(): void {
		// Mirrors Tachikoma Dumper.pm:dump_ping. VALUE carries the original send
		// timestamp; the Dumper computes RTT in ms.
		[ $dumper, $out ] = $this->fresh();

		Core::$right_now = 1234567890.5;
		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_PING;
		$msg[ Message::VALUE ] = '1234567890.0';   // sent 500 ms before "now"
		$dumper->fill( $msg );

		$rendered = $this->read_all( $out );
		$this->assertStringContainsString( 'round trip time:', $rendered );
		$this->assertStringContainsString( '500.00 ms', $rendered );
	}

	public function test_TM_COMMAND_TM_RESPONSE_prints_payload(): void {
		[ $dumper, $out, $err ] = $this->fresh();

		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$msg[ Message::VALUE ] = \json_encode( [ 'name' => 'ls', 'payload' => "alice\nbob" ] );
		$dumper->fill( $msg );

		$this->assertSame( "alice\nbob\n", $this->read_all( $out ) );
		$this->assertSame( '', $this->read_all( $err ) );
	}

	public function test_TM_COMMAND_TM_RESPONSE_does_not_double_newline(): void {
		[ $dumper, $out ] = $this->fresh();

		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$msg[ Message::VALUE ] = \json_encode( [ 'name' => 'ls', 'payload' => "ends-with-newline\n" ] );
		$dumper->fill( $msg );

		$this->assertSame( "ends-with-newline\n", $this->read_all( $out ) );
	}

	public function test_TM_COMMAND_TM_RESPONSE_with_name_prompt_updates_shell_prompt(): void {
		[ $dumper, $out, $err ] = $this->fresh();

		$shell = new Shell();
		$dumper->set_shell( $shell );

		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$msg[ Message::VALUE ] = \json_encode( [ 'name' => 'prompt', 'payload' => 'pivot> ' ] );
		$dumper->fill( $msg );

		$this->assertSame( 'pivot> ', $shell->prompt );
		$this->assertSame( '', $this->read_all( $out ), 'prompt-update must NOT print to stdout' );
	}

	public function test_TM_ERROR_prints_to_stderr_with_prefix(): void {
		[ $dumper, $out, $err ] = $this->fresh();

		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_ERROR;
		$msg[ Message::VALUE ] = "NOT_AVAILABLE\n";
		$dumper->fill( $msg );

		$this->assertSame( '', $this->read_all( $out ) );
		$this->assertSame( "ERROR: NOT_AVAILABLE\n", $this->read_all( $err ) );
	}

	public function test_TM_INFO_prints_with_FROM_prefix(): void {
		[ $dumper, $out, $err ] = $this->fresh();

		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_INFO;
		$msg[ Message::FROM ]  = 'alpha';
		$msg[ Message::VALUE ] = 'broadcast text';
		$dumper->fill( $msg );

		$this->assertSame( "INFO[alpha]: broadcast text\n", $this->read_all( $out ) );
		$this->assertSame( '', $this->read_all( $err ) );
	}

	public function test_default_type_prints_VALUE(): void {
		[ $dumper, $out ] = $this->fresh();

		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$msg[ Message::VALUE ] = 'plain bytes';
		$dumper->fill( $msg );

		$this->assertSame( "plain bytes\n", $this->read_all( $out ) );
	}

	public function test_TM_COMMAND_TM_RESPONSE_with_invalid_json_falls_through_to_default(): void {
		[ $dumper, $out ] = $this->fresh();

		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$msg[ Message::VALUE ] = 'not-json';
		$dumper->fill( $msg );

		// json_decode → null, !is_array → fall through to default branch (prints VALUE).
		$this->assertSame( "not-json\n", $this->read_all( $out ) );
	}

	public function test_counter_increments_per_fill(): void {
		[ $dumper, $out ] = $this->fresh();
		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_INFO;
		$msg[ Message::FROM ]  = 'x';
		$msg[ Message::VALUE ] = 'a';

		$dumper->fill( $msg );
		$dumper->fill( $msg );

		$this->assertSame( 2, $dumper->counter() );
	}

	// ── Async prompt-below dance ────────────────────────────────────────────────

	/** @return array{0:Dumper, 1:resource, 2:resource, 3:Shell} */
	private function fresh_tty(): array {
		$out    = \fopen( 'php://memory', 'w+' );
		$err    = \fopen( 'php://memory', 'w+' );
		$dumper = new Dumper( $out, $err, true ); // force_tty=true
		$shell  = new Shell();
		$shell->prompt = 'newspack> ';
		$dumper->set_shell( $shell );
		return [ $dumper, $out, $err, $shell ];
	}

	public function test_TM_INFO_with_prompt_displayed_emits_wipe_and_redraw_on_tty(): void {
		[ $dumper, $out, , $shell ] = $this->fresh_tty();
		$dumper->mark_prompt_displayed();

		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_INFO;
		$msg[ Message::FROM ]  = 'broadcaster';
		$msg[ Message::VALUE ] = 'hello world';
		$dumper->fill( $msg );

		$expected = "\033[s" . "\r\033[2K"
			. "INFO[broadcaster]: hello world\n"
			. 'newspack> '
			. "\033[u";
		$this->assertSame( $expected, $this->read_all( $out ) );
	}

	public function test_TM_INFO_without_prompt_displayed_falls_back_to_plain_write(): void {
		[ $dumper, $out ] = $this->fresh_tty();
		// prompt_displayed=false → no wipe, no redraw.
		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_INFO;
		$msg[ Message::FROM ]  = 'x';
		$msg[ Message::VALUE ] = 'plain';
		$dumper->fill( $msg );

		$this->assertSame( "INFO[x]: plain\n", $this->read_all( $out ) );
	}

	public function test_TM_INFO_on_non_tty_skips_escape_sequences_even_when_prompt_displayed(): void {
		// Default $force_tty=null on a memory stream → posix_isatty=false →
		// non-TTY mode. Even with prompt_displayed=true, we must NOT emit ANSI.
		[ $dumper, $out ] = $this->fresh();
		$shell = new Shell();
		$dumper->set_shell( $shell );
		$dumper->mark_prompt_displayed();

		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_INFO;
		$msg[ Message::FROM ]  = 'x';
		$msg[ Message::VALUE ] = 'plain';
		$dumper->fill( $msg );

		$out_text = $this->read_all( $out );
		$this->assertStringNotContainsString( "\033", $out_text, 'non-TTY must not emit ANSI escapes' );
		$this->assertSame( "INFO[x]: plain\n", $out_text );
	}

	public function test_default_bytestream_with_prompt_displayed_emits_wipe_and_redraw(): void {
		[ $dumper, $out, , $shell ] = $this->fresh_tty();
		$dumper->mark_prompt_displayed();

		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$msg[ Message::VALUE ] = 'data';
		$dumper->fill( $msg );

		$expected = "\033[s" . "\r\033[2K" . "data\n" . 'newspack> ' . "\033[u";
		$this->assertSame( $expected, $this->read_all( $out ) );
	}

	public function test_TM_COMMAND_TM_RESPONSE_with_prompt_displayed_takes_async_redraw_path(): void {
		// In pivoted mode the response arrives async (worker → reply-in
		// Consumer → router → dumper) AFTER the cli has already drawn its
		// prompt waiting for input. Dumper goes through write_async so the
		// prompt line is wiped before the response prints, then redrawn.
		[ $dumper, $out, , $shell ] = $this->fresh_tty();
		$dumper->mark_prompt_displayed();

		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$msg[ Message::VALUE ] = \json_encode( [ 'name' => 'ls', 'payload' => 'a' ] );
		$dumper->fill( $msg );

		$expected = "\033[s" . "\r\033[2K" . "a\n" . 'newspack> ' . "\033[u";
		$this->assertSame( $expected, $this->read_all( $out ) );
	}

	public function test_TM_COMMAND_TM_RESPONSE_with_prompt_not_displayed_is_plain_write(): void {
		// Bare-mode cli flow: when the readline callback fires it clears
		// $dumper->prompt_displayed so synchronous output during queue
		// processing falls through to a plain stdout write — no ANSI dance,
		// because there's no prompt on screen yet (install_handler will draw
		// a fresh one after queue processing).
		[ $dumper, $out, , $shell ] = $this->fresh_tty();
		$dumper->prompt_displayed = false;

		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$msg[ Message::VALUE ] = \json_encode( [ 'name' => 'ls', 'payload' => 'a' ] );
		$dumper->fill( $msg );

		$this->assertSame( "a\n", $this->read_all( $out ) );
	}

	public function test_async_then_command_response_then_async_round_trip(): void {
		// Realistic interleaved sequence:
		//   prompt drawn → async TM_INFO arrives (wipe-and-redraw) →
		//   pivoted-mode TM_COMMAND|TM_RESPONSE arrives async too (wipe-and-
		//   redraw, prompt stays on screen) → another TM_INFO arrives (same
		//   path). All three share the same write_async wipe-and-redraw
		//   treatment because the prompt is still visible throughout.
		[ $dumper, $out, , $shell ] = $this->fresh_tty();
		$dumper->mark_prompt_displayed();

		// Async during prompt.
		$async = Message::new_message();
		$async[ Message::TYPE ]  = Message::TM_INFO;
		$async[ Message::FROM ]  = 'a';
		$async[ Message::VALUE ] = 'one';
		$dumper->fill( $async );

		// Pivoted-mode response — also async, also redraws around the prompt.
		$resp = Message::new_message();
		$resp[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$resp[ Message::VALUE ] = \json_encode( [ 'name' => 'ls', 'payload' => 'two' ] );
		$dumper->fill( $resp );

		// Another async.
		$async2 = Message::new_message();
		$async2[ Message::TYPE ]  = Message::TM_INFO;
		$async2[ Message::FROM ]  = 'b';
		$async2[ Message::VALUE ] = 'three';
		$dumper->fill( $async2 );

		$expected = "\033[s" . "\r\033[2K" . "INFO[a]: one\n" . 'newspack> ' . "\033[u"
			. "\033[s" . "\r\033[2K" . "two\n" . 'newspack> ' . "\033[u"
			. "\033[s" . "\r\033[2K" . "INFO[b]: three\n" . 'newspack> ' . "\033[u";
		$this->assertSame( $expected, $this->read_all( $out ) );
	}

	public function test_TM_ERROR_does_not_emit_escape_sequences_even_with_prompt_displayed(): void {
		[ $dumper, $out, $err, $shell ] = $this->fresh_tty();
		$dumper->mark_prompt_displayed();

		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_ERROR;
		$msg[ Message::VALUE ] = "boom\n";
		$dumper->fill( $msg );

		// Synchronous error path: stderr untouched by the prompt dance.
		$this->assertStringNotContainsString( "\033", $this->read_all( $err ) );
		$this->assertSame( "ERROR: boom\n", $this->read_all( $err ) );
	}
}
