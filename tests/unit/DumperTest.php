<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
use Newspack_Nodes\Dumper_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Shell_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Dumper_Node::class )]
class DumperTest extends TestCase {

	/** @return array{0:Dumper_Node, 1:resource} */
	private function fresh(): array {
		$out    = \fopen( 'php://memory', 'w+' );
		$dumper = new Dumper_Node( $out );
		return [ $dumper, $out ];
	}

	private function read_all( $stream ): string {
		\rewind( $stream );
		return \stream_get_contents( $stream );
	}

	public function test_TM_EOF_invokes_on_eof_callback_and_renders_nothing(): void {
		// TM_EOF is the drain marker for the cli's stdin-close round-trip:
		// cli emits TM_EOF, worker bounces it, cli's Dumper sees the echo
		// and fires the registered callback so the cli's run_repl predicate
		// can exit. The Dumper itself prints nothing — TM_EOF is a control
		// marker, not output.
		[ $dumper, $out ] = $this->fresh();

		$fired = 0;
		$dumper->on_eof( function () use ( &$fired ) { ++$fired; } );

		$message                  = Message::new_message();
		$message[ Message::TYPE ] = Message::TM_EOF;
		$dumper->fill( $message );

		$this->assertSame( 1, $fired, 'on_eof callback should fire once' );
		$this->assertSame( '', $this->read_all( $out ) );
	}

	public function test_TM_EOF_filtered_out_by_to_filter_does_not_fire_callback(): void {
		// TM_EOF addressed at a different pid (different cli session) is
		// filtered out at the Dumper's to_filter gate — same as any other
		// type. The callback only fires for our own session's echo.
		[ $dumper, $out ] = $this->fresh();
		$dumper->set_to_filter( '12345' );

		$fired = 0;
		$dumper->on_eof( function () use ( &$fired ) { ++$fired; } );

		$message                  = Message::new_message();
		$message[ Message::TYPE ] = Message::TM_EOF;
		$message[ Message::TO ]   = '_output/99999'; // different pid
		$dumper->fill( $message );

		$this->assertSame( 0, $fired );
	}

	public function test_TM_PING_prints_round_trip_time(): void {
		// Mirrors Tachikoma Dumper.pm:dump_ping. VALUE carries the original send
		// timestamp; the Dumper computes RTT in ms.
		[ $dumper, $out ] = $this->fresh();

		Core::$now = 1234567890.5;
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_PING;
		$message[ Message::VALUE ] = '1234567890.0';   // sent 500 ms before "now"
		$dumper->fill( $message );

		$rendered = $this->read_all( $out );
		$this->assertStringContainsString( 'round trip time:', $rendered );
		$this->assertStringContainsString( '500.00 ms', $rendered );
	}

	public function test_TM_COMMAND_TM_RESPONSE_prints_payload(): void {
		[ $dumper, $out ] = $this->fresh();

		// Response VALUE rides as a live PHP structure — not a JSON string.
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$message[ Message::VALUE ] = [ 'name' => 'ls', 'payload' => "alice\nbob" ];
		$dumper->fill( $message );

		$this->assertSame( "alice\nbob\n", $this->read_all( $out ) );
	}

	public function test_TM_COMMAND_TM_RESPONSE_does_not_double_newline(): void {
		[ $dumper, $out ] = $this->fresh();

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$message[ Message::VALUE ] = [ 'name' => 'ls', 'payload' => "ends-with-newline\n" ];
		$dumper->fill( $message );

		$this->assertSame( "ends-with-newline\n", $this->read_all( $out ) );
	}

	public function test_TM_COMMAND_TM_RESPONSE_with_name_prompt_updates_shell_prompt(): void {
		[ $dumper, $out ] = $this->fresh();

		$shell = new Shell_Node();
		$dumper->set_shell( $shell );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$message[ Message::VALUE ] = [ 'name' => 'prompt', 'payload' => 'pivot> ' ];
		$dumper->fill( $message );

		$this->assertSame( 'pivot> ', $shell->prompt );
		$this->assertSame( '', $this->read_all( $out ), 'prompt-update must NOT print to stdout' );
	}

