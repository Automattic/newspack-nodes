<?php
/**
 * Dumper: terminal output node for the REPL.
 *
 * Dispatches by TYPE flag:
 *  - TM_COMMAND|TM_RESPONSE → unwrap Command JSON, print payload to stdout
 *    (special case: name=='prompt' updates the Shell's prompt, no print)
 *  - TM_ERROR               → "ERROR: …" to stderr
 *  - TM_INFO                → payload to stdout (no prefix; the `debug_level 1`
 *                              header already labels TM_INFO when it's wanted)
 *  - default                → VALUE to stdout
 *
 * Async-output dance: when a TM_INFO or default-bytestream message arrives while
 * a prompt is on screen, the Dumper emits ANSI escape codes so the async output
 * appears above a freshly-redrawn prompt instead of trampling the user's typing:
 *   1. \033[s         — save cursor (capture user's caret column)
 *   2. \r\033[2K      — CR + clear-to-EOL (wipe the in-flight prompt)
 *   3. async output + "\n"
 *   4. $shell->prompt — redraw prompt on the fresh line
 *   5. \033[u         — restore cursor (best-effort caret return)
 *
 * Synchronous responses (TM_COMMAND|TM_RESPONSE, TM_ERROR) skip the redraw —
 * those are direct answers to the user's last command and the caller (Shell)
 * is already responsible for re-prompting.
 *
 * Non-TTY stdout falls back to plain writes (no ANSI escapes) — escape sequences
 * in a piped log file are noise.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Dumper extends Node {
	// ANSI escape sequences. Pre-computed constants — declared once, used on every
	// async write (efficiency principle: pre-compute at setup).
	//
	// Sequence used:
	//   \033[s   save cursor       — captures column of user's typed-input caret
	//   \r       carriage return   — moves to start of line
	//   \033[2K  erase entire line — wipes the in-flight prompt+input
	//   (write async output + "\n")
	//   (write $shell->prompt)
	//   \033[u   restore cursor    — best-effort return to caret column past prompt
	//
	// Concatenated into a single fwrite so partial-write windows are minimized;
	// the wipe and redraw normally hit the terminal in one syscall.
	private const ANSI_SAVE_CURSOR    = "\033[s";
	private const ANSI_RESTORE_CURSOR = "\033[u";
	private const ANSI_CR_CLEAR_LINE  = "\r\033[2K";

	/** @var resource */
	private $stdout;
	/** @var resource */
	private $stderr;

	private ?Shell $shell = null;

	/**
	 * Tracks whether a prompt is currently on the user's screen. Set by
	 * mark_prompt_displayed() (called by the Cli loop right after writing the
	 * prompt); cleared by the Dumper after each redraw of the prompt below
	 * async output. Public so the Cli readline loop can flip it without
	 * needing a setter call per iteration.
	 */
	public bool $prompt_displayed = false;

	/**
	 * Whether stdout is a real terminal. Cached at construction so we don't
	 * call posix_isatty() per message. False → fall back to plain writes.
	 */
	private bool $stdout_is_tty;

	/**
	 * Set by Cli_Command when the REPL is using readline_callback_handler_install
	 * (the non-blocking readline path that mirrors Term::ReadLine::Gnu's
	 * callback_handler_install). When true, async output uses
	 * readline_on_new_line() + readline_redisplay() to re-paint the prompt
	 * instead of the manual ANSI cursor-save/restore dance — readline owns
	 * the line buffer and would otherwise be left out of sync.
	 */
	private bool $readline_mode = false;

	/**
	 * @param resource|null $stdout Defaults to STDOUT. Pass php://memory for tests.
	 * @param resource|null $stderr Defaults to STDERR.
	 * @param bool|null     $force_tty If non-null, override the posix_isatty()
	 *                                 detection (tests pass true to exercise the
	 *                                 escape-sequence path on a memory stream).
	 */
	public function __construct( $stdout = null, $stderr = null, ?bool $force_tty = null ) {
		$this->stdout = $stdout ?? \STDOUT;
		$this->stderr = $stderr ?? \STDERR;

		if ( null !== $force_tty ) {
			$this->stdout_is_tty = $force_tty;
		} else {
			$this->stdout_is_tty = \is_resource( $this->stdout )
				&& \function_exists( 'posix_isatty' )
				&& @\posix_isatty( $this->stdout );
		}
	}

	public function set_shell( Shell $shell ): void {
		$this->shell = $shell;
	}

	public function set_readline_mode( bool $on ): void {
		$this->readline_mode = $on;
	}

	/**
	 * Multi-session TO filter — set to this cli's $pid. Render iff TO matches
	 * either `_output/$pid` (worker reply that didn't peel _output) or
	 * `$pid` (worker reply that did peel via _router) OR TO is empty (async
	 * broadcast / synthetic in-process response). Other sessions' replies are
	 * dropped silently. Spec line 856; user direction in REPL pivoted-mode
	 * thread.
	 */
	private string $to_filter = '';

	/**
	 * Broadcast TO addresses the Dumper should ALSO render in addition to its
	 * own pid/to_filter traffic. Empty = render only personal traffic. Used by
	 * `show_sse` (and any future similar toggles) to opt into watching a
	 * worker-side fan-out stream — `TO=sse` traffic, after `_router` peels the
	 * `_repl` conduit prefix on the producer side, becomes a bare `sse` here.
	 *
	 * Matched as an exact equality against the (already-peeled) TO. No pid
	 * suffix, no regex — the broadcast address is a fixed identity that
	 * multiple cli/SSE sessions all consume.
	 *
	 * @var array<string,bool> Set-of-strings, e.g. [ 'sse' => true ].
	 */
	private array $broadcast_filter = [];

	/**
	 * Callback fired when a TM_EOF echo arrives matching the to_filter — the
	 * cli's stdin-close round-trip drain marker. Cli wires this to flip the
	 * reader's exit flag so the event loop terminates after the echo (i.e.
	 * after every preceding output message has been drained off the reply
	 * partition). Null when not registered.
	 *
	 * @var callable|null
	 */
	private $on_eof = null;

	public function on_eof( ?callable $cb ): void {
		$this->on_eof = $cb;
	}

	public function set_to_filter( string $pid ): void {
		$this->to_filter = $pid;
	}

	/**
	 * Render-verbosity dial. Mirrors Perl Tachikoma `debug_level` semantics:
	 *
	 *   0 (default) — interactive rendering only; control messages (TM_EOF
	 *                 echo) silenced; the user sees curated output.
	 *   1           — additionally emit a one-line debug header to stderr
	 *                 for EVERY Message that arrives at this Dumper, including
	 *                 messages the normal renderer would silence. Format:
	 *                   <TM_FLAGS> from <FROM>: <stringified-value>
	 *   2           — same as 1, but the header is the full envelope:
	 *                   <TM_FLAGS> id=<ID> stream=<STREAM> from=<FROM> to=<TO>
	 *                 followed by the value on the next line.
	 *
	 * The normal render still happens after the debug header, so level 1/2
	 * additively narrate without replacing user-friendly output.
	 *
	 * @var int 0, 1, or 2.
	 */
	private int $debug_level = 0;

	/**
	 * Set the debug-render level. Clamps to [0, 2]. Returns the value actually
	 * applied so the Shell builtin can report `debug_level: <n>` to the user.
	 */
	public function set_debug_level( int $level ): int {
		$this->debug_level = \max( 0, \min( 2, $level ) );
		return $this->debug_level;
	}

	/**
	 * Read-only accessor — used by Shell builtins to toggle (read current,
	 * pass `!current` to set) and by tests.
	 */
	public function debug_level(): int {
		return $this->debug_level;
	}

	/**
	 * Render a TM-flag bitmask as a human-readable string. Multi-flag types
	 * (TM_COMMAND|TM_RESPONSE etc.) get all their flags concatenated.
	 */
	private static function format_type_flags( int $type ): string {
		static $map = [
			Message::TM_BYTESTREAM => 'TM_BYTESTREAM',
			Message::TM_EOF        => 'TM_EOF',
			Message::TM_PING       => 'TM_PING',
			Message::TM_COMMAND    => 'TM_COMMAND',
			Message::TM_RESPONSE   => 'TM_RESPONSE',
			Message::TM_ERROR      => 'TM_ERROR',
			Message::TM_INFO       => 'TM_INFO',
			Message::TM_STRUCT     => 'TM_STRUCT',
			Message::TM_REQUEST    => 'TM_REQUEST',
		];
		$flags = [];
		foreach ( $map as $flag => $name ) {
			if ( $type & $flag ) {
				$flags[] = $name;
			}
		}
		return $flags ? \implode( ' | ', $flags ) : \sprintf( 'TM_UNKNOWN(0x%x)', $type );
	}

	/**
	 * Level-2 dump: full envelope as a structural multi-line render. Equivalent
	 * to Perl's `$message->as_string`, which Data::Dumper-prints all envelope
	 * fields with the value unwrapped (TM_COMMAND values get their inner
	 * Tachikoma::Command shown as a sub-hash). Goal here is to be every bit
	 * as readable: each envelope field on its own line, type flags by name,
	 * timestamp humanized, value either pretty-printed JSON (for TM_STRUCT
	 * arrays) or — for TM_COMMAND envelopes — the decoded inner command as
	 * a nested block.
	 */
	private function format_envelope_dump( array $message ): string {
		$type      = (int) ( $message[ Message::TYPE ] ?? 0 );
		$flags     = self::format_type_flags( $type );
		$ts        = (string) ( $message[ Message::TIMESTAMP ] ?? '' );
		$ts_human  = '' !== $ts && \is_numeric( $ts )
			? \gmdate( 'Y-m-d H:i:s', (int) $ts ) . ' UTC'
			: '';
		$value     = self::stringify_value( $message[ Message::VALUE ] ?? '', true );

		$lines = [
			'Message {',
			'    type:      ' . $flags,
			'    from:      ' . (string) ( $message[ Message::FROM ] ?? '' ),
			'    to:        ' . (string) ( $message[ Message::TO ] ?? '' ),
			'    id:        ' . (string) ( $message[ Message::ID ] ?? '' ),
			'    key:       ' . (string) ( $message[ Message::KEY ] ?? '' ),
			'    timestamp: ' . $ts . ( '' !== $ts_human ? ' (' . $ts_human . ')' : '' ),
			'    value:     ' . self::indent_following_lines( $value, '               ' ),
			'}',
		];
		return \implode( "\n", $lines );
	}

	/**
	 * Stringify a Message::VALUE for debug rendering.
	 *
	 * - Arrays (TM_STRUCT VALUE) → JSON. Pretty-printed when $structured=true.
	 * - JSON-encoded Command strings (TM_COMMAND VALUE — `{"name":...,"payload":...}`):
	 *   decode and re-render so the user sees the command structure, not a
	 *   stringified-of-string. Matches Perl Tachikoma which calls
	 *   `Tachikoma::Command->new($payload)` and renders the resulting hash.
	 *   (The inner `payload` field is a Tachikoma::Command convention; the
	 *   outer Message slot is what we call VALUE.)
	 * - Plain strings → as-is.
	 *
	 * @param mixed $value      Raw VALUE.
	 * @param bool  $structured Whether to use JSON_PRETTY_PRINT for arrays.
	 */
	private static function stringify_value( $value, bool $structured ): string {
		if ( \is_array( $value ) ) {
			$flags = JSON_UNESCAPED_SLASHES;
			if ( $structured ) {
				$flags |= JSON_PRETTY_PRINT;
			}
			return (string) \wp_json_encode( $value, $flags );
		}
		if ( \is_string( $value ) && '' !== $value && ( '{' === $value[0] || '[' === $value[0] ) ) {
			$decoded = \json_decode( $value, true );
			if ( \is_array( $decoded ) ) {
				$flags = JSON_UNESCAPED_SLASHES;
				if ( $structured ) {
					$flags |= JSON_PRETTY_PRINT;
				}
				return (string) \wp_json_encode( $decoded, $flags );
			}
		}
		return (string) $value;
	}

	/**
	 * Indent every line after the first by $prefix. Used so the value block
	 * sits visually under `value:` rather than wrapping under the column.
	 */
	private static function indent_following_lines( string $text, string $prefix ): string {
		$lines = \explode( "\n", $text );
		if ( \count( $lines ) <= 1 ) {
			return $text;
		}
		return $lines[0] . "\n" . \implode( "\n", \array_map( static fn ( $l ) => $prefix . $l, \array_slice( $lines, 1 ) ) );
	}

	/**
	 * Toggle whether the Dumper renders TM_BYTESTREAM/TM_STRUCT messages with
	 * a given broadcast address (post-router-peel form — e.g. 'sse' for the
	 * `_repl/sse` fan-out). Idempotent; returns the new state so the caller
	 * (Shell builtin) can report `show_sse: on` / `show_sse: off`.
	 *
	 * @param string $name        Broadcast address (post-peel form).
	 * @param bool|null $explicit If null, toggles current state; otherwise sets.
	 * @return bool New state.
	 */
	public function toggle_broadcast_filter( string $name, ?bool $explicit = null ): bool {
		$current = ! empty( $this->broadcast_filter[ $name ] );
		$next    = $explicit ?? ! $current;
		if ( $next ) {
			$this->broadcast_filter[ $name ] = true;
		} else {
			unset( $this->broadcast_filter[ $name ] );
		}
		return $next;
	}

	/**
	 * Read-only accessor — used by Shell builtins to report current state and
	 * by tests to assert the filter map without exposing the internal storage.
	 */
	public function broadcast_filter_enabled( string $name ): bool {
		return ! empty( $this->broadcast_filter[ $name ] );
	}

	/**
	 * Cli readline loop calls this immediately after writing the prompt so the
	 * Dumper knows to wipe-and-redraw on the next async write.
	 */
	public function mark_prompt_displayed(): void {
		$this->prompt_displayed = true;
	}

	/**
	 * Write the cli prompt onto our owned stdout stream and flip the
	 * prompt-displayed flag. Routed through Dumper (rather than `fwrite(STDOUT,
	 * …)` at the call site) so tests with a memory-stream Dumper don't pollute
	 * phpunit's real STDOUT.
	 */
	public function write_prompt( string $prompt ): void {
		// $this->stdout is the cli's own output stream (real STDOUT in
		// production; injected php://memory in tests).
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_fwrite
		\fwrite( $this->stdout, $prompt );
		$this->prompt_displayed = true;
	}

	public function fill( array &$message ): void {
		++$this->counter;

		// Multi-session filter: drop messages addressed to a different cli
		// session. Match `_output/$pid` and `$pid` (the two forms a reply
		// can take depending on whether _router peeled the _output
		// segment). Empty TO is always rendered. Broadcasts (an exact TO
		// match in the broadcast_filter set, e.g. `sse`) are also rendered
		// — used by `show_sse` to opt into the worker's _repl/sse fan-out.
		if ( '' !== $this->to_filter ) {
			$to = (string) $message[ Message::TO ];
			if ( '' !== $to
				&& ! \preg_match( '/^(?:_output\/)?' . \preg_quote( $this->to_filter, '/' ) . '$/', $to )
				&& empty( $this->broadcast_filter[ $to ] )
			) {
				return;
			}
		}

		$type = $message[ Message::TYPE ];

		// debug_level >= 1: the dump REPLACES the normal render — same as Perl
		// Tachikoma Dumper.pm where dump_message rewrites the rendered output.
		//
		// Level 2 REPLACES the normal render entirely — emit the full structural
		// envelope dump and return; the type-specific renderers below are skipped.
		//
		// Level 1 PREPENDS a type-from header and falls through to the normal
		// renderer. For TM_COMMAND|TM_RESPONSE this means the user sees the
		// header followed by the unwrapped inner payload (not the raw JSON
		// envelope) — matching how `dump_response` runs before `dump_message`
		// in Perl Tachikoma. For TM_EOF, the header writes through but the
		// callback still fires below and the return prevents an empty render.
		if ( $this->debug_level >= 2 ) {
			$this->write_async( $this->format_envelope_dump( $message ) );
			return;
		}
		if ( $this->debug_level >= 1 ) {
			$flags = self::format_type_flags( (int) $type );
			$from  = (string) ( $message[ Message::FROM ] ?? '' );
			$this->write_async( $flags . ' from ' . $from . ':' );
			// fall through to the type-specific renderer.
		}

		// TM_EOF: drain marker — cli emitted TM_EOF on stdin close, the
		// receiving CI bounced it back, now we're seeing the echo. Fire the
		// registered callback (Cli wires this to flip the reader's exit flag)
		// and render nothing. TM_EOF is a control marker, not output.
		if ( $type & Message::TM_EOF ) {
			if ( null !== $this->on_eof ) {
				( $this->on_eof )();
			}
			return;
		}

		// TM_COMMAND|TM_RESPONSE: response to the user's command. Bare-mode
		// responses are synchronous (rendered inside the same drain_fh that
		// processed the line); pivoted-mode responses arrive async via the
		// reply-in Consumer poll. Both paths route through write_async — when
		// the prompt is on screen (async case), the wipe-and-redisplay dance
		// preserves the user's typing context; when the prompt was just
		// consumed (sync case, prompt_displayed=false from the readline
		// callback), it falls through to a plain stdout write.
		if ( ( $type & Message::TM_COMMAND ) && ( $type & Message::TM_RESPONSE ) ) {
			$cmd = \json_decode( (string) $message[ Message::VALUE ], true );
			if ( \is_array( $cmd ) ) {
				$name    = (string) ( $cmd['name'] ?? '' );
				$payload = (string) ( $cmd['payload'] ?? '' );

				if ( 'prompt' === $name && null !== $this->shell ) {
					$this->shell->prompt = $payload;
					return;
				}

				$this->write_async( $payload );
				return;
			}
		}

		// TM_COMMAND|TM_ERROR: a verb handler threw — render the unwrapped
		// payload as the error message, not the JSON envelope. Mirrors
		// Tachikoma CommandInterpreter.pm:error() responses.
		if ( ( $type & Message::TM_COMMAND ) && ( $type & Message::TM_ERROR ) ) {
			$cmd     = \json_decode( (string) $message[ Message::VALUE ], true );
			$payload = \is_array( $cmd ) ? (string) ( $cmd['payload'] ?? '' ) : (string) $message[ Message::VALUE ];
			$this->write( $this->stderr, 'ERROR: ' . $payload, true );
			return;
		}

		// TM_ERROR: synchronous error path; skip the prompt dance for the same
		// reason as TM_COMMAND|TM_RESPONSE.
		if ( $type & Message::TM_ERROR ) {
			$this->write( $this->stderr, 'ERROR: ' . (string) $message[ Message::VALUE ], false );
			return;
		}

		// TM_PING: bounced ping reply. VALUE carries the original send timestamp;
		// rewrite to "round trip time: $rtt ms" before falling into the default
		// async-bytestream path. Mirrors Tachikoma Dumper.pm:dump_ping.
		if ( $type & Message::TM_PING ) {
			$sent = (float) $message[ Message::VALUE ];
			$rtt  = ( Core::$now - $sent ) * 1000.0;
			$this->write_async( \sprintf( 'round trip time: %.2f ms', $rtt ) );
			return;
		}

		// TM_STRUCT: VALUE is structured (array). JSON-encode for display.
		// Producers writing array VALUE set this flag (LogManager, RequestBuilder,
		// FlameBuilder, JobIntake, StreamMerger). Plain `(string) $array` would
		// just print "Array".
		if ( $type & Message::TM_STRUCT ) {
			$value = $message[ Message::VALUE ];
			$line  = \is_string( $value ) ? $value : \wp_json_encode( $value, JSON_UNESCAPED_SLASHES );
			$this->write_async( (string) $line );
			return;
		}

		// TM_INFO and default TM_BYTESTREAM both render as plain async
		// bytestreams. The former `INFO[from]: ...` prefix was redundant
		// noise — `debug_level 1` already prepends a `TM_INFO from <from>:`
		// header to every message at the verbosity dial; the curated
		// level-0 render should just show the payload.
		$this->write_async( (string) $message[ Message::VALUE ] );
	}

	/**
	 * Async-output path. If a prompt is on screen AND stdout is a TTY, wipe
	 * the prompt line first, write the async text + newline, then redraw the
	 * prompt below it so the user's editing context survives.
	 *
	 * Non-TTY output (piped to a file or a test memory stream) bypasses ANSI
	 * sequences entirely — they would just be noise in a log file.
	 */
	private function write_async( string $text ): void {
		if ( ! $this->stdout_is_tty || ! $this->prompt_displayed || null === $this->shell ) {
			// No prompt to step around: plain write.
			$this->write( $this->stdout, $text, true );
			return;
		}

		if ( ! \str_ends_with( $text, "\n" ) ) {
			$text .= "\n";
		}

		// stdout/stderr are the cli's own terminal streams — not WP-Filesystem paths.
		// phpcs:disable WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_fwrite
		if ( $this->readline_mode ) {
			// Readline is installed with an empty prompt (see Cli_Command::
			// install_handler) so its idea of the prompt is always blank;
			// the prompt the user sees is whatever we write to stdout. That
			// means we never call readline_redisplay() / readline_on_new_line()
			// — those calls were what put readline into incremental-search
			// mode after the first async output. Wipe the in-flight line,
			// write the async text, then write a fresh prompt directly.
			\fwrite(
				$this->stdout,
				self::ANSI_CR_CLEAR_LINE . $text . $this->shell->prompt
			);
			// prompt_displayed stays true — we re-emitted it.
			return;
		}

		// Non-readline manual path: ANSI cursor save/restore.
		// 1. Save cursor (so terminals supporting it can return to the user's
		//    typed-input caret column after the redraw).
		// 2. CR + clear-to-EOL — wipe the in-flight prompt line.
		// 3. Async output + newline.
		// 4. Redraw the prompt on the fresh line.
		// 5. Restore cursor (best-effort; some terminals discard after newline,
		//    which is fine — the user keeps their typed-input visible courtesy
		//    of the redrawn prompt).
		\fwrite(
			$this->stdout,
			self::ANSI_SAVE_CURSOR
				. self::ANSI_CR_CLEAR_LINE
				. $text
				. $this->shell->prompt
				. self::ANSI_RESTORE_CURSOR
		);
		// prompt_displayed stays true — we re-emitted it.
		// phpcs:enable
	}

	/**
	 * Write to the given stream. If $ensure_newline, append "\n" only when
	 * the payload doesn't already end with one (avoids double-newlines in
	 * common command output). For stderr we deliberately preserve the raw
	 * payload — error formatters typically include their own trailing newline.
	 */
	private function write( $stream, string $text, bool $ensure_newline ): void {
		if ( $ensure_newline && ! \str_ends_with( $text, "\n" ) ) {
			$text .= "\n";
		}
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_fwrite
		\fwrite( $stream, $text );
	}
}
