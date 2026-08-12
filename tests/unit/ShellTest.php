<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Command_Auth;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Node;
use Newspack_Nodes\Node_Names;
use Newspack_Nodes\Shell_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\Capture_Stdout_Node;
use Newspack_Nodes\Tests\TestCase;

#[CoversClass( Shell_Node::class )]
class ShellTest extends TestCase {

	public function test_tokenize_plain_words(): void {
		$shell = new Shell_Node();
		$this->assertSame( [ 'tell', 'foo', 'bar' ], $shell->tokenize( 'tell foo bar' ) );
	}

	public function test_tokenize_unescapes_quote_and_backslash_inside_quotes(): void {
		$shell = new Shell_Node();
		// Inside a quote, `\` escapes the next char so the wrapping quote (and a
		// literal backslash) survive: `'it\'s'` -> `it's`, `'a\\b'` -> `a\b`.
		$this->assertSame( [ "it's" ], $shell->tokenize( "'it\\'s'" ) );
		$this->assertSame( [ 'a\\b' ], $shell->tokenize( "'a\\\\b'" ) );
	}

	/**
	 * @dataProvider adversarial_tokens
	 * @param list<string> $tokens
	 */
	public function test_serialize_args_round_trips_through_tokenize( array $tokens ): void {
		$shell = new Shell_Node();
		// serialize_args -> tokenize must recover the EXACT tokens, including
		// ones carrying quote chars and backslashes (the pre-escape gap).
		$line = 'X Y ' . Node::serialize_args( $tokens );
		$back = \array_slice( $shell->tokenize( $line ), 2 );
		$this->assertSame( $tokens, $back );
	}

	/** @return array<string,array{list<string>}> */
	public static function adversarial_tokens(): array {
		return [
			'spaced'          => [ [ 'a b', 'c' ] ],
			// Unquoted, `#` starts a comment and `;` ends the statement, so
			// both truncate the LINE rather than just mangling the token.
			'comment_char'    => [ [ 'a#b', 'c' ] ],
			'statement_sep'   => [ [ 'a;b', 'c' ] ],
			'leading_hash'    => [ [ '#foo' ] ],
			'single-quote'    => [ [ "it's" ] ],
			'double-quote'    => [ [ 'pa"th' ] ],
			'backtick'        => [ [ 'back`tick' ] ],
			'backslash'       => [ [ 'a\\b' ] ],
			'space-and-quote' => [ [ "a 'b" ] ],
			'all-three-quotes'=> [ [ "q'\"`x" ] ],
			'empty-leading'   => [ [ '', 'bval' ] ],
			'empty-middle'    => [ [ 'a', '', 'c' ] ],
			'single-empty'    => [ [ '' ] ],
			'plain-path'      => [ [ '/logs/x.p0', '65536', '4' ] ],
		];
	}

	/**
	 * A stored argument can carry an UNEXPANDED `<…>`: that is exactly what the
	 * single-quoted idiom (`<config:logs_dir>/jobs.p'<partition>'`) hands a node,
	 * and dump_config re-emits what the node holds. Re-emitting it bare loses it
	 * — interpolate() runs BEFORE tokenize(), and an unknown marker expands to
	 * nothing — so the whole round trip, not just tokenize, has to recover it.
	 */
	public function test_serialize_args_defers_an_unexpanded_interpolation_marker(): void {
		$shell  = new Shell_Node();
		$tokens = [ '/logs/firehose.p<partition>', '/offsets/x.<topology>' ];
		$line   = 'X Y ' . Node::serialize_args( $tokens );
		$back   = \array_slice( $shell->tokenize( $shell->interpolate( $line ) ), 2 );
		$this->assertSame( $tokens, $back );
	}

	/**
	 * The same deferral, for a token serialize_arg had to ESCAPE. It writes `'`
	 * as `\'`, and interpolate() runs before tokenize() — so a literal span that
	 * closes on the escape inverts quote parity and expands every later `<…>`.
	 */
	public function test_serialize_arg_defers_a_marker_following_an_escaped_quote(): void {
		$shell  = new Shell_Node();
		$tokens = [ "Don't use <partition>", '/logs/x.p<partition>' ];
		$line   = 'X Y ' . Node::serialize_args( $tokens );
		$back   = \array_slice( $shell->tokenize( $shell->interpolate( $line ) ), 2 );
		$this->assertSame( $tokens, $back );
	}

	/** Double quotes are Shell3's string1: escape SEQUENCES expand. */
	public function test_double_quotes_expand_escape_sequences(): void {
		$shell = new Shell_Node();
		$this->assertSame( [ "foo\nbar\n" ], $shell->tokenize( '"foo\\nbar\\n"' ) );
		$this->assertSame( [ "a\tb" ], $shell->tokenize( '"a\\tb"' ) );
		$this->assertSame( [ "a\rb" ], $shell->tokenize( '"a\\rb"' ) );
		$this->assertSame( [ "a\033b" ], $shell->tokenize( '"a\\eb"' ) );
	}

