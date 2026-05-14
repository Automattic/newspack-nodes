<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
use Newspack_Nodes\Dumper;
use Newspack_Nodes\Message;
use Newspack_Nodes\Shell;
use Newspack_Nodes\Tests\CaptureSink;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Shell::class )]
class ShellTest extends TestCase {

	public function test_tokenize_plain_words(): void {
		$shell = new Shell();
		$this->assertSame( [ 'tell', 'foo', 'bar' ], $shell->tokenize( 'tell foo bar' ) );
	}

	public function test_tokenize_collapses_repeated_whitespace(): void {
		$shell = new Shell();
		$this->assertSame( [ 'a', 'b', 'c' ], $shell->tokenize( "a   b\tc" ) );
	}

	public function test_tokenize_double_quoted_string_is_one_token(): void {
		$shell = new Shell();
		$this->assertSame( [ 'send', 'node', 'hello world' ], $shell->tokenize( 'send node "hello world"' ) );
	}

	public function test_tokenize_single_quoted_string_is_one_token(): void {
		$shell = new Shell();
		$this->assertSame( [ 'send', "two words" ], $shell->tokenize( "send 'two words'" ) );
	}

	public function test_tokenize_backtick_quoted_string_is_one_token(): void {
		$shell = new Shell();
		$this->assertSame( [ 'cmd', 'literal $foo' ], $shell->tokenize( 'cmd `literal $foo`' ) );
	}

	public function test_tokenize_empty_quoted_string_is_a_token(): void {
		$shell = new Shell();
		$this->assertSame( [ 'send', '', 'after' ], $shell->tokenize( "send '' after" ) );
	}

	public function test_interpolate_replaces_known_variable(): void {
		$shell = new Shell();
		$shell->set_variable( 'name', 'alice' );
		$this->assertSame( 'tell alice hello', $shell->interpolate( 'tell <name> hello' ) );
	}

	public function test_interpolate_unknown_variable_yields_empty(): void {
		$shell = new Shell();
		$this->assertSame( 'tell  hello', $shell->interpolate( 'tell <ghost> hello' ) );
	}

	public function test_parse_tell_yields_TM_INFO(): void {
		$shell = new Shell();
		$msg   = $shell->parse( 'tell node msg');

		$this->assertNotNull( $msg );
		$this->assertSame( Message::TM_INFO, $msg[ Message::TYPE ] );
		$this->assertSame( 'node', $msg[ Message::TO ] );
		$this->assertSame( 'msg', $msg[ Message::VALUE ] );
		$this->assertNotSame( '', $msg[ Message::ID ] );
	}

	public function test_parse_send_yields_TM_BYTESTREAM(): void {
		$shell = new Shell();
		$msg   = $shell->parse( 'send node bytes');

		$this->assertSame( Message::TM_BYTESTREAM, $msg[ Message::TYPE ] );
		$this->assertSame( 'node', $msg[ Message::TO ] );
		$this->assertSame( 'bytes', $msg[ Message::VALUE ] );
	}

	public function test_parse_send_eof_yields_TM_EOF(): void {
		$shell = new Shell();
		$msg   = $shell->parse( 'send_eof node');

		$this->assertSame( Message::TM_EOF, $msg[ Message::TYPE ] );
		$this->assertSame( 'node', $msg[ Message::TO ] );
	}

	public function test_parse_ping_yields_TM_PING_with_timestamp_payload(): void {
		// Tachikoma Shell3 ping builtin: build TM_PING addressed at the path,
		// payload = current timestamp; receiver's CI bounces TO=FROM.
		Core::$now = 1234567890.123456;
		$shell = new Shell();
		$msg   = $shell->parse( 'ping _command_interpreter');

		$this->assertNotNull( $msg );
		$this->assertSame( Message::TM_PING, $msg[ Message::TYPE ] );
		$this->assertSame( '_command_interpreter', $msg[ Message::TO ] );
		$this->assertSame( '1234567890.1235', $msg[ Message::VALUE ] );
		$this->assertStringStartsWith( '_output/', $msg[ Message::FROM ] );
	}

