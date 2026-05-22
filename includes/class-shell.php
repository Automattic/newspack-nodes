<?php
/**
 * Shell: REPL parser node.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Shell extends Node {
	public string $prompt = 'newspack-nodes> ';

	/** Current cwd — the node-path non-builtin commands route to by default; empty = local CI. */
	public string $path = '';

	/**
	 * Lines printed by the local `status` builtin on demand; empty = silent no-op.
	 *
	 * @var array<int,string>
	 */
	public array $status_lines = [];

	/**
	 * Output sink for local-only builtins; null = silent.
	 *
	 * @var resource|null
	 */
	public $output_stream = null;

	/**
	 * Refuse to register the Shell under a node name — shells are anonymous.
	 */
	public function name( ?string $name = null ): string {
		if ( null !== $name ) {
			throw new \RuntimeException( 'named Shell nodes are not allowed' );
		}
		return $this->name;
	}

	/** Backslash-continuation accumulator. */
	private string $continuation = '';

	/** When true, every parsed line dumps its interpolated/tokenized form to $output_stream. */
	private bool $show_parse = false;

	public function show_parse(): bool {
		return $this->show_parse;
	}

	public function set_show_parse( bool $on ): void {
		$this->show_parse = $on;
	}

	private const FORBIDDEN = [ 'if', 'while', 'for', 'func', 'eval', 'unless', 'until' ];

	/**
	 * Syntax-check a single TSL statement; throws on forbidden verbs, bad continuation, or quote errors.
	 */
	public function validate_line( string $line ): void {
		$line = \trim( $line );
		if ( '' === $line || '#' === $line[0] ) {
			return;
		}
		if ( \str_ends_with( $line, '\\' ) ) {
			throw new \RuntimeException( 'unterminated backslash continuation' );
		}
		$tokens = $this->tokenize( $this->interpolate( $line ) );
		if ( empty( $tokens ) ) {
			return;
		}
		$verb = $tokens[0];
		if ( \in_array( $verb, self::FORBIDDEN, true ) ) {
			$safe = \function_exists( 'esc_html' ) ? \esc_html( $verb ) : $verb;
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- $safe already escaped.
			throw new \RuntimeException( "forbidden verb '" . $safe . "'" );
		}
	}

	public function set_variable( string $name, string $value ): void {
		Core::$var[ $name ] = $value;
	}

	/**
	 * Quote-aware tokenizer ('/"/`): splits on unquoted whitespace, strips the quote chars.
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
	 * Single-tier interpolation: `<var>` → Core::$var, `<config:foo>` → Core::$config; unknown → ''.
	 */
	public function interpolate( string $line ): string {
		return (string) \preg_replace_callback(
			'/<([a-zA-Z_][a-zA-Z0-9_]*(?::[a-zA-Z_][a-zA-Z0-9_]*)?)>/',
			static function ( array $m ): string {
				$key = $m[1];
				if ( \str_starts_with( $key, 'config:' ) ) {
					$cfg_key = \substr( $key, 7 );
					return (string) ( Core::$config[ $cfg_key ] ?? '' );
				}
				return (string) ( Core::$var[ $key ] ?? '' );
			},
			$line
		);
	}

	/**
	 * Generate a message id: time():monotonic-counter.
	 */
	private function generate_id(): string {
		return \sprintf( '%d:%010d', \time(), Core::msg_counter() );
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
	 * Parse a multi-statement script and dispatch each resulting Message via the sink.
	 */
	public function eval_script( string $script ): void {
		foreach ( $this->split_statements( $script ) as $statement ) {
			$msg = $this->parse( $statement );
			if ( null !== $msg && null !== $this->sink ) {
				$this->sink->fill( $msg );
			}
		}
	}

	/**
	 * Parse one line into a Message; null on empty/comment, held continuation, or forbidden verb.
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

		if ( $this->show_parse && \is_resource( $this->output_stream ) ) {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_fwrite
			\fwrite(
				$this->output_stream,
				'parse> line: ' . $line . "\n" .
				'parse> tokens: ' . (string) \wp_json_encode( $tokens ) . "\n"
			);
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
			return null;
		}

		if ( 'echo' === $verb ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- shell-builtin output, not user-facing HTML.
			echo \implode( ' ', $args ) . "\n";
			return null;
		}

		if ( 'debug_level' === $verb ) {
			$dumper = Core::node( Node_Names::OUTPUT );
			if ( $dumper instanceof Dumper ) {
				$current = $dumper->debug_level();
				$next    = ! empty( $args )
					? (int) $args[0]
					: ( $current > 0 ? 0 : 1 );
				$applied = $dumper->set_debug_level( $next );
				if ( \is_resource( $this->output_stream ) ) {
					// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_fwrite
					\fwrite( $this->output_stream, 'debug_level: ' . $applied . "\n" );
				}
			}
			return null;
		}

		if ( 'status' === $verb ) {
			if ( \is_resource( $this->output_stream ) ) {
				foreach ( $this->status_lines as $line ) {
					// $output_stream is STDOUT or a test memory stream — never a managed path.
					// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_fwrite
					\fwrite( $this->output_stream, $line . "\n" );
				}
			}
			return null;
		}

		if ( 'show_parse' === $verb ) {
			$this->show_parse = ! $this->show_parse;
			if ( \is_resource( $this->output_stream ) ) {
				// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_fwrite
				\fwrite( $this->output_stream, 'show_parse: ' . ( $this->show_parse ? 'on' : 'off' ) . "\n" );
			}
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
				if ( \is_resource( $this->output_stream ) ) {
					// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_fwrite
					\fwrite( $this->output_stream, "var: invalid name '{$name}' (':' is reserved for read-only namespaces like config:)\n" );
				}
				return null;
			}
			Core::$var[ $name ] = \implode( ' ', \array_slice( $args, 2 ) );
			return null;
		}

		if ( \in_array( $verb, self::FORBIDDEN, true ) ) {
			Core::print_less_often( "Shell: '$verb' not supported in v1" );
			return null;
		}

		// FROM=`_output/$pid` so replies route back to this session's Dumper.
		$id                   = $this->generate_id();
		$msg                  = Message::new_message();
		$msg[ Message::ID ]   = $id;
		$msg[ Message::FROM ] = Node_Names::OUTPUT . '/' . \getmypid();
		// LOCAL provenance taint — minted in this process. Stripped at the wire
		// boundary (packed()), so it authorizes only an in-process CI; a pivoted
		// command instead gets HMAC-signed by Command_Signer before IPC.
		$msg[ Message::LOCAL ] = true;

		switch ( $verb ) {
			case 'command':
			case 'cmd':
			case 'command_node':
				$cmd_path  = $args[0] ?? '';
				$cmd_verb  = $args[1] ?? '';
				$cmd_args  = \implode( ' ', \array_slice( $args, 2 ) );
				$msg[ Message::TYPE ]  = Message::TM_COMMAND;
				$msg[ Message::TO ]    = $this->prefix( $cmd_path );
				$msg[ Message::VALUE ] = [
					'name'      => $cmd_verb,
					'arguments' => $cmd_args,
					'payload'   => '',
				];
				break;
			case 'pwd':
				$msg[ Message::TYPE ]  = Message::TM_COMMAND;
				$msg[ Message::TO ]    = $this->path;
				$msg[ Message::VALUE ] = [
					'name'      => 'pwd',
					'arguments' => $this->path,
					'payload'   => '',
				];
				break;
			case 'ping':
				// Receiver bounces TO=FROM; VALUE is the send timestamp.
				$msg[ Message::TYPE ]  = Message::TM_PING;
				$msg[ Message::TO ]    = $this->prefix( $args[0] ?? '' );
				$msg[ Message::VALUE ] = (string) Core::$now;
				break;
			case 'request':
			case 'request_node':
				$msg[ Message::TYPE ]  = Message::TM_REQUEST;
				$msg[ Message::TO ]    = $this->prefix( $args[0] ?? '' );
				$msg[ Message::VALUE ] = \implode( ' ', \array_slice( $args, 1 ) );
				break;
			case 'send':
			case 'send_node':
				$msg[ Message::TYPE ]  = Message::TM_BYTESTREAM;
				$msg[ Message::TO ]    = $this->prefix( $args[0] ?? '' );
				$msg[ Message::VALUE ] = \implode( ' ', \array_slice( $args, 1 ) ) . "\n";
				break;
			case 'send_eof':
				$msg[ Message::TYPE ] = Message::TM_EOF;
				$msg[ Message::TO ]   = $this->prefix( $args[0] ?? '' );
				break;
			case 'tell':
			case 'tell_node':
				$msg[ Message::TYPE ]  = Message::TM_INFO;
				$msg[ Message::TO ]    = $this->prefix( $args[0] ?? '' );
				$msg[ Message::VALUE ] = \implode( ' ', \array_slice( $args, 1 ) );
				break;
			default:
				// TO=cwd: empty → local CI; set → routed via _router.
				$msg[ Message::TYPE ]  = Message::TM_COMMAND;
				$msg[ Message::TO ]    = $this->prefix( '' );
				$msg[ Message::VALUE ] = [
					'name'      => $verb,
					'arguments' => \implode( ' ', $args ),
					'payload'   => '',
				];
				break;
		}

		return $msg;
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


	/**
	 * Read & parse a file, filling each non-trivial line through the sink as if typed.
	 */
	private function include_file( string $file ): void {
		if ( '' === $file || ! \is_file( $file ) ) {
			Core::print_less_often( "Shell: include: file not found: $file" );
			return;
		}
		// Topology files live alongside the plugin, not in WP-managed storage.
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fopen
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
	 * Standard sink-forward, counting the message.
	 */
	public function fill( array &$message ): void {
		++$this->counter;
		$this->sink?->fill( $message );
	}

	public static function node_schema(): array {
		return [
			'category'    => 'Hidden',
			'description' => 'TSL parser/REPL — used in cli sessions, not part of topology graphs.',
			'ctor'        => [],
			'verbs'       => [],
		];
	}
}
