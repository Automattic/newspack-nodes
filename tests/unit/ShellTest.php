<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Shell_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Shell_Node::class )]
class ShellTest extends TestCase {

	public function test_tokenize_plain_words(): void {
		$shell = new Shell_Node();
		$this->assertSame( [ 'tell', 'foo', 'bar' ], $shell->tokenize( 'tell foo bar' ) );
	}

	public function test_tokenize_collapses_repeated_whitespace(): void {
		$shell = new Shell_Node();
		$this->assertSame( [ 'a', 'b', 'c' ], $shell->tokenize( "a   b\tc" ) );
	}

	public function test_tokenize_double_quoted_string_is_one_token(): void {
		$shell = new Shell_Node();
		$this->assertSame( [ 'send', 'node', 'hello world' ], $shell->tokenize( 'send node "hello world"' ) );
	}

	public function test_tokenize_single_quoted_string_is_one_token(): void {
		$shell = new Shell_Node();
		$this->assertSame( [ 'send', "two words" ], $shell->tokenize( "send 'two words'" ) );
	}

	public function test_tokenize_backtick_quoted_string_is_one_token(): void {
		$shell = new Shell_Node();
		$this->assertSame( [ 'cmd', 'literal $foo' ], $shell->tokenize( 'cmd `literal $foo`' ) );
	}

	public function test_tokenize_empty_quoted_string_is_a_token(): void {
		$shell = new Shell_Node();
		$this->assertSame( [ 'send', '', 'after' ], $shell->tokenize( "send '' after" ) );
	}

	public function test_interpolate_replaces_known_variable(): void {
		$shell = new Shell_Node();
		\Newspack_Nodes\Core::$var[ 'name' ] = 'alice';
		$this->assertSame( 'tell alice hello', $shell->interpolate( 'tell <name> hello' ) );
	}

	public function test_interpolate_unknown_variable_yields_empty(): void {
		$shell = new Shell_Node();
		$this->assertSame( 'tell  hello', $shell->interpolate( 'tell <ghost> hello' ) );
	}

	public function test_var_command_accepts_name_equals_value_without_spaces(): void {
		$shell = new Shell_Node();
		$this->assertNull( $shell->parse( 'var spam=eggs' ) );
		$this->assertSame( 'eggs', $shell->interpolate( '<spam>' ) );
	}

	public function test_var_command_accepts_spaced_form_with_multiword_value(): void {
		$shell = new Shell_Node();
		$this->assertNull( $shell->parse( 'var greeting = hello there' ) );
		$this->assertSame( 'hello there', $shell->interpolate( '<greeting>' ) );
	}

	public function test_interpolate_does_not_expand_inside_single_quotes(): void {
		$shell = new Shell_Node();
		\Newspack_Nodes\Core::$var[ 'who' ] = 'alice';
		// Single quotes are literal — the token survives for a downstream node (e.g. Topic) to bind.
		$this->assertSame( "echo '<who>'", $shell->interpolate( "echo '<who>'" ) );
	}

	public function test_interpolate_does_not_expand_inside_backticks(): void {
		$shell = new Shell_Node();
		\Newspack_Nodes\Core::$var[ 'who' ] = 'alice';
		$this->assertSame( 'echo `<who>`', $shell->interpolate( 'echo `<who>`' ) );
	}

	public function test_interpolate_still_expands_inside_double_quotes(): void {
		$shell = new Shell_Node();
		\Newspack_Nodes\Core::$var[ 'who' ] = 'alice';
		$this->assertSame( 'echo "alice"', $shell->interpolate( 'echo "<who>"' ) );
	}

	public function test_interpolate_mixed_quoting_expands_unquoted_defers_single_quoted(): void {
		$shell = new Shell_Node();
		\Newspack_Nodes\Core::$var[ 'base' ] = '/logs';
		// The Topic-template idiom: <base> expands now; the single-quoted <partition>
		// is deferred (quote chars survive interpolation, stripped later by tokenize).
		$this->assertSame( "/logs/jobs.p'<partition>'", $shell->interpolate( "<base>/jobs.p'<partition>'" ) );
		// End-to-end: after tokenize strips the quotes, the deferred token stands literal.
		$this->assertSame( [ '/logs/jobs.p<partition>' ], $shell->tokenize( $shell->interpolate( "<base>/jobs.p'<partition>'" ) ) );
	}

