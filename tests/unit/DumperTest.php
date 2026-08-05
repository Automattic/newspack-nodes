<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Core;
use Newspack_Nodes\Dumper_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Node_Names;
use Newspack_Nodes\Shell_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;

#[CoversClass( Dumper_Node::class )]
class DumperTest extends TestCase {

	/** @return array{0:Dumper_Node, 1:Capture_Sink_Node} */
	private function fresh(): array {
		$dumper = new Dumper_Node();
		$cap    = new Capture_Sink_Node();
		$dumper->sink( $cap );
		$dumper->target( Node_Names::STDOUT );
		return [ $dumper, $cap ];
	}

	private function rendered( Capture_Sink_Node $cap ): string {
		$out = '';
		foreach ( $cap->captured as $m ) {
			$text = (string) $m[ Message::VALUE ];
			if ( ! \str_ends_with( $text, "\n" ) ) {
				$text .= "\n";
			}
			$out .= $text;
		}
		return $out;
	}

	public function test_TM_EOF_invokes_on_eof_callback_and_renders_nothing(): void {
		// TM_EOF is the drain marker for the cli's stdin-close round-trip:
		// cli emits TM_EOF, worker bounces it, cli's Dumper sees the echo
		// and fires the registered callback so the cli's run_repl predicate
		// can exit. The Dumper itself prints nothing — TM_EOF is a control
		// marker, not output.
		[ $dumper, $cap ] = $this->fresh();

		$fired = 0;
		$dumper->on_eof( function () use ( &$fired ) { ++$fired; } );

		$message                  = Message::new_message();
		$message[ Message::TYPE ] = Message::TM_EOF;
		$dumper->fill( $message );

		$this->assertSame( 1, $fired, 'on_eof callback should fire once' );
		$this->assertSame( '', $this->rendered( $cap ) );
	}

	/**
	 * The verbosity-2 branch dumped the envelope and returned, so TM_EOF never
	 * reached its callback: after an operator raised verbosity with the
	 * `debug_level` REPL verb, `wp nodes cli` sat until its 5s deadline instead
	 * of exiting on the echo. Default level is 0, so this never bit an operator
	 * who left verbosity alone. Inherited from Tachikoma, which still has it —
	 * a reason, not a justification.
	 *
	 * The level-2 assertion below pins the envelope dump as well as the
	 * callback: hoisting the TM_EOF check ABOVE the verbosity block would fire
	 * the callback and silently stop dumping, which is the obvious wrong fix.
	 */
	public function test_TM_EOF_fires_on_eof_at_every_debug_level(): void {
		foreach ( [ 0, 1, 2 ] as $level ) {
			[ $dumper, $cap ] = $this->fresh();
			$dumper->set_debug_level( $level );

			$fired = 0;
			$dumper->on_eof(
				function () use ( &$fired ) {
					++$fired;
				}
			);

			$message                  = Message::new_message();
			$message[ Message::TYPE ] = Message::TM_EOF;
			$dumper->fill( $message );

			$this->assertSame( 1, $fired, "on_eof must fire at debug_level {$level}" );

			if ( 2 === $level ) {
				$this->assertStringContainsString(
					'TM_EOF',
					$this->rendered( $cap ),
					'debug_level 2 must still dump the TM_EOF envelope'
				);
			}
		}
	}

	public function test_TM_EOF_filtered_out_by_to_filter_does_not_fire_callback(): void {
		// TM_EOF addressed at a different pid (different cli session) is
		// filtered out at the Dumper's to_filter gate — same as any other
		// type. The callback only fires for our own session's echo.
		[ $dumper, $cap ] = $this->fresh();
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
		[ $dumper, $cap ] = $this->fresh();

		Core::$now = 1234567890.5;
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_PING;
		$message[ Message::VALUE ] = '1234567890.0';   // sent 500 ms before "now"
		$dumper->fill( $message );

		$rendered = $this->rendered( $cap );
		$this->assertStringContainsString( 'round trip time:', $rendered );
		$this->assertStringContainsString( '500.00 ms', $rendered );
	}