	public function test_parse_default_verb_yields_TM_COMMAND(): void {
		$shell = new Shell();
		$msg   = $shell->parse( 'ls');

		$this->assertSame( Message::TM_COMMAND, $msg[ Message::TYPE ] );
		$cmd = \json_decode( $msg[ Message::VALUE ], true );
		$this->assertSame( 'ls', $cmd['name'] );
		$this->assertSame( '', $cmd['arguments'] );
	}

	public function test_parse_default_verb_with_args(): void {
		$shell = new Shell();
		$msg   = $shell->parse( 'make_node CaptureSink alice');

		$cmd = \json_decode( $msg[ Message::VALUE ], true );
		$this->assertSame( 'make_node', $cmd['name'] );
		$this->assertSame( 'CaptureSink alice', $cmd['arguments'] );
	}

	public function test_parse_status_writes_status_lines_to_output_stream_returns_null(): void {
		// `status` is a local-only builtin: it writes the shell's
		// pre-populated $status_lines to the configured $output_stream and
		// returns null (no Message emitted, no command sent to the worker).
		// This is how pivoted-cli prints "Pivoted-cli mode for X" + IPC paths
		// on demand instead of auto-printing them at startup, so scripted
		// callers can capture clean output.
		$out_stream = \fopen( 'php://memory', 'w+' );
		$shell      = new Shell();
		$shell->output_stream = $out_stream;
		$shell->status_lines  = [
			'Pivoted-cli mode for firehose-workers.p0',
			'  input  partition: /tmp/in',
			'  output partition: /tmp/out',
		];

		$this->assertNull( $shell->parse( 'status' ) );

		\rewind( $out_stream );
		$contents = \stream_get_contents( $out_stream );
		$this->assertStringContainsString( 'Pivoted-cli mode for firehose-workers.p0', $contents );
		$this->assertStringContainsString( '  input  partition: /tmp/in', $contents );
		$this->assertStringContainsString( '  output partition: /tmp/out', $contents );
		\fclose( $out_stream );
	}

	public function test_parse_show_sse_toggles_local_dumper_filter(): void {
		// `show_sse` is a local-only builtin: it looks up the cli's Dumper by
		// its registered `_output` name and flips its broadcast filter for
		// `TO=sse` (the post-_router-peel form of `_repl/sse`). Pure toggle —
		// no arguments — matching Perl Tachikoma's builtin convention. Reports
		// the new state to $output_stream so the user knows whether they're
		// looking at sse traffic or not.
		$dumper = new Dumper();
		$dumper->name( '_output' );
		$this->assertFalse( $dumper->broadcast_filter_enabled( 'sse' ), 'default off' );

		$out_stream = \fopen( 'php://memory', 'w+' );
		$shell      = new Shell();
		$shell->output_stream = $out_stream;

		$this->assertNull( $shell->parse( 'show_sse' ) );
		$this->assertTrue( $dumper->broadcast_filter_enabled( 'sse' ), 'first call enables' );

		\rewind( $out_stream );
		$this->assertSame( "show_sse: on\n", \stream_get_contents( $out_stream ) );

		// Second invocation toggles back off; output reflects the new state.
		\ftruncate( $out_stream, 0 );
		\rewind( $out_stream );
		$this->assertNull( $shell->parse( 'show_sse' ) );
		$this->assertFalse( $dumper->broadcast_filter_enabled( 'sse' ), 'second call disables' );
		\rewind( $out_stream );
		$this->assertSame( "show_sse: off\n", \stream_get_contents( $out_stream ) );
		\fclose( $out_stream );
	}

	public function test_parse_debug_level_no_args_toggles_dumper_state(): void {
		// `debug_level` with no args toggles between 0 and 1.
		$dumper = new Dumper();
		$dumper->name( '_output' );
		$this->assertSame( 0, $dumper->debug_level(), 'default off' );

		$out_stream = \fopen( 'php://memory', 'w+' );
		$shell      = new Shell();
		$shell->output_stream = $out_stream;

		$this->assertNull( $shell->parse( 'debug_level' ) );
		$this->assertSame( 1, $dumper->debug_level(), 'toggle 0→1' );
		\rewind( $out_stream );
		$this->assertSame( "debug_level: 1\n", \stream_get_contents( $out_stream ) );

		\ftruncate( $out_stream, 0 );
		\rewind( $out_stream );
		$this->assertNull( $shell->parse( 'debug_level' ) );
		$this->assertSame( 0, $dumper->debug_level(), 'toggle back 1→0' );
		\fclose( $out_stream );
	}