	public function test_parse_tell_yields_TM_INFO(): void {
		$shell = new Shell_Node();
		$message = $shell->parse( 'tell node msg');

		$this->assertNotNull( $message );
		$this->assertSame( Message::TM_INFO, $message[ Message::TYPE ] );
		$this->assertSame( 'node', $message[ Message::TO ] );
		$this->assertSame( 'msg', $message[ Message::VALUE ] );
	}

	public function test_parse_send_yields_TM_BYTESTREAM(): void {
		$shell = new Shell_Node();
		$message = $shell->parse( 'send node bytes');

		$this->assertSame( Message::TM_BYTESTREAM, $message[ Message::TYPE ] );
		$this->assertSame( 'node', $message[ Message::TO ] );
		$this->assertSame( "bytes\n", $message[ Message::VALUE ] );
	}

	public function test_parse_send_struct_yields_TM_STRUCT_with_decoded_value(): void {
		// JSON is single-quoted so the tokenizer keeps the inner double-quotes
		// as one token (mirrors Tachikoma's `send_hash <path> '<json>'`).
		$shell = new Shell_Node();
		$message = $shell->parse( "send_struct node '{\"foo\":23,\"bar\":42}'" );

		$this->assertNotNull( $message );
		$this->assertSame( Message::TM_STRUCT, $message[ Message::TYPE ] );
		$this->assertSame( 'node', $message[ Message::TO ] );
		$this->assertSame( [ 'foo' => 23, 'bar' => 42 ], $message[ Message::VALUE ] );
	}

	public function test_parse_send_struct_accepts_single_quoted_json_with_spaces(): void {
		$shell = new Shell_Node();
		$message = $shell->parse( "send_struct node '{ \"foo\": 23, \"bar\": 42 }'" );

		$this->assertSame( Message::TM_STRUCT, $message[ Message::TYPE ] );
		$this->assertSame( [ 'foo' => 23, 'bar' => 42 ], $message[ Message::VALUE ] );
	}

	public function test_parse_send_struct_invalid_json_reports_error_and_sends_nothing(): void {
		$capture = $this->register_output_capture();
		$shell   = new Shell_Node();

		$this->assertNull( $shell->parse( "send_struct node '{bad json}'" ), 'Invalid JSON must not produce a message.' );
		$this->assertStringContainsString( 'send_struct', $capture->captured[0][ Message::VALUE ] );
	}

	public function test_parse_send_eof_yields_TM_EOF(): void {
		$shell = new Shell_Node();
		$message = $shell->parse( 'send_eof node');

		$this->assertSame( Message::TM_EOF, $message[ Message::TYPE ] );
		$this->assertSame( 'node', $message[ Message::TO ] );
	}

	public function test_parse_ping_yields_TM_PING_with_timestamp_payload(): void {
		// Tachikoma Shell3 ping builtin: build TM_PING addressed at the path,
		// payload = current timestamp; receiver's interpreter bounces TO=FROM.
		\Newspack_Nodes\Core::$now = 1234567890.123456;
		$shell = new Shell_Node();
		$message = $shell->parse( 'ping _command_interpreter');

		$this->assertNotNull( $message );
		$this->assertSame( Message::TM_PING, $message[ Message::TYPE ] );
		$this->assertSame( '_command_interpreter', $message[ Message::TO ] );
		$this->assertSame( '1234567890.1235', $message[ Message::VALUE ] );
		$this->assertStringStartsWith( '_output/', $message[ Message::FROM ] );
	}

	public function test_parse_default_verb_yields_TM_COMMAND(): void {
		$shell = new Shell_Node();
		$message = $shell->parse( 'ls');

		$this->assertSame( Message::TM_COMMAND, $message[ Message::TYPE ] );
		// VALUE rides as a live PHP array — no JSON string to decode.
		$cmd = $message[ Message::VALUE ];
		$this->assertSame( 'ls', $cmd['name'] );
		$this->assertSame( '', $cmd['arguments'] );
	}

	public function test_want_reply_false_stamps_noreply_on_parsed_commands(): void {
		// A Shell with want_reply off (topology-load / script mode) marks commands
		// TM_NOREPLY so the interpreter suppresses their replies — no console to
		// reply to at boot. Mirrors Tachikoma Shell::send_command's want_reply gate.
		$shell = new Shell_Node();
		$shell->want_reply( false );
		$message = $shell->parse( 'make_node Capture_Sink alice' );
		$this->assertSame( Message::TM_NOREPLY, $message[ Message::TYPE ] & Message::TM_NOREPLY );
		$this->assertSame( Message::TM_COMMAND, $message[ Message::TYPE ] & Message::TM_COMMAND );
	}

