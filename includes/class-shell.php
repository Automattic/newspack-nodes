<?php
/**
 * Shell: REPL parser node.
 *
 * Subset of real Tachikoma's Shell3.pm — line-oriented, single-tier `<var>`
 * interpolation, backslash continuation, quote-aware tokenization (', ", `).
 * Conditionals/loops/pipes/eval explicitly NOT supported (rejected with warning).
 *
 * Each parsed line emits one Message stamped with FROM=_output/$pid so the
 * reply walks back through _router to the local Dumper named `_output`.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Shell extends Node {
	public string $prompt = 'newspack-nodes> ';

	// Variable storage moved to Core::$var (process-global) so multiple
	// Shell instances share state and any PHP caller can read the
	// current TSL bindings (e.g. JobWorker handlers reading `partition`
	// or `config:base_directory`). The `$variables` accessor below
	// reads/writes the same map.

	/**
	 * Current "directory" — the node-path TO which non-builtin commands route
	 * by default. Empty = local _command_interpreter handles it. Updated by
	 * the `cd`/`chdir` builtin (see Tachikoma Shell.pm:106-114).
	 */
	public string $path = '';

	/**
	 * Lines printed by the local `status` builtin. Cli sets these to the
	 * mode banner + IPC paths so users can summon them on demand instead of
	 * having them auto-printed at session start (where they pollute scripted
	 * captures). Empty = `status` is a silent no-op.
	 *
	 * @var array<int,string>
	 */
	public array $status_lines = [];

	/**
	 * Output sink for local-only builtins (e.g. `status`). Defaults to null;
	 * the cli's `run_repl` injects STDOUT in production, tests inject a
	 * `php://memory` resource. When null, local-print builtins are silent.
	 *
	 * @var resource|null
	 */
	public $output_stream = null;

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

	/**
	 * `show_parse` toggle — when true, every parsed line emits its post-
	 * interpolation form, tokenized form, and the message envelope it built
	 * (if any) to $output_stream. Useful when debugging interpolation /
	 * tokenization quirks. Mirrors Perl Tachikoma Shell3 `show_parse`.
	 */
	private bool $show_parse = false;

	public function show_parse(): bool {
		return $this->show_parse;
	}

	public function set_show_parse( bool $on ): void {
		$this->show_parse = $on;
	}

	private const FORBIDDEN = [ 'if', 'while', 'for', 'func', 'eval', 'unless', 'until' ];

	public function set_variable( string $name, string $value ): void {
		Core::$var[ $name ] = $value;
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
	 * Single-tier interpolation. Two namespaces:
	 *   `<varname>`     → Core::$var[varname]
	 *   `<config:foo>`  → Core::$config[foo]   (read-only PHP-populated)
	 * Unknown keys expand to empty string (matches real Shell3 unset-var policy).
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
	 * Quote-aware statement splitter. Splits a multi-statement script
	 * into trimmed non-empty fragments. Lines whose first non-whitespace
	 * character is `#` are returned whole (comment lines aren't scanned
	 * for `;`); other lines split on unquoted `;` so multiple statements
	 * fit on one line.
	 *
	 * Topology_Loader (and any other multi-statement caller) uses this
	 * to turn a TSL file into a list of single-statement strings before
	 * handing each one to parse().
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
			// Non-comment line: split on unquoted `;`.
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
	 * Parse a multi-statement script and dispatch each resulting
	 * Message via $this->sink->fill(). Statements are separated by
	 * unquoted `;` or newline. Builtins (var, cd, …) take effect via
	 * side-effects and emit no Message.
	 *
	 * Used by Topology_Loader to feed a whole TSL file through the
	 * Shell in one call. Cli REPL keeps using parse() per typed line.
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

		// show_parse: report the post-interpolation line + tokens before
		// dispatching. Builtins return before constructing a Message, so this
		// is the only place every line passes through. Goes to output_stream
		// (same channel as `status` / `show_sse` reporting); silent when
		// output_stream is unset.
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

		// `include <file>` builtin: read file, recursively parse each line.
		if ( 'include' === $verb ) {
			$file = $args[0] ?? '';
			$this->include_file( $file );
			return null;
		}

		// `cd` / `chdir` builtin: update $this->path so subsequent default
		// commands route to that node-path (Tachikoma Shell.pm:106-114).
		// No message emitted — pure state mutation in the local Shell.
		if ( 'cd' === $verb || 'chdir' === $verb ) {
			$this->path = $this->cd( $this->path, $args[0] ?? '' );
			return null;
		}

		// `var name = value` builtin (Tachikoma Shell-style). Writes
		// Core::$var[$name]. Used in TSL frontmatter to declare
		// per-topology metadata (var num_partitions = 4;) and ad-hoc
		// shell variables. No Message emitted.
		//
		// Tokenizer eats the `=` when it's whitespace-separated; the
		// shape is `var <name> = <value>` (3 tokens after the verb)
		// or `var <name> = <value with spaces>` (the value is the
		// tail joined). Reject names containing `:` — that namespace
		// is reserved for read-only PHP-populated lookups (e.g.
		// `<config:foo>` resolves Core::$config['foo']) and writes
		// to it through `var` would silently confuse readers.
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

		// `status` builtin: print pre-populated $status_lines to the
		// configured $output_stream. Local-only — no Message emitted, no
		// command sent to the worker (in pivoted mode, Shell's sink is the
		// cmd-out Partition, so a Message would just go to disk). Cli
		// populates the lines at session start; user types `status` to see
		// them on demand. Empty list or null stream → silent no-op.
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

		// `show_parse` builtin: toggle dumping of the parsed token list (and the
		// resulting Message envelope) to $output_stream for every subsequent
		// parse(). Local-only, mirrors Perl Tachikoma Shell3 `show_parse` —
		// useful when interpolation/tokenization quirks need a microscope. No
		// arguments — pure toggle.
		if ( 'show_parse' === $verb ) {
			$this->show_parse = ! $this->show_parse;
			if ( \is_resource( $this->output_stream ) ) {
				// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_fwrite
				\fwrite( $this->output_stream, 'show_parse: ' . ( $this->show_parse ? 'on' : 'off' ) . "\n" );
			}
			return null;
		}

		// `debug_level` builtin: set or toggle the local Dumper's render
		// verbosity. With no args, toggles between 0 and 1 (matching Perl
		// Tachikoma's `debug_level` semantics). With one numeric arg, sets
		// explicitly (clamped to 0..2 inside Dumper). Levels:
		//   0  curated interactive output (default)
		//   1  + one-line debug header per Message to stderr
		//   2  + full envelope (id/stream/from/to/ts) in the header
		// Reports the resulting level to $output_stream.
		if ( 'debug_level' === $verb ) {
			$dumper = Core::node( '_output' );
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

		// `show_sse` builtin: toggle the local Dumper's `TO=sse` filter. The
		// worker fans stats / debug_state events out to `TO=_repl/sse`; the
		// worker-side _router peels `_repl`, so each cli/SSE reader sees
		// bare `TO=sse` arriving at its Dumper. By default the Dumper drops
		// those (they're not addressed to this session's $pid). `show_sse`
		// flips the per-session opt-in so the user can peek at the stream.
		// Takes no arguments — pure toggle, matching Perl Tachikoma's
		// builtin convention. Reports the new state to $output_stream.
		if ( 'show_sse' === $verb ) {
			$dumper = Core::node( '_output' );
			if ( $dumper instanceof Dumper ) {
				$now = $dumper->toggle_broadcast_filter( 'sse' );
				if ( \is_resource( $this->output_stream ) ) {
					// $output_stream is STDOUT or a test memory stream — never a managed path.
					// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_fwrite
					\fwrite( $this->output_stream, 'show_sse: ' . ( $now ? 'on' : 'off' ) . "\n" );
				}
			}
			return null;
		}

		// Reject unsupported features early & loudly.
		if ( \in_array( $verb, self::FORBIDDEN, true ) ) {
			Core::print_less_often( "Shell: '$verb' not supported in v1" );
			return null;
		}

		// FROM=`_output/$pid` so replies route uniformly in both bare and
		// pivoted modes:
		//   - Bare:  CI's response has TO=_output/$pid. Local _router peels
		//            _output, forwards to _output (Dumper) with TO=$pid.
		//            Local-only — no IPC envelope.
		//   - Pivot: Worker's input-Consumer (stamp_as=_repl) prepends, making
		//            FROM=_repl/_output/$pid. CI's response TO=_repl/_output/$pid.
		//            Worker's _router peels _repl, forwards to _repl Partition
		//            with TO=_output/$pid; the envelope hits disk and the
		//            cli's reply-in Consumer reads it, sinks to _router, which
		//            forwards to _output (Dumper). Multi-session: each cli's
		//            Dumper filters TO ∈ {_output/$pid, $pid} so other
		//            sessions' replies fall through silently.
		$id                   = $this->generate_id();
		$msg                  = Message::new_message();
		$msg[ Message::ID ]   = $id;
		$msg[ Message::FROM ] = '_output/' . \getmypid();

		switch ( $verb ) {
			case 'tell':
			case 'tell_node':
				// Tachikoma Shell.pm `tell_node <path> <info>` (alias: tell) —
				// emits TM_INFO at prefix(<path>) so the cwd composes.
				$msg[ Message::TYPE ]  = Message::TM_INFO;
				$msg[ Message::TO ]    = $this->prefix( $args[0] ?? '' );
				$msg[ Message::VALUE ] = \implode( ' ', \array_slice( $args, 1 ) );
				break;
			case 'send':
			case 'send_node':
				// Tachikoma Shell.pm `send_node <path> <bytes>` (alias: send) —
				// emits TM_BYTESTREAM at prefix(<path>) so the cwd composes.
				$msg[ Message::TYPE ]  = Message::TM_BYTESTREAM;
				$msg[ Message::TO ]    = $this->prefix( $args[0] ?? '' );
				$msg[ Message::VALUE ] = \implode( ' ', \array_slice( $args, 1 ) );
				break;
			case 'send_eof':
				$msg[ Message::TYPE ] = Message::TM_EOF;
				$msg[ Message::TO ]   = $this->prefix( $args[0] ?? '' );
				break;
			case 'command':
			case 'cmd':
			case 'command_node':
				// Tachikoma Shell.pm `command_node <path> <verb> [<args>]`
				// (aliases: command, cmd) — drive a TM_COMMAND at a specific
				// path without changing cwd. Uses prefix() so the cwd
				// composes as it does for `send_node`.
				$cmd_path  = $args[0] ?? '';
				$cmd_verb  = $args[1] ?? '';
				$cmd_args  = \implode( ' ', \array_slice( $args, 2 ) );
				$msg[ Message::TYPE ]  = Message::TM_COMMAND;
				$msg[ Message::TO ]    = $this->prefix( $cmd_path );
				$msg[ Message::VALUE ] = (string) \wp_json_encode(
					[
						'name'      => $cmd_verb,
						'arguments' => $cmd_args,
						'payload'   => '',
					]
				);
				break;
			case 'request':
			case 'request_node':
				// Tachikoma-style introspection: TM_REQUEST at prefix(<path>)
				// with the rest of the line as VALUE. Receiver is expected to
				// build a TM_RESPONSE addressed back at FROM.
				$msg[ Message::TYPE ]  = Message::TM_REQUEST;
				$msg[ Message::TO ]    = $this->prefix( $args[0] ?? '' );
				$msg[ Message::VALUE ] = \implode( ' ', \array_slice( $args, 1 ) );
				break;
			case 'pwd':
				// Tachikoma Shell.pm:146-150 — send `pwd <cwd>` as TM_COMMAND
				// to the current path. The receiving CI's `pwd` handler
				// renders ` <args> -> <from>` so output reflects where the
				// command landed and where the reply walked back from.
				$msg[ Message::TYPE ]  = Message::TM_COMMAND;
				$msg[ Message::TO ]    = $this->path;
				$msg[ Message::VALUE ] = (string) \wp_json_encode(
					[
						'name'      => 'pwd',
						'arguments' => $this->path,
						'payload'   => '',
					]
				);
				break;
			case 'ping':
				// Tachikoma Shell3 builtin: build TM_PING addressed at <path>,
				// payload = current timestamp. Receiver's CommandInterpreter
				// bounces TO=FROM, so the message returns along the FROM trail
				// to _output/$pid → Dumper.
				$msg[ Message::TYPE ]  = Message::TM_PING;
				$msg[ Message::TO ]    = $this->prefix( $args[0] ?? '' );
				$msg[ Message::VALUE ] = (string) Core::$now;
				break;
			default:
				// Default: TM_COMMAND with verb as command name. TO is the
				// shell's current `path` — empty means the local
				// _command_interpreter handles it; non-empty (after `cd
				// firehose:partition`) routes via _router to that node's CI.
				// Pivoted-mode callers re-route via the cmd-out Partition.
				$msg[ Message::TYPE ]  = Message::TM_COMMAND;
				$msg[ Message::TO ]    = $this->prefix( '' );
				$msg[ Message::VALUE ] = (string) \wp_json_encode(
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
	 * Tachikoma Shell.pm:prefix() — combine the shell's cwd (`$this->path`)
	 * with an additional `<path>` arg into the canonical slash-joined form.
	 * Empty pieces drop out so leading/trailing slashes don't appear when
	 * either side is empty.
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
	 * Tachikoma Shell.pm:cd() — resolve a relative or absolute path against
	 * the current cwd. Empty path clears cwd; absolute paths replace it;
	 * `../` walks up one segment (recursing for chains like `../../foo`).
	 * Final result has leading/trailing slashes stripped so it can be used
	 * directly as a Message TO.
	 */
	public function cd( string $cwd, string $path ): string {
		// Empty path is a no-op — keeps cwd as-is (matches Tachikoma
		// Shell.pm:cd; `cd` with no args is "redraw the prompt"). Use `cd /`
		// to reset to the local interpreter.
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
	 * Recursively read & parse a file. Each non-trivial line is parsed and
	 * filled through this Shell's sink, exactly as if it had been typed at
	 * the prompt.
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
	 * Standard sink-forward. Counts the message; subclasses might rewrite TO.
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