	public function test_parse_debug_level_with_explicit_argument_sets(): void {
		// `debug_level 2` explicitly sets to 2 (max).
		$dumper = new Dumper();
		$dumper->name( '_output' );

		$out_stream = \fopen( 'php://memory', 'w+' );
		$shell      = new Shell();
		$shell->output_stream = $out_stream;

		$this->assertNull( $shell->parse( 'debug_level 2' ) );
		$this->assertSame( 2, $dumper->debug_level() );

		\rewind( $out_stream );
		$this->assertSame( "debug_level: 2\n", \stream_get_contents( $out_stream ) );
		\fclose( $out_stream );
	}

	public function test_parse_show_parse_toggles_and_dumps_tokens(): void {
		// `show_parse` is a Shell-local toggle (no Dumper involvement). When
		// on, every parse() emits the post-interpolation line and tokens to
		// $output_stream BEFORE the actual command dispatches.
		$out_stream = \fopen( 'php://memory', 'w+' );
		$shell      = new Shell();
		$shell->output_stream = $out_stream;
		$this->assertFalse( $shell->show_parse(), 'default off' );

		$this->assertNull( $shell->parse( 'show_parse' ) );
		$this->assertTrue( $shell->show_parse() );
		\rewind( $out_stream );
		$this->assertSame( "show_parse: on\n", \stream_get_contents( $out_stream ) );

		// Now a real command should emit parse> diagnostics before the message.
		\ftruncate( $out_stream, 0 );
		\rewind( $out_stream );
		$captured = new CaptureSink();
		$shell->sink( $captured );
		$msg = $shell->parse( 'tell some/path hello' );
		$this->assertIsArray( $msg, 'should still build a Message' );

		\rewind( $out_stream );
		$contents = \stream_get_contents( $out_stream );
		$this->assertStringContainsString( 'parse> line: tell some/path hello', $contents );
		$this->assertStringContainsString( 'parse> tokens: ', $contents );
		$this->assertStringContainsString( '"tell"', $contents );
		\fclose( $out_stream );
	}

	public function test_parse_show_sse_silent_when_no_dumper_registered(): void {
		// Defensive: if the Shell runs in a context where no Dumper is
		// registered under `_output` (e.g. a fully-headless test harness),
		// `show_sse` must not crash — silent no-op, returning null.
		$out_stream = \fopen( 'php://memory', 'w+' );
		$shell      = new Shell();
		$shell->output_stream = $out_stream;

		$this->assertNull( $shell->parse( 'show_sse' ) );

		\rewind( $out_stream );
		$this->assertSame( '', \stream_get_contents( $out_stream ), 'silent when no Dumper' );
		\fclose( $out_stream );
	}

	public function test_parse_status_with_no_status_lines_writes_nothing(): void {
		// Empty $status_lines (e.g. shell wasn't configured by the cli) →
		// status is a no-op; no garbage output, no errors.
		$out_stream = \fopen( 'php://memory', 'w+' );
		$shell      = new Shell();
		$shell->output_stream = $out_stream;

		$this->assertNull( $shell->parse( 'status' ) );

		\rewind( $out_stream );
		$this->assertSame( '', \stream_get_contents( $out_stream ) );
		\fclose( $out_stream );
	}

	public function test_parse_forbidden_verb_returns_null(): void {
		$shell = new Shell();
		$this->assertNull( $shell->parse( 'eval foo') );
		$this->assertNull( $shell->parse( 'if true') );
		$this->assertNull( $shell->parse( 'while x') );
		$this->assertNull( $shell->parse( 'for x') );
		$this->assertNull( $shell->parse( 'func name') );
	}

	public function test_parse_empty_or_comment_returns_null(): void {
		$shell = new Shell();
		$this->assertNull( $shell->parse( '') );
		$this->assertNull( $shell->parse( '   ') );
		$this->assertNull( $shell->parse( '# a comment') );
	}

