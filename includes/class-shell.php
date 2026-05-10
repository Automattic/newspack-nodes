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

	/** @var array<string,string> name → value */
	public array $variables = [];

	/**
	 * Refuse to register the Shell under a node name. Mirrors real Tachikoma
	 * `Shell3::name`: shells are anonymous so they don't show up in `ls`,
	 * can't be addressed via TO, and can't accidentally form a graph cycle by
	 * sinking into themselves.
	 */
	public function name( ?string $name = null ): string {
		if ( null !== $name ) {
			throw new \RuntimeException( 'named Shell nodes are not allowed' );
		}
		return $this->name;
	}

	/** Backslash-continuation accumulator. */
	private string $continuation = '';

	private const FORBIDDEN = [ 'if', 'while', 'for', 'func', 'eval', 'unless', 'until' ];

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
			if ( null !== $in_quote ) {
				if ( $ch === $in_quote ) {
					$in_quote = null;
				} else {
					$buf .= $ch;
				}
				continue;
			}
			if ( '"' === $ch || "'" === $ch || '`' === $ch ) {
				$in_quote = $ch;
				$in_token = true; // empty quoted string still counts as a token
				continue;
			}
			if ( ' ' === $ch || "\t" === $ch ) {
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
	 */
	public function parse( string $line ): ?array {
		// Backslash continuation: accumulate and return null (caller reads next line).
		if ( \str_ends_with( $line, '\\' ) ) {
			$this->continuation .= \substr( $line, 0, -1 ) . "\n";
			return null;
		}
		if ( '' !== $this->continuation ) {
			$line               = $this->continuation . $line;
			$this->continuation = '';
		}

		$line = $this->interpolate( $line );

		// Strip leading/trailing whitespace AFTER interpolation so `<var>` can
		// expand into leading whitespace tokens cleanly.
		$line = \trim( $line );
		if ( '' === $line || '#' === $line[0] ) {
			return null;
		}

		$tokens = $this->tokenize( $line );
		if ( empty( $tokens ) ) {
			return null;
		}

		$verb = \array_shift( $tokens );
		$args = $tokens;

		// `include <file>` builtin: read file, recursively parse each line.
		if ( 'include' === $verb ) {
			$file = $args[0] ?? '';
			$this->include_file( $file );
			return null;
		}

		// Reject unsupported features early & loudly.
		if ( \in_array( $verb, self::FORBIDDEN, true ) ) {
			Core::print_less_often( "Shell: '$verb' not supported in v1" );
			return null;
		}

		// FROM=`_responder/$pid` so replies route uniformly in both bare and
		// pivoted modes:
		//   - Bare:  CI's response has TO=_responder/$pid. Local _router peels
		//            _responder, forwards to _responder with TO=$pid; Responder
		//            dispatches by ID through the shell-callback registry to
		//            Dumper. Local-only — no IPC envelope.
		//   - Pivot: Worker's input-Consumer (stamp_as=_repl) prepends, making
		//            FROM=_repl/_responder/$pid. CI's response TO=_repl/_responder/$pid.
		//            Worker's _router peels _repl, forwards to _repl Partition
		//            with TO=_responder/$pid; the envelope hits disk and the
		//            cli's reply-in Consumer reads it, sinks to _responder,
		//            which dispatches by ID. Multi-session: each cli's Dumper
		//            filters TO ∈ {_responder/$pid, $pid} so other sessions'
		//            replies fall through silently.
		// Spec line 856.
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
			case 'ping':
				// Tachikoma Shell3 builtin: build TM_PING addressed at <path>,
				// payload = current timestamp. Receiver's CommandInterpreter
				// bounces TO=FROM, so the message returns along the FROM trail
				// to _responder/$pid → Dumper.
				$msg[ Message::TYPE ]  = Message::TM_PING;
				$msg[ Message::TO ]    = $args[0] ?? '';
				$msg[ Message::VALUE ] = (string) Core::$right_now;
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

		return $msg;
	}

	/**
	 * Recursively read & parse a file. Each non-trivial line is parsed and
	 * filled through this Shell's sink, exactly as if it had been typed at
	 * the prompt.
	 */
	private function include_file( string $file ): void {
		if ( '' === $file || ! \is_file( $file ) ) {
			Core::print_less_often( "Shell: include: file not found: $file" );
			return;
		}
		$fh = @\fopen( $file, 'r' );
		if ( false === $fh ) {
			Core::print_less_often( "Shell: include: cannot open: $file" );
			return;
		}
		while ( ( $line = \fgets( $fh ) ) !== false ) {
			$line = \rtrim( $line, "\r\n" );
			$msg  = $this->parse( $line );
			if ( null !== $msg ) {
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