	public function test_TM_COMMAND_TM_RESPONSE_prints_payload(): void {
		[ $dumper, $cap ] = $this->fresh();

		// Response VALUE rides as a live PHP structure — not a JSON string.
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$message[ Message::VALUE ] = [ 'name' => 'ls', 'payload' => "alice\nbob" ];
		$dumper->fill( $message );

		$this->assertSame( "alice\nbob\n", $this->rendered( $cap ) );
	}

	public function test_TM_COMMAND_TM_RESPONSE_does_not_double_newline(): void {
		[ $dumper, $cap ] = $this->fresh();

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$message[ Message::VALUE ] = [ 'name' => 'ls', 'payload' => "ends-with-newline\n" ];
		$dumper->fill( $message );

		$this->assertSame( "ends-with-newline\n", $this->rendered( $cap ) );
	}

	public function test_TM_COMMAND_TM_RESPONSE_with_name_prompt_updates_shell_prompt(): void {
		[ $dumper, $cap ] = $this->fresh();

		$shell = new Shell_Node();
		$dumper->set_shell( $shell );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$message[ Message::VALUE ] = [ 'name' => 'prompt', 'payload' => 'repl> ' ];
		$dumper->fill( $message );

		$this->assertSame( 'repl> ', $shell->prompt );
		$this->assertSame( '', $this->rendered( $cap ), 'prompt-update must NOT print to stdout' );
	}

	/**
	 * `prompt` is the ONE response that mutates state rather than rendering, so
	 * it is the one worth spoofing: a peer that sets the operator's prompt makes
	 * them believe they are attached somewhere they are not, and type the next
	 * command there. FROM is X-Forwarded-For — the IPC Consumer stamps the
	 * worker id at the HEAD and everything after is whatever the worker wrote,
	 * so only the head may be trusted.
	 */
	public function test_prompt_from_the_attached_worker_is_honored(): void {
		[ $dumper ] = $this->fresh();
		$shell        = new Shell_Node();
		$shell->path  = 'firehose-workers.p0';
		$dumper->set_shell( $shell );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$message[ Message::FROM ]  = 'firehose-workers.p0/_output';
		$message[ Message::VALUE ] = [ 'name' => 'prompt', 'payload' => 'worker> ' ];
		$dumper->fill( $message );

		$this->assertSame( 'worker> ', $shell->prompt );
	}

	public function test_prompt_from_another_origin_is_refused(): void {
		[ $dumper ] = $this->fresh();
		$shell        = new Shell_Node();
		$shell->path  = 'firehose-workers.p0';
		$shell->prompt = 'worker> ';
		$dumper->set_shell( $shell );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$message[ Message::FROM ]  = 'spoke-austin/_output';
		$message[ Message::VALUE ] = [ 'name' => 'prompt', 'payload' => 'combined.p0> ' ];
		$dumper->fill( $message );

		$this->assertSame( 'worker> ', $shell->prompt );
	}

	/** The worker id further down the path is the peer's own text, not our stamp. */
	public function test_prompt_with_the_worker_id_only_in_the_tail_is_refused(): void {
		[ $dumper ] = $this->fresh();
		$shell        = new Shell_Node();
		$shell->path  = 'firehose-workers.p0';
		$shell->prompt = 'worker> ';
		$dumper->set_shell( $shell );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$message[ Message::FROM ]  = 'spoke-austin/firehose-workers.p0';
		$message[ Message::VALUE ] = [ 'name' => 'prompt', 'payload' => 'combined.p0> ' ];
		$dumper->fill( $message );

		$this->assertSame( 'worker> ', $shell->prompt );
	}