	public function test_parse_with_interpolation(): void {
		$shell = new Shell();
		$shell->set_variable( 'who', 'bob' );

		$msg = $shell->parse( 'tell <who> hi');
		$this->assertSame( 'bob', $msg[ Message::TO ] );
		$this->assertSame( 'hi', $msg[ Message::VALUE ] );
	}

	public function test_backslash_continuation_yields_null_until_terminating_line(): void {
		$shell = new Shell();
		// First line ends with '\' → continuation.
		$msg1 = $shell->parse( 'tell node "hello\\');
		$this->assertNull( $msg1, 'backslash continuation must defer message emission' );

		$msg2 = $shell->parse( ' world"');
		$this->assertNotNull( $msg2 );
		$this->assertSame( Message::TM_INFO, $msg2[ Message::TYPE ] );
	}

	public function test_fill_forwards_to_sink(): void {
		$shell = new Shell();
		$sink  = new CaptureSink();
		$shell->sink( $sink );

		$msg = $shell->parse( 'ls');
		$shell->fill( $msg );

		$this->assertCount( 1, $sink->captured );
		$this->assertSame( $msg[ Message::ID ], $sink->captured[0][ Message::ID ] );
	}

	public function test_msg_ids_are_unique_within_a_session(): void {
		$shell = new Shell();
		$m1 = $shell->parse( 'ls');
		$m2 = $shell->parse( 'ls');
		$this->assertNotSame( $m1[ Message::ID ], $m2[ Message::ID ] );
	}

	public function test_include_file_processes_each_line(): void {
		$dir  = $this->make_temp_dir();
		$file = "$dir/script.tsl";
		\file_put_contents( $file, "tell alpha first\ntell beta second\n# comment\n" );

		// include is processed inline; each parsed line goes through fill() → sink.
		$shell = new Shell();
		$sink  = new CaptureSink();
		$shell->sink( $sink );

		$result = $shell->parse( "include $file" );
		$this->assertNull( $result, 'include returns null (handled inline)' );
		$this->assertCount( 2, $sink->captured, 'include should fire two TM_INFOs' );
		$this->assertSame( 'alpha', $sink->captured[0][ Message::TO ] );
		$this->assertSame( 'beta', $sink->captured[1][ Message::TO ] );
	}

	public function test_include_missing_file_is_silent_warning(): void {
		$shell = new Shell();
		$this->assertNull(
			$shell->parse( 'include /no/such/file'),
			'missing include must not throw — only warn'
		);
	}

	// ── FROM=$pid stamping (multi-session contention) ───────────────────────────

	public function test_parse_from_is_pid(): void {
		// Shell stamps FROM=`_output/$pid` so replies route uniformly in
		// both bare and pivoted modes (CI's response uses TO=$message->from,
		// _router peels _output, _output dispatches by ID through the
		// shell-callback registry). In pivoted mode the worker's input-Consumer
		// prepends stamp_as=_repl, so server-side FROM=_repl/_output/$pid;
		// the worker's _router peels _repl, the _repl Partition writes to disk
		// with TO=_output/$pid, and the cli's reply-in Consumer reads it
		// where Dumper's regex filter (`(?:_output/)?$pid`) matches.
		// Multi-session: other clis' replies use a different $pid → drop.
		$shell = new Shell();
		$msg   = $shell->parse( 'ls');

		$this->assertNotNull( $msg );
		$this->assertSame( '_output/' . \getmypid(), $msg[ Message::FROM ] );
	}

	public function test_parse_from_is_pid_for_tell(): void {
		$shell = new Shell();
		$msg   = $shell->parse( 'tell node msg');
		$this->assertSame( '_output/' . \getmypid(), $msg[ Message::FROM ] );
	}

	public function test_parse_from_is_pid_for_send(): void {
		$shell = new Shell();
		$msg   = $shell->parse( 'send node bytes');
		$this->assertSame( '_output/' . \getmypid(), $msg[ Message::FROM ] );
	}

	public function test_parse_from_is_pid_for_send_eof(): void {
		$shell = new Shell();
		$msg   = $shell->parse( 'send_eof node');
		$this->assertSame( '_output/' . \getmypid(), $msg[ Message::FROM ] );
	}