	public function test_want_reply_false_does_not_stamp_noreply_on_non_commands(): void {
		// Only commands get the gate; a ping still expects its bounce.
		$shell = new Shell_Node();
		$shell->want_reply( false );
		$message = $shell->parse( 'ping _command_interpreter' );
		$this->assertSame( 0, $message[ Message::TYPE ] & Message::TM_NOREPLY );
	}

	public function test_parse_default_verb_with_args(): void {
		$shell = new Shell_Node();
		$message = $shell->parse( 'make_node Capture_Sink alice');

		$cmd = $message[ Message::VALUE ];
		$this->assertSame( 'make_node', $cmd['name'] );
		$this->assertSame( 'Capture_Sink alice', $cmd['arguments'] );
	}

	/**
	 * Builtins route output through `Core::node('_output')` when it is a
	 * Dumper. Capture_Sink_Node extends Dumper_Node, so registering one as
	 * `_output` captures each emitted bytestream Message for assertion.
	 */
	private function register_output_capture(): Capture_Sink_Node {
		$capture = new Capture_Sink_Node();
		$capture->name( '_output' );
		return $capture;
	}

	public function test_parse_status_writes_status_lines_to_output_returns_null(): void {
		// `status` is a local-only builtin: it routes the shell's pre-populated
		// $status_lines through the `_output` Dumper and returns null (no command
		// sent to the worker). This is how attached-cli prints "Attached-cli mode
		// for X" + IPC paths on demand instead of auto-printing them at startup.
		$capture              = $this->register_output_capture();
		$shell                = new Shell_Node();
		$shell->status_lines  = [
			'Attached-cli mode for firehose-workers.p0',
			'  input  partition: /tmp/in',
			'  output partition: /tmp/out',
		];

		$this->assertNull( $shell->parse( 'status' ) );

		$this->assertSame(
			[
				"Attached-cli mode for firehose-workers.p0\n",
				"  input  partition: /tmp/in\n",
				"  output partition: /tmp/out\n",
			],
			\array_column( $capture->captured, Message::VALUE )
		);
	}

	public function test_parse_debug_level_no_args_toggles_dumper_state(): void {
		// `debug_level` with no args toggles between 0 and 1.
		$capture = $this->register_output_capture();
		$this->assertSame( 0, $capture->debug_level(), 'default off' );

		$shell = new Shell_Node();

		$this->assertNull( $shell->parse( 'debug_level' ) );
		$this->assertSame( 1, $capture->debug_level(), 'toggle 0→1' );
		$this->assertSame( "debug_level: 1\n", $capture->captured[0][ Message::VALUE ] );

		$this->assertNull( $shell->parse( 'debug_level' ) );
		$this->assertSame( 0, $capture->debug_level(), 'toggle back 1→0' );
	}

	public function test_parse_debug_level_with_explicit_argument_sets(): void {
		// `debug_level 2` explicitly sets to 2 (max).
		$capture = $this->register_output_capture();

		$shell = new Shell_Node();

		$this->assertNull( $shell->parse( 'debug_level 2' ) );
		$this->assertSame( 2, $capture->debug_level() );
		$this->assertSame( "debug_level: 2\n", $capture->captured[0][ Message::VALUE ] );
	}

	public function test_parse_show_parse_toggles_and_dumps_tokens(): void {
		// `show_parse` is a Shell-local toggle. When on, every parse() routes the
		// post-interpolation line + tokens through the `_output` Dumper BEFORE the
		// actual command dispatches.
		$capture = $this->register_output_capture();
		$shell   = new Shell_Node();

		$this->assertNull( $shell->parse( 'show_parse' ) );
		$this->assertSame( "show_parse: on\n", $capture->captured[0][ Message::VALUE ] );

		// Now a real command should emit parse> diagnostics before the message.
		$message= $shell->parse( 'tell some/path hello' );
		$this->assertIsArray( $message, 'should still build a Message' );
		$dump = $capture->captured[1][ Message::VALUE ];

		$this->assertStringContainsString( 'parse> line: tell some/path hello', $dump );
		$this->assertStringContainsString( 'parse> tokens: ', $dump );
		$this->assertStringContainsString( '"tell"', $dump );
	}

	public function test_parse_status_with_no_status_lines_writes_nothing(): void {
		// Empty $status_lines (e.g. shell wasn't configured by the cli) →
		// status is a no-op; no garbage output, no errors.
		$capture = $this->register_output_capture();
		$shell   = new Shell_Node();

		$this->assertNull( $shell->parse( 'status' ) );

		$this->assertCount( 0, $capture->captured );
	}

