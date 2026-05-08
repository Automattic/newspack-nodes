<?php
/**
 * Shell: REPL parser node.
 *
 * Subset of real Tachikoma's Shell3.pm — line-oriented, single-tier `<var>`
 * interpolation, backslash continuation, quote-aware tokenization (', ", `).
 * Conditionals/loops/pipes/eval explicitly NOT supported (rejected with warning).
 *
 * Each parsed line emits one Message and registers a single-shot callback under
 * the generated ID. Callbacks fire when the matching response arrives via
 * Responder; they auto-deregister after invocation.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Shell extends Node {
	public string $prompt = 'newspack-nodes> ';

	/** @var array<string,callable> id → callback */
	private array $callbacks = [];

	/** @var array<string,string> name → value */
	public array $variables = [];

	/** Backslash-continuation accumulator. */
	private string $continuation = '';

	private const FORBIDDEN = [ 'if', 'while', 'for', 'func', 'eval', 'unless', 'until' ];

	/**
	 * Accessor primarily for tests; keeps callbacks private.
	 */
	public function callbacks(): array {
		return $this->callbacks;
	}

	/**
	 * Invoke a registered callback by id. If the callback returns falsy, it's
	 * single-shot — auto-deregister. Returns true if the id was registered.
	 */
	public function callback( string $id, mixed $info ): bool {
		if ( ! isset( $this->callbacks[ $id ] ) ) {
			return false;
		}
		$cb   = $this->callbacks[ $id ];
		$keep = $cb( $info );
		if ( ! $keep ) {
			unset( $this->callbacks[ $id ] );
		}
		return true;
	}

	public function set_variable( string $name, string $value ): void {
		$this->variables[ $name ] = $value;
	}

	/**
	 * Quote-aware tokenizer. Recognizes single, double, and backtick quotes;
	 * splits on unquoted whitespace. Quote characters themselves are stripped
	 * from the token (matching real-Shell3 behavior for the simple case).
	 */
	public function tokenize( string $line ): array {
		$tokens   = [];
		$buf      = '';
		$in_quote = null;
		$in_token = false;
		$len      = \strlen( $line );

		for ( $i = 0; $i < $len; ++$i ) {
			$ch = $line[ $i ];
			if ( $in_quote !== null ) {
				if ( $ch === $in_quote ) {
					$in_quote = null;
				} else {
					$buf .= $ch;
				}
				continue;
			}
			if ( $ch === '"' || $ch === "'" || $ch === '`' ) {
				$in_quote = $ch;
				$in_token = true; // empty quoted string still counts as a token
				continue;
			}
			if ( $ch === ' ' || $ch === "\t" ) {
				if ( $in_token ) {
					$tokens[] = $buf;
					$buf      = '';
					$in_token = false;
				}
				continue;
			}
			$buf      .= $ch;
			$in_token  = true;
		}

		if ( $in_token ) {
			$tokens[] = $buf;
		}

		return $tokens;
	}

	/**
	 * Single-tier interpolation: `<varname>` → $variables['varname'].
	 * Unknown vars expand to empty string (matches real Shell3 unset-var policy).
	 * Pre-compiled regex pattern (efficiency: hot-path-cheap dispatch).
	 */
	public function interpolate( string $line ): string {
		return (string) \preg_replace_callback(
			'/<([a-zA-Z_][a-zA-Z0-9_]*)>/',
			fn ( $m ) => $this->variables[ $m[1] ] ?? '',
			$line
		);
	}

	/**
	 * Generate a message id in canonical Tachikoma format: time():counter.
	 * Counter is monotonic via Core::msg_counter().
	 *
	 * Multi-session collision protection happens via FROM-stamping (FROM=$pid),
	 * not via the ID prefix — see spec line 856.
	 */
	private function generate_id(): string {
		return \sprintf( '%d:%010d', \time(), Core::msg_counter() );
	}

	/**
	 * Parse one line into a Message. Handles backslash line continuation and
	 * `include <file>` recursively. Returns null when:
	 *  - the line is empty/comment after trimming
	 *  - the line is being held for continuation (caller should read more)
	 *  - the verb is forbidden (if/while/eval/etc.)
	 *
	 * `$emit_callback` is called with response info ({from,event,payload,error})
	 * when the matching response arrives.
	 */
	public function parse( string $line, callable $emit_callback ): ?array {
		// Backslash continuation: accumulate and return null (caller reads next line).
		if ( \str_ends_with( $line, '\\' ) ) {
			$this->continuation .= \substr( $line, 0, -1 ) . "\n";
			return null;
		}
		if ( $this->continuation !== '' ) {
			$line               = $this->continuation . $line;
			$this->continuation = '';
		}

		$line = $this->interpolate( $line );

		// Strip leading/trailing whitespace AFTER interpolation so `<var>` can
		// expand into leading whitespace tokens cleanly.
		$line = \trim( $line );
		if ( $line === '' || $line[0] === '#' ) {
			return null;
		}

		$tokens = $this->tokenize( $line );
		if ( empty( $tokens ) ) {
			return null;
		}

		$verb = \array_shift( $tokens );
		$args = $tokens;

		// `include <file>` builtin: read file, recursively parse each line.
		if ( $verb === 'include' ) {
			$file = $args[0] ?? '';
			$this->include_file( $file, $emit_callback );
			return null;
		}

		// Reject unsupported features early & loudly.
		if ( \in_array( $verb, self::FORBIDDEN, true ) ) {
			Core::print_less_often( "Shell: '$verb' not supported in v1" );
			return null;
		}

		// FROM=`_responder/$pid` so the response's TO=FROM walks back via
		// `_router → _responder` (which dispatches by ID through the shell
		// callback registry → Dumper). The `$pid` suffix is the multi-session
		// disambiguator (spec line 856): in pivoted mode the worker's _router
		// peels `_responder`, the Partition envelope ships back to the cli with
		// TO=$pid, and each cli's Dumper filters on its own getmypid().
		// Bare mode never re-emits the path past `_responder`; the suffix is
		// there but unused locally.
		$id                   = $this->generate_id();
		$msg                  = Message::new_message();
		$msg[ Message::ID ]   = $id;
		$msg[ Message::FROM ] = '_responder/' . \getmypid();

		switch ( $verb ) {
			case 'tell':
				$msg[ Message::TYPE ]  = Message::TM_INFO;
				$msg[ Message::TO ]    = $args[0] ?? '';
				$msg[ Message::VALUE ] = \implode( ' ', \array_slice( $args, 1 ) );
				break;
			case 'send':
				$msg[ Message::TYPE ]  = Message::TM_BYTESTREAM;
				$msg[ Message::TO ]    = $args[0] ?? '';
				$msg[ Message::VALUE ] = \implode( ' ', \array_slice( $args, 1 ) );
				break;
			case 'send_eof':
				$msg[ Message::TYPE ] = Message::TM_EOF;
				$msg[ Message::TO ]   = $args[0] ?? '';
				break;
			default:
				// Default: TM_COMMAND with verb as command name. TO empty so
				// the local _command_interpreter handles it; pivoted-mode
				// callers re-route via Partition.
				$msg[ Message::TYPE ]  = Message::TM_COMMAND;
				$msg[ Message::TO ]    = '';
				$msg[ Message::VALUE ] = (string) \json_encode(
					[
						'name'      => $verb,
						'arguments' => \implode( ' ', $args ),
						'payload'   => '',
					]
				);
				break;
		}

		// Single-shot callback: emit_callback runs once, then we drop the registration.
		$this->callbacks[ $id ] = function ( $info ) use ( $emit_callback ) {
			$emit_callback( $info );
			return false;
		};

		return $msg;
	}

	/**
	 * Recursively read & parse a file. Emits each non-trivial line through
	 * $emit_callback as if it had been typed at the prompt.
	 */
	private function include_file( string $file, callable $emit_callback ): void {
		if ( $file === '' || ! \is_file( $file ) ) {
			Core::print_less_often( "Shell: include: file not found: $file" );
			return;
		}
		$fh = @\fopen( $file, 'r' );
		if ( $fh === false ) {
			Core::print_less_often( "Shell: include: cannot open: $file" );
			return;
		}
		while ( ( $line = \fgets( $fh ) ) !== false ) {
			$line = \rtrim( $line, "\r\n" );
			$msg  = $this->parse( $line, $emit_callback );
			if ( $msg !== null ) {
				$this->fill( $msg );
			}
		}
		\fclose( $fh );
	}

	/**
	 * Standard sink-forward. Counts the message; subclasses might rewrite TO.
	 */
	public function fill( array &$message ): void {
		++$this->counter;
		$this->sink?->fill( $message );
	}
}
