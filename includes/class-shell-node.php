<?php
/**
 * Shell: REPL parser node.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Shell_Node extends Node {

	/** Current cwd — the node-path non-builtin commands route to by default; empty = local interpreter. */
	public string $path = '';

	public string $prompt = '/> ';

	/**
	 * Lines printed by the local `status` builtin on demand; empty = silent no-op.
	 *
	 * @var array<int,string>
	 */
	public array $status_lines = [];

	/** Backslash-continuation accumulator. */
	private string $continuation = '';

	/**
	 * Open-quote continuation accumulator (raw, pre-interpolation). Tachikoma
	 * parity: an open quote continues the statement onto the next line, newline
	 * included in the token; flush_pending() errors if EOF arrives first.
	 */
	private string $quote_continuation = '';

	/** Prompt to restore when the open quote closes ('' = none stashed). */
	private string $prompt_stash = '';

	/**
	 * Script-context error handling: REPLs log-and-continue (safe default) so
	 * a typo'd include or quote doesn't kill the session; Topology_Loader
	 * turns this on so a cyclic include or an unterminated quote in a .tsl
	 * fails loud at worker boot rather than booting a half-built or silently
	 * mangled graph. Mirrors the want_reply() setter shape.
	 */
	private bool $fatal_errors = false;

	/**
	 * Resolved include paths on the current ancestor chain — a repeat is a cycle.
	 *
	 * @var list<string>
	 */
	private array $include_stack = [];

	/**
	 * Resolved include paths already evaluated within the CURRENT top-level
	 * script (`#pragma once`) — scoped per fill() entered with an empty
	 * include_stack, not per Shell lifetime, so a long-lived REPL re-running
	 * `include foo` after editing foo.tsl isn't a silent no-op.
	 *
	 * @var array<string,true>
	 */
	private array $included = [];

	/** When true, every parsed line dumps its interpolated/tokenized form to $output_stream. */
	private bool $show_parse = false;

	/**
	 * Interactive REPLs want their command replies (default). A script/topology
	 * loader sets this false so commands go out TM_NOREPLY — the interpreter then
	 * suppresses replies that would otherwise dead-end (no console at boot).
	 * Mirrors Tachikoma Shell's $self->{want_reply}.
	 */
	private bool $want_reply = true;

	/**
	 * Verb aliases the interpreter's dispatch table resolves — the ONE table the
	 * static front-end applies on the tokenized verb (make/connect/disconnect and
	 * the command family), so a topology written with the short form reads the same
	 * as the long form to every static analysis.
	 *
	 * @var array<string,string>
	 */
	private const VERB_ALIASES = [
		'make'       => 'make_node',
		'connect'    => 'connect_node',
		'disconnect' => 'disconnect_node',
		'command'    => 'command_node',
		'cmd'        => 'command_node',
	];

	/**
	 * Shell BUILTINS: `var` sets shell state and `include` evals a file
	 * through this same shell (as though piped into the REPL) — neither ever
	 * becomes a message, so the static front-end returns them as bare
	 * statements wherever they appear. Any other bare verb inside a cwd is a
	 * command to that node, `make_node` included.
	 */
	private const BUILTIN_VERBS = [ 'include', 'var' ];

	/**
	 * Per-quote-type escape rules, following Shell3's string1/string2/string3
	 * expansion. Double quotes expand sequences; single quotes and backticks
	 * stay literal so a deferred `<token>` survives to its downstream binder.
	 * An unlisted `\X` keeps both characters (Perl leaves it untouched too).
	 */
	private const ESCAPES = [
		'"'  => [
			'e'    => "\e",
			'n'    => "\n",
			'r'    => "\r",
			't'    => "\t",
			'"'    => '"',
			'\\'   => '\\',
			'<'    => '<',
			'>'    => '>',
		],
		"'"  => [
			"'"  => "'",
			'\\' => '\\',
		],
		'`'  => [
			'`'  => '`',
			'\\' => '\\',
		],
	];

	/** `<name> [ <op> [ <value> ] ]` — the operator set of Shell3's `$H{'var'}`. */
	private const VAR_GRAMMAR = '/^([^\s=+\-*\/.|]+(?:\.[^\s=+\-*\/.|]+)*)\s*(\/\/=|\|\|=|[.+\-*\/]=|\+\+|--|=)?(.*)$/s';

	/**
	 * Shell egress. A TM_BYTESTREAM is raw REPL input: parse each statement into a
	 * Message and dispatch it. Anything else (a pre-built command from
	 * dispatch_line, a completion query, an EOF/ping marker) passes straight
	 * through to the sink. Mirrors Tachikoma::Nodes::Shell::fill, which sinks any
	 * non-TM_BYTESTREAM message rather than dropping it. Every command leaving the
	 * Shell is signed here so it carries an HMAC envelope across the IPC boundary
	 * to a worker (Command_Auth::sign is a no-op on non-command types).
	 */
	public function fill( array $message ): void {
		if ( null === $this->sink ) {
			throw new \RuntimeException( 'fill requires a wired sink' );
		}
		$type  = $message[ Message::TYPE ]  ?? 0;
		$value = $message[ Message::VALUE ] ?? null;
		if ( ! \is_integer( $type ) ) {
			throw new \RuntimeException( 'Shell::fill requires a valid message' );
		}
		if ( Message::TM_EOF === $type ) {
			$sink = $this->sink;
			// Stdin closed mid-statement: report before draining.
			$this->flush_pending();
			$message[ Message::FROM ] = Node_Names::OUTPUT . '/' . \getmypid();
			$message[ Message::TO ]   = $this->path;
			$sink->fill( $message );
			return;
		}
		if ( Message::TM_BYTESTREAM !== $type || ! \is_string( $value ) ) {
			throw new \RuntimeException( 'Shell::fill requires a TM_BYTESTREAM message with a string VALUE' );
		}
		if ( empty( $this->include_stack ) ) {
			// A fresh top-level script (not a recursive include) — new memo.
			$this->included = [];
		}
		foreach ( $this->split_statements( $value ) as $statement ) {
			$parsed = $this->parse( $statement );
			if ( null !== $parsed ) {
				++$this->counter;
				if ( '' === $parsed[ Message::KEY ] ) {
					$parsed[ Message::KEY ] = $message[ Message::KEY ];
				}
				Command_Auth::sign( $parsed );
				$this->sink->fill( $parsed );
			}
		}
	}

	/**
	 * Quote-aware statement splitter: comment lines returned whole, others split on unquoted `;`.
	 *
	 * @return array<int,string>
	 */
	public function split_statements( string $script ): array {
		return \array_column( self::split_statements_indexed( $script ), 'text' );
	}

	/**
	 * The one static TSL statement front-end: split → join backslash
	 * continuations → tokenize → resolve verb aliases + cwd, keeping BOTH token
	 * forms. A public static sibling of tokenize() built from
	 * the pieces the Shell already owns, with dispatch removed and no side
	 * effects: no interpolation, no Core::$var reads, no node construction. Static
	 * analysis (Topology_Registry) reads the list without executing it.
	 *
	 * Each statement is `{ verb, values, spans, raw, line }`: `verb` is the
	 * canonical verb; `values` the quote-stripped tokens (`values[0] === verb`,
	 * and for `cmd` `values[1]` is the cwd-resolved path); `spans` the same tokens
	 * with quote chars + escapes verbatim (what a round-trip must emit, so a
	 * deferred `'<partition>'` never becomes an eager `"<partition>"`); `raw` the
	 * canonical single-line form (the sharing signature readers normalize); `line`
	 * the 1-based first physical source line.
	 *
	 * @return list<array{verb:string,values:list<string>,spans:list<string>,raw:string,line:int}>
	 * @throws \RuntimeException On an unterminated quote at end-of-input.
	 */
	public static function parse_statements( string $text ): array {
		$shell      = new self();
		$statements = [];
		foreach ( self::join_statement_continuations( self::split_statements_indexed( $text ) ) as $joined ) {
			$statement = self::build_statement( $shell, $joined['text'], $joined['line'] );
			if ( null !== $statement ) {
				$statements[] = $statement;
			}
		}
		return $statements;
	}

	/**
	 * split_statements(), but each statement carries the 1-based first physical
	 * line of its run — the only thing parse_statements() needs that
	 * split_statements() didn't already compute.
	 *
	 * @return list<array{text:string,line:int}>
	 */
	private static function split_statements_indexed( string $script ): array {
		$statements = [];
		$buf        = '';
		$in_quote   = null;
		$stmt_line  = 0;
		$line_no    = 0;
		foreach ( \explode( "\n", $script ) as $line ) {
			++$line_no;
			if ( null !== $in_quote ) {
				// Mid-quote: the newline is token content, keep accumulating.
				$buf .= "\n";
			} else {
				$leading = \ltrim( $line );
				if ( '' === $leading ) {
					continue;
				}
				if ( '#' === $leading[0] ) {
					// Whole-line comment — don't scan for `;` inside it.
					$statements[] = [
						'text' => \trim( $line ),
						'line' => $line_no,
					];
					continue;
				}
			}
			$length = \strlen( $line );
			for ( $i = 0; $i < $length; ++$i ) {
				$ch = $line[ $i ];
				if ( null !== $in_quote ) {
					// An escaped quote must not close the run.
					if ( '\\' === $ch && $i + 1 < $length ) {
						$buf .= $ch . $line[ ++$i ];
						continue;
					}
					$buf .= $ch;
					if ( $ch === $in_quote ) {
						$in_quote = null;
					}
					continue;
				}
				if ( "'" === $ch || '"' === $ch || '`' === $ch ) {
					if ( 0 === $stmt_line ) {
						$stmt_line = $line_no;
					}
					$in_quote = $ch;
					$buf     .= $ch;
					continue;
				}
				if ( '\\' === $ch && $i + 1 < $length ) {
					$buf .= $ch . $line[ ++$i ];
					continue;
				}
				// A `;` inside a comment tail must not split the statement.
				if ( '#' === $ch ) {
					$buf .= \substr( $line, $i );
					break;
				}
				if ( ';' === $ch ) {
					$trim = \trim( $buf );
					if ( '' !== $trim ) {
						$statements[] = [
							'text' => $trim,
							'line' => $stmt_line,
						];
					}
					$buf       = '';
					$stmt_line = 0;
					continue;
				}
				if ( 0 === $stmt_line && ' ' !== $ch && "\t" !== $ch ) {
					$stmt_line = $line_no;
				}
				$buf .= $ch;
			}
			if ( null === $in_quote ) {
				$tail = \trim( $buf );
				if ( '' !== $tail ) {
					$statements[] = [
						'text' => $tail,
						'line' => $stmt_line,
					];
				}
				$buf       = '';
				$stmt_line = 0;
			}
		}
		// EOF mid-quote: parse() holds the tail; flush_pending() judges it.
		$tail = \trim( $buf );
		if ( '' !== $tail ) {
			$statements[] = [
				'text' => $tail,
				'line' => $stmt_line,
			];
		}
		return $statements;
	}

	/**
	 * Fold trailing-backslash continuations across the statement stream — the same
	 * splice parse() performs, applied statelessly. The joined statement keeps the
	 * FIRST physical line of its run; an unterminated trailing continuation yields
	 * whatever accumulated.
	 *
	 * @param list<array{text:string,line:int}> $indexed
	 * @return list<array{text:string,line:int}>
	 */
	private static function join_statement_continuations( array $indexed ): array {
		$out      = [];
		$acc      = '';
		$acc_line = 0;
		foreach ( $indexed as $statement ) {
			if ( 0 === $acc_line ) {
				$acc_line = $statement['line'];
			}
			$text = $statement['text'];
			if ( self::is_continuation( $text ) ) {
				$acc .= \substr( $text, 0, -1 );
				continue;
			}
			$out[]    = [
				'text' => $acc . $text,
				'line' => $acc_line,
			];
			$acc      = '';
			$acc_line = 0;
		}
		if ( '' !== $acc ) {
			// Runtime parity: flush_pending() fails loud here too.
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- parse diagnostic, not HTML.
			throw new \RuntimeException( "got EOF while waiting for tokens at line {$acc_line}" );
		}
		return $out;
	}

	/**
	 * Tokenize one joined statement and resolve its verb alias + cwd into the
	 * canonical `{ verb, values, spans, raw, line }` record. Returns null for a
	 * comment/blank statement or a `cd`/`chdir` (which only mutates the shared
	 * throwaway shell's cwd). Reuses the Shell's own cd()/prefix() so the static
	 * and runtime paths route identically.
	 *
	 * @return array{verb:string,values:list<string>,spans:list<string>,raw:string,line:int}|null
	 * @throws \RuntimeException On an unterminated quote at end-of-input.
	 */
	private static function build_statement( self $shell, string $text, int $line ): ?array {
		if ( '' === $text || '#' === $text[0] ) {
			return null;
		}
		$open_quote = null;
		$scanned    = self::scan_tokens( $text, $open_quote );
		if ( null !== $open_quote ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text loader/CLI message; escape at the view, not the runtime.
			throw new \RuntimeException( 'got EOF while waiting for tokens: ' . \trim( $text ) );
		}
		if ( empty( $scanned ) ) {
			return null;
		}
		$token_values = \array_column( $scanned, 'value' );
		$token_spans  = \array_column( $scanned, 'raw' );
		$verb         = self::VERB_ALIASES[ $token_values[0] ] ?? $token_values[0];

		if ( 'cd' === $verb || 'chdir' === $verb ) {
			$shell->path = $shell->cd( $shell->path, $token_values[1] ?? '' );
			return null;
		}
		if ( 'command_node' === $verb ) {
			$path   = $shell->prefix( $token_values[1] ?? '' );
			$values = [ 'command_node', $path, ...\array_slice( $token_values, 2 ) ];
			$spans  = [ 'command_node', $path, ...\array_slice( $token_spans, 2 ) ];
		} elseif ( \in_array( $verb, self::BUILTIN_VERBS, true ) || '' === $shell->path ) {
			// Builtins and root-level bare verbs are not cwd-routed.
			$values = [ $verb, ...\array_slice( $token_values, 1 ) ];
			$spans  = [ $verb, ...\array_slice( $token_spans, 1 ) ];
		} else {
			// A bare verb inside a cwd is a command to that node.
			$values = [ 'command_node', $shell->path, $verb, ...\array_slice( $token_values, 1 ) ];
			$spans  = [ 'command_node', $shell->path, $verb, ...\array_slice( $token_spans, 1 ) ];
		}
		return [
			'verb'   => $values[0],
			'values' => $values,
			'spans'  => $spans,
			'raw'    => \trim( \implode( ' ', $spans ) ),
			'line'   => $line,
		];
	}

	/**
	 * Parse one line into a Message; null on empty/comment or held continuation.
	 *
	 * @return array<int, mixed>|null The 7-field positional Message, or null.
	 */
	public function parse( string $line ): ?array {
		// Backslash splice: the \<newline> vanishes (bash: hi\+bye = hibye).
		if ( self::is_continuation( $line ) ) {
			$this->continuation .= \substr( $line, 0, -1 );
			if ( '' === $this->prompt_stash ) {
				$this->prompt_stash = $this->prompt;
			}
			$this->prompt = '> ';
			return null;
		}
		if ( '' !== $this->continuation ) {
			$line               = $this->continuation . $line;
			$this->continuation = '';
		}
		if ( '' !== $this->quote_continuation ) {
			$line                     = $this->quote_continuation . "\n" . $line;
			$this->quote_continuation = '';
		}
		$raw = $line;

		// Settle comments first: interpolating an inert line warns spuriously.
		$trimmed_raw = \trim( $line );
		if ( '' === $trimmed_raw || '#' === $trimmed_raw[0] ) {
			return null;
		}

		$line = $this->interpolate( $line );

		// Trim AFTER interpolation so `<var>` can expand into leading space.
		$line = \trim( $line );
		if ( '' === $line || '#' === $line[0] ) {
			return null;
		}

		$open_quote = null;
		$tokens     = \array_column( self::scan_tokens( $line, $open_quote ), 'value' );
		if ( null !== $open_quote ) {
			// Continue on the next line (raw, so the join interpolates ONCE).
			if ( '' === $this->prompt_stash ) {
				$this->prompt_stash = $this->prompt;
			}
			$this->quote_continuation = $raw;
			$this->prompt             = "{$open_quote}> ";
			return null;
		}
		if ( '' !== $this->prompt_stash ) {
			$this->prompt       = $this->prompt_stash;
			$this->prompt_stash = '';
		}
		if ( empty( $tokens ) ) {
			return null;
		}

		if ( $this->show_parse ) {
			$dump = 'parse> line: ' . $line . "\n"
				. 'parse> tokens: ' . (string) \wp_json_encode( $tokens ) . "\n";
			$this->stdout( $dump );
		}

		$verb = \array_shift( $tokens );
		$args = $tokens;

		if ( 'include' === $verb ) {
			$file = $args[0] ?? '';
			$this->include_file( $file );
			return null;
		}

		if ( 'cd' === $verb || 'chdir' === $verb ) {
			$this->path = $this->cd( $this->path, $args[0] ?? '' );
			$this->prompt = '/' . $this->path . '> ';
			return null;
		}

		// Shell3:1363 — verbatim; the newline is the caller's. No `echo`.
		if ( 'print' === $verb ) {
			$this->stdout( \implode( ' ', $args ) );
			return null;
		}

		if ( 'debug_level' === $verb ) {
			$dumper = Core::node( Node_Names::OUTPUT );
			if ( $dumper instanceof Dumper_Node ) {
				$current = $dumper->debug_level();
				$next    = ! empty( $args )
					? (int) $args[0]
					: ( $current > 0 ? 0 : 1 );
				$applied = $dumper->set_debug_level( $next );
				$this->stdout( 'debug_level: ' . $applied . "\n" );
			}
			return null;
		}

		if ( 'status' === $verb ) {
			foreach ( $this->status_lines as $status_line ) {
				$this->stdout( $status_line . "\n" );
			}
			return null;
		}

		if ( 'show_parse' === $verb ) {
			$this->show_parse = ! $this->show_parse;
			$this->stdout( 'show_parse: ' . ( $this->show_parse ? 'on' : 'off' ) . "\n" );
			return null;
		}

		if ( 'var' === $verb ) {
			$this->var_command( \implode( ' ', $args ) );
			return null;
		}

		// Shell3:2240-2242 — var scope; overriding FROM re-routes the reply.
		$message                   = Message::new_message();
		// A forged TIMESTAMP is a debugging tool; unset keeps the mint clock.
		$forged                    = Core::str( Core::$var['message.timestamp'] ?? '', '' );
		if ( '' !== $forged ) {
			$message[ Message::TIMESTAMP ] = $forged;
		}
		$message[ Message::FROM ]  = Core::str( Core::$var['message.from'] ?? '', '' )
			?: Node_Names::OUTPUT . '/' . \getmypid();
		$message[ Message::ID ]    = Core::str( Core::$var['message.id'] ?? '', '' );
		$message[ Message::KEY ]   = Core::str( Core::$var['message.key'] ?? '', '' );
		// LOCAL taint: in-proc mint, stripped at wire (packed()); local-only.
		$message[ Message::LOCAL ] = true;

		switch ( $verb ) {
			case 'command':
			case 'cmd':
			case 'command_node':
				$cmd_path  = $args[0] ?? '';
				$cmd_verb  = $args[1] ?? '';
				$cmd_args  = \array_slice( $args, 2 );
				$message[ Message::TYPE ]  = Message::TM_COMMAND;
				$message[ Message::TO ]    = $this->prefix( $cmd_path );
				$message[ Message::VALUE ] = [
					'name'      => $cmd_verb,
					'arguments' => $cmd_args,
				];
				break;
			case 'pwd':
				$message[ Message::TYPE ]  = Message::TM_COMMAND;
				$message[ Message::TO ]    = $this->path;
				$message[ Message::VALUE ] = [
					'name'      => 'pwd',
					'arguments' => '' === $this->path ? [] : [ $this->path ],
				];
				break;
			case 'ping':
				// Receiver bounces TO=FROM; VALUE is the send timestamp.
				$message[ Message::TYPE ]  = Message::TM_PING;
				$message[ Message::TO ]    = $this->prefix( $args[0] ?? '' );
				// %.6F: a (string) cast rounds, and rounding up = negative RTT.
				$message[ Message::VALUE ] = \sprintf( '%.6F', Core::$now );
				break;
			case 'request':
			case 'request_node':
				$message[ Message::TYPE ]  = Message::TM_REQUEST;
				$message[ Message::TO ]    = $this->prefix( $args[0] ?? '' );
				$message[ Message::VALUE ] = \implode( ' ', \array_slice( $args, 1 ) );
				break;
			case 'send':
			case 'send_node':
				$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
				$message[ Message::TO ]    = $this->prefix( $args[0] ?? '' );
				$message[ Message::VALUE ] = \implode( ' ', \array_slice( $args, 1 ) ) . "\n";
				break;
			case 'send_struct':
			case 'send_struct_node':
				// Runs in parse(), before central catch — decode error here.
				try {
					$decoded = \json_decode( \implode( ' ', \array_slice( $args, 1 ) ), true, 512, \JSON_THROW_ON_ERROR );
				} catch ( \JsonException $e ) {
					$this->stdout( 'send_struct: ' . $e->getMessage() . "\n" );
					return null;
				}
				$message[ Message::TYPE ]  = Message::TM_STRUCT;
				$message[ Message::TO ]    = $this->prefix( $args[0] ?? '' );
				$message[ Message::VALUE ] = $decoded;
				break;
			case 'send_eof':
				$message[ Message::TYPE ] = Message::TM_EOF;
				$message[ Message::TO ]   = $this->prefix( $args[0] ?? '' );
				break;
			case 'tell':
			case 'tell_node':
				$message[ Message::TYPE ]  = Message::TM_INFO;
				$message[ Message::TO ]    = $this->prefix( $args[0] ?? '' );
				$message[ Message::VALUE ] = \implode( ' ', \array_slice( $args, 1 ) );
				break;
			default:
				// TO=cwd: empty - local interpreter; set - routed via _router.
				$message[ Message::TYPE ]  = Message::TM_COMMAND;
				$message[ Message::TO ]    = $this->prefix( '' );
				$message[ Message::VALUE ] = [
					'name'      => $verb,
					'arguments' => $args,
				];
				break;
		}

		$this->stamp_noreply( $message );
		return $message;
	}

	/**
	 * A line continues only on an ODD run of trailing backslashes — an even run
	 * is escaped literals (`a\\` is one backslash, a complete line). Matters
	 * now that a backslash escapes outside quotes too.
	 */
	private static function is_continuation( string $line ): bool {
		return 0 !== ( \strlen( $line ) - \strlen( \rtrim( $line, '\\' ) ) ) % 2;
	}

	/**
	 * `var [ <name> [ <op> [ <value> ] ] ]` — follows Shell3's var_assignment.
	 *
	 * Bare lists every var as `name=value`; a name alone prints its value and
	 * autovivifies it to empty (Shell3.pm:2715); `<name> =` with no value
	 * DELETES it (Shell3.pm:2839); otherwise the operator set applies.
	 */
	private function var_command( string $assignment ): void {
		// ltrim only: a trailing whitespace VALUE must reach the grammar.
		$assignment = \ltrim( $assignment );
		if ( '' === \rtrim( $assignment ) ) {
			$out = '';
			$all = Core::$var;
			\ksort( $all );
			foreach ( $all as $name => $value ) {
				$out .= $name . '=' . \rtrim( Core::as_string( $value, '' ), "\n" ) . "\n";
			}
			if ( '' !== $out ) {
				$this->stdout( $out );
			}
			return;
		}

		if ( ! \preg_match( self::VAR_GRAMMAR, $assignment, $m ) ) {
			$this->stdout( "var: expected <name> [ <op> [ <value> ] ]\n" );
			return;
		}
		[ , $name, $op, $raw_value ] = $m + [ 3 => '' ];
		// Shell3:2825 — a value TOKEN sets (even if blank); none deletes.
		$has_value = '' !== $raw_value;
		// ltrim only: tokenize stripped the edges, so the tail is content.
		$value     = \ltrim( $raw_value );
		if ( \str_contains( $name, ':' ) ) {
			$this->stdout( "var: invalid name '{$name}' (':' is reserved for namespaces like config:)\n" );
			return;
		}

		if ( '' === $op ) {
			// Shell3:630 fatals on trailing junk where an operator belongs.
			if ( '' !== \trim( $value ) ) {
				$this->stdout( "var: unexpected token in assignment: {$value}\n" );
				return;
			}
			// Reading defines the key — Shell3's `$hash->{$name} //= q()`.
			Core::$var[ $name ] ??= '';
			$read                 = Core::as_string( Core::$var[ $name ], '' );
			// Printed verbatim: an empty value prints nothing at all.
			if ( '' !== $read ) {
				$this->stdout( $read );
			}
			return;
		}

		$this->operate( $name, $op, $value, $has_value );
	}

	/** Shell3's `operate()` / `operate_with_value()` over one var. */
	private function operate( string $name, string $op, string $value, bool $has_value ): void {
		$current = Core::as_string( Core::$var[ $name ] ?? '', '' );
		$exists  = \array_key_exists( $name, Core::$var );

		if ( ! $has_value ) {
			// Valueless: only these three exist; the rest are usage errors.
			if ( '=' === $op ) {
				unset( Core::$var[ $name ] );
			} elseif ( '++' === $op ) {
				Core::$var[ $name ] = self::format_number( Core::num_float( $current, 0 ) + 1 );
			} elseif ( '--' === $op ) {
				Core::$var[ $name ] = self::format_number( Core::num_float( $current, 0 ) - 1 );
			} else {
				$this->stdout( "var: bad arguments: {$op}\n" );
			}
			return;
		}

		switch ( $op ) {
			case '=':
				Core::$var[ $name ] = $value;
				return;
			case '.=':
				Core::$var[ $name ] = $exists ? $current . ' ' . $value : $value;
				return;
			case '//=':
				if ( ! $exists ) {
					Core::$var[ $name ] = $value;
				}
				return;
			case '||=':
				if ( '' === $current || '0' === $current ) {
					Core::$var[ $name ] = $value;
				}
				return;
			case '/=':
				if ( 0.0 === Core::num_float( $value, 0 ) ) {
					$this->stdout( "var: division by zero\n" );
					return;
				}
				Core::$var[ $name ] = self::format_number( Core::num_float( $current, 0 ) / Core::num_float( $value, 0 ) );
				return;
			case '+=':
			case '-=':
			case '*=':
				$left               = Core::num_float( $current, 0 );
				$right              = Core::num_float( $value, 0 );
				Core::$var[ $name ] = self::format_number(
					'+=' === $op ? $left + $right : ( '-=' === $op ? $left - $right : $left * $right )
				);
				return;
			default:
				$this->stdout( "var: invalid operator: {$op}\n" );
		}
	}

	/** Perl prints an integral float without its fractional part. */
	private static function format_number( float $n ): string {
		return (float) (int) $n === $n ? (string) (int) $n : (string) $n;
	}

	/**
	 * Quote-aware single-tier interpolation. Outside quotes and inside double
	 * quotes: `<ns:key>` → that namespace's registered resolver
	 * (Core::resolve_config_token); bare `<var>` → Core::$var; unknown → ''.
	 * Inside single quotes or backticks the `<…>` is left LITERAL (standard shell
	 * semantics) so a token can be deferred to a downstream binder — e.g. a Topic
	 * line writes `<config:logs_dir>/jobs.p'<partition>'`, expanding the dir now
	 * and handing the raw `<partition>` to Topic. The quote chars survive here;
	 * tokenize() strips them afterward.
	 */
	public function interpolate( string $line ): string {
		$out     = '';
		$literal = null; // active quote/backtick span, suppresses expansion.
		$length     = \strlen( $line );
		for ( $i = 0; $i < $length; ) {
			$ch = $line[ $i ];
			if ( null !== $literal ) {
				$out .= $ch;
				if ( $ch === $literal ) {
					$literal = null;
				}
				++$i;
				continue;
			}
			// An escape pair passes through; tokenize() resolves it later.
			if ( '\\' === $ch && $i + 1 < $length ) {
				$out .= $ch . $line[ $i + 1 ];
				$i   += 2;
				continue;
			}
			// A comment tail is inert — copy it verbatim, expand nothing.
			if ( '#' === $ch ) {
				return $out . \substr( $line, $i );
			}
			if ( "'" === $ch || '`' === $ch ) {
				$literal = $ch;
				$out    .= $ch;
				++$i;
				continue;
			}
			if ( '<' === $ch && \preg_match( '/\G<([a-zA-Z_][a-zA-Z0-9_]*(?::[a-zA-Z_][a-zA-Z0-9_]*)?)>/', $line, $m, 0, $i ) ) {
				$key   = $m[1];
				$colon = \strpos( $key, ':' );
				if ( false !== $colon ) {
					$out .= Core::resolve_config_token( \substr( $key, 0, $colon ), \substr( $key, $colon + 1 ) );
				} else {
					// get_shared: undefined warns, defined-empty is silent.
					if ( ! \array_key_exists( $key, Core::$var ) ) {
						// Raw, like Shell3's `print {*STDERR}`: no prefix.
						Core::_stderr( "WARNING: use of uninitialized value <{$key}>\n", true );
					}
					$out .= Core::as_string( Core::$var[ $key ] ?? '', '' );
				}
				$i    += \strlen( $m[0] );
				continue;
			}
			$out .= $ch;
			++$i;
		}
		return $out;
	}

	/**
	 * Quote-aware tokenizer ('/"/`): splits on unquoted whitespace, strips the quote chars.
	 *
	 * @return list<string>
	 */
	public function tokenize( string $line ): array {
		return \array_column( self::scan_tokens( $line ), 'value' );
	}


	/**
	 * The one tokenizer state machine ('/"/` + backslash escapes): splits on
	 * unquoted whitespace; an empty quoted string still counts as a token.
	 * Yields both forms per token — `value` (quote chars stripped, escapes
	 * resolved) and `raw` (the span verbatim, so quote TYPE survives: double
	 * quotes interpolate `<…>`, single quotes/backticks defer — see
	 * interpolate()). Mirrors src/runtime/shell-node.js scanTokens.
	 *
	 * @return list<array{value: string, raw: string}>
	 */
	private static function scan_tokens( string $line, ?string &$open_quote = null ): array {
		$tokens   = [];
		$buf      = '';
		$raw      = '';
		$in_quote = null;
		$in_token = false;
		$length   = \strlen( $line );

		for ( $i = 0; $i < $length; ++$i ) {
			$ch = $line[ $i ];
			if ( null !== $in_quote ) {
				// Escapes are quote-typed: only double quotes expand sequences.
				if ( '\\' === $ch && $i + 1 < $length ) {
					$next  = $line[ ++$i ];
					$raw  .= $ch . $next;
					$buf  .= self::ESCAPES[ $in_quote ][ $next ] ?? ( $ch . $next );
					continue;
				}
				$raw .= $ch;
				if ( $ch === $in_quote ) {
					$in_quote = null;
				} else {
					$buf .= $ch;
				}
				continue;
			}
			// Shell3:411 — `\X` is literal X; a trailing `\` is skipped.
			if ( '\\' === $ch && $i + 1 < $length ) {
				$raw     .= $ch . $line[ $i + 1 ];
				$buf     .= $line[ ++$i ];
				$in_token = true;
				continue;
			}
			// Shell3:303 — outside a quote, `#` comments out the rest.
			if ( '#' === $ch ) {
				break;
			}
			if ( '"' === $ch || "'" === $ch || '`' === $ch ) {
				$in_quote = $ch;
				$in_token = true; // empty quoted string counts as a token.
				$raw     .= $ch;
				continue;
			}
			if ( ' ' === $ch || "\t" === $ch ) {
				if ( $in_token ) {
					$tokens[] = [
						'value' => $buf,
						'raw'   => $raw,
					];
					$buf      = '';
					$raw      = '';
					$in_token = false;
				}
				continue;
			}
			$buf      .= $ch;
			$raw      .= $ch;
			$in_token  = true;
		}

		if ( $in_token ) {
			$tokens[] = [
				'value' => $buf,
				'raw'   => $raw,
			];
		}

		$open_quote = $in_quote;
		return $tokens;
	}

	/**
	 * Read & parse a file, filling each non-trivial line through the sink as if typed.
	 */
	private function include_file( string $file ): void {
		$path = $this->resolve_include( $file );
		if ( null === $path ) {
			$this->print_less_often( 'Shell: include: file not found: ', $file );
			return;
		}
		$real = \realpath( $path );
		$key  = false === $real ? $path : $real;
		if ( \in_array( $key, $this->include_stack, true ) ) {
			$chain = \implode(
				' -> ',
				\array_map( static fn ( string $p ): string => \basename( $p ), [ ...$this->include_stack, $key ] )
			);
			if ( $this->fatal_errors ) {
				// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers; escape at the view, not the runtime.
				throw new \RuntimeException( "topology include cycle: $chain" );
			}
			$this->print_less_often( 'Shell: include: cycle: ', $chain );
			return;
		}
		if ( isset( $this->included[ $key ] ) ) {
			return;
		}
		// Topology files live alongside the plugin, not in WP-managed storage.
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fopen
		$fh = @\fopen( $path, 'r' );
		if ( false === $fh ) {
			$this->print_less_often( 'Shell: include: cannot open: ', $path );
			return;
		}
		$this->included[ $key ] = true;
		$this->include_stack[] = $key;
		try {
			while ( ( $line = \fgets( $fh ) ) !== false ) {
				$line = \rtrim( $line, "\r\n" );
				if ( self::declares_secure_level( $line ) ) {
					continue;
				}
				$this->eval_script( $line );
			}
			// A quote/continuation left open at include EOF never resolves.
			$this->flush_pending();
		} finally {
			\array_pop( $this->include_stack );
			\fclose( $fh );
		}
	}

	/**
	 * Whether a line declares the process's secure level.
	 *
	 * `secure` / `insecure` are a decision about the PROCESS, so they belong to
	 * the topology being loaded and not to anything it includes — an include
	 * that declared would decide on its parent's behalf. It would also break the
	 * parent outright: `secure 1` disables `make_node`, so every make_node after
	 * the include would be refused mid-load.
	 */
	private static function declares_secure_level( string $line ): bool {
		$verb = \strtok( \trim( $line ), " \t" );
		return 'secure' === $verb || 'insecure' === $verb;
	}

	/**
	 * End-of-input gate: an accumulator still holding a statement means EOF
	 * arrived inside an open quote or backslash continuation. Script context
	 * (fatal_errors) throws — Tachikoma's `got EOF while waiting for tokens` —
	 * so a mangled .tsl never half-loads; a REPL reports, clears, and resets
	 * the prompt.
	 */
	public function flush_pending(): void {
		$pending = '' !== $this->quote_continuation ? $this->quote_continuation : $this->continuation;
		if ( '' === $pending ) {
			return;
		}
		$this->quote_continuation = '';
		$this->continuation       = '';
		if ( '' !== $this->prompt_stash ) {
			$this->prompt       = $this->prompt_stash;
			$this->prompt_stash = '';
		}
		if ( $this->fatal_errors ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers; esc_html() would render quotes as &#039;.
			throw new \RuntimeException( 'got EOF while waiting for tokens: ' . \trim( $pending ) );
		}
		$this->stdout( 'got EOF while waiting for tokens: ' . \trim( $pending ) . "\n" );
	}

	public function stdout( string $line ): void {
		$message = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::VALUE ] = $line;
		$dumper = Core::node( Node_Names::OUTPUT );
		if ( $dumper instanceof Dumper_Node ) {
			$dumper->fill( $message );
		}
	}

	/** A topology NAME resolves through the registry; a literal path is taken as-is. */
	private function resolve_include( string $file ): ?string {
		// @longform Registered topology dirs ONLY. Worker boot eval_script()s
		// admin-authored TSL, so anything an include can reach, an admin who
		// can save a topology can execute. A bare `is_file()` fallback reached
		// the whole disk; a name carrying separators walks out of the dir
		// resolve() interpolates it into. Same reasoning as resolve()'s own
		// "stock owns its names" rule. If topologies ever become a tree,
		// replace this with canonicalize-then-contain, not a looser pattern.
		if ( '' === $file || \preg_match( '{[/\\\\]|^\.\.$}', $file ) ) {
			return null;
		}
		return Topology_Registry::resolve( $file );
	}

	/**
	 * Parse a multi-statement script and dispatch each resulting Message via the sink.
	 */
	public function eval_script( string $script ): void {
		$message = Message::new_message();
		$message[ Message::TYPE  ] = Message::TM_BYTESTREAM;
		$message[ Message::VALUE ] = $script;
		$this->fill( $message );
	}

	/**
	 * Resolve a relative/absolute path against the cwd. `/` resets; `../` walks up; result is TO-ready.
	 */
	public function cd( string $cwd, string $path ): string {
		// Empty path is a no-op; `cd /` resets to the local interpreter.
		if ( '/' !== $path && '' !== $path && '/' === $path[0] ) {
			$cwd = $path;
		} elseif ( '/' === $path ) {
			$cwd = '';
		} elseif ( '' !== $path && \preg_match( '#^[.][.]/?#', $path ) ) {
			$cwd  = (string) \preg_replace( '#/?[^/]+$#', '', $cwd );
			$path = (string) \preg_replace( '#^[.][.]/?#', '', $path );
			$cwd  = $this->cd( $cwd, $path );
		} elseif ( '' !== $path ) {
			$cwd .= '/' . $path;
		}
		return \trim( $cwd, '/' );
	}

	/**
	 * Slash-join the shell's cwd with an additional `<path>` arg, dropping empty pieces.
	 */
	public function prefix( string $path ): string {
		$parts = [];
		if ( '' !== $this->path ) {
			$parts[] = $this->path;
		}
		if ( '' !== $path ) {
			$parts[] = $path;
		}
		return \implode( '/', $parts );
	}

	/**
	 * When want_reply is off, mark a command TM_NOREPLY (no-op on non-commands).
	 *
	 * @param array<int, mixed> $message Message to stamp in place.
	 */
	private function stamp_noreply( array &$message ): void {
		$type = $message[ Message::TYPE ] ?? 0;
		if ( ! $this->want_reply && \is_int( $type ) && ( $type & Message::TM_COMMAND ) ) {
			$message[ Message::TYPE ] = $type | Message::TM_NOREPLY;
		}
	}

	/**
	 * The Shell is the unnamed REPL front-end; naming it would register a command
	 * surface in the graph. Fatal on any name argument so the rule can't be violated.
	 */
	public function name( ?string $name = null ): string {
		if ( \func_num_args() > 0 ) {
			throw new \RuntimeException( 'named Shell nodes are not allowed' );
		}
		return $this->name;
	}

	/** Accessor (Tachikoma Shell want_reply): interactive sessions reply; scripts/topology loads don't. */
	public function want_reply( ?bool $value = null ): bool {
		if ( null !== $value ) {
			$this->want_reply = $value;
		}
		return $this->want_reply;
	}

	/** Accessor: interactive sessions log-and-continue on a cycle; topology loads fail loud. */
	public function fatal_errors( ?bool $value = null ): bool {
		if ( null !== $value ) {
			$this->fatal_errors = $value;
		}
		return $this->fatal_errors;
	}

	/**
	 * Syntax-check a single TSL statement; throws on an unterminated backslash
	 * continuation. Unknown verbs are NOT rejected here — they flow through and
	 * the target CommandInterpreter answers `unknown command: <verb>`.
	 */
	public function validate_line( string $line ): void {
		$line = \trim( $line );
		if ( '' === $line || '#' === $line[0] ) {
			return;
		}
		if ( \str_ends_with( $line, '\\' ) ) {
			throw new \RuntimeException( 'unterminated backslash continuation' );
		}
	}

	public static function node_schema(): array {
		return [
			'category'    => 'Hidden',
			'description' => 'TSL parser/REPL — used in cli sessions, not part of topology graphs.',
			'arguments'        => [],
			'commands'       => [],
		];
	}
}
