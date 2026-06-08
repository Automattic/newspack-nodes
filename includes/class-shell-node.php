<?php
/**
 * Shell: REPL parser node.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Shell_Node extends Node {
	public string $prompt = '/> ';

	/** Current cwd — the node-path non-builtin commands route to by default; empty = local interpreter. */
	public string $path = '';

	/**
	 * Lines printed by the local `status` builtin on demand; empty = silent no-op.
	 *
	 * @var array<int,string>
	 */
	public array $status_lines = [];

	/** Backslash-continuation accumulator. */
	private string $continuation = '';

	/** When true, every parsed line dumps its interpolated/tokenized form to $output_stream. */
	private bool $show_parse = false;

	/**
	 * Shell egress. A TM_BYTESTREAM is raw REPL input: parse each statement into a
	 * Message and dispatch it. Anything else (a pre-built command from
	 * dispatch_line, a completion query, an EOF/ping marker) passes straight
	 * through to the sink. Mirrors Tachikoma::Nodes::Shell::fill, which sinks any
	 * non-TM_BYTESTREAM message rather than dropping it. Every command leaving the
	 * Shell is signed here so it carries an HMAC envelope across the IPC boundary
	 * to a worker (Command_Auth::sign is a no-op on non-command types).
	 */
	public function fill( array &$message ): void {
		if ( null === $this->sink ) {
			throw new \RuntimeException( 'Shell::fill requires a wired sink' );
		}
		$type  = $message[ Message::TYPE ]  ?? 0;
		$value = $message[ Message::VALUE ] ?? null;
		if ( ! \is_integer( $type ) ) {
			throw new \RuntimeException( 'Shell::fill requires a valid message' );
		}
		if ( Message::TM_EOF === $type ) {
			$message[ Message::FROM ] = Node_Names::OUTPUT . '/' . \getmypid();
			$message[ Message::TO ]   = $this->path;
			$this->sink->fill( $message );
			return;
		}
		if ( Message::TM_BYTESTREAM !== $type || ! \is_string( $value ) ) {
			throw new \RuntimeException( 'Shell::fill requires a TM_BYTESTREAM message with a string VALUE' );
		}
		foreach ( $this->split_statements( $value ) as $statement ) {
			$parsed = $this->parse( $statement );
			if ( null !== $parsed ) {
				++$this->counter;
				$parsed[ Message::KEY ] = $message[ Message::KEY ];
				Command_Auth::sign( $parsed );
				$this->sink->fill( $parsed );
			}
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

	/**
	 * Build a TM_COMMAND via $this->command(...) (inherited from Node), stamp the
	 * Shell session's FROM/LOCAL provenance + the target TO ($path), and fill
	 * it through $this->sink. Mirrors Tachikoma::Nodes::Shell::send_command —
	 * callers issue commands as method calls instead of via parse().
	 *
	 * @param string $path      Routing target (TO). Empty = local interpreter.
	 * @param string $name      Command verb (e.g. 'connect_node').
	 * @param string $arguments Positional argument string.
	 * @return void
	 */
	public function send_command( string $path, string $name, string $arguments = '' ): void {
		if ( null === $this->sink ) {
			throw new \RuntimeException( 'Shell::send_command requires a wired sink' );
		}
		$message                  = $this->command( $name, $arguments );
		$message[ Message::FROM ] = Node_Names::OUTPUT . '/' . \getmypid();
		$message[ Message::TO ]   = $path;
		Command_Auth::sign( $message );
		$this->sink->fill( $message );
	}

	/**
	 * Read & parse a file, filling each non-trivial line through the sink as if typed.
	 */
	private function include_file( string $file ): void {
		if ( '' === $file || ! \is_file( $file ) ) {
			$this->print_less_often( "Shell: include: file not found: $file" );
			return;
		}
		// Topology files live alongside the plugin, not in WP-managed storage.
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fopen
		$fh = @\fopen( $file, 'r' );
		if ( false === $fh ) {
			$this->print_less_often( "Shell: include: cannot open: $file" );
			return;
		}
		while ( ( $line = \fgets( $fh ) ) !== false ) {
			$line = \rtrim( $line, "\r\n" );
			$this->eval_script( $line );
		}
		\fclose( $fh );
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
	 * Quote-aware statement splitter: comment lines returned whole, others split on unquoted `;`.
	 *
	 * @return array<int,string>
	 */
	public function split_statements( string $script ): array {
		$statements = [];
		foreach ( \explode( "\n", $script ) as $line ) {
			$leading = \ltrim( $line );
			if ( '' === $leading ) {
				continue;
			}
			if ( '#' === $leading[0] ) {
				// Whole-line comment — don't scan for `;` inside it.
				$statements[] = \trim( $line );
				continue;
			}
			$buf      = '';
			$in_quote = null;
			$len      = \strlen( $line );
			for ( $i = 0; $i < $len; ++$i ) {
				$ch = $line[ $i ];
				if ( null !== $in_quote ) {
					$buf .= $ch;
					if ( $ch === $in_quote ) {
						$in_quote = null;
					}
					continue;
				}
				if ( "'" === $ch || '"' === $ch || '`' === $ch ) {
					$in_quote = $ch;
					$buf     .= $ch;
					continue;
				}
				if ( ';' === $ch ) {
					$trim = \trim( $buf );
					if ( '' !== $trim ) {
						$statements[] = $trim;
					}
					$buf = '';
					continue;
				}
				$buf .= $ch;
			}
			$tail = \trim( $buf );
			if ( '' !== $tail ) {
				$statements[] = $tail;
			}
		}
		return $statements;
	}

	/**
	 * Parse one line into a Message; null on empty/comment or held continuation.
	 *
	 * @return array<int, mixed>|null The 7-field positional Message, or null.
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

		// Trim AFTER interpolation so `<var>` can expand into leading whitespace.
		$line = \trim( $line );
		if ( '' === $line || '#' === $line[0] ) {
			return null;
		}

		$tokens = $this->tokenize( $line );
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

		if ( 'echo' === $verb ) {
			$this->stdout( \implode( ' ', $args ) . "\n" );
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

		// `var <name> = <value>`: reject `:` names (reserved for read-only namespaces like config:).
		if ( 'var' === $verb ) {
			$name = $args[0] ?? '';
			$eq   = $args[1] ?? '';
			if ( '' === $name || '=' !== $eq ) {
				return null;
			}
			if ( \str_contains( $name , ':' ) ) {
				$this->stdout( "var: invalid name '{$name}' (':' is reserved for namespaces like config:)\n" );
				return null;
			}
			Core::$var[ $name ] = \implode( ' ', \array_slice( $args, 2 ) );
			return null;
		}

		// FROM=`_output/$pid` so replies route back to this session's Dumper.
		$message                   = Message::new_message();
		$message[ Message::FROM ]  = Node_Names::OUTPUT . '/' . \getmypid();
		// LOCAL provenance taint — minted in this process. Stripped at the wire
		// boundary (packed()), so it authorizes only an in-process interpreter.
		$message[ Message::LOCAL ] = true;

		switch ( $verb ) {
			case 'command':
			case 'cmd':
			case 'command_node':
				$cmd_path  = $args[0] ?? '';
				$cmd_verb  = $args[1] ?? '';
				$cmd_args  = \implode( ' ', \array_slice( $args, 2 ) );
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
					'arguments' => $this->path,
				];
				break;
			case 'ping':
				// Receiver bounces TO=FROM; VALUE is the send timestamp.
				$message[ Message::TYPE ]  = Message::TM_PING;
				$message[ Message::TO ]    = $this->prefix( $args[0] ?? '' );
				$message[ Message::VALUE ] = (string) Core::$now;
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
				// TO=cwd: empty → local interpreter; set → routed via _router.
				$message[ Message::TYPE ]  = Message::TM_COMMAND;
				$message[ Message::TO ]    = $this->prefix( '' );
				$message[ Message::VALUE ] = [
					'name'      => $verb,
					'arguments' => \implode( ' ', $args ),
				];
				break;
		}

		return $message;
	}

	/**
	 * Quote-aware tokenizer ('/"/`): splits on unquoted whitespace, strips the quote chars.
	 *
	 * @return array<int, string>
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
				$in_token = true; // empty quoted string still counts as a token.
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

	public function show_parse(): bool {
		return $this->show_parse;
	}

	public function set_show_parse( bool $on ): void {
		$this->show_parse = $on;
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

	public function set_variable( string $name, string $value ): void {
		Core::$var[ $name ] = $value;
	}

	/**
	 * Single-tier interpolation: `<ns:key>` → that namespace's registered
	 * resolver (Core::resolve_config_token); bare `<var>` → Core::$var; unknown → ''.
	 */
	public function interpolate( string $line ): string {
		return (string) \preg_replace_callback(
			'/<([a-zA-Z_][a-zA-Z0-9_]*(?::[a-zA-Z_][a-zA-Z0-9_]*)?)>/',
			static function ( array $m ): string {
				$key   = $m[1];
				$colon = \strpos( $key, ':' );
				if ( false !== $colon ) {
					return Core::resolve_config_token( \substr( $key, 0, $colon ), \substr( $key, $colon + 1 ) );
				}
				return Core::$var[ $key ] ?? '';
			},
			$line
		);
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

	public static function node_schema(): array {
		return [
			'category'    => 'Hidden',
			'description' => 'TSL parser/REPL — used in cli sessions, not part of topology graphs.',
			'arguments'        => [],
			'commands'       => [],
		];
	}
}