	public function test_TM_ERROR_prints_payload_to_stdout_like_any_other_value(): void {
		// A bare TM_ERROR has no dedicated branch — it falls through to the
		// default renderer and goes out via write_async, exactly like a plain
		// TM_BYTESTREAM payload. On a non-TTY that's a plain stdout write; stderr
		// stays untouched.
		[ $dumper, $cap ] = $this->fresh();

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_ERROR;
		$message[ Message::VALUE ] = "NOT_AVAILABLE\n";
		$dumper->fill( $message );

		$this->assertSame( "NOT_AVAILABLE\n", $this->rendered( $cap ) );
	}

	public function test_TM_INFO_prints_payload_without_prefix(): void {
		// TM_INFO renders as a plain async bytestream — same as default
		// TM_BYTESTREAM. The former `INFO[from]: ...` prefix was
		// redundant noise; debug_level 1 already prepends a
		// `TM_INFO from <from>:` header when verbosity is wanted.
		[ $dumper, $cap ] = $this->fresh();

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_INFO;
		$message[ Message::FROM ]  = 'alpha';
		$message[ Message::VALUE ] = 'broadcast text';
		$dumper->fill( $message );

		$this->assertSame( "broadcast text\n", $this->rendered( $cap ) );
	}

	public function test_default_type_prints_VALUE(): void {
		[ $dumper, $cap ] = $this->fresh();

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::VALUE ] = 'plain bytes';
		$dumper->fill( $message );