	public function test_parse_from_is_stable_within_a_process(): void {
		// All messages from a single Shell instance must carry the same FROM.
		$shell = new Shell();
		$m1    = $shell->parse( 'ls');
		$m2    = $shell->parse( 'tell node hi');
		$m3    = $shell->parse( 'send node bytes');

		$this->assertSame( $m1[ Message::FROM ], $m2[ Message::FROM ] );
		$this->assertSame( $m2[ Message::FROM ], $m3[ Message::FROM ] );
	}

	// ── name (refusal) ─────────────────────────────────────────────────────

	public function test_name_refuses_to_register_under_a_name(): void {
		$shell = new Shell();
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessageMatches( '/named Shell nodes are not allowed/' );
		$shell->name( 'attempted-name' );
	}

	public function test_name_returns_empty_string_when_not_set(): void {
		// Shells stay anonymous so they don't appear in `ls` or get addressed
		// via TO. Calling name() with no arg returns the unset value.
		$shell = new Shell();
		$this->assertSame( '', $shell->name() );
	}

	// ── cd / chdir builtin ─────────────────────────────────────────────────

	public function test_cd_absolute_path_replaces_cwd(): void {
		// `cd /foo/bar` resolves to "foo/bar" (leading slash stripped).
		$shell = new Shell();
		$shell->path = 'old/cwd';
		$this->assertNull( $shell->parse( 'cd /firehose-workers.p0' ) );
		$this->assertSame( 'firehose-workers.p0', $shell->path );
	}

	public function test_cd_relative_path_appends_to_cwd(): void {
		$shell       = new Shell();
		$shell->path = 'jobs:partition';
		$shell->parse( 'cd subnode' );
		$this->assertSame( 'jobs:partition/subnode', $shell->path );
	}

	public function test_cd_dotdot_walks_up_one_segment(): void {
		$shell       = new Shell();
		$shell->path = 'a/b/c';
		$shell->parse( 'cd ..' );
		$this->assertSame( 'a/b', $shell->path );
	}

	public function test_cd_dotdot_chain_walks_up_multiple_segments(): void {
		// `../../foo` walks up two segments then descends.
		$shell       = new Shell();
		$shell->path = 'a/b/c';
		$shell->parse( 'cd ../../foo' );
		$this->assertSame( 'a/foo', $shell->path );
	}

	public function test_cd_with_no_arg_keeps_cwd(): void {
		// Empty path is a no-op (Tachikoma Shell.pm semantics) — `cd` alone
		// is "redraw prompt"; use `cd /` to reset.
		$shell       = new Shell();
		$shell->path = 'somewhere/deep';
		$shell->parse( 'cd' );
		$this->assertSame( 'somewhere/deep', $shell->path );
	}

	public function test_cd_slash_resets_to_root(): void {
		// `cd /` returns to the local interpreter (cwd='').
		$shell       = new Shell();
		$shell->path = 'somewhere/deep';
		$shell->parse( 'cd /' );
		$this->assertSame( '', $shell->path );
	}

	public function test_chdir_alias_acts_like_cd(): void {
		$shell = new Shell();
		$shell->parse( 'chdir /target' );
		$this->assertSame( 'target', $shell->path );
	}

	// ── prefix() composition ───────────────────────────────────────────────

	public function test_prefix_with_empty_path_and_arg_returns_empty(): void {
		$shell = new Shell();
		$this->assertSame( '', $shell->prefix( '' ) );
	}

	public function test_prefix_with_path_only_returns_path(): void {
		$shell       = new Shell();
		$shell->path = 'firehose-workers.p0';
		$this->assertSame( 'firehose-workers.p0', $shell->prefix( '' ) );
	}

	public function test_prefix_with_arg_only_returns_arg(): void {
		$shell = new Shell();
		$this->assertSame( 'node', $shell->prefix( 'node' ) );
	}

	public function test_prefix_combines_path_and_arg_with_slash(): void {
		$shell       = new Shell();
		$shell->path = 'firehose-workers.p0';
		$this->assertSame( 'firehose-workers.p0/firehose:tee', $shell->prefix( 'firehose:tee' ) );
	}