	/** Double quotes still unescape the literal chars: \" \\ \< \>. */
	public function test_double_quotes_unescape_literal_chars(): void {
		$shell = new Shell_Node();
		$this->assertSame( [ 'say "hi"' ], $shell->tokenize( '"say \\"hi\\""' ) );
		$this->assertSame( [ 'a\\b' ], $shell->tokenize( '"a\\\\b"' ) );
		$this->assertSame( [ '<literal>' ], $shell->tokenize( '"\\<literal\\>"' ) );
	}

	/** Single quotes are string2: ONLY \' and \\ unescape, \n stays literal. */
	public function test_single_quotes_keep_escape_sequences_literal(): void {
		$shell = new Shell_Node();
		$this->assertSame( [ 'foo\\nbar' ], $shell->tokenize( "'foo\\nbar'" ) );
		$this->assertSame( [ "it's" ], $shell->tokenize( "'it\\'s'" ) );
		$this->assertSame( [ 'a\\b' ], $shell->tokenize( "'a\\\\b'" ) );
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

	public function test_a_quoted_value_keeps_its_trailing_newline(): void {
		// The tokenizer already stripped surrounding whitespace, so whatever
		// reaches the value IS the value. Trimming here ate a terminator the
		// caller had deliberately quoted in.
		$shell = new Shell_Node();

		$shell->parse( 'var foo = "bar\n"' );

		$this->assertSame( "bar\n", $shell->interpolate( '<foo>' ) );
	}

	public function test_var_command_accepts_spaced_form_with_multiword_value(): void {
		$shell = new Shell_Node();
		$this->assertNull( $shell->parse( 'var greeting = hello there' ) );
		$this->assertSame( 'hello there', $shell->interpolate( '<greeting>' ) );
	}

	/** `var` with no argument lists every var as `name=value`, sorted. */
	public function test_bare_var_lists_all_vars_sorted(): void {
		$capture = $this->register_output_capture();
		$shell   = new Shell_Node();
		$shell->parse( 'var zebra = last' );
		$shell->parse( 'var apple = first' );

		$this->assertNull( $shell->parse( 'var' ) );
		$this->assertSame( "apple=first\nzebra=last\n", $capture->captured[0][ Message::VALUE ] );
	}

	/** `var <name>` prints the value (Shell3.pm:2713-2721). */
	public function test_var_name_prints_the_value(): void {
		$capture = $this->register_output_capture();
		$shell   = new Shell_Node();
		$shell->parse( 'var foo = bar' );

		$this->assertNull( $shell->parse( 'var foo' ) );
		// Verbatim, like Shell3 — no newline is appended.
		$this->assertSame( 'bar', $capture->captured[0][ Message::VALUE ] );
	}

	/** Reading an unset var autovivifies it to empty — Shell3.pm:2715 `//= q()`. */
	public function test_reading_an_unset_var_defines_it_as_empty(): void {
		$capture = $this->register_output_capture();
		$shell   = new Shell_Node();

		$shell->parse( 'var ghost' );
		$this->assertSame( '', Core::$var['ghost'] ?? null, 'read must define the key' );

		// The read itself prints nothing (empty value), so `var` is capture 0.
		$shell->parse( 'var' );
		$this->assertStringContainsString( "ghost=\n", $capture->captured[0][ Message::VALUE ] );
	}

	/** `print` writes its argument verbatim — the newline is the caller's. */
	public function test_print_writes_verbatim_without_appending_a_newline(): void {
		$capture = $this->register_output_capture();
		$shell   = new Shell_Node();

		$shell->parse( 'print hello' );
		$this->assertSame( 'hello', $capture->captured[0][ Message::VALUE ] );
	}

	/** The newline comes from the value, as Shell3's `print "<msg>\n"` shows. */
	public function test_print_emits_an_embedded_newline(): void {
		$capture = $this->register_output_capture();
		$shell   = new Shell_Node();

		$shell->parse( 'print "hello' . '\\n' . '"' );
		$this->assertSame( "hello\n", $capture->captured[0][ Message::VALUE ] );
	}

	/** `echo` is gone — Tachikoma has no such verb. */
	public function test_echo_is_not_a_builtin(): void {
		$shell   = new Shell_Node();
		$message = $shell->parse( 'echo hello' );

		$this->assertNotNull( $message, 'an unknown verb falls through as a command' );
		$this->assertSame( 'echo', $message[ Message::VALUE ]['name'] );
	}

	/** A whitespace-only value SETS empty; only a missing value deletes. */
	public function test_whitespace_only_value_sets_empty_rather_than_deleting(): void {
		$shell = new Shell_Node();
		$shell->parse( 'var foo = bar' );

		$shell->parse( 'var foo = "' . '\\n' . '"' );
		$this->assertArrayHasKey( 'foo', Core::$var, 'a newline value must not delete' );
		$this->assertSame( '', Core::$var['foo'] );
	}

	/** Reading prints the value verbatim — an empty one prints nothing. */
	public function test_reading_an_empty_var_prints_nothing(): void {
		$capture = $this->register_output_capture();
		$shell   = new Shell_Node();
		$shell->parse( 'var hollow' );

		$shell->parse( 'var hollow' );
		$this->assertSame( [], $capture->captured, 'an empty value prints nothing at all' );
	}

	/** An empty var store lists nothing, not a blank line. */
	public function test_bare_var_with_no_vars_prints_nothing(): void {
		$capture = $this->register_output_capture();
		$shell   = new Shell_Node();

		$shell->parse( 'var' );
		$this->assertSame( [], $capture->captured );
	}

	/** Trailing junk where an operator belongs is an error (Shell3.pm:630). */
	public function test_name_followed_by_junk_is_rejected(): void {
		$capture = $this->register_output_capture();
		$shell   = new Shell_Node();

		$shell->parse( 'var greeting hello' );
		$this->assertArrayNotHasKey( 'greeting', Core::$var );
		$this->assertStringContainsString( 'unexpected token', $capture->captured[0][ Message::VALUE ] );
	}

	/** `var <name> =` with no value DELETES the var (Shell3.pm:2839). */
	public function test_empty_assignment_deletes_the_var(): void {
		$shell = new Shell_Node();
		$shell->parse( 'var doomed = alive' );

		$shell->parse( 'var doomed =' );
		$this->assertArrayNotHasKey( 'doomed', Core::$var );
	}

	/** Interpolating an undefined var warns; the result is still empty. */
	public function test_interpolating_an_undefined_var_warns(): void {
		$shell   = new Shell_Node();
		$emitted = [];
		Core::set_stderr_handler( static function ( string $t ) use ( &$emitted ): void {
			$emitted[] = $t;
		} );

		$this->assertSame( 'tell  hello', $shell->interpolate( 'tell <ghost> hello' ) );
		// Shell3 prints this one raw (`print {*STDERR}`) — no timestamp, no
		// hostname, no pid, in a worker as much as in the REPL.
		$this->assertSame( [ "WARNING: use of uninitialized value <ghost>\n" ], $emitted );
	}

	/** Shell3:303 — an unquoted `#` starts a comment anywhere, not just col 0. */
	public function test_trailing_comment_is_dropped_from_tokens(): void {
		$shell = new Shell_Node();
		$this->assertSame(
			[ 'make_node', 'Log', 'foo' ],
			$shell->tokenize( 'make_node Log foo   # the request log' )
		);
	}

	/** A `#` inside a quote is content, not a comment. */
	public function test_hash_inside_quotes_is_content(): void {
		$shell = new Shell_Node();
		$this->assertSame( [ 'send', 'a # b' ], $shell->tokenize( 'send "a # b"' ) );
		$this->assertSame( [ 'send', '#fff' ], $shell->tokenize( "send '#fff'" ) );
	}

	/** The ident charset excludes `#`, so it ends the token it interrupts. */
	public function test_hash_ends_the_token_it_interrupts(): void {
		$shell = new Shell_Node();
		$this->assertSame( [ 'foo' ], $shell->tokenize( 'foo#bar' ) );
	}

	/** A `<token>` in a trailing comment is inert — it must not interpolate. */
	public function test_trailing_comment_does_not_interpolate_or_warn(): void {
		$shell   = new Shell_Node();
		$emitted = [];
		Core::set_stderr_handler( static function ( string $t ) use ( &$emitted ): void {
			$emitted[] = $t;
		} );

		$this->assertSame( 'tell node hi  # see <id>', $shell->interpolate( 'tell node hi  # see <id>' ) );
		$this->assertSame( [], $emitted );
	}

	/** A `;` inside a trailing comment must not split the statement. */
	public function test_semicolon_inside_a_trailing_comment_does_not_split(): void {
		$shell = new Shell_Node();
		$this->assertSame(
			[ 'make_node Log foo # a; b' ],
			$shell->split_statements( 'make_node Log foo # a; b' )
		);
	}

	/** Shell3:411 string4 — outside a quote, a backslash escapes the next char. */
	public function test_backslash_escapes_outside_quotes(): void {
		$shell = new Shell_Node();
		$bs    = \chr( 92 );

		$this->assertSame( [ 'echo', 'foo', '#', 'bar' ], $shell->tokenize( "echo foo {$bs}# bar" ) );
		$this->assertSame( [ 'echo', 'a b' ], $shell->tokenize( "echo a{$bs} b" ) );
		// An escaped backslash collapses to one literal backslash.
		$this->assertSame( [ 'echo', "a{$bs}b" ], $shell->tokenize( "echo a{$bs}{$bs}b" ) );
	}

	/** An escaped `<` is not a variable opener. */
	public function test_escaped_angle_bracket_does_not_interpolate(): void {
		$shell = new Shell_Node();
		Core::$var['who'] = 'alice';

		$this->assertSame( 'echo \<who>', $shell->interpolate( 'echo \<who>' ) );
		$this->assertSame( [ 'echo', '<who>' ], $shell->tokenize( $shell->interpolate( 'echo \<who>' ) ) );
	}

	/** An escaped `;` is content, not a statement separator. */
	public function test_escaped_semicolon_does_not_split(): void {
		$shell = new Shell_Node();
		$this->assertSame( [ 'echo a\; b' ], $shell->split_statements( 'echo a\; b' ) );
		$this->assertSame( [ 'echo', 'a;', 'b' ], $shell->tokenize( 'echo a\; b' ) );
	}

	/** A trailing backslash still continues the line (Shell3 rule order). */
	public function test_trailing_backslash_is_still_a_continuation(): void {
		$shell = new Shell_Node();
		$this->assertNull( $shell->parse( 'tell node \\' ) );
		$message = $shell->parse( 'hello' );

		$this->assertNotNull( $message, 'the continuation must complete on the next line' );
		$this->assertSame( 'hello', $message[ Message::VALUE ] );
	}

	/** An ESCAPED trailing backslash is a literal, not a continuation. */
	public function test_even_trailing_backslashes_are_not_a_continuation(): void {
		$shell = new Shell_Node();
		$bs    = \chr( 92 );
		// `tell node a\\` — the pair is one literal backslash; the line is complete.
		$message = $shell->parse( "tell node a{$bs}{$bs}" );

		$this->assertNotNull( $message, 'an escaped backslash must not hold the line' );
		$this->assertSame( "a{$bs}", $message[ Message::VALUE ] );
	}

	/** A commented line is inert — its `<tokens>` must not warn (aggregator.tsl). */
	public function test_comment_line_does_not_interpolate_or_warn(): void {
		$shell   = new Shell_Node();
		$emitted = [];
		Core::set_stderr_handler( static function ( string $t ) use ( &$emitted ): void {
			$emitted[] = $t;
		} );

		$this->assertNull( $shell->parse( '#   make_node Remote_Source spoke-<id> <vault-id>' ) );
		$this->assertSame( [], $emitted, 'a commented example must not warn' );
	}

	/** An indented comment is still a comment (the aggregator.tsl block is). */
	public function test_indented_comment_line_does_not_warn(): void {
		$shell   = new Shell_Node();
		$emitted = [];
		Core::set_stderr_handler( static function ( string $t ) use ( &$emitted ): void {
			$emitted[] = $t;
		} );

		$this->assertNull( $shell->parse( '    # spoke-<id>' ) );
		$this->assertSame( [], $emitted );
	}

	/** Through the REAL default handler, the REPL sink sees it bare. */
	public function test_uninitialized_warning_reaches_the_repl_unprefixed(): void {
		$shell   = new Shell_Node();
		$capture = $this->register_output_capture();

		$shell->interpolate( 'tell <ghost> hello' );

		// Shell3 writes straight to STDERR: no timestamp, no hostname, no pid.
		// Core::_stderr is a diagnostic path, so it lands on `_output`, not the
		// `_stdout` a builtin prints through.
		$this->assertSame(
			"WARNING: use of uninitialized value <ghost>\n",
			$capture->dumper->captured[0][ Message::VALUE ]
		);
	}

	/** A var defined as empty interpolates silently — defined beats non-empty. */
	public function test_interpolating_a_defined_empty_var_does_not_warn(): void {
		$shell = new Shell_Node();
		$shell->parse( 'var hollow' );
		$emitted = [];
		Core::set_stderr_handler( static function ( string $t ) use ( &$emitted ): void {
			$emitted[] = $t;
		} );

		$this->assertSame( 'tell  hello', $shell->interpolate( 'tell <hollow> hello' ) );
		$this->assertSame( [], $emitted );
	}

	/** The documented operator set (Shell3.pm `$H{'var'}` + operate_with_value). */
	public function test_assignment_operators(): void {
		$shell = new Shell_Node();
		$shell->parse( 'var s = ab' );
		$shell->parse( 'var s .= cd' );
		$this->assertSame( 'ab cd', Core::$var['s'], '.= joins with a space' );

		$shell->parse( 'var n = 10' );
		$shell->parse( 'var n += 5' );
		$this->assertSame( '15', Core::$var['n'] );
		$shell->parse( 'var n -= 3' );
		$this->assertSame( '12', Core::$var['n'] );
		$shell->parse( 'var n *= 2' );
		$this->assertSame( '24', Core::$var['n'] );
		$shell->parse( 'var n /= 4' );
		$this->assertSame( '6', Core::$var['n'] );

		$shell->parse( 'var n ++' );
		$this->assertSame( '7', Core::$var['n'] );
		$shell->parse( 'var n --' );
		$this->assertSame( '6', Core::$var['n'] );
	}

	/** `//=` fills only an UNSET var; `||=` also fills an empty one. */
	public function test_defined_or_and_logical_or_assignment(): void {
		$shell = new Shell_Node();
		$shell->parse( 'var a = kept' );
		$shell->parse( 'var a //= ignored' );
		$this->assertSame( 'kept', Core::$var['a'] );

		$shell->parse( 'var b =' );
		$shell->parse( 'var b //= filled' );
		$this->assertSame( 'filled', Core::$var['b'] );

		$shell->parse( 'var c' );
		$shell->parse( 'var c //= kept-empty' );
		$this->assertSame( '', Core::$var['c'], '//= keeps a DEFINED empty value' );
		$shell->parse( 'var c ||= replaced' );
		$this->assertSame( 'replaced', Core::$var['c'], '||= replaces an empty value' );

		$shell->parse( 'var d = 0' );
		$shell->parse( 'var d //= untouched' );
		$this->assertSame( '0', Core::$var['d'], '//= keeps a defined falsy value' );
	}

	/** Port of Shell3.pm:2241 — `message.key` is read out of var scope at mint. */
	public function test_message_key_var_stamps_KEY_on_a_minted_message(): void {
		$shell = new Shell_Node();
		$this->assertNull( $shell->parse( 'var message.key = trace-77' ) );
		$message = $shell->parse( 'send node bytes' );

		$this->assertSame( 'trace-77', $message[ Message::KEY ] );
	}

	/** Every mint site reads it, not just send_node (Shell3.pm:2241/2275/2307/2342). */
	public function test_message_key_var_stamps_KEY_on_tell_request_and_command(): void {
		$shell = new Shell_Node();
		$shell->parse( 'var message.key = trace-77' );

		$this->assertSame( 'trace-77', $shell->parse( 'tell node info' )[ Message::KEY ] );
		$this->assertSame( 'trace-77', $shell->parse( 'request node q' )[ Message::KEY ] );
		$this->assertSame( 'trace-77', $shell->parse( 'cmd node ls' )[ Message::KEY ] );
	}

	/** Unset leaves KEY empty — the var is opt-in, never a synthesized default. */
	public function test_KEY_is_empty_when_no_message_key_var_is_set(): void {
		$shell = new Shell_Node();
		$this->assertSame( '', $shell->parse( 'send node bytes' )[ Message::KEY ] );
	}

	/** ID is var-settable here — a divergence from Shell3, where it is shell-owned. */
	public function test_message_id_var_stamps_ID_on_a_minted_message(): void {
		$shell = new Shell_Node();
		$shell->parse( 'var message.id = 4242' );

		$this->assertSame( '4242', $shell->parse( 'send node bytes' )[ Message::ID ] );
	}

	/** Port of Shell3.pm:2240 — `message.from` overrides the session's reply path. */
	public function test_message_from_var_overrides_the_default_reply_path(): void {
		$shell = new Shell_Node();
		$shell->parse( 'var message.from = elsewhere/sink' );

		$this->assertSame( 'elsewhere/sink', $shell->parse( 'send node bytes' )[ Message::FROM ] );
	}

	/** Unset falls back to `_output/<pid>` so replies reach this session's Dumper. */
	public function test_FROM_defaults_to_the_session_output_path(): void {
		$shell = new Shell_Node();

		$this->assertSame(
			Node_Names::OUTPUT . '/' . \getmypid(),
			$shell->parse( 'send node bytes' )[ Message::FROM ]
		);
	}

	/** TIMESTAMP is forgeable for the same reason ID is: debugging. */
	public function test_message_timestamp_var_stamps_TIMESTAMP(): void {
		$shell = new Shell_Node();
		$shell->parse( 'var message.timestamp = 1700000000' );

		$this->assertSame( '1700000000', $shell->parse( 'send node bytes' )[ Message::TIMESTAMP ] );
	}

	/** Unset TIMESTAMP still gets the mint clock, never an empty string. */
	public function test_TIMESTAMP_defaults_to_the_mint_clock(): void {
		Core::$now = 1234567890.5;
		$shell     = new Shell_Node();

		$this->assertSame( 1234567890.5, $shell->parse( 'send node bytes' )[ Message::TIMESTAMP ] );
	}

	/** Unset ID stays empty — opt-in, never synthesized. */
	public function test_ID_is_empty_when_no_message_id_var_is_set(): void {
		$shell = new Shell_Node();
		$this->assertSame( '', $shell->parse( 'send node bytes' )[ Message::ID ] );
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
		// Must round-trip EXACTLY. A lossy stamp that rounds up reads as sent
		// later than received, so a local ping's RTT comes out negative.
		$this->assertSame( '1234567890.123456', $message[ Message::VALUE ] );
		$this->assertSame(
			\Newspack_Nodes\Core::$now,
			(float) $message[ Message::VALUE ],
			'ping stamp lost precision'
		);
		$this->assertStringStartsWith( '_output/', $message[ Message::FROM ] );
	}

	public function test_parse_default_verb_yields_TM_COMMAND(): void {
		$shell = new Shell_Node();
		$message = $shell->parse( 'ls');

		$this->assertSame( Message::TM_COMMAND, $message[ Message::TYPE ] );
		// VALUE rides as a live PHP array — no JSON string to decode.
		$cmd = $message[ Message::VALUE ];
		$this->assertSame( 'ls', $cmd['name'] );
		$this->assertSame( [], $cmd['arguments'] );
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
		$this->assertSame( [ 'Capture_Sink', 'alice' ], $cmd['arguments'] );
	}

	public function test_parse_cmd_preserves_a_quoted_arg_as_one_token(): void {
		// The keystone: a quoted multi-word arg survives as ONE token all the way
		// into VALUE['arguments'], instead of being flattened to a re-split string.
		$shell   = new Shell_Node();
		$message = $shell->parse( "cmd node:config set_label 'a b'" );

		$cmd = $message[ Message::VALUE ];
		$this->assertSame( 'set_label', $cmd['name'] );
		$this->assertSame( [ 'a b' ], $cmd['arguments'] );
	}

	/**
	 * Builtins route output through `Core::node('_output')` when it is a
	 * Dumper. Capture_Sink_Node extends Dumper_Node, so registering one as
	 * `_output` captures each emitted bytestream Message for assertion.
	 */
	/**
	 * Mount both halves of the REPL's output: `_stdout`, where a builtin's text
	 * lands, and the `_output` Dumper the `debug_level` builtin dials. Returns
	 * the stdout capture; `$capture->dumper` is the Dumper.
	 */
	private function register_output_capture(): Capture_Stdout_Node {
		$dumper = new Capture_Sink_Node();
		$dumper->name( '_output' );
		$capture = new Capture_Stdout_Node();
		$capture->name( '_stdout' );
		$capture->dumper = $dumper;
		return $capture;
	}

	public function test_parse_continues_an_open_quote_across_lines(): void {
		// Tachikoma parity: an open quote continues the statement onto the next
		// line (the `'>` prompt), newline included in the token.
		$shell = new Shell_Node();

		$this->assertNull( $shell->parse( "tell node 'foo" ) );
		$this->assertSame( "'> ", $shell->prompt, 'continuation prompt while the quote is open' );

		$message = $shell->parse( "bar'" );
		$this->assertNotNull( $message );
		$this->assertSame( "foo\nbar", $message[ Message::VALUE ] );
		$this->assertSame( '/> ', $shell->prompt, 'prompt restored after the quote closes' );
	}

	public function test_eval_script_carries_a_quoted_newline_through_one_statement(): void {
		$capture = new Capture_Sink_Node();
		$shell   = new Shell_Node();
		$shell->sink( $capture );

		$shell->eval_script( "tell node 'foo\nbar; baz'\n" );

		$this->assertCount( 1, $capture->captured, 'a quoted ; or newline must not split the statement' );
		$this->assertSame( "foo\nbar; baz", $capture->captured[0][ Message::VALUE ] );
	}

	public function test_flush_pending_throws_on_eof_inside_a_quote_in_script_context(): void {
		// Tachikoma: `ERROR: got EOF while waiting for tokens`.
		$shell = new Shell_Node();
		$shell->sink( new Capture_Sink_Node() );
		$shell->fatal_errors( true );
		$shell->eval_script( "cmd digest:config add_profile Don't produce tables." );
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'got EOF while waiting for tokens' );
		$shell->flush_pending();
	}

