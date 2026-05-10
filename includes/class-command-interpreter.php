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
			'make_node' => "make_node <type> <name> [<arguments>]\n",
			'set_sink'  => "set_sink <node> <target>\n",
			'connect_node' => "connect_node <node> <target>\n    alias: connect\n",
			'disconnect_node' => "disconnect_node <node> [<target>]\n    alias: disconnect\n    note: <target> is required for multi-target nodes (e.g. Tee).\n",
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
			'ping' => "ping <path>\n",
			'help' => "help [ <topic> ]\n",
		];
		self::$C = [
			'make_node'       => fn ( CommandInterpreter $self, string $args ): string => self::cmd_make_node( $self, $args ),
			'set_sink'        => fn ( CommandInterpreter $self, string $args ): string => self::cmd_set_sink( $args ),
			'connect_node'    => fn ( CommandInterpreter $self, string $args ): string => self::cmd_connect_node( $args ),
			'connect'         => fn ( CommandInterpreter $self, string $args ): string => self::cmd_connect_node( $args ),
			'disconnect_node' => fn ( CommandInterpreter $self, string $args ): string => self::cmd_disconnect_node( $args ),
			'disconnect'      => fn ( CommandInterpreter $self, string $args ): string => self::cmd_disconnect_node( $args ),
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
		// Resolve aliases to the canonical entry name (ls → list_nodes; dump → dump_node).
		$alias_to_canonical = [
			'ls'   => 'list_nodes',
			'dump' => 'dump_node',
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

		// TM_PING with empty TO: bounce back along the FROM trail.
		// Mirrors real Tachikoma CommandInterpreter.pm:94-96.
		if ( ( $type & Message::TM_PING ) && '' === $message[ Message::TO ] ) {
			$message[ Message::TO ] = $message[ Message::FROM ];
			$this->sink?->fill( $message );
			return;
		}

		if ( ( $type & Message::TM_COMMAND ) && ! ( $type & Message::TM_RESPONSE ) ) {
			$this->interpret( $message );
			return;
		}
		$this->sink?->fill( $message );
	}

	public function execute( string $command_line ): string {
		self::init_C();
		$parts = \explode( ' ', $command_line, 2 );
		$verb  = $parts[0];
		$args  = $parts[1] ?? '';
		if ( ! isset( self::$C[ $verb ] ) ) {
			return "unknown command: $verb";
		}
		return ( self::$C[ $verb ] )( $this, $args );
	}

	private function interpret( array &$message ): void {
		$cmd = \json_decode( $message[ Message::VALUE ], true );
		if ( ! \is_array( $cmd ) || ! isset( $cmd['name'] ) ) {
			$this->drop_message( $message, 'invalid command struct' );
			return;
		}
		$result = $this->execute( $cmd['name'] . ' ' . ( $cmd['arguments'] ?? '' ) );
		// Build TM_COMMAND|TM_RESPONSE; route TO=FROM.
		$response                   = Message::new_message();
		$response[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
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