	public function test_TM_ERROR_prints_payload_to_stdout_like_any_other_value(): void {
		// A bare TM_ERROR has no dedicated branch — it falls through to the
		// default renderer and goes out via write_async, exactly like a plain
		// TM_BYTESTREAM payload. On a non-TTY that's a plain stdout write; stderr
		// stays untouched.
		[ $dumper, $out ] = $this->fresh();

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_ERROR;
		$message[ Message::VALUE ] = "NOT_AVAILABLE\n";
		$dumper->fill( $message );

		$this->assertSame( "NOT_AVAILABLE\n", $this->read_all( $out ) );
	}

	public function test_TM_INFO_prints_payload_without_prefix(): void {
		// TM_INFO renders as a plain async bytestream — same as default
		// TM_BYTESTREAM. The former `INFO[from]: ...` prefix was
		// redundant noise; debug_level 1 already prepends a
		// `TM_INFO from <from>:` header when verbosity is wanted.
		[ $dumper, $out ] = $this->fresh();

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_INFO;
		$message[ Message::FROM ]  = 'alpha';
		$message[ Message::VALUE ] = 'broadcast text';
		$dumper->fill( $message );

		$this->assertSame( "broadcast text\n", $this->read_all( $out ) );
	}

	public function test_default_type_prints_VALUE(): void {
		[ $dumper, $out ] = $this->fresh();

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::VALUE ] = 'plain bytes';
		$dumper->fill( $message );