	// ── default-verb routing uses cwd ──────────────────────────────────────

	public function test_default_verb_uses_cwd_as_TO(): void {
		// After `cd firehose-workers.p0`, an unbuiltin verb like `ls` should
		// emit TM_COMMAND with TO=firehose-workers.p0 so the worker's CI
		// (not the local one) handles it.
		$shell       = new Shell();
		$shell->path = 'firehose-workers.p0';
		$msg         = $shell->parse( 'ls -al' );
		$this->assertSame( 'firehose-workers.p0', $msg[ Message::TO ] );
		$decoded = \json_decode( $msg[ Message::VALUE ], true );
		$this->assertSame( 'ls', $decoded['name'] );
		$this->assertSame( '-al', $decoded['arguments'] );
	}

	// ── new verbs: tell_node / send_node / command_node / request_node ────

	public function test_tell_node_canonical_emits_TM_INFO_at_prefix(): void {
		$shell       = new Shell();
		$shell->path = 'cwd';
		$msg         = $shell->parse( 'tell_node target hello world' );
		$this->assertSame( Message::TM_INFO, $msg[ Message::TYPE ] );
		$this->assertSame( 'cwd/target', $msg[ Message::TO ] );
		$this->assertSame( 'hello world', $msg[ Message::VALUE ] );
	}

	public function test_command_node_canonical_emits_TM_COMMAND_at_prefix(): void {
		$shell       = new Shell();
		$shell->path = 'jobs:partition';
		$msg         = $shell->parse( 'command_node helper-node ls -al' );
		$this->assertSame( Message::TM_COMMAND, $msg[ Message::TYPE ] );
		$this->assertSame( 'jobs:partition/helper-node', $msg[ Message::TO ] );
		$decoded = \json_decode( $msg[ Message::VALUE ], true );
		$this->assertSame( 'ls', $decoded['name'] );
		$this->assertSame( '-al', $decoded['arguments'] );
	}

	public function test_command_alias_works_like_command_node(): void {
		$shell = new Shell();
		$msg   = $shell->parse( 'command target ping' );
		$this->assertSame( Message::TM_COMMAND, $msg[ Message::TYPE ] );
		$this->assertSame( 'target', $msg[ Message::TO ] );
	}

	public function test_cmd_alias_works_like_command_node(): void {
		$shell = new Shell();
		$msg   = $shell->parse( 'cmd target ping' );
		$this->assertSame( Message::TM_COMMAND, $msg[ Message::TYPE ] );
		$this->assertSame( 'target', $msg[ Message::TO ] );
	}

	public function test_request_node_emits_TM_REQUEST_at_prefix(): void {
		$shell       = new Shell();
		$shell->path = 'cwd';
		$msg         = $shell->parse( 'request_node target whatever' );
		$this->assertSame( Message::TM_REQUEST, $msg[ Message::TYPE ] );
		$this->assertSame( 'cwd/target', $msg[ Message::TO ] );
		$this->assertSame( 'whatever', $msg[ Message::VALUE ] );
	}

	public function test_request_alias_works_like_request_node(): void {
		$shell = new Shell();
		$msg   = $shell->parse( 'request target arg' );
		$this->assertSame( Message::TM_REQUEST, $msg[ Message::TYPE ] );
		$this->assertSame( 'target', $msg[ Message::TO ] );
	}

	public function test_pwd_builtin_emits_pwd_TM_COMMAND_with_cwd_as_arg(): void {
		// pwd sends `pwd` to current cwd with cwd as the argument so receiver's
		// CI can render ` <cwd> -> <from>`.
		$shell       = new Shell();
		$shell->path = 'firehose-workers.p0';
		$msg         = $shell->parse( 'pwd' );
		$this->assertSame( Message::TM_COMMAND, $msg[ Message::TYPE ] );
		$this->assertSame( 'firehose-workers.p0', $msg[ Message::TO ] );
		$decoded = \json_decode( $msg[ Message::VALUE ], true );
		$this->assertSame( 'pwd', $decoded['name'] );
		$this->assertSame( 'firehose-workers.p0', $decoded['arguments'] );
	}