	public function test_flush_pending_reports_and_clears_interactively(): void {
		$capture = $this->register_output_capture();
		$shell   = new Shell_Node();

		$this->assertNull( $shell->parse( "tell node 'foo" ) );
		$shell->flush_pending();

		$out = \implode( '', \array_column( $capture->captured, Message::VALUE ) );
		$this->assertStringContainsString( 'got EOF while waiting for tokens', $out );
		$this->assertSame( '/> ', $shell->prompt );
		$this->assertNotNull( $shell->parse( "tell node ok" ), 'accumulator cleared; the next statement parses fresh' );
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
		$this->assertSame( 0, $capture->dumper->debug_level(), 'default off' );

		$shell = new Shell_Node();

		$this->assertNull( $shell->parse( 'debug_level' ) );
		$this->assertSame( 1, $capture->dumper->debug_level(), 'toggle 0→1' );
		$this->assertSame( "debug_level: 1\n", $capture->captured[0][ Message::VALUE ] );

		$this->assertNull( $shell->parse( 'debug_level' ) );
		$this->assertSame( 0, $capture->dumper->debug_level(), 'toggle back 1→0' );
	}

	public function test_parse_clear_emits_the_terminal_erase_sequence(): void {
		// QoL parity with the browser REPL's Ctrl-L. A terminal has no
		// transcript to wipe, so the wipe is output: erase display, home cursor.
		$capture = $this->register_output_capture();

		$shell = new Shell_Node();

		$this->assertNull( $shell->parse( 'clear' ), 'clear sends no Message' );
		$this->assertNotEmpty( $capture->captured, 'clear printed nothing' );
		$this->assertSame( "\033[2J\033[H", $capture->captured[0][ Message::VALUE ] );
	}