	public function test_parse_control_flow_verbs_flow_through_as_commands(): void {
		// No special "forbidden verb" list: control-flow keywords are just unknown
		// verbs that parse to a TM_COMMAND and flow through — the target
		// CommandInterpreter answers `unknown command: <verb>`.
		$shell = new Shell_Node();
		foreach ( [ 'eval foo', 'if true', 'while x', 'for x', 'func name' ] as $line ) {
			$message = $shell->parse( $line );
			$this->assertIsArray( $message, "'$line' should parse to a Message" );
			$this->assertSame(
				Message::TM_COMMAND,
				$message[ Message::TYPE ] & Message::TM_COMMAND
			);
		}
	}

	public function test_parse_empty_or_comment_returns_null(): void {
		$shell = new Shell_Node();
		$this->assertNull( $shell->parse( '') );
		$this->assertNull( $shell->parse( '   ') );
		$this->assertNull( $shell->parse( '# a comment') );
	}

	public function test_parse_with_interpolation(): void {
		$shell = new Shell_Node();
		\Newspack_Nodes\Core::$var[ 'who' ] = 'bob';

		$message = $shell->parse( 'tell <who> hi');
		$this->assertSame( 'bob', $message[ Message::TO ] );
		$this->assertSame( 'hi', $message[ Message::VALUE ] );
	}

	public function test_backslash_continuation_yields_null_until_terminating_line(): void {
		$shell = new Shell_Node();
		// First line ends with '\' → continuation.
		$message1 = $shell->parse( 'tell node "hello\\');
		$this->assertNull( $message1, 'backslash continuation must defer message emission' );

		$message2 = $shell->parse( ' world"');
		$this->assertNotNull( $message2 );
		$this->assertSame( Message::TM_INFO, $message2[ Message::TYPE ] );
	}

	public function test_fill_parses_bytestream_and_forwards_command_to_sink(): void {
		// fill() is the bytestream entry point (mirrors Tachikoma Shell::fill,
		// which splits payload into lines and parse_line's each). A raw 'ls'
		// line parses to a TM_COMMAND that lands on the sink — it is NOT
		// re-filled, so it cannot be double-parsed.
		$shell = new Shell_Node();
		$sink  = new Capture_Sink_Node();
		$shell->sink( $sink );

		$message               = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::VALUE ] = 'ls';
		$shell->fill( $message );