	public function test_pwd_at_root_emits_with_empty_TO(): void {
		// `pwd` at empty cwd targets the local CI (TO='').
		$shell = new Shell();
		$msg   = $shell->parse( 'pwd' );
		$this->assertSame( '', $msg[ Message::TO ] );
		$decoded = \json_decode( $msg[ Message::VALUE ], true );
		$this->assertSame( '', $decoded['arguments'] );
	}

	// ── include_file branches ──────────────────────────────────────────────

	public function test_include_missing_file_logs_and_returns_null(): void {
		// include of a nonexistent file shouldn't throw — print_less_often
		// catches it via Core's stderr handler.
		$captured = [];
		Core::set_stderr_handler( function ( $msg ) use ( &$captured ) {
			$captured[] = $msg;
		} );

		$shell = new Shell();
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

			$shell = new Shell();
			$sink  = new CaptureSink();
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

	// ── A3: Core::$var / Core::$config interpolation + var builtin ─────

	public function test_set_variable_writes_to_core_var(): void {
		\Newspack_Nodes\Core::$var = [];
		$shell = new Shell();
		$shell->set_variable( 'partition', '7' );
		$this->assertSame( '7', \Newspack_Nodes\Core::$var['partition'] );
	}

	public function test_interpolate_reads_config_namespace_from_core_config(): void {
		\Newspack_Nodes\Core::$config = [ 'base_directory' => '/tmp/foo' ];
		\Newspack_Nodes\Core::$var    = [ 'partition' => '0' ];
		$shell = new Shell();
		$this->assertSame(
			'make_node Partition p /tmp/foo/p0',
			$shell->interpolate( 'make_node Partition p <config:base_directory>/p<partition>' )
		);
	}

	public function test_var_builtin_writes_core_var(): void {
		\Newspack_Nodes\Core::$var = [];
		$shell = new Shell();
		$shell->parse( 'var num_partitions = 4' );
		$this->assertSame( '4', \Newspack_Nodes\Core::$var['num_partitions'] );
	}

	public function test_var_builtin_rejects_colon_namespaced_name(): void {
		\Newspack_Nodes\Core::$var    = [];
		\Newspack_Nodes\Core::$config = [];
		$shell = new Shell();
		$shell->parse( 'var config:foo = 1' );
		$this->assertArrayNotHasKey( 'config:foo', \Newspack_Nodes\Core::$var );
		$this->assertArrayNotHasKey( 'foo', \Newspack_Nodes\Core::$config );
	}

	public function test_split_statements_on_semicolons_and_newlines(): void {
		$shell = new Shell();
		$this->assertSame(
			[ 'var foo = 1', 'var bar = 2', 'tell node hi' ],
			$shell->split_statements( "var foo = 1; var bar = 2\ntell node hi" )
		);
	}

	public function test_split_statements_does_not_split_semicolons_inside_comments(): void {
		// Bug regression: a `;` in a `# comment` line was treated as a
		// statement separator, breaking the second half off as a verb.
		$shell = new Shell();
		$this->assertSame(
			[ '# warning; jobs can be slow', 'var foo = 1' ],
			$shell->split_statements( "# warning; jobs can be slow\nvar foo = 1" )
		);
	}

	public function test_split_statements_preserves_semicolons_inside_quotes(): void {
		$shell = new Shell();
		$this->assertSame(
			[ "tell node 'a;b;c'", 'var foo = 1' ],
			$shell->split_statements( "tell node 'a;b;c'; var foo = 1" )
		);
	}

	public function test_eval_script_dispatches_each_statement(): void {
		\Newspack_Nodes\Core::reset();
		$shell = new Shell();
		$sink  = new \Newspack_Nodes\Tests\CaptureSink();
		$shell->sink( $sink );
		$shell->eval_script( "var partition = 3; tell foo hello; tell bar <partition>" );
		// `var` doesn't emit; the two `tell` statements do.
		$this->assertCount( 2, $sink->captured );
		$this->assertSame( 'hello', $sink->captured[0][ Message::VALUE ] );
		// Second tell uses the var set by the first statement.
		$this->assertSame( '3', $sink->captured[1][ Message::VALUE ] );
	}
}