	public function test_parse_debug_level_with_explicit_argument_sets(): void {
		// `debug_level 2` explicitly sets to 2 (max).
		$capture = $this->register_output_capture();

		$shell = new Shell_Node();

		$this->assertNull( $shell->parse( 'debug_level 2' ) );
		$this->assertSame( 2, $capture->dumper->debug_level() );
		$this->assertSame( "debug_level: 2\n", $capture->captured[0][ Message::VALUE ] );
	}

	public function test_parse_debug_level_refuses_a_non_numeric_argument(): void {
		// Tachikoma Shell.pm:158 refuses anything but `^\d+$`; a cast would read
		// `frobnicate` as 0 and silently turn the dial off.
		$capture = $this->register_output_capture();
		$capture->dumper->set_debug_level( 2 );

		$shell = new Shell_Node();

		$this->assertNull( $shell->parse( 'debug_level frobnicate' ) );
		$this->assertSame( 2, $capture->dumper->debug_level(), 'a refusal changes nothing' );
		$this->assertSame( "usage: debug_level [0|1|2]\n", $capture->captured[0][ Message::VALUE ] );
	}

	public function test_parse_debug_level_refuses_a_level_above_the_maximum(): void {
		// The JS twin refuses `> 2` rather than clamping it; so does this one.
		$capture = $this->register_output_capture();
		$capture->dumper->set_debug_level( 1 );

		$shell = new Shell_Node();

		$this->assertNull( $shell->parse( 'debug_level 7' ) );
		$this->assertSame( 1, $capture->dumper->debug_level(), 'a refusal changes nothing' );
		$this->assertSame( "usage: debug_level [0|1|2]\n", $capture->captured[0][ Message::VALUE ] );
	}