		$this->assertSame( "plain bytes\n", $this->rendered( $cap ) );
	}

	public function test_TM_COMMAND_TM_RESPONSE_with_non_array_value_falls_through_to_default(): void {
		[ $dumper, $cap ] = $this->fresh();

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		// A bare-string VALUE on a response is malformed (the contract is a
		// `['name'=>,'payload'=>]` array) — fall through to the default
		// branch and print VALUE as-is rather than crash.
		$message[ Message::VALUE ] = 'not-a-struct';
		$dumper->fill( $message );

		$this->assertSame( "not-a-struct\n", $this->rendered( $cap ) );
	}

	public function test_TM_COMMAND_TM_ERROR_with_array_value_prints_payload(): void {
		[ $dumper, $cap ] = $this->fresh();

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_ERROR;
		$message[ Message::VALUE ] = [ 'name' => 'save', 'payload' => 'invalid topology' ];
		$dumper->fill( $message );

		$this->assertSame( "invalid topology\n", $this->rendered( $cap ) );
	}

	public function test_command_response_array_payload_renders_pretty_json(): void {
		[ $dumper, $cap ] = $this->fresh();

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$message[ Message::VALUE ] = [
			'name'    => 'inspect',
			'payload' => [ 'node' => 'alpha', 'ok' => true ],
		];
		$dumper->fill( $message );

		$rendered = $this->rendered( $cap );
		$this->assertStringContainsString( "\"node\": \"alpha\"", $rendered );
		$this->assertStringContainsString( "\"ok\": true", $rendered );
	}

	public function test_default_renderer_coerces_non_string_values_like_php_casts(): void {
		[ $dumper, $cap ] = $this->fresh();

		$object = new class {
			public function __toString(): string {
				return 'stringable-object';
			}
		};

		foreach ( [ null, [ 'x' ], $object, \fopen( 'php://memory', 'r+' ) ] as $value ) {
			$message                   = Message::new_message();
			$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
			$message[ Message::VALUE ] = $value;
			$dumper->fill( $message );
			if ( \is_resource( $value ) ) {
				\fclose( $value );
			}
		}

		$this->assertSame( "\nArray\nstringable-object\n\n", $this->rendered( $cap ) );
	}

	public function test_ping_renderer_coerces_non_scalar_timestamps(): void {
		[ $dumper, $cap ] = $this->fresh();
		Core::$now = 2.0;

		foreach ( [ null, [], [ 'x' ], new \stdClass(), \fopen( 'php://memory', 'r+' ) ] as $value ) {
			$message                   = Message::new_message();
			$message[ Message::TYPE ]  = Message::TM_PING;
			$message[ Message::VALUE ] = $value;
			$dumper->fill( $message );
			if ( \is_resource( $value ) ) {
				\fclose( $value );
			}
		}

		$rendered = $this->rendered( $cap );
		$this->assertSame( 5, \substr_count( $rendered, 'round trip time:' ) );
		$this->assertStringContainsString( '2000.00 ms', $rendered );
		$this->assertStringContainsString( '1000.00 ms', $rendered );
	}

	public function test_type_coercion_accepts_array_object_and_resource_fields(): void {
		[ $dumper, $cap ] = $this->fresh();

		foreach ( [ [], new \stdClass(), \fopen( 'php://memory', 'r+' ) ] as $type ) {
			$message                   = Message::new_message();
			$message[ Message::TYPE ]  = $type;
			$message[ Message::VALUE ] = 'plain';
			$dumper->fill( $message );
			if ( \is_resource( $type ) ) {
				\fclose( $type );
			}
		}

		$this->assertSame( "plain\nplain\nplain\n", $this->rendered( $cap ) );
	}

	public function test_counter_increments_per_fill(): void {
		[ $dumper, $cap ] = $this->fresh();
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_INFO;
		$message[ Message::FROM ]  = 'x';
		$message[ Message::VALUE ] = 'a';

		$dumper->fill( $message );
		$dumper->fill( $message );

		$this->assertSame( 2, $dumper->counter() );
	}

	public function test_render_forwards_bytestream_to_target_clearing_inbound_to(): void {
		[ $dumper, $cap ] = $this->fresh();
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$m[ Message::TO ]    = Node_Names::OUTPUT . '/' . \getmypid();
		$m[ Message::VALUE ] = 'rendered';
		$dumper->fill( $m );
		$this->assertCount( 1, $cap->captured );
		$out = $cap->captured[0];
		$this->assertSame( 'rendered', $out[ Message::VALUE ] );
		$this->assertSame( Node_Names::STDOUT, $out[ Message::TO ] );
	}

	public function test_set_to_filter_drops_messages_with_unmatched_TO(): void {
		// Multi-session: only matching $pid (or empty TO) renders.
		[ $dumper, $cap ] = $this->fresh();
		$dumper->set_to_filter( '12345' );

		// Different cli's reply — must drop silently.
		$other                      = Message::new_message();
		$other[ Message::TYPE ]     = Message::TM_BYTESTREAM;
		$other[ Message::TO ]       = '99999';
		$other[ Message::VALUE ]    = 'not-mine';
		$dumper->fill( $other );

		$this->assertSame( '', $this->rendered( $cap ) );
	}

	public function test_set_to_filter_renders_when_TO_matches_pid(): void {
		[ $dumper, $cap ] = $this->fresh();
		$dumper->set_to_filter( '12345' );

		// Worker reply with _router-peeled prefix → TO=$pid.
		$mine                  = Message::new_message();
		$mine[ Message::TYPE ] = Message::TM_BYTESTREAM;
		$mine[ Message::TO ]   = '12345';
		$mine[ Message::VALUE ] = 'mine';
		$dumper->fill( $mine );

		$this->assertSame( "mine\n", $this->rendered( $cap ) );
	}

	public function test_set_to_filter_renders_with_unpeeled_output_prefix(): void {
		// The other shape: TO=_output/$pid (worker reply with _output not yet peeled).
		[ $dumper, $cap ] = $this->fresh();
		$dumper->set_to_filter( '12345' );

		$message                  = Message::new_message();
		$message[ Message::TYPE ] = Message::TM_BYTESTREAM;
		$message[ Message::TO ]   = '_output/12345';
		$message[ Message::VALUE ] = 'mine';
		$dumper->fill( $message );

		$this->assertSame( "mine\n", $this->rendered( $cap ) );
	}

	public function test_set_to_filter_always_renders_empty_TO(): void {
		// Async broadcasts (TM_INFO) typically have empty TO — must render even
		// when filter is active so users see their own session's broadcasts.
		[ $dumper, $cap ] = $this->fresh();
		$dumper->set_to_filter( '12345' );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_INFO;
		$message[ Message::FROM ]  = 'broadcaster';
		$message[ Message::TO ]    = '';
		$message[ Message::VALUE ] = 'broadcast';
		$dumper->fill( $message );

		$this->assertSame( "broadcast\n", $this->rendered( $cap ) );
	}

	public function test_TM_STRUCT_array_value_json_encodes_for_display(): void {
		// TM_STRUCT signals VALUE is structured — Dumper JSON-encodes for printable
		// output so users don't see "Array".
		[ $dumper, $cap ] = $this->fresh();

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_STRUCT;
		$message[ Message::VALUE ] = [ 'a' => 1, 'nested' => [ 'b' => 2 ] ];
		$dumper->fill( $message );

		$rendered = $this->rendered( $cap );
		$decoded  = \json_decode( \rtrim( $rendered, "\n" ), true );
		$this->assertSame( [ 'a' => 1, 'nested' => [ 'b' => 2 ] ], $decoded );
	}

	public function test_TM_STRUCT_string_value_renders_as_string_not_double_encoded(): void {
		// Defense: a producer that mistakenly sets TM_STRUCT on a string VALUE
		// should still render plainly rather than wrapping the string in JSON quotes.
		[ $dumper, $cap ] = $this->fresh();

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_STRUCT;
		$message[ Message::VALUE ] = 'plain';
		$dumper->fill( $message );

		$this->assertSame( "plain\n", $this->rendered( $cap ) );
	}

	public function test_to_filter_drops_foreign_session_traffic(): void {
		// `TO=sse` (the post-_router-peel form of TO=_repl/sse) is foreign
		// traffic to this cli session and gets dropped silently — same as
		// any other TO that doesn't match this session's pid.
		[ $dumper, $cap ] = $this->fresh();
		$dumper->set_to_filter( '12345' );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_STRUCT;
		$message[ Message::TO ]    = 'sse';
		$message[ Message::VALUE ] = [ 'rate' => 42.5 ];
		$dumper->fill( $message );

		$this->assertSame( '', $this->rendered( $cap ) );
	}

	public function test_debug_level_default_off_no_header_emitted(): void {
		// Baseline: debug_level=0 → no debug header to stderr, only the
		// curated rendering to stdout.
		[ $dumper, $cap ] = $this->fresh();
		$this->assertSame( 0, $dumper->debug_level() );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::FROM ]  = 'producer';
		$message[ Message::VALUE ] = 'hello';
		$dumper->fill( $message );

		$this->assertSame( "hello\n", $this->rendered( $cap ) );
	}

	public function test_debug_level_1_prepends_header_then_falls_through_to_normal_render(): void {
		// Level 1: emit a one-line `<FLAGS> from <FROM>:` header and FALL
		// THROUGH to the normal type-specific renderer. For TM_BYTESTREAM
		// this means header + plain payload. Mirrors Perl Tachikoma where
		// dump_message prepends and SUPER::fill writes the result.
		[ $dumper, $cap ] = $this->fresh();
		$dumper->set_debug_level( 1 );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::FROM ]  = 'producer';
		$message[ Message::VALUE ] = 'hello';
		$dumper->fill( $message );

		$rendered = $this->rendered( $cap );
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
		[ $dumper, $cap ] = $this->fresh();
		$dumper->set_debug_level( 1 );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$message[ Message::FROM ]  = '_command_interpreter';
		$message[ Message::VALUE ] = [
			'name'    => 'ls',
			'payload' => "alpha\nbeta\n",
		];
		$dumper->fill( $message );

		$rendered = $this->rendered( $cap );
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
		[ $dumper, $cap ] = $this->fresh();
		$dumper->set_debug_level( 2 );

		$message                       = Message::new_message();
		$message[ Message::TYPE ]      = Message::TM_BYTESTREAM;
		$message[ Message::ID ]        = 'abc';
		$message[ Message::FROM ]      = 'producer';
		$message[ Message::TO ]        = 'consumer';
		$message[ Message::TIMESTAMP ] = '1700000000';
		$message[ Message::VALUE ]     = 'hello';
		$dumper->fill( $message );

		$rendered = $this->rendered( $cap );
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

	public function test_debug_level_2_trims_trailing_newline_before_closing_brace(): void {
		// A VALUE ending in a newline used to render a blank (indented) line
		// wedged before `}`. Trim it so exactly one newline separates them.
		[ $dumper, $cap ] = $this->fresh();
		$dumper->set_debug_level( 2 );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::VALUE ] = "SEGMENT 1\n";
		$dumper->fill( $message );

		$rendered = $this->rendered( $cap );
		$this->assertStringContainsString( "value:     SEGMENT 1\n}", $rendered );
		// No blank / whitespace-only line wedged before the closing brace.
		$this->assertDoesNotMatchRegularExpression( "/\n[ \t]*\n\}/", $rendered );
	}

	public function test_debug_level_2_decodes_tm_command_payload(): void {
		// TM_COMMAND payloads are JSON envelopes (`{"name":"ls","payload":...}`).
		// Level 2 should decode and pretty-print so the user sees structure,
		// not a stringified-of-string with backslash-escapes everywhere.
		[ $dumper, $cap ] = $this->fresh();
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

		$rendered = $this->rendered( $cap );
		$this->assertStringContainsString( 'TM_COMMAND | TM_RESPONSE',     $rendered );
		// Decoded and pretty-printed — keys appear on their own indented lines.
		$this->assertStringContainsString( '"name": "ls"',                 $rendered );
		$this->assertStringContainsString( '"arguments": "-al"',           $rendered );
		// Payload is inside the decoded JSON, not in a separate escaped string.
		$this->assertStringContainsString( '"alpha',                       $rendered );
	}

	public function test_debug_level_2_decodes_json_string_value_and_skips_timestamp_humanizing_when_non_numeric(): void {
		[ $dumper, $cap ] = $this->fresh();
		$dumper->set_debug_level( 2 );

		$message                       = Message::new_message();
		$message[ Message::TYPE ]      = Message::TM_BYTESTREAM;
		$message[ Message::TIMESTAMP ] = 'not-a-timestamp';
		$message[ Message::VALUE ]     = '{"alpha":1,"items":["a","b"]}';
		$dumper->fill( $message );

		$rendered = $this->rendered( $cap );
		$this->assertStringContainsString( 'timestamp: not-a-timestamp', $rendered );
		$this->assertStringNotContainsString( 'UTC', $rendered );
		$this->assertStringContainsString( "\"alpha\": 1", $rendered );
		$this->assertStringContainsString( "\"items\": [", $rendered );
	}

	public function test_debug_level_clamps_to_0_2_range(): void {
		// Out-of-range arguments clamp instead of raising.
		[ $dumper ] = $this->fresh();

		$this->assertSame( 2, $dumper->set_debug_level( 5 ),  'overshoot clamps high' );
		$this->assertSame( 0, $dumper->set_debug_level( -1 ), 'undershoot clamps low' );
		$this->assertSame( 1, $dumper->set_debug_level( 1 ),  'middle preserved' );
	}

	public function test_node_schema_is_a_placeable_transform(): void {
		// The Dumper renders a message to human-readable text — the lossy display
		// counterpart to the lossless Struct_To_JSON / JSON_To_Struct pair. It
		// belongs in the palette's Transform group, not Hidden.
		$schema = \Newspack_Nodes\Dumper_Node::node_schema();
		$this->assertSame( 'Transform', $schema['category'] );
	}

}
