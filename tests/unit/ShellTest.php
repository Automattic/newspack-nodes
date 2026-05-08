<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
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
		$msg   = $shell->parse( 'tell node msg', static fn ( $info ) => null );

		$this->assertNotNull( $msg );
		$this->assertSame( Message::TM_INFO, $msg[ Message::TYPE ] );
		$this->assertSame( 'node', $msg[ Message::TO ] );
		$this->assertSame( 'msg', $msg[ Message::VALUE ] );
		$this->assertNotSame( '', $msg[ Message::ID ] );
	}

	public function test_parse_send_yields_TM_BYTESTREAM(): void {
		$shell = new Shell();
		$msg   = $shell->parse( 'send node bytes', static fn ( $info ) => null );

		$this->assertSame( Message::TM_BYTESTREAM, $msg[ Message::TYPE ] );
		$this->assertSame( 'node', $msg[ Message::TO ] );
		$this->assertSame( 'bytes', $msg[ Message::VALUE ] );
	}

	public function test_parse_send_eof_yields_TM_EOF(): void {
		$shell = new Shell();
		$msg   = $shell->parse( 'send_eof node', static fn ( $info ) => null );

		$this->assertSame( Message::TM_EOF, $msg[ Message::TYPE ] );
		$this->assertSame( 'node', $msg[ Message::TO ] );
	}

	public function test_parse_default_verb_yields_TM_COMMAND(): void {
		$shell = new Shell();
		$msg   = $shell->parse( 'ls', static fn ( $info ) => null );

		$this->assertSame( Message::TM_COMMAND, $msg[ Message::TYPE ] );
		$cmd = \json_decode( $msg[ Message::VALUE ], true );
		$this->assertSame( 'ls', $cmd['name'] );
		$this->assertSame( '', $cmd['arguments'] );
	}

	public function test_parse_default_verb_with_args(): void {
		$shell = new Shell();
		$msg   = $shell->parse( 'make_node CaptureSink alice', static fn ( $info ) => null );

		$cmd = \json_decode( $msg[ Message::VALUE ], true );
		$this->assertSame( 'make_node', $cmd['name'] );
		$this->assertSame( 'CaptureSink alice', $cmd['arguments'] );
	}

	public function test_parse_forbidden_verb_returns_null(): void {
		$shell = new Shell();
		$this->assertNull( $shell->parse( 'eval foo', static fn ( $info ) => null ) );
		$this->assertNull( $shell->parse( 'if true', static fn ( $info ) => null ) );
		$this->assertNull( $shell->parse( 'while x', static fn ( $info ) => null ) );
		$this->assertNull( $shell->parse( 'for x', static fn ( $info ) => null ) );
		$this->assertNull( $shell->parse( 'func name', static fn ( $info ) => null ) );
	}

	public function test_parse_empty_or_comment_returns_null(): void {
		$shell = new Shell();
		$this->assertNull( $shell->parse( '', static fn ( $info ) => null ) );
		$this->assertNull( $shell->parse( '   ', static fn ( $info ) => null ) );
		$this->assertNull( $shell->parse( '# a comment', static fn ( $info ) => null ) );
	}

	public function test_parse_registers_single_shot_callback(): void {
		$shell = new Shell();
		$msg   = $shell->parse( 'ls', static fn ( $info ) => null );

		$this->assertNotNull( $msg );
		$id = $msg[ Message::ID ];
		$this->assertArrayHasKey( $id, $shell->callbacks() );
	}

	public function test_callback_invocation_removes_registration(): void {
		$shell = new Shell();
		$received = null;
		$msg = $shell->parse( 'ls', function ( $info ) use ( &$received ) {
			$received = $info;
		} );
		$id = $msg[ Message::ID ];

		// Pretend a response arrived.
		$ok = $shell->callback( $id, [ 'from' => 'x', 'event' => 'y', 'payload' => 'z', 'error' => false ] );

		$this->assertTrue( $ok );
		$this->assertSame( [ 'from' => 'x', 'event' => 'y', 'payload' => 'z', 'error' => false ], $received );
		$this->assertArrayNotHasKey( $id, $shell->callbacks(), 'callback must auto-deregister after firing' );
	}

	public function test_callback_unknown_id_returns_false(): void {
		$shell = new Shell();
		$this->assertFalse( $shell->callback( 'no-such-id', [] ) );
	}

	public function test_parse_with_interpolation(): void {
		$shell = new Shell();
		$shell->set_variable( 'who', 'bob' );

		$msg = $shell->parse( 'tell <who> hi', static fn ( $info ) => null );
		$this->assertSame( 'bob', $msg[ Message::TO ] );
		$this->assertSame( 'hi', $msg[ Message::VALUE ] );
	}

	public function test_backslash_continuation_yields_null_until_terminating_line(): void {
		$shell = new Shell();
		// First line ends with '\' → continuation.
		$msg1 = $shell->parse( 'tell node "hello\\', static fn ( $info ) => null );
		$this->assertNull( $msg1, 'backslash continuation must defer message emission' );

		$msg2 = $shell->parse( ' world"', static fn ( $info ) => null );
		$this->assertNotNull( $msg2 );
		$this->assertSame( Message::TM_INFO, $msg2[ Message::TYPE ] );
	}

	public function test_fill_forwards_to_sink(): void {
		$shell = new Shell();
		$sink  = new CaptureSink();
		$shell->sink( $sink );

		$msg = $shell->parse( 'ls', static fn ( $info ) => null );
		$shell->fill( $msg );

		$this->assertCount( 1, $sink->captured );
		$this->assertSame( $msg[ Message::ID ], $sink->captured[0][ Message::ID ] );
	}

	public function test_msg_ids_are_unique_within_a_session(): void {
		$shell = new Shell();
		$m1 = $shell->parse( 'ls', static fn ( $info ) => null );
		$m2 = $shell->parse( 'ls', static fn ( $info ) => null );
		$this->assertNotSame( $m1[ Message::ID ], $m2[ Message::ID ] );
	}

	public function test_include_file_processes_each_line(): void {
		$dir  = $this->make_temp_dir();
		$file = "$dir/script.tsl";
		\file_put_contents( $file, "tell alpha first\ntell beta second\n# comment\n" );

		$shell    = new Shell();
		$captured = [];
		$cb       = static function ( $info ) use ( &$captured ): void {
			$captured[] = $info;
		};

		// include is processed inline; each line goes through fill() → sink.
		$sink = new CaptureSink();
		$shell->sink( $sink );

		$result = $shell->parse( "include $file", $cb );
		$this->assertNull( $result, 'include returns null (handled inline)' );
		$this->assertCount( 2, $sink->captured, 'include should fire two TM_INFOs' );
		$this->assertSame( 'alpha', $sink->captured[0][ Message::TO ] );
		$this->assertSame( 'beta', $sink->captured[1][ Message::TO ] );
	}

	public function test_include_missing_file_is_silent_warning(): void {
		$shell = new Shell();
		$this->assertNull(
			$shell->parse( 'include /no/such/file', static fn ( $info ) => null ),
			'missing include must not throw — only warn'
		);
	}

	// ── FROM=$pid stamping (multi-session contention) ───────────────────────────

	public function test_parse_from_is_pid(): void {
		// Shell stamps FROM=`_responder/$pid` so replies route uniformly in
		// both bare and pivoted modes (CI's response uses TO=$message->from,
		// _router peels _responder, _responder dispatches by ID through the
		// shell-callback registry). In pivoted mode the worker's input-Consumer
		// prepends stamp_as=_repl, so server-side FROM=_repl/_responder/$pid;
		// the worker's _router peels _repl, the _repl Partition writes to disk
		// with TO=_responder/$pid, and the cli's reply-in Consumer reads it
		// where Dumper's regex filter (`(?:_responder/)?$pid`) matches.
		// Multi-session: other clis' replies use a different $pid → drop.
		$shell = new Shell();
		$msg   = $shell->parse( 'ls', static fn ( $info ) => null );

		$this->assertNotNull( $msg );
		$this->assertSame( '_responder/' . \getmypid(), $msg[ Message::FROM ] );
	}

	public function test_parse_from_is_pid_for_tell(): void {
		$shell = new Shell();
		$msg   = $shell->parse( 'tell node msg', static fn ( $info ) => null );
		$this->assertSame( '_responder/' . \getmypid(), $msg[ Message::FROM ] );
	}

	public function test_parse_from_is_pid_for_send(): void {
		$shell = new Shell();
		$msg   = $shell->parse( 'send node bytes', static fn ( $info ) => null );
		$this->assertSame( '_responder/' . \getmypid(), $msg[ Message::FROM ] );
	}

	public function test_parse_from_is_pid_for_send_eof(): void {
		$shell = new Shell();
		$msg   = $shell->parse( 'send_eof node', static fn ( $info ) => null );
		$this->assertSame( '_responder/' . \getmypid(), $msg[ Message::FROM ] );
	}

	public function test_parse_from_is_stable_within_a_process(): void {
		// All messages from a single Shell instance must carry the same FROM.
		$shell = new Shell();
		$m1    = $shell->parse( 'ls', static fn ( $info ) => null );
		$m2    = $shell->parse( 'tell node hi', static fn ( $info ) => null );
		$m3    = $shell->parse( 'send node bytes', static fn ( $info ) => null );

		$this->assertSame( $m1[ Message::FROM ], $m2[ Message::FROM ] );
		$this->assertSame( $m2[ Message::FROM ], $m3[ Message::FROM ] );
	}
}