	public function test_parse_debug_level_reports_a_missing_output_dumper(): void {
		// A Shell driving a TSL in worker or request scope has no `_output`
		// Dumper to dial. Silence reads as success for a verb the user typed.
		$capture = new Capture_Stdout_Node();
		$capture->name( Node_Names::STDOUT );

		$shell = new Shell_Node();

		$this->assertNull( $shell->parse( 'debug_level 2' ) );
		$this->assertSame(
			'debug_level: unknown node: ' . Node_Names::OUTPUT . "\n",
			$capture->captured[0][ Message::VALUE ] ?? ''
		);
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

	public function test_parse_show_parse_toggling_off_reports_off(): void {
		// Toggling the flag a second time turns it back off and reports "off".
		$capture = $this->register_output_capture();
		$shell   = new Shell_Node();

		$this->assertNull( $shell->parse( 'show_parse' ) );
		$this->assertSame( "show_parse: on\n", $capture->captured[0][ Message::VALUE ] );

		// Second toggle: show_parse is still on, so parse diagnostics emit first,
		// then the state line reports the new "off" state.
		$this->assertNull( $shell->parse( 'show_parse' ) );
		$this->assertSame( "show_parse: off\n", $capture->captured[2][ Message::VALUE ] );
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

	public function test_backslash_continuation_splices_with_nothing_like_bash(): void {
		// bash + Tachikoma: `print hi\` + `bye` -> `hibye`, and the pending
		// continuation shows a bare `> ` prompt.
		$capture = $this->register_output_capture();
		$shell   = new Shell_Node();

		$this->assertNull( $shell->parse( 'print hi\\' ) );
		$this->assertSame( '> ', $shell->prompt, 'bare continuation prompt while pending' );

		$this->assertNull( $shell->parse( 'bye' ), 'print is a local builtin' );
		$this->assertSame( '/> ', $shell->prompt, 'prompt restored' );

		$out = \implode( '', \array_column( $capture->captured, Message::VALUE ) );
		// `print` appends nothing — the splice itself is what's under test.
		$this->assertSame( 'hibye', $out );
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

	public function test_an_escaped_trailing_backslash_is_a_complete_statement(): void {
		// One grammar rule, ONE definition: a line continues only on an ODD run
		// of trailing backslashes. `tell n1 back\\` ends in an escaped literal,
		// so the loader parses it whole and the topology `save` verb must not
		// reject it as unterminated. parse_statements() is that one definition —
		// the second copy (validate_line) was deleted, not the rule.
		$line  = 'tell n1 back\\\\';
		$shell = new Shell_Node();
		$this->assertCount( 1, Shell_Node::parse_statements( $line ) );
		$this->assertNotNull( $shell->parse( $line ), 'the loader parses it as a complete statement' );
	}

	public function test_an_odd_trailing_backslash_run_is_an_unterminated_continuation(): void {
		$line  = 'tell n1 back\\\\\\';
		$shell = new Shell_Node();
		$this->assertNull( $shell->parse( $line ), 'the loader holds it as a continuation' );
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'got EOF while waiting for tokens at line 1' );
		Shell_Node::parse_statements( $line );
	}

	public function test_fill_passes_a_non_bytestream_message_through_to_the_sink(): void {
		// Not REPL input, so there is nothing to parse — Tachikoma
		// Shell::fill sinks any non-TM_BYTESTREAM message rather than
		// dropping it, and the JS twin does the same.
		$shell = new Shell_Node();
		$sink  = new Capture_Sink_Node();
		$shell->sink( $sink );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_COMMAND;
		$message[ Message::VALUE ] = [ 'name' => 'ls', 'arguments' => [] ];
		$shell->fill( $message );

		$this->assertCount( 1, $sink->captured );
		$this->assertSame( Message::TM_COMMAND, $sink->captured[0][ Message::TYPE ] );
	}

	public function test_fill_forwards_a_pre_signed_command_untouched(): void {
		// ADR-15: the MINTER signs, never the ingress. A command already bound
		// to a remote session must cross the Shell byte-identical — re-signing
		// it here would replace the envelope with a local-secret one and drop
		// the handle, silently unbinding it from its destination.
		Command_Auth::remember_session( 'hub-7', 'handle-4b19c2', 'key-77f0a3d6' );
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_COMMAND;
		$message[ Message::VALUE ] = [
			'name'      => 'set_retention',
			'arguments' => [ '--segments=17' ],
		];
		Command_Auth::sign_for( 'hub-7', $message );
		$signed = $message;

		$shell = new Shell_Node();
		$sink  = new Capture_Sink_Node();
		$shell->sink( $sink );
		$shell->fill( $message );

		Command_Auth::forget_session( 'hub-7' );
		$this->assertSame( $signed, $sink->captured[0], 'a pre-built command passes through verbatim' );
		$this->assertSame(
			'handle-4b19c2',
			$sink->captured[0][ Message::VALUE ]['auth']['handle'],
			'the destination binding survives the Shell'
		);
	}

	public function test_fill_parses_a_bytestream_carrying_an_extra_flag(): void {
		// TYPE is a bitmask: a composite TM_BYTESTREAM|TM_NOREPLY line is
		// still REPL input. An exact-equality test would reject it as
		// non-input and pass the raw line through unparsed.
		$shell = new Shell_Node();
		$sink  = new Capture_Sink_Node();
		$shell->sink( $sink );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM | Message::TM_NOREPLY;
		$message[ Message::VALUE ] = 'ls';
		$shell->fill( $message );

		$this->assertCount( 1, $sink->captured );
		$this->assertSame( 'ls', $sink->captured[0][ Message::VALUE ]['name'] );
	}

	public function test_fill_drains_an_eof_carrying_an_extra_flag(): void {
		// Same bitmask reading on the drain marker.
		$shell       = new Shell_Node();
		$shell->path = 'firehose-workers.p0';
		$sink        = new Capture_Sink_Node();
		$shell->sink( $sink );

		$message                  = Message::new_message();
		$message[ Message::TYPE ] = Message::TM_EOF | Message::TM_NOREPLY;
		$message[ Message::FROM ] = 'upstream';
		$shell->fill( $message );

		$this->assertCount( 1, $sink->captured );
		$out = $sink->captured[0];
		$this->assertSame( '_output/' . \getmypid(), $out[ Message::FROM ] );
		$this->assertSame( 'firehose-workers.p0', $out[ Message::TO ] );
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
		$dir = $this->make_temp_dir();
		\file_put_contents( "$dir/script.tsl", "tell alpha first\ntell beta second\n# comment\n" );
		// include takes a registry NAME, not a path — register the dir.
		\Newspack_Nodes\Topology_Registry::register_stock_dir( $dir );

		// include is processed inline; each parsed line goes through fill() → sink.
		$shell = new Shell_Node();
		$sink  = new Capture_Sink_Node();
		$shell->sink( $sink );

		$result = $shell->parse( 'include script' );
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
		$this->assertSame( [ '-al' ], $decoded['arguments'] );
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
		$this->assertSame( [ '-al' ], $decoded['arguments'] );
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
		$this->assertSame( [ 'firehose-workers.p0' ], $decoded['arguments'] );
	}

	public function test_pwd_at_root_emits_with_empty_TO(): void {
		// `pwd` at empty cwd targets the local interpreter (TO='').
		$shell = new Shell_Node();
		$message = $shell->parse( 'pwd' );
		$this->assertSame( '', $message[ Message::TO ] );
		$decoded = $message[ Message::VALUE ];
		$this->assertSame( [], $decoded['arguments'] );
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
			\file_put_contents( "{$tmp}/cmds.tsl", "ls\ntell node hi\n" );
			\Newspack_Nodes\Topology_Registry::register_stock_dir( $tmp );

			$shell = new Shell_Node();
			$sink  = new Capture_Sink_Node();
			$shell->sink( $sink );

			$shell->parse( 'include cmds' );

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

	/**
	 * The JS twin refuses each path-taking verb with a `usage:` line when the
	 * path argument is missing (Tachikoma's CommandInterpreter dies "no path
	 * specified"). PHP minted the message anyway: with no cwd that is TO='',
	 * which Router drops as "message not addressed" — a command that vanishes.
	 *
	 * @dataProvider path_taking_verbs
	 */
	public function test_a_path_taking_verb_without_a_path_prints_usage( string $verb, string $usage ): void {
		$capture = $this->register_output_capture();
		$shell   = new Shell_Node();
		$shell->sink( new Capture_Sink_Node() );

		$this->assertNull( $shell->parse( $verb ), "$verb should mint nothing" );
		$printed = \implode( '', \array_column( $capture->captured, Message::VALUE ) );
		$this->assertStringContainsString( $usage, $printed );
	}

	/** @return array<string,array{0:string,1:string}> */
	public static function path_taking_verbs(): array {
		return [
			'send'        => [ 'send', 'usage: send <path> <bytes>' ],
			'send_node'   => [ 'send_node', 'usage: send <path> <bytes>' ],
			'request'     => [ 'request', 'usage: request <path> <args>' ],
			'tell'        => [ 'tell', 'usage: tell <path> <bytes>' ],
			'send_struct' => [ 'send_struct', 'usage: send_struct <path> <json>' ],
			'send_eof'    => [ 'send_eof', 'usage: send_eof <path>' ],
			'cmd'         => [ 'cmd', 'usage: cmd <path> <verb> [<args>]' ],
			// A path but no verb name mints a command with an empty name, which
			// the interpreter answers `unknown command: ` — the JS twin refuses.
			'cmd-no-verb' => [ 'cmd beacon', 'usage: cmd <path> <verb> [<args>]' ],
		];
	}
}