		$this->assertSame( "plain bytes\n", $this->read_all( $out ) );
	}

	public function test_TM_COMMAND_TM_RESPONSE_with_non_array_value_falls_through_to_default(): void {
		[ $dumper, $out ] = $this->fresh();

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		// A bare-string VALUE on a response is malformed (the contract is a
		// `['name'=>,'payload'=>]` array) — fall through to the default
		// branch and print VALUE as-is rather than crash.
		$message[ Message::VALUE ] = 'not-a-struct';
		$dumper->fill( $message );

		$this->assertSame( "not-a-struct\n", $this->read_all( $out ) );
	}

	public function test_counter_increments_per_fill(): void {
		[ $dumper, $out ] = $this->fresh();
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_INFO;
		$message[ Message::FROM ]  = 'x';
		$message[ Message::VALUE ] = 'a';

		$dumper->fill( $message );
		$dumper->fill( $message );

		$this->assertSame( 2, $dumper->counter() );
	}

	// ── Async prompt-below dance ────────────────────────────────────────────────

	/** @return array{0:Dumper_Node, 1:resource, 2:Shell_Node} */
	private function fresh_tty(): array {
		$out    = \fopen( 'php://memory', 'w+' );
		$dumper = new Dumper_Node( $out, true ); // force_tty=true
		$shell  = new Shell_Node();
		$shell->prompt = 'newspack> ';
		$dumper->set_shell( $shell );
		return [ $dumper, $out, $shell ];
	}

	public function test_TM_INFO_with_prompt_displayed_emits_wipe_and_redraw_on_tty(): void {
		[ $dumper, $out, $shell ] = $this->fresh_tty();
		$dumper->mark_prompt_displayed();

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_INFO;
		$message[ Message::FROM ]  = 'broadcaster';
		$message[ Message::VALUE ] = 'hello world';
		$dumper->fill( $message );

		$expected = "\033[s" . "\r\033[2K"
			. "hello world\n"
			. 'newspack> '
			. "\033[u";
		$this->assertSame( $expected, $this->read_all( $out ) );
	}

	public function test_TM_INFO_without_prompt_displayed_falls_back_to_plain_write(): void {
		[ $dumper, $out ] = $this->fresh_tty();
		// prompt_displayed=false → no wipe, no redraw.
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_INFO;
		$message[ Message::FROM ]  = 'x';
		$message[ Message::VALUE ] = 'plain';
		$dumper->fill( $message );

		$this->assertSame( "plain\n", $this->read_all( $out ) );
	}

	public function test_TM_INFO_on_non_tty_skips_escape_sequences_even_when_prompt_displayed(): void {
		// Default $force_tty=null on a memory stream → posix_isatty=false →
		// non-TTY mode. Even with prompt_displayed=true, we must NOT emit ANSI.
		[ $dumper, $out ] = $this->fresh();
		$shell = new Shell_Node();
		$dumper->set_shell( $shell );
		$dumper->mark_prompt_displayed();

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_INFO;
		$message[ Message::FROM ]  = 'x';
		$message[ Message::VALUE ] = 'plain';
		$dumper->fill( $message );

		$out_text = $this->read_all( $out );
		$this->assertStringNotContainsString( "\033", $out_text, 'non-TTY must not emit ANSI escapes' );
		$this->assertSame( "plain\n", $out_text );
	}

	public function test_default_bytestream_with_prompt_displayed_emits_wipe_and_redraw(): void {
		[ $dumper, $out, $shell ] = $this->fresh_tty();
		$dumper->mark_prompt_displayed();

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::VALUE ] = 'data';
		$dumper->fill( $message );

		$expected = "\033[s" . "\r\033[2K" . "data\n" . 'newspack> ' . "\033[u";
		$this->assertSame( $expected, $this->read_all( $out ) );
	}

	public function test_TM_COMMAND_TM_RESPONSE_with_prompt_displayed_takes_async_redraw_path(): void {
		// In pivoted mode the response arrives async (worker → reply-in
		// Consumer → router → dumper) AFTER the cli has already drawn its
		// prompt waiting for input. Dumper goes through write_async so the
		// prompt line is wiped before the response prints, then redrawn.
		[ $dumper, $out, $shell ] = $this->fresh_tty();
		$dumper->mark_prompt_displayed();

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$message[ Message::VALUE ] = [ 'name' => 'ls', 'payload' => 'a' ];
		$dumper->fill( $message );

		$expected = "\033[s" . "\r\033[2K" . "a\n" . 'newspack> ' . "\033[u";
		$this->assertSame( $expected, $this->read_all( $out ) );
	}

	public function test_TM_COMMAND_TM_RESPONSE_with_prompt_not_displayed_is_plain_write(): void {
		// Bare-mode cli flow: when the readline callback fires it clears
		// $dumper->prompt_displayed so synchronous output during queue
		// processing falls through to a plain stdout write — no ANSI dance,
		// because there's no prompt on screen yet (install_handler will draw
		// a fresh one after queue processing).
		[ $dumper, $out, $shell ] = $this->fresh_tty();
		$dumper->prompt_displayed = false;

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$message[ Message::VALUE ] = [ 'name' => 'ls', 'payload' => 'a' ];
		$dumper->fill( $message );

		$this->assertSame( "a\n", $this->read_all( $out ) );
	}

	public function test_async_then_command_response_then_async_round_trip(): void {
		// Realistic interleaved sequence:
		//   prompt drawn → async TM_INFO arrives (wipe-and-redraw) →
		//   pivoted-mode TM_COMMAND|TM_RESPONSE arrives async too (wipe-and-
		//   redraw, prompt stays on screen) → another TM_INFO arrives (same
		//   path). All three share the same write_async wipe-and-redraw
		//   treatment because the prompt is still visible throughout.
		[ $dumper, $out, $shell ] = $this->fresh_tty();
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
		$resp[ Message::VALUE ] = [ 'name' => 'ls', 'payload' => 'two' ];
		$dumper->fill( $resp );

		// Another async.
		$async2 = Message::new_message();
		$async2[ Message::TYPE ]  = Message::TM_INFO;
		$async2[ Message::FROM ]  = 'b';
		$async2[ Message::VALUE ] = 'three';
		$dumper->fill( $async2 );

		$expected = "\033[s" . "\r\033[2K" . "one\n" . 'newspack> ' . "\033[u"
			. "\033[s" . "\r\033[2K" . "two\n" . 'newspack> ' . "\033[u"
			. "\033[s" . "\r\033[2K" . "three\n" . 'newspack> ' . "\033[u";
		$this->assertSame( $expected, $this->read_all( $out ) );
	}

	public function test_TM_ERROR_takes_async_wipe_and_redraw_path_with_prompt_displayed(): void {
		// A bare TM_ERROR is just another payload now — on a TTY with the prompt
		// up it goes through write_async's wipe-and-redraw on STDOUT, same as any
		// async TM_INFO/TM_BYTESTREAM. There's no separate synchronous stderr path.
		[ $dumper, $out, $shell ] = $this->fresh_tty();
		$dumper->mark_prompt_displayed();

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_ERROR;
		$message[ Message::VALUE ] = "boom\n";
		$dumper->fill( $message );

		$expected = "\033[s" . "\r\033[2K" . "boom\n" . 'newspack> ' . "\033[u";
		$this->assertSame( $expected, $this->read_all( $out ) );
	}

	public function test_set_readline_mode_changes_async_redraw_path(): void {
		// readline_mode=true uses the simpler "wipe and rewrite prompt" path —
		// no ANSI save/restore around it, because readline is installed with an
		// empty prompt (Cli_Command::install_handler) and we drive the prompt
		// directly. set_readline_mode toggles between the two paths.
		[ $dumper, $out, $shell ] = $this->fresh_tty();
		$dumper->mark_prompt_displayed();
		$dumper->set_readline_mode( true );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_INFO;
		$message[ Message::FROM ]  = 'a';
		$message[ Message::VALUE ] = 'one';
		$dumper->fill( $message );

		// readline_mode path: just CR+clear-line + text + prompt — no save/restore.
		$expected = "\r\033[2K" . "one\n" . 'newspack> ';
		$this->assertSame( $expected, $this->read_all( $out ) );
	}

	public function test_set_to_filter_drops_messages_with_unmatched_TO(): void {
		// Multi-session: only matching $pid (or empty TO) renders.
		[ $dumper, $out ] = $this->fresh();
		$dumper->set_to_filter( '12345' );

		// Different cli's reply — must drop silently.
		$other                      = Message::new_message();
		$other[ Message::TYPE ]     = Message::TM_BYTESTREAM;
		$other[ Message::TO ]       = '99999';
		$other[ Message::VALUE ]    = 'not-mine';
		$dumper->fill( $other );

		$this->assertSame( '', $this->read_all( $out ) );
	}

	public function test_set_to_filter_renders_when_TO_matches_pid(): void {
		[ $dumper, $out ] = $this->fresh();
		$dumper->set_to_filter( '12345' );

		// Worker reply with _router-peeled prefix → TO=$pid.
		$mine                  = Message::new_message();
		$mine[ Message::TYPE ] = Message::TM_BYTESTREAM;
		$mine[ Message::TO ]   = '12345';
		$mine[ Message::VALUE ] = 'mine';
		$dumper->fill( $mine );

		$this->assertSame( "mine\n", $this->read_all( $out ) );
	}

	public function test_set_to_filter_renders_with_unpeeled_output_prefix(): void {
		// The other shape: TO=_output/$pid (worker reply with _output not yet peeled).
		[ $dumper, $out ] = $this->fresh();
		$dumper->set_to_filter( '12345' );

		$message                  = Message::new_message();
		$message[ Message::TYPE ] = Message::TM_BYTESTREAM;
		$message[ Message::TO ]   = '_output/12345';
		$message[ Message::VALUE ] = 'mine';
		$dumper->fill( $message );

		$this->assertSame( "mine\n", $this->read_all( $out ) );
	}

	public function test_set_to_filter_always_renders_empty_TO(): void {
		// Async broadcasts (TM_INFO) typically have empty TO — must render even
		// when filter is active so users see their own session's broadcasts.
		[ $dumper, $out ] = $this->fresh();
		$dumper->set_to_filter( '12345' );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_INFO;
		$message[ Message::FROM ]  = 'broadcaster';
		$message[ Message::TO ]    = '';
		$message[ Message::VALUE ] = 'broadcast';
		$dumper->fill( $message );

		$this->assertSame( "broadcast\n", $this->read_all( $out ) );
	}

	public function test_TM_STRUCT_array_value_json_encodes_for_display(): void {
		// TM_STRUCT signals VALUE is structured — Dumper JSON-encodes for printable
		// output so users don't see "Array".
		[ $dumper, $out ] = $this->fresh();

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_STRUCT;
		$message[ Message::VALUE ] = [ 'a' => 1, 'nested' => [ 'b' => 2 ] ];
		$dumper->fill( $message );

		$rendered = $this->read_all( $out );
		$decoded  = \json_decode( \rtrim( $rendered, "\n" ), true );
		$this->assertSame( [ 'a' => 1, 'nested' => [ 'b' => 2 ] ], $decoded );
	}

	public function test_TM_STRUCT_string_value_renders_as_string_not_double_encoded(): void {
		// Defense: a producer that mistakenly sets TM_STRUCT on a string VALUE
		// should still render plainly rather than wrapping the string in JSON quotes.
		[ $dumper, $out ] = $this->fresh();

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_STRUCT;
		$message[ Message::VALUE ] = 'plain';
		$dumper->fill( $message );

		$this->assertSame( "plain\n", $this->read_all( $out ) );
	}

	public function test_to_filter_drops_foreign_session_traffic(): void {
		// `TO=sse` (the post-_router-peel form of TO=_repl/sse) is foreign
		// traffic to this cli session and gets dropped silently — same as
		// any other TO that doesn't match this session's pid.
		[ $dumper, $out ] = $this->fresh();
		$dumper->set_to_filter( '12345' );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_STRUCT;
		$message[ Message::TO ]    = 'sse';
		$message[ Message::VALUE ] = [ 'rate' => 42.5 ];
		$dumper->fill( $message );

		$this->assertSame( '', $this->read_all( $out ) );
	}

	public function test_debug_level_default_off_no_header_emitted(): void {
		// Baseline: debug_level=0 → no debug header to stderr, only the
		// curated rendering to stdout.
		[ $dumper, $out ] = $this->fresh();
		$this->assertSame( 0, $dumper->debug_level() );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::FROM ]  = 'producer';
		$message[ Message::VALUE ] = 'hello';
		$dumper->fill( $message );

		$this->assertSame( "hello\n", $this->read_all( $out ) );
	}

	public function test_debug_level_1_prepends_header_then_falls_through_to_normal_render(): void {
		// Level 1: emit a one-line `<FLAGS> from <FROM>:` header and FALL
		// THROUGH to the normal type-specific renderer. For TM_BYTESTREAM
		// this means header + plain payload. Mirrors Perl Tachikoma where
		// dump_message prepends and SUPER::fill writes the result.
		[ $dumper, $out ] = $this->fresh();
		$dumper->set_debug_level( 1 );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::FROM ]  = 'producer';
		$message[ Message::VALUE ] = 'hello';
		$dumper->fill( $message );

		$rendered = $this->read_all( $out );
		$this->assertStringContainsString( "TM_BYTESTREAM from producer:\n", $rendered );
		$this->assertStringContainsString( 'hello', $rendered );
		// The payload appears once (via the normal TM_BYTESTREAM renderer,
		// not duplicated by the header itself).
		$this->assertSame( 1, \substr_count( $rendered, 'hello' ) );
	}

	public function test_debug_level_1_unwraps_tm_command_response_payload(): void {
		// TM_COMMAND|TM_RESPONSE's normal renderer decodes the JSON envelope
		// and writes just the inner command `payload` field. Level 1's header
		// rides on top, but the unwrap still happens — the user sees the
		// header + the friendly unwrapped output, NOT the raw JSON envelope.
		[ $dumper, $out ] = $this->fresh();
		$dumper->set_debug_level( 1 );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$message[ Message::FROM ]  = '_command_interpreter';
		$message[ Message::VALUE ] = [
			'name'    => 'ls',
			'payload' => "alpha\nbeta\n",
		];
		$dumper->fill( $message );

		$rendered = $this->read_all( $out );
		$this->assertStringContainsString( "TM_COMMAND | TM_RESPONSE from _command_interpreter:\n", $rendered );
		$this->assertStringContainsString( 'alpha', $rendered );
		$this->assertStringContainsString( 'beta',  $rendered );
		// No raw JSON envelope leakage — the unwrap fired, so the user does
		// NOT see `{"name":"ls"...}`.
		$this->assertStringNotContainsString( '"name":"ls"', $rendered );
		$this->assertStringNotContainsString( '\\n', $rendered );
	}

	public function test_debug_level_2_emits_full_envelope_dump(): void {
		// Level 2: multi-line structural dump with all envelope fields,
		// type flags by name, timestamp humanized. Equivalent to Perl
		// $message->as_string output.
		[ $dumper, $out ] = $this->fresh();
		$dumper->set_debug_level( 2 );

		$message                       = Message::new_message();
		$message[ Message::TYPE ]      = Message::TM_BYTESTREAM;
		$message[ Message::ID ]        = 'abc';
		$message[ Message::FROM ]      = 'producer';
		$message[ Message::TO ]        = 'consumer';
		$message[ Message::TIMESTAMP ] = '1700000000';
		$message[ Message::VALUE ]     = 'hello';
		$dumper->fill( $message );

		$rendered = $this->read_all( $out );
		// Structural shape — labelled fields, indented payload, opens/closes with braces.
		$this->assertStringContainsString( 'Message {', $rendered );
		$this->assertStringContainsString( 'type:      TM_BYTESTREAM',       $rendered );
		$this->assertStringContainsString( 'from:      producer',            $rendered );
		$this->assertStringContainsString( 'to:        consumer',            $rendered );
		$this->assertStringContainsString( 'id:        abc',                 $rendered );
		$this->assertStringContainsString( 'timestamp: 1700000000 (2023-11-14', $rendered );
		$this->assertStringContainsString( 'value:     hello',               $rendered );
		$this->assertStringContainsString( "\n}\n",                          $rendered );
	}

	public function test_debug_level_2_decodes_tm_command_payload(): void {
		// TM_COMMAND payloads are JSON envelopes (`{"name":"ls","payload":...}`).
		// Level 2 should decode and pretty-print so the user sees structure,
		// not a stringified-of-string with backslash-escapes everywhere.
		[ $dumper, $out ] = $this->fresh();
		$dumper->set_debug_level( 2 );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$message[ Message::FROM ]  = '_command_interpreter';
		$message[ Message::VALUE ] = [
			'name'      => 'ls',
			'arguments' => '-al',
			'payload'   => "alpha\nbeta\n",
		];
		$dumper->fill( $message );

		$rendered = $this->read_all( $out );
		$this->assertStringContainsString( 'TM_COMMAND | TM_RESPONSE',     $rendered );
		// Decoded and pretty-printed — keys appear on their own indented lines.
		$this->assertStringContainsString( '"name": "ls"',                 $rendered );
		$this->assertStringContainsString( '"arguments": "-al"',           $rendered );
		// Payload is inside the decoded JSON, not in a separate escaped string.
		$this->assertStringContainsString( '"alpha',                       $rendered );
	}

	public function test_debug_level_clamps_to_0_2_range(): void {
		// Out-of-range arguments clamp instead of raising.
		[ $dumper ] = $this->fresh();

		$this->assertSame( 2, $dumper->set_debug_level( 5 ),  'overshoot clamps high' );
		$this->assertSame( 0, $dumper->set_debug_level( -1 ), 'undershoot clamps low' );
		$this->assertSame( 1, $dumper->set_debug_level( 1 ),  'middle preserved' );
	}

}
