<?php
/**
 * Dumper: terminal output node for the REPL.
 *
 * Dispatches by TYPE flag:
 *  - TM_COMMAND|TM_RESPONSE → unwrap Command JSON, print payload to stdout
 *    (special case: name=='prompt' updates the Shell's prompt, no print)
 *  - TM_ERROR               → "ERROR: …" to stderr
 *  - TM_INFO                → "INFO[from]: …" to stdout
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
	 * @param resource|null $stdout Defaults to STDOUT. Pass php://memory for tests.
	 * @param resource|null $stderr Defaults to STDERR.
	 * @param bool|null     $force_tty If non-null, override the posix_isatty()
	 *                                 detection (tests pass true to exercise the
	 *                                 escape-sequence path on a memory stream).
	 */
	public function __construct( $stdout = null, $stderr = null, ?bool $force_tty = null ) {
		$this->stdout = $stdout ?? \STDOUT;
		$this->stderr = $stderr ?? \STDERR;

		if ( $force_tty !== null ) {
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

	/**
	 * Cli readline loop calls this immediately after writing the prompt so the
	 * Dumper knows to wipe-and-redraw on the next async write.
	 */
	public function mark_prompt_displayed(): void {
		$this->prompt_displayed = true;
	}

	public function fill( array &$message ): void {
		++$this->counter;
		$type = $message[ Message::TYPE ];

		// TM_COMMAND|TM_RESPONSE: synchronous response to the user's command.
		// Skip the prompt-redraw dance — Shell's read-eval-print loop will
		// re-prompt on its own once the response is rendered.
		if ( ( $type & Message::TM_COMMAND ) && ( $type & Message::TM_RESPONSE ) ) {
			$cmd = \json_decode( (string) $message[ Message::VALUE ], true );
			if ( \is_array( $cmd ) ) {
				$name    = (string) ( $cmd['name'] ?? '' );
				$payload = (string) ( $cmd['payload'] ?? '' );

				if ( $name === 'prompt' && $this->shell !== null ) {
					$this->shell->prompt = $payload;
					return;
				}

				$this->write( $this->stdout, $payload, true );
				$this->prompt_displayed = false;
				return;
			}
		}

		// TM_ERROR: synchronous error path; skip the prompt dance for the same
		// reason as TM_COMMAND|TM_RESPONSE.
		if ( $type & Message::TM_ERROR ) {
			$this->write( $this->stderr, 'ERROR: ' . (string) $message[ Message::VALUE ], false );
			return;
		}

		// TM_INFO: async broadcast — may interrupt the user's prompt.
		if ( $type & Message::TM_INFO ) {
			$line = 'INFO[' . (string) $message[ Message::FROM ] . ']: '
				. (string) $message[ Message::VALUE ];
			$this->write_async( $line );
			return;
		}

		// Default: async bytestream — same prompt-aware path as TM_INFO.
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
		if ( ! $this->stdout_is_tty || ! $this->prompt_displayed || $this->shell === null ) {
			// No prompt to step around: plain write.
			$this->write( $this->stdout, $text, true );
			return;
		}

		// 1. Save cursor (so terminals supporting it can return to the user's
		//    typed-input caret column after the redraw).
		// 2. CR + clear-to-EOL — wipe the in-flight prompt line.
		// 3. Async output + newline.
		// 4. Redraw the prompt on the fresh line.
		// 5. Restore cursor (best-effort; some terminals discard after newline,
		//    which is fine — the user keeps their typed-input visible courtesy
		//    of the redrawn prompt).
		if ( ! \str_ends_with( $text, "\n" ) ) {
			$text .= "\n";
		}
		\fwrite(
			$this->stdout,
			self::ANSI_SAVE_CURSOR
				. self::ANSI_CR_CLEAR_LINE
				. $text
				. $this->shell->prompt
				. self::ANSI_RESTORE_CURSOR
		);
		// prompt_displayed stays true — we re-emitted it.
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
		\fwrite( $stream, $text );
	}
}