		$this->assertCount( 1, $sink->captured );
		$this->assertSame( 'ls', $sink->captured[0][ Message::VALUE ]['name'] );
	}

	public function test_fill_send_verb_emits_bytestream_payload_without_reparsing(): void {
		// Regression: `send <node> <data>` parses to a TM_BYTESTREAM whose VALUE
		// is the payload. That bytestream must reach the SINK as-is — it must NOT
		// be re-filled into the Shell (which would re-parse the payload as a fresh
		// command line, turning `send _output test` into `unknown command: test`).
		$shell = new Shell_Node();
		$sink  = new Capture_Sink_Node();
		$shell->sink( $sink );

		$message               = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::VALUE ] = 'send _output test';
		$shell->fill( $message );

		$this->assertCount( 1, $sink->captured );
		$out = $sink->captured[0];
		$this->assertSame( Message::TM_BYTESTREAM, $out[ Message::TYPE ], 'send emits a bytestream, not a re-parsed command' );
		$this->assertSame( '_output', $out[ Message::TO ] );
		$this->assertStringContainsString( 'test', (string) $out[ Message::VALUE ] );
	}

	public function test_fill_throws_on_non_bytestream_non_eof_message(): void {
		// fill() only accepts bytestream input + TM_EOF (mirrors Tachikoma's
		// _stdin → _responder, which only ever feeds those two). A stray
		// command/info/error is a wiring mistake, surfaced rather than sprayed
		// through the graph.
		$shell = new Shell_Node();
		$shell->sink( new Capture_Sink_Node() );

		$message              = Message::new_message();
		$message[ Message::TYPE ] = Message::TM_COMMAND;

		$this->expectException( \RuntimeException::class );
		$shell->fill( $message );
	}

	public function test_fill_tm_eof_restamps_from_to_session_identity_and_forwards(): void {
		// On TM_EOF the Shell stamps FROM to its own `_output/$pid` reply
		// identity (the PHP analog of Tachikoma's _stdin → _responder rewrite)
		// and TO to its cwd path, then forwards to the sink for the drain
		// round-trip.
		$shell       = new Shell_Node();
		$shell->path = 'firehose-workers.p0';
		$sink        = new Capture_Sink_Node();
		$shell->sink( $sink );

		$message              = Message::new_message();
		$message[ Message::TYPE ] = Message::TM_EOF;
		$message[ Message::FROM ] = 'upstream';
		$shell->fill( $message );

		$this->assertCount( 1, $sink->captured );
		$out = $sink->captured[0];
		$this->assertSame( Message::TM_EOF, $out[ Message::TYPE ] );
		$this->assertSame( '_output/' . \getmypid(), $out[ Message::FROM ] );
		$this->assertSame( 'firehose-workers.p0', $out[ Message::TO ] );
	}

	public function test_include_file_processes_each_line(): void {
		$dir  = $this->make_temp_dir();
		$file = "$dir/script.tsl";
		\file_put_contents( $file, "tell alpha first\ntell beta second\n# comment\n" );

		// include is processed inline; each parsed line goes through fill() → sink.
		$shell = new Shell_Node();
		$sink  = new Capture_Sink_Node();
		$shell->sink( $sink );

		$result = $shell->parse( "include $file" );
		$this->assertNull( $result, 'include returns null (handled inline)' );
		$this->assertCount( 2, $sink->captured, 'include should fire two TM_INFOs' );
		$this->assertSame( 'alpha', $sink->captured[0][ Message::TO ] );
		$this->assertSame( 'beta', $sink->captured[1][ Message::TO ] );
	}

	public function test_include_missing_file_is_silent_warning(): void {
		$shell = new Shell_Node();
		$this->assertNull(
			$shell->parse( 'include /no/such/file'),
			'missing include must not throw — only warn'
		);
	}

	// ── FROM=$pid stamping (multi-session contention) ───────────────────────────

	public function test_parse_from_is_pid(): void {
		// Shell stamps FROM=`_output/$pid` so replies route uniformly in
		// both bare and attached modes (interpreter's response uses TO=$message->from,
		// _router peels _output, _output dispatches by ID through the
		// shell-callback registry). In attached mode the worker's input-Consumer
		// prepends stamp_as=_repl, so server-side FROM=_repl/_output/$pid;
		// the worker's _router peels _repl, the _repl Partition writes to disk
		// with TO=_output/$pid, and the cli's reply-in Consumer reads it
		// where Dumper's regex filter (`(?:_output/)?$pid`) matches.
		// Multi-session: other clis' replies use a different $pid → drop.
		$shell = new Shell_Node();
		$message = $shell->parse( 'ls');

		$this->assertNotNull( $message );
		$this->assertSame( '_output/' . \getmypid(), $message[ Message::FROM ] );
	}

	public function test_parse_from_is_pid_for_tell(): void {
		$shell = new Shell_Node();
		$message = $shell->parse( 'tell node msg');
		$this->assertSame( '_output/' . \getmypid(), $message[ Message::FROM ] );
	}

	public function test_parse_from_is_pid_for_send(): void {
		$shell = new Shell_Node();
		$message = $shell->parse( 'send node bytes');
		$this->assertSame( '_output/' . \getmypid(), $message[ Message::FROM ] );
	}

	public function test_parse_from_is_pid_for_send_eof(): void {
		$shell = new Shell_Node();
		$message = $shell->parse( 'send_eof node');
		$this->assertSame( '_output/' . \getmypid(), $message[ Message::FROM ] );
	}

	public function test_parse_from_is_stable_within_a_process(): void {
		// All messages from a single Shell instance must carry the same FROM.
		$shell = new Shell_Node();
		$m1    = $shell->parse( 'ls');
		$m2    = $shell->parse( 'tell node hi');
		$m3    = $shell->parse( 'send node bytes');

		$this->assertSame( $m1[ Message::FROM ], $m2[ Message::FROM ] );
		$this->assertSame( $m2[ Message::FROM ], $m3[ Message::FROM ] );
	}

	// ── name (refusal) ─────────────────────────────────────────────────────

	public function test_name_refuses_to_register_under_a_name(): void {
		$shell = new Shell_Node();
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessageMatches( '/named Shell nodes are not allowed/' );
		$shell->name( 'attempted-name' );
	}

	public function test_name_returns_empty_string_when_not_set(): void {
		// Shells stay anonymous so they don't appear in `ls` or get addressed
		// via TO. Calling name() with no arg returns the unset value.
		$shell = new Shell_Node();
		$this->assertSame( '', $shell->name() );
	}

	// ── cd / chdir builtin ─────────────────────────────────────────────────

	public function test_cd_absolute_path_replaces_cwd(): void {
		// `cd /foo/bar` resolves to "foo/bar" (leading slash stripped).
		$shell = new Shell_Node();
		$shell->path = 'old/cwd';
		$this->assertNull( $shell->parse( 'cd /firehose-workers.p0' ) );
		$this->assertSame( 'firehose-workers.p0', $shell->path );
	}

	public function test_cd_relative_path_appends_to_cwd(): void {
		$shell       = new Shell_Node();
		$shell->path = 'jobs:partition';
		$shell->parse( 'cd subnode' );
		$this->assertSame( 'jobs:partition/subnode', $shell->path );
	}

	public function test_cd_dotdot_walks_up_one_segment(): void {
		$shell       = new Shell_Node();
		$shell->path = 'a/b/c';
		$shell->parse( 'cd ..' );
		$this->assertSame( 'a/b', $shell->path );
	}

	public function test_cd_dotdot_chain_walks_up_multiple_segments(): void {
		// `../../foo` walks up two segments then descends.
		$shell       = new Shell_Node();
		$shell->path = 'a/b/c';
		$shell->parse( 'cd ../../foo' );
		$this->assertSame( 'a/foo', $shell->path );
	}

	public function test_cd_with_no_arg_keeps_cwd(): void {
		// Empty path is a no-op (Tachikoma Shell.pm semantics) — `cd` alone
		// is "redraw prompt"; use `cd /` to reset.
		$shell       = new Shell_Node();
		$shell->path = 'somewhere/deep';
		$shell->parse( 'cd' );
		$this->assertSame( 'somewhere/deep', $shell->path );
	}

	public function test_cd_slash_resets_to_root(): void {
		// `cd /` returns to the local interpreter (cwd='').
		$shell       = new Shell_Node();
		$shell->path = 'somewhere/deep';
		$shell->parse( 'cd /' );
		$this->assertSame( '', $shell->path );
	}

	public function test_chdir_alias_acts_like_cd(): void {
		$shell = new Shell_Node();
		$shell->parse( 'chdir /target' );
		$this->assertSame( 'target', $shell->path );
	}

	// ── prefix() composition ───────────────────────────────────────────────

	public function test_prefix_with_empty_path_and_arg_returns_empty(): void {
		$shell = new Shell_Node();
		$this->assertSame( '', $shell->prefix( '' ) );
	}

	public function test_prefix_with_path_only_returns_path(): void {
		$shell       = new Shell_Node();
		$shell->path = 'firehose-workers.p0';
		$this->assertSame( 'firehose-workers.p0', $shell->prefix( '' ) );
	}

	public function test_prefix_with_arg_only_returns_arg(): void {
		$shell = new Shell_Node();
		$this->assertSame( 'node', $shell->prefix( 'node' ) );
	}

	public function test_prefix_combines_path_and_arg_with_slash(): void {
		$shell       = new Shell_Node();
		$shell->path = 'firehose-workers.p0';
		$this->assertSame( 'firehose-workers.p0/firehose:tee', $shell->prefix( 'firehose:tee' ) );
	}

	// ── default-verb routing uses cwd ──────────────────────────────────────

	public function test_default_verb_uses_cwd_as_TO(): void {
		// After `cd firehose-workers.p0`, an unbuiltin verb like `ls` should
		// emit TM_COMMAND with TO=firehose-workers.p0 so the worker's interpreter
		// (not the local one) handles it.
		$shell       = new Shell_Node();
		$shell->path = 'firehose-workers.p0';
		$message     = $shell->parse( 'ls -al' );
		$this->assertSame( 'firehose-workers.p0', $message[ Message::TO ] );
		$decoded = $message[ Message::VALUE ];
		$this->assertSame( 'ls', $decoded['name'] );
		$this->assertSame( '-al', $decoded['arguments'] );
	}

	// ── new verbs: tell_node / send_node / command_node / request_node ────

	public function test_tell_node_canonical_emits_TM_INFO_at_prefix(): void {
		$shell       = new Shell_Node();
		$shell->path = 'cwd';
		$message     = $shell->parse( 'tell_node target hello world' );
		$this->assertSame( Message::TM_INFO, $message[ Message::TYPE ] );
		$this->assertSame( 'cwd/target', $message[ Message::TO ] );
		$this->assertSame( 'hello world', $message[ Message::VALUE ] );
	}

	public function test_send_node_canonical_emits_TM_BYTESTREAM_at_prefix_with_lf_terminator(): void {
		$shell       = new Shell_Node();
		$shell->path = 'cwd';
		$message     = $shell->parse( 'send_node target hello world' );
		$this->assertSame( Message::TM_BYTESTREAM, $message[ Message::TYPE ] );
		$this->assertSame( 'cwd/target', $message[ Message::TO ] );
		$this->assertSame( "hello world\n", $message[ Message::VALUE ] );
	}

	public function test_send_alias_works_like_send_node(): void {
		$shell   = new Shell_Node();
		$message = $shell->parse( 'send target payload' );
		$this->assertSame( Message::TM_BYTESTREAM, $message[ Message::TYPE ] );
		$this->assertSame( 'target', $message[ Message::TO ] );
		$this->assertSame( "payload\n", $message[ Message::VALUE ] );
	}

	public function test_command_node_canonical_emits_TM_COMMAND_at_prefix(): void {
		$shell       = new Shell_Node();
		$shell->path = 'jobs:partition';
		$message     = $shell->parse( 'command_node helper-node ls -al' );
		$this->assertSame( Message::TM_COMMAND, $message[ Message::TYPE ] );
		$this->assertSame( 'jobs:partition/helper-node', $message[ Message::TO ] );
		$decoded = $message[ Message::VALUE ];
		$this->assertSame( 'ls', $decoded['name'] );
		$this->assertSame( '-al', $decoded['arguments'] );
	}

	public function test_command_alias_works_like_command_node(): void {
		$shell   = new Shell_Node();
		$message = $shell->parse( 'command target ping' );
		$this->assertSame( Message::TM_COMMAND, $message[ Message::TYPE ] );
		$this->assertSame( 'target', $message[ Message::TO ] );
	}

	public function test_cmd_alias_works_like_command_node(): void {
		$shell   = new Shell_Node();
		$message = $shell->parse( 'cmd target ping' );
		$this->assertSame( Message::TM_COMMAND, $message[ Message::TYPE ] );
		$this->assertSame( 'target', $message[ Message::TO ] );
	}

	public function test_request_node_emits_TM_REQUEST_at_prefix(): void {
		$shell       = new Shell_Node();
		$shell->path = 'cwd';
		$message     = $shell->parse( 'request_node target whatever' );
		$this->assertSame( Message::TM_REQUEST, $message[ Message::TYPE ] );
		$this->assertSame( 'cwd/target', $message[ Message::TO ] );
		$this->assertSame( 'whatever', $message[ Message::VALUE ] );
	}

	public function test_request_alias_works_like_request_node(): void {
		$shell   = new Shell_Node();
		$message = $shell->parse( 'request target arg' );
		$this->assertSame( Message::TM_REQUEST, $message[ Message::TYPE ] );
		$this->assertSame( 'target', $message[ Message::TO ] );
	}

	public function test_pwd_builtin_emits_pwd_TM_COMMAND_with_cwd_as_arg(): void {
		// pwd sends `pwd` to current cwd with cwd as the argument so receiver's
		// interpreter can render ` <cwd> -> <from>`.
		$shell       = new Shell_Node();
		$shell->path = 'firehose-workers.p0';
		$message     = $shell->parse( 'pwd' );
		$this->assertSame( Message::TM_COMMAND, $message[ Message::TYPE ] );
		$this->assertSame( 'firehose-workers.p0', $message[ Message::TO ] );
		$decoded = $message[ Message::VALUE ];
		$this->assertSame( 'pwd', $decoded['name'] );
		$this->assertSame( 'firehose-workers.p0', $decoded['arguments'] );
	}

	public function test_pwd_at_root_emits_with_empty_TO(): void {
		// `pwd` at empty cwd targets the local interpreter (TO='').
		$shell = new Shell_Node();
		$message = $shell->parse( 'pwd' );
		$this->assertSame( '', $message[ Message::TO ] );
		$decoded = $message[ Message::VALUE ];
		$this->assertSame( '', $decoded['arguments'] );
	}

	// ── include_file branches ──────────────────────────────────────────────

	public function test_include_missing_file_logs_and_returns_null(): void {
		// include of a nonexistent file shouldn't throw — print_less_often
		// catches it via Core's stderr handler.
		$captured = [];
		\Newspack_Nodes\Core::set_stderr_handler( function ( $message ) use ( &$captured ) {
			$captured[] = $message;
		} );

		$shell = new Shell_Node();
		$this->assertNull( $shell->parse( 'include /nonexistent/path.txt' ) );
		$this->assertNotEmpty( $captured );
		$this->assertStringContainsString( 'file not found', \implode( "\n", $captured ) );
	}

	public function test_include_processes_each_line(): void {
		// Build a script file with two commands; include should fill both
		// through the Shell's sink.
		$tmp = $this->make_temp_dir();
		try {
			$script = "{$tmp}/cmds.txt";
			\file_put_contents( $script, "ls\ntell node hi\n" );

			$shell = new Shell_Node();
			$sink  = new Capture_Sink_Node();
			$shell->sink( $sink );

			$shell->parse( 'include ' . $script );

			$this->assertCount( 2, $sink->captured );
			// First line was `ls` → TM_COMMAND.
			$this->assertSame( Message::TM_COMMAND, $sink->captured[0][ Message::TYPE ] );
			// Second line was `tell node hi` → TM_INFO.
			$this->assertSame( Message::TM_INFO, $sink->captured[1][ Message::TYPE ] );
		} finally {
			$this->rmdir_recursive( $tmp );
		}
	}

	// ── A3: Core::$var / namespaced-token interpolation + var builtin ─────

	public function test_interpolate_reads_namespaced_token_from_registered_resolver(): void {
		$saved = \Newspack_Nodes\Core::$config_resolvers;
		\Newspack_Nodes\Core::register_config_namespace(
			'config',
			static fn ( string $k ) => 'base_directory' === $k ? '/tmp/foo' : null
		);
		\Newspack_Nodes\Core::$var = [ 'partition' => '0' ];
		$shell                     = new Shell_Node();
		try {
			$this->assertSame(
				'make_node Partition p /tmp/foo/p0',
				$shell->interpolate( 'make_node Partition p <config:base_directory>/p<partition>' )
			);
		} finally {
			\Newspack_Nodes\Core::$config_resolvers = $saved;
		}
	}

	public function test_var_builtin_writes_core_var(): void {
		\Newspack_Nodes\Core::$var = [];
		$shell = new Shell_Node();
		$shell->parse( 'var num_partitions = 4' );
		$this->assertSame( '4', \Newspack_Nodes\Core::$var['num_partitions'] );
	}

	public function test_var_builtin_rejects_colon_namespaced_name(): void {
		\Newspack_Nodes\Core::$var = [];
		$shell                     = new Shell_Node();
		$shell->parse( 'var config:foo = 1' );
		$this->assertArrayNotHasKey( 'config:foo', \Newspack_Nodes\Core::$var );
	}

	public function test_split_statements_on_semicolons_and_newlines(): void {
		$shell = new Shell_Node();
		$this->assertSame(
			[ 'var foo = 1', 'var bar = 2', 'tell node hi' ],
			$shell->split_statements( "var foo = 1; var bar = 2\ntell node hi" )
		);
	}

	public function test_split_statements_does_not_split_semicolons_inside_comments(): void {
		// Bug regression: a `;` in a `# comment` line was treated as a
		// statement separator, breaking the second half off as a verb.
		$shell = new Shell_Node();
		$this->assertSame(
			[ '# warning; jobs can be slow', 'var foo = 1' ],
			$shell->split_statements( "# warning; jobs can be slow\nvar foo = 1" )
		);
	}

	public function test_split_statements_preserves_semicolons_inside_quotes(): void {
		$shell = new Shell_Node();
		$this->assertSame(
			[ "tell node 'a;b;c'", 'var foo = 1' ],
			$shell->split_statements( "tell node 'a;b;c'; var foo = 1" )
		);
	}

	public function test_eval_script_dispatches_each_statement(): void {
		\Newspack_Nodes\Core::reset();
		$shell = new Shell_Node();
		$sink  = new \Newspack_Nodes\Tests\Capture_Sink_Node();
		$shell->sink( $sink );
		$shell->eval_script( "var partition = 3; tell foo hello; tell bar <partition>" );
		// `var` doesn't emit; the two `tell` statements do.
		$this->assertCount( 2, $sink->captured );
		$this->assertSame( 'hello', $sink->captured[0][ Message::VALUE ] );
		// Second tell uses the var set by the first statement.
		$this->assertSame( '3', $sink->captured[1][ Message::VALUE ] );
	}
}
