<?php
/**
 * CommandInterpreter: graph builder + shell vocabulary dispatch.
 *
 * One per process, named `_command_interpreter`. Auto-sink default for every make_node
 * (matches real Tachikoma; see prototype Nodes/CommandInterpreter.php:319). Forwards
 * non-TM_COMMAND messages to its sink, which is typically `_router`.
 *
 * Vocabulary lives in a static dispatch table ($C) — state-machine pattern, efficiency
 * principle "table-driven dispatch."
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class CommandInterpreter extends Node {
	/** @var array<string,callable>|null Verb → handler. Initialized lazily. */
	private static ?array $C = null;

	/**
	 * Per-command help text. Multi-line strings shown by the `help` command,
	 * mirrors `$H{...}` in real Tachikoma's CommandInterpreter.pm. Keyed by the
	 * canonical verb; aliases share entries via the dispatch table.
	 *
	 * @var array<string,string>|null
	 */
	private static ?array $H = null;

	/** @var array<string,class-string> Class registry: shell-name → FQCN. */
	private static array $class_map = [];

	public static function register_class( string $shell_name, string $fqcn ): void {
		self::$class_map[ $shell_name ] = $fqcn;
	}

	private static function init_C(): void {
		if ( null !== self::$C ) {
			return;
		}
		self::$H = [
			// CI-dispatched verbs.
			'make_node' => "make_node <type> <name> [<arguments>]\n    alias: make\n",
			'set_sink'  => "set_sink <node> <target>\n",
			'connect_node' => "connect_node <node> <target>\n    alias: connect\n",
			'disconnect_node' => "disconnect_node <node> [<target>]\n    alias: disconnect\n    note: <target> is required for multi-target nodes (e.g. Tee).\n",
			'remove_node' => "remove_node <node name> [<more names>...]\n"
				. "remove_node -a <anchored regex glob>\n"
				. "    aliases: remove, rm\n",
			'list_nodes' => "list_nodes [ -celos ] [ <node name> ]\n"
				. "list_nodes -a [ -celos ] [ <regex glob> ]\n"
				. "    -c show message counters\n"
				. "    -e show edges\n"
				. "    -l show counters and owners\n"
				. "    -o show owners\n"
				. "    -s show sinks\n"
				. "    -a show all nodes matching regex glob\n"
				. "       show all nodes if regex glob is omitted\n"
				. "    note: Without -a, the argument specifies a node;\n"
				. "          all nodes sinking into the specified node are displayed.\n"
				. "    alias: ls\n",
			'dump_node' => "dump_node <node name> [<keys>]\n    alias: dump\n",
			'dump_config' => "dump_config\n",
			'pwd' => "pwd\n",
			'help' => "help [ <topic> ]\n",

			// Shell-level builtins. Documented here so `help` is a single
			// source of truth for everything the user can type at the prompt.
			// These never reach the CI dispatch table — Shell intercepts them
			// before sending a Message — but they're part of the interactive
			// vocabulary so they belong in `help`.
			'cd' => "cd [ <path> ]\n    alias: chdir\n    note: empty path resets cwd to the local interpreter.\n",
			'status' => "status\n    note: print local cli mode summary (no command sent to worker).\n",
			'tell_node' => "tell_node <path> <info>\n    alias: tell\n    note: emits TM_INFO at prefix(<path>); fire-and-forget broadcast.\n",
			'send_node' => "send_node <path> <bytes>\n    alias: send\n    note: emits TM_BYTESTREAM at prefix(<path>).\n",
			'send_eof' => "send_eof <path>\n    note: emits TM_EOF at prefix(<path>).\n",
			'command_node' => "command_node <path> <verb> [<arguments>]\n    aliases: command, cmd\n    note: dispatches a TM_COMMAND at prefix(<path>) without changing cwd.\n",
			'request_node' => "request_node <path> [<value>]\n    alias: request\n    note: emits TM_REQUEST at prefix(<path>); receiver replies via TO=FROM.\n",
			'ping' => "ping <path>\n    note: round-trips a TM_PING; receiver bounces TO=FROM. Output shows RTT.\n",
			'include' => "include <file>\n    note: read commands from <file>, parse each line as if typed.\n",
		];
		self::$C = [
			'make_node'       => fn ( CommandInterpreter $self, string $args ): string => self::cmd_make_node( $self, $args ),
			'make'            => fn ( CommandInterpreter $self, string $args ): string => self::cmd_make_node( $self, $args ),
			'pwd'             => fn ( CommandInterpreter $self, string $args, array $message ): string => self::cmd_pwd( $args, $message ),
			'set_sink'        => fn ( CommandInterpreter $self, string $args ): string => self::cmd_set_sink( $args ),
			'connect_node'    => fn ( CommandInterpreter $self, string $args ): string => self::cmd_connect_node( $args ),
			'connect'         => fn ( CommandInterpreter $self, string $args ): string => self::cmd_connect_node( $args ),
			'disconnect_node' => fn ( CommandInterpreter $self, string $args ): string => self::cmd_disconnect_node( $args ),
			'disconnect'      => fn ( CommandInterpreter $self, string $args ): string => self::cmd_disconnect_node( $args ),
			'remove_node'     => fn ( CommandInterpreter $self, string $args ): string => self::cmd_remove_node( $self, $args ),
			'remove'          => fn ( CommandInterpreter $self, string $args ): string => self::cmd_remove_node( $self, $args ),
			'rm'              => fn ( CommandInterpreter $self, string $args ): string => self::cmd_remove_node( $self, $args ),
			'list_nodes'      => fn ( CommandInterpreter $self, string $args ): string => self::cmd_list_nodes( $self, $args ),
			'ls'              => fn ( CommandInterpreter $self, string $args ): string => self::cmd_list_nodes( $self, $args ),
			'dump_node'       => fn ( CommandInterpreter $self, string $args ): string => self::cmd_dump_node( $args ),
			'dump'            => fn ( CommandInterpreter $self, string $args ): string => self::cmd_dump_node( $args ),
			'dump_config'     => fn ( CommandInterpreter $self, string $args ): string => self::cmd_dump_config(),
			'help'            => fn ( CommandInterpreter $self, string $args ): string => self::cmd_help( $args ),
		];
	}

	/**
	 * Shell-vocabulary entry: parses `<type> <name> [<ctor_args>...]` from
	 * the command line and delegates to the instance API. Whitespace-
	 * separated trailing tokens become variadic constructor arguments —
	 * since we don't declare `strict_types=1`, PHP coerces string tokens to
	 * the typed parameter the constructor declares (e.g. `int $partition`).
	 *
	 * Topology code uses the same `make_node()` instance method with native
	 * PHP types. One construction path, no Node::arguments() round-trip.
	 */
	private static function cmd_make_node( CommandInterpreter $self, string $args ): string {
		$parts = \preg_split( '/\s+/', \trim( $args ) );
		if ( \count( $parts ) < 2 ) {
			return 'usage: make_node <type> <name> [<ctor_args>...]';
		}
		$type = \array_shift( $parts );
		$name = \array_shift( $parts );
		$node = $self->make_node( $type, $name, ...$parts );
		return null === $node ? "unknown class: $type" : 'ok';
	}

	/**
	 * Instance API used by topology PHP code: construct a registered Node
	 * subclass with positional ctor args, name it, sink it to this CI, and
	 * return it. The shell `make_node` verb uses the same code path —
	 * cmd_make_node just splits its args string and forwards via variadic.
	 *
	 * Topology call site:
	 *   $interpreter->make_node( 'Partition', 'requests:partition',
	 *       $path, $partition, $segment_size, $num_segments, $max_lifespan );
	 *
	 * Returns null when the class shell-name isn't registered. Class
	 * registration happens via `register_class( $shell_name, $fqcn )`;
	 * substrate types register themselves at plugin file load.
	 *
	 * @param string $type      Shell name registered in `$class_map`.
	 * @param string $name      Unique name for the new node (registered with Core).
	 * @param mixed  ...$ctor_args Positional constructor arguments.
	 * @return Node|null
	 */
	public function make_node( string $type, string $name, ...$ctor_args ): ?Node {
		$fqcn = self::$class_map[ $type ] ?? null;
		if ( null === $fqcn || ! \class_exists( $fqcn ) ) {
			return null;
		}
		$node = new $fqcn( ...$ctor_args );
		$node->name( $name );
		$node->sink( $this );
		return $node;
	}

	/**
	 * `pwd` verb: return ` <args> -> <envelope.from>` so the user sees both
	 * the cwd that issued the command and the path the response walked back
	 * along. Mirrors Tachikoma CommandInterpreter.pm:pwd. The Shell builtin
	 * passes its current path as $args; empty args displays as `/`.
	 */
	private static function cmd_pwd( string $args, array $envelope ): string {
		$cwd  = '' === $args ? '/' : $args;
		$from = $envelope[ Message::FROM ] ?? '';
		return ' ' . $cwd . ' -> ' . $from;
	}

	private static function cmd_set_sink( string $args ): string {
		[ $name, $target ] = \array_pad( \preg_split( '/\s+/', \trim( $args ), 2 ), 2, '' );
		if ( '' === $name || '' === $target ) {
			return 'usage: set_sink <node> <target>';
		}
		$src = Core::node( $name );
		$dst = Core::node( $target );
		if ( null === $src || null === $dst ) {
			return 'unknown node';
		}
		$src->sink( $dst );
		return 'ok';
	}

	private static function cmd_connect_node( string $args ): string {
		[ $name, $target ] = \array_pad( \preg_split( '/\s+/', \trim( $args ), 2 ), 2, '' );
		if ( '' === $name || '' === $target ) {
			return 'usage: connect_node <node> <target>';
		}
		$src = Core::node( $name );
		if ( null === $src ) {
			return "unknown node: $name";
		}
		$src->connect_node( $target );
		return 'ok';
	}

	private static function cmd_disconnect_node( string $args ): string {
		[ $name, $target ] = \array_pad( \preg_split( '/\s+/', \trim( $args ), 2 ), 2, '' );
		if ( '' === $name ) {
			return 'usage: disconnect_node <node> [<target>]';
		}
		$src = Core::node( $name );
		if ( null === $src ) {
			return "unknown node: $name";
		}
		$src->disconnect_node( $target );
		return 'ok';
	}

	/**
	 * `remove_node <name>` / `remove_node <a> <b> <c>` / `remove_node -a <regex>`.
	 *
	 * Mirrors Tachikoma CommandInterpreter.pm:remove_node — single name,
	 * space-separated list, or anchored-regex glob via -a. Refuses to destroy
	 * the baseline scaffolding (`_command_interpreter`, `_router`, `_output`)
	 * or the calling interpreter itself; everything else gets `remove_node()`
	 * called on it. The Tachikoma JobController-specific guard isn't ported
	 * because we don't have JobController here.
	 *
	 * Returns a multi-line summary so the cli can render which nodes were
	 * removed and which weren't found. Throws (caught upstream as
	 * TM_COMMAND|TM_ERROR) only when the args are malformed.
	 */
	private static function cmd_remove_node( CommandInterpreter $self, string $args ): string {
		$args = \trim( $args );
		if ( '' === $args ) {
			return 'usage: remove_node <node name>';
		}

		$list_matches = false;
		if ( \str_starts_with( $args, '-a ' ) || '-a' === $args ) {
			$list_matches = true;
			$args         = \trim( \substr( $args, 2 ) );
			if ( '' === $args ) {
				return 'usage: remove_node -a <anchored regex glob>';
			}
		}

		if ( $list_matches ) {
			// Anchored regex match. Use `@regex@` so user-supplied / and ^$ don't
			// need to be escaped. Filter out anything that doesn't match cleanly.
			$names = [];
			foreach ( \array_keys( Core::$nodes_by_name ) as $candidate ) {
				if ( @\preg_match( '@^' . $args . '$@', $candidate ) ) {
					$names[] = $candidate;
				}
			}
			\sort( $names );
		} else {
			$names = \preg_split( '/\s+/', $args );
		}

		$removed   = [];
		$errors    = [];
		$protected = [ '_command_interpreter', '_router', '_output' ];
		foreach ( $names as $name ) {
			if ( '' === $name ) {
				continue;
			}
			$node = Core::node( $name );
			if ( null === $node ) {
				$errors[] = "can't find node \"$name\"";
				continue;
			}
			if ( $node === $self ) {
				$errors[] = 'refusing to destroy interpreter';
				continue;
			}
			if ( \in_array( $name, $protected, true ) ) {
				$errors[] = "refusing to destroy baseline scaffolding: $name";
				continue;
			}
			$node->remove_node();
			$removed[] = "removed $name";
		}

		$out = \implode( "\n", \array_merge( $removed, $errors ) );
		if ( $list_matches && empty( $removed ) && empty( $errors ) ) {
			return 'no matches';
		}
		return '' === $out ? 'ok' : $out;
	}

	/**
	 * Tachikoma `list_nodes` (alias `ls`). Three modes:
	 *  - default (no args, no -a): nodes whose sink IS this CI ("siblings")
	 *  - `-a [glob]`: all nodes (or filtered by regex glob)
	 *  - `<name>` (no -a): nodes whose sink IS the named node
	 *
	 * Flags: `-c` count, `-s` sink, `-e` edge, `-o` owner (target), `-l` = -co.
	 */
	private static function cmd_list_nodes( CommandInterpreter $self, string $args ): string {
		$list_matches = false;
		$show_count   = false;
		$show_sink    = false;
		$show_edge    = false;
		$show_owner   = false;
		$argv         = [];

		foreach ( \preg_split( '/\s+/', \trim( $args ) ) as $tok ) {
			if ( '' === $tok ) {
				continue;
			}
			if ( \preg_match( '/^-([acelos]+)$/', $tok, $m ) ) {
				$len = \strlen( $m[1] );
				for ( $i = 0; $i < $len; ++$i ) {
					$opt = $m[1][ $i ];
					if ( 'a' === $opt ) { $list_matches = true; }
					if ( 'c' === $opt ) { $show_count   = true; }
					if ( 'e' === $opt ) { $show_edge    = true; }
					if ( 'l' === $opt ) { $show_count   = true; $show_owner = true; }
					if ( 'o' === $opt ) { $show_owner   = true; }
					if ( 's' === $opt ) { $show_sink    = true; }
				}
				continue;
			}
			$argv[] = $tok;
		}

		// Build header row: COUNT NAME [SINK] [EDGE] [OWNER]
		$dirs   = [];
		$header = [];
		$any_extra = $show_count || $show_sink || $show_edge || $show_owner;
		if ( $show_count ) { $dirs[] = 'right'; $header[] = 'COUNT'; }
		$dirs[]   = 'left';
		$header[] = 'NAME';
		if ( $show_sink )  { $dirs[] = 'left'; $header[] = 'SINK';  }
		if ( $show_edge )  { $dirs[] = 'left'; $header[] = 'EDGE';  }
		if ( $show_owner ) { $dirs[] = 'left'; $header[] = 'OWNER'; }

		$rows = [];

		// Validate explicit-name targets up front (mode: "ls <name>").
		if ( ! $list_matches && ! empty( $argv ) ) {
			foreach ( $argv as $name ) {
				if ( Core::node( $name ) === null ) {
					return "can't find node \"$name\"";
				}
			}
		}

		$globs = empty( $argv ) ? [ null ] : $argv;

		$all_names = \array_keys( Core::$nodes_by_name );
		\sort( $all_names );

		foreach ( $globs as $glob ) {
			$matched = false;
			foreach ( $all_names as $name ) {
				$node = Core::node( $name );
				if ( null === $node ) {
					continue;
				}
				$sink_name  = $node->sink() ? $node->sink()->name() : '';
				$edge_name  = $node->edge() ? $node->edge()->name() : '';
				$target_val = $node->target();
				$owner_str  = '';
				if ( \is_array( $target_val ) ) {
					$owner_str = \implode( ', ', $target_val );
				} elseif ( \is_string( $target_val ) && '' !== $target_val ) {
					$owner_str = $target_val;
				}

				if ( $list_matches ) {
					if ( null !== $glob && '' !== $glob && ! @\preg_match( "/$glob/", $name ) ) {
						continue;
					}
				} else {
					if ( null === $glob ) {
						// Default: siblings — nodes whose sink IS this CI.
						if ( $self->name() !== $sink_name ) {
							continue;
						}
					} else {
						if ( $glob !== $sink_name ) {
							continue;
						}
					}
				}

				$matched = true;
				$row     = [];
				if ( $show_count ) { $row[] = (string) $node->counter(); }
				$row[] = $name;
				if ( $show_sink )  { $row[] = '' !== $sink_name ? "> $sink_name"   : '- '; }
				if ( $show_edge )  { $row[] = '' !== $edge_name ? ">> $edge_name"  : '- '; }
				if ( $show_owner ) { $row[] = '' !== $owner_str ? "-> $owner_str"  : '- '; }
				$rows[] = $row;
			}

			if ( $list_matches && null !== $glob && '' !== $glob && ! $matched ) {
				$rows[] = [ 'no matches' ];
			}
		}

		// Render: with column flags, include header. Otherwise just plain names.
		if ( ! $any_extra ) {
			$names = [];
			foreach ( $rows as $r ) {
				$names[] = $r[0];
			}
			return \implode( "\n", $names );
		}
		return self::tabulate( $dirs, $header, $rows );
	}

	/**
	 * Pretty-print a node's internal state. Mirrors Tachikoma's `dump_node`:
	 * sink/edge collapse to names; optional key-filter narrows the dump.
	 */
	private static function cmd_dump_node( string $args ): string {
		$parts = \preg_split( '/\s+/', \trim( $args ) );
		$name  = $parts[0] ?? '';
		if ( '' === $name ) {
			return 'no node specified';
		}
		$node = Core::node( $name );
		if ( null === $node ) {
			return "can't find node \"$name\"";
		}
		$wanted = \array_slice( $parts, 1 );

		// Reflect node properties (declared + dynamic). Collapse sink/edge to names.
		$ref     = new \ReflectionObject( $node );
		$snapshot = [];
		foreach ( $ref->getProperties() as $prop ) {
			$prop->setAccessible( true );
			if ( ! $prop->isInitialized( $node ) ) {
				continue;
			}
			$key   = $prop->getName();
			$value = $prop->getValue( $node );
			if ( 'sink' === $key  && $value instanceof Node ) { $value = $value->name(); }
			if ( 'edge' === $key  && $value instanceof Node ) { $value = $value->name(); }
			if ( \is_object( $value ) ) {
				$value = '(' . \get_class( $value ) . ')';
			}
			// Resources (open file handles, etc.) aren't JSON-encodable —
			// without this coercion, json_encode fails on the whole snapshot
			// with "Type is not supported" and returns false (cast to '').
			// Was: dumping `_repl` after its first write returned an empty
			// payload because Partition's $fh / $idx_fh held stream
			// resources by then.
			if ( \is_resource( $value ) ) {
				$value = '(resource:' . \get_resource_type( $value ) . ')';
			}
			$snapshot[ $key ] = $value;
		}

		if ( ! empty( $wanted ) ) {
			foreach ( $wanted as $k ) {
				if ( ! \array_key_exists( $k, $snapshot ) ) {
					return "can't find key \"$k\"";
				}
			}
			$snapshot = \array_intersect_key( $snapshot, \array_flip( $wanted ) );
		}

		// JSON render with pretty-print so structure is readable in the REPL.
		return (string) \json_encode( $snapshot, \JSON_PRETTY_PRINT | \JSON_UNESCAPED_SLASHES );
	}

	private static function cmd_dump_config(): string {
		$out = '';
		foreach ( \array_keys( Core::$nodes_by_name ) as $name ) {
			if ( '_command_interpreter' === $name || '_router' === $name || '_output' === $name ) {
				continue; // Skip baseline scaffolding.
			}
			$out .= Core::node( $name )->dump_config();
		}
		return $out;
	}

	/**
	 * `help` — no args lists all command names tabulated. With a topic, returns
	 * that command's help string. Mirrors Tachikoma's `topical_help`.
	 */
	private static function cmd_help( string $args ): string {
		$topic = \trim( $args );
		if ( '' === $topic ) {
			// Source of truth for "things the user can type at the shell" is $H,
			// which includes Shell-level verbs (ping) AND CI commands.
			$names = \array_keys( self::$H );
			\sort( $names );
			$rows = [];
			$row  = [];
			foreach ( $names as $i => $n ) {
				$row[] = $n;
				if ( ( $i + 1 ) % 4 === 0 ) {
					$rows[] = $row;
					$row    = [];
				}
			}
			if ( ! empty( $row ) ) {
				$rows[] = $row;
			}
			return self::tabulate( [ 'left', 'left', 'left', 'left' ], null, $rows );
		}
		// Resolve aliases to the canonical entry name. Every alias the user
		// might type maps to the corresponding $H key — keep this table in
		// lockstep with the alias entries in $C and the Shell builtin
		// dispatch table.
		$alias_to_canonical = [
			'ls'           => 'list_nodes',
			'dump'         => 'dump_node',
			'make'         => 'make_node',
			'connect'      => 'connect_node',
			'disconnect'   => 'disconnect_node',
			'remove'       => 'remove_node',
			'rm'           => 'remove_node',
			'chdir'        => 'cd',
			'tell'         => 'tell_node',
			'send'         => 'send_node',
			'command'      => 'command_node',
			'cmd'          => 'command_node',
			'request'      => 'request_node',
		];
		$key = $alias_to_canonical[ $topic ] ?? $topic;
		if ( isset( self::$H[ $key ] ) ) {
			return self::$H[ $key ];
		}
		return "no such topic: \"$topic\"";
	}

	/**
	 * Column-aligned table rendering. $dirs: per-column 'left' or 'right'.
	 * $header: optional column names; null skips header. Last left-aligned column
	 * isn't padded (matches Tachikoma's tabulate).
	 *
	 * @param array<int,string>            $dirs   One per column.
	 * @param array<int,string>|null       $header Optional header row.
	 * @param array<int,array<int,string>> $rows
	 */
	private static function tabulate( array $dirs, ?array $header, array $rows ): string {
		$ncols = \count( $dirs );
		$max   = \array_fill( 0, $ncols, 0 );
		if ( null !== $header ) {
			foreach ( $header as $col => $val ) {
				$max[ $col ] = \max( $max[ $col ], \strlen( (string) $val ) );
			}
		}
		foreach ( $rows as $row ) {
			foreach ( $row as $col => $val ) {
				if ( $col >= $ncols ) {
					continue;
				}
				$max[ $col ] = \max( $max[ $col ], \strlen( (string) $val ) );
			}
		}

		$format_row = function ( array $row ) use ( $dirs, $max, $ncols ): string {
			$parts = [];
			for ( $col = 0; $col < $ncols; ++$col ) {
				$val  = (string) ( $row[ $col ] ?? '' );
				$dir  = $dirs[ $col ] ?? 'left';
				$last = ( $col === $ncols - 1 );
				if ( 'right' === $dir ) {
					$parts[] = \str_pad( $val, $max[ $col ], ' ', \STR_PAD_LEFT );
				} elseif ( $last ) {
					$parts[] = $val;
				} else {
					$parts[] = \str_pad( $val, $max[ $col ], ' ', \STR_PAD_RIGHT );
				}
			}
			return \implode( ' ', $parts );
		};

		$out = '';
		if ( null !== $header ) {
			$out .= $format_row( $header ) . "\n";
		}
		foreach ( $rows as $row ) {
			$out .= $format_row( $row ) . "\n";
		}
		return \rtrim( $out, "\n" );
	}

	public function fill( array &$message ): void {
		++$this->counter;

		$type = $message[ Message::TYPE ];

		// TM_PING / TM_EOF with empty TO: bounce back along the FROM trail.
		// Mirrors real Tachikoma CommandInterpreter.pm:94-96 for PING;
		// TM_EOF round-trip is the drain marker the pivoted-cli relies on
		// (cli emits TM_EOF on stdin close, waits for the bounce to know
		// all preceding output has been read off the reply partition before
		// exiting).
		if ( ( $type & ( Message::TM_PING | Message::TM_EOF ) ) && '' === $message[ Message::TO ] ) {
			$message[ Message::TO ] = $message[ Message::FROM ];
			$this->sink?->fill( $message );
			return;
		}

		// Only handle commands addressed at us — empty TO means "for whoever
		// receives this", which by convention is the local interpreter. A
		// non-empty TO indicates the message is in transit toward another
		// node; forward it through the sink so Router can route it. Without
		// this guard, an intermediate CI on the path (e.g. cd-routed cmds in
		// pivoted mode) would intercept commands meant for a downstream CI.
		if ( ( $type & Message::TM_COMMAND ) && ! ( $type & Message::TM_RESPONSE ) && '' === $message[ Message::TO ] ) {
			$this->interpret( $message );
			return;
		}
		$this->sink?->fill( $message );
	}

	/**
	 * Run a verb. `$envelope` is the inbound TM_COMMAND message (when this
	 * was driven by a CI dispatch); pass an empty array for inline calls.
	 * Verb handlers may peek at the envelope's FROM/TO to compose responses
	 * — see Tachikoma CommandInterpreter.pm:pwd().
	 */
	public function execute( string $command_line, array $envelope = [] ): string {
		self::init_C();
		$parts = \explode( ' ', $command_line, 2 );
		$verb  = $parts[0];
		$args  = $parts[1] ?? '';
		if ( ! isset( self::$C[ $verb ] ) ) {
			return "unknown command: $verb";
		}
		return ( self::$C[ $verb ] )( $this, $args, $envelope );
	}

	private function interpret( array &$message ): void {
		$cmd = \json_decode( $message[ Message::VALUE ], true );
		if ( ! \is_array( $cmd ) || ! isset( $cmd['name'] ) ) {
			$this->drop_message( $message, 'invalid command struct' );
			return;
		}
		// Catch exceptions from any verb handler (typo'd ctor args, missing
		// node, bad regex, etc.) and turn them into a TM_COMMAND|TM_ERROR
		// response so the cli renders "ERROR: ..." instead of crashing the
		// worker. Mirrors Tachikoma CommandInterpreter.pm:error().
		try {
			$result    = $this->execute( $cmd['name'] . ' ' . ( $cmd['arguments'] ?? '' ), $message );
			$resp_type = Message::TM_COMMAND | Message::TM_RESPONSE;
		} catch ( \Throwable $e ) {
			$result    = $e->getMessage();
			$resp_type = Message::TM_COMMAND | Message::TM_ERROR;
		}

		// Route TO=FROM (response walks the breadcrumb trail back).
		$response                   = Message::new_message();
		$response[ Message::TYPE ]  = $resp_type;
		$response[ Message::FROM ]  = $this->name;
		$response[ Message::TO ]    = $message[ Message::FROM ];
		$response[ Message::ID ]    = $message[ Message::ID ];
		$response[ Message::VALUE ] = \json_encode(
			[
				'name'    => $cmd['name'],
				'payload' => $result,
			]
		);
		$this->sink?->fill( $response );
	}
}
