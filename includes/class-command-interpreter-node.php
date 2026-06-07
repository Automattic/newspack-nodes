<?php
/**
 * CommandInterpreter: graph builder + shell vocabulary dispatch.
 *
 * One per process (`_command_interpreter`), auto-sink default for every make_node.
 * Forwards non-TM_COMMAND messages to its sink (typically `_router`). Vocabulary
 * lives in a static dispatch table ($C).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Command_Interpreter_Node extends Node {
	/**
	 * Shared default verb table the bare `_command_interpreter` starts from.
	 *
	 * @var array<string,callable>|null Verb → handler. Initialized lazily.
	 */
	private static ?array $C = null;

	/**
	 * Per-command help text shown by `help`, keyed by canonical verb.
	 *
	 * @var array<string,string>|null
	 */
	private static ?array $H = null;

	/**
	 * Registered class namespace prefixes. `make_node('Tee')` resolves the
	 * first `{$prefix}Tee_Node` that exists and is a Node subclass. The catalog
	 * (Classes_CI) scans the composer classmap for FQCNs under these prefixes.
	 *
	 * @var array<string,bool> Prefix → true (set semantics).
	 */
	protected static array $namespaces = [];

	/**
	 * Per-instance verb table; defaults to self::$C, siblings install their own via commands().
	 *
	 * @var array<string,callable>|null
	 */
	protected ?array $commands = null;

	/**
	 * Process-wide default command-authorization policy. A verifier process
	 * (worker, /command request) sets this ONCE at bootstrap so EVERY interpreter in the
	 * process — the main `_command_interpreter` plus the patron interpreters embedded in
	 * Partitions and other config-bearing nodes — inherits it without per-instance
	 * wiring. Null → the built-in LOCAL-provenance check (client tier).
	 * Signature: `function ( array $message ): bool` (true = allow).
	 *
	 * @var \Closure|null
	 */
	public static ?\Closure $default_authorize = null;

	/**
	 * Per-instance override of $default_authorize (tests / special cases). Null →
	 * fall back to the static default. Same signature.
	 *
	 * @var \Closure|null
	 */
	public ?\Closure $authorize = null;

	public function fill( array &$message ): void {
		if ( null === $this->sink ) {
			throw new \RuntimeException( 'Command_Interpreter::fill requires a wired sink' );
		}
		++$this->counter;

		$type_raw = $message[ Message::TYPE ];
		$type     = \is_numeric( $type_raw ) ? (int) $type_raw : 0;

		// TM_PING / TM_EOF with empty TO: bounce back along the FROM trail (drain marker).
		if ( ( $type & ( Message::TM_PING | Message::TM_EOF ) ) && '' === $message[ Message::TO ] ) {
			$message[ Message::TO ] = $message[ Message::FROM ];
			$this->sink->fill( $message );
			return;
		}

		// Only handle commands with empty TO; non-empty TO forwards so a mid-path interpreter doesn't eat it.
		if ( ( $type & Message::TM_COMMAND ) && ! ( $type & Message::TM_RESPONSE ) && '' === $message[ Message::TO ] ) {
			$this->interpret( $message );
			return;
		}
		$this->sink->fill( $message );
	}

	/** @param array<int, mixed> $message Incoming command Message to interpret. */
	private function interpret( array &$message ): void {
		if ( null === $this->sink ) {
			throw new \RuntimeException( 'Command_Interpreter::fill requires a wired sink' );
		}
		$cmd = $message[ Message::VALUE ];
		if ( ! \is_array( $cmd ) || ! isset( $cmd['name'] ) ) {
			$this->drop_message( $message, 'invalid command struct' );
			return;
		}
		$name_raw  = $cmd['name'];
		$args_raw  = $cmd['arguments'] ?? '';
		$cmd_name  = \is_scalar( $name_raw ) ? (string) $name_raw : '';
		$cmd_args  = \is_scalar( $args_raw ) ? (string) $args_raw : '';

		// Authorization gate (every command): client tier requires the LOCAL
		// provenance taint; verifier processes swap in an HMAC check. Refuse
		// before dispatch, replying TM_COMMAND|TM_ERROR via the shared block below.
		$authorize = $this->authorize ?? self::$default_authorize
			?? static fn ( array $m ): bool => isset( $m[ Message::LOCAL ] );
		if ( ! $authorize( $message ) ) {
			$result    = 'unauthorized: ' . $cmd_name;
			$resp_type = Message::TM_COMMAND | Message::TM_ERROR;
		} else {
			// Verb handlers throw freely; wrap as TM_COMMAND|TM_ERROR so the cli renders the error.
			try {
				$result = $this->dispatch(
					$cmd_name,
					$cmd_args,
					$message
				);
				$resp_type = Message::TM_COMMAND | Message::TM_RESPONSE;
			} catch ( \Throwable $e ) {
				$result    = $e->getMessage();
				$resp_type = Message::TM_COMMAND | Message::TM_ERROR;
			}
		}

		// Route TO=FROM (walk the breadcrumb back); KEY is client correlation metadata.
		if ( '' !== $result ) {
			$response                   = Message::new_message();
			$response[ Message::TYPE ]  = $resp_type;
			$response[ Message::FROM ]  = $this->name;
			$response[ Message::TO ]    = $message[ Message::FROM ];
			$response[ Message::ID ]    = $message[ Message::ID ];
			$response[ Message::KEY ]   = $message[ Message::KEY ];
			$response[ Message::VALUE ] = [
				'name'      => $cmd_name,
				'arguments' => $cmd_args,
				'payload'   => $result,
			];
			$this->sink->fill( $response );
		}
	}

	/**
	 * Dispatch a verb by name. Result rides the Message VALUE unencoded (never JSON here).
	 *
	 * @param string                  $name     Verb name.
	 * @param string                  $args     Literal arguments tail (verbs parse it via Command_Args).
	 * @param array<int,mixed>        $envelope Inbound TM_COMMAND message, or [] for inline calls.
	 * @return mixed Verb result (string for most verbs; array for dump_metadata).
	 */
	public function dispatch( string $name, string $args = '', array $envelope = [] ): mixed {
		$commands = $this->commands();
		if ( ! isset( $commands[ $name ] ) ) {
			throw new \InvalidArgumentException( \esc_html( "unknown command: {$name}" ) );
		}
		return ( $commands[ $name ] )( $this, $args, $envelope );
	}

	/**
	 * Register a class-namespace prefix for `make_node` resolution. Plugins
	 * call this once at boot (e.g. `register_namespace( 'Newspack_Nodes\\' )`);
	 * `make_node('Tee')` then resolves `Newspack_Nodes\Tee_Node`.
	 */
	public static function register_namespace( string $prefix ): void {
		self::$namespaces[ $prefix ] = true;
	}

	/**
	 * Read-only view of the registered namespace prefixes.
	 *
	 * @return array<int,string>
	 */
	public static function registered_namespaces(): array {
		return \array_keys( self::$namespaces );
	}

	/**
	 * Registered shell name for a node instance.
	 *
	 * `make_node`/topology lines use the shell name (e.g. `Log`, `Tee`), which
	 * is the class short name minus the `_Node` suffix (`Tee_Node` → `Tee`,
	 * `Flame_Builder_Node` → `Flame_Builder`). A short name without `_Node`
	 * (ad-hoc test classes) is returned unchanged.
	 */
	public static function shell_name_for( object $node ): string {
		$short = ( new \ReflectionClass( $node ) )->getShortName();
		if ( \str_ends_with( $short, '_Node' ) ) {
			return \substr( $short, 0, -\strlen( '_Node' ) );
		}
		return $short;
	}

	/**
	 * Per-instance verb-table accessor; falls back to self::$C.
	 *
	 * @param array<string,callable>|null $table Replacement verb table.
	 * @return array<string,callable>
	 */
	public function commands( ?array $table = null ): array {
		if ( null !== $table ) {
			$this->commands = $table;
		}
		if ( null === $this->commands ) {
			self::init_C();
			$this->commands = self::$C ?? [];
		}
		// Every interpreter answers `help`. A subclass that installs a custom verb table
		// (e.g. the REST service interpreters) gets a default that lists its own verbs;
		// the base table ships its own richer `help`, so this never overrides one.
		if ( ! isset( $this->commands['help'] ) ) {
			$this->commands['help'] = static fn ( Command_Interpreter_Node $self, string $args = '', array $envelope = [] ): string => $self->default_help();
		}
		return $this->commands;
	}

	/**
	 * Default `help` for an interpreter with a custom verb table: its verb names, sorted,
	 * one per line (includes `help` itself). The base interpreter overrides this with the
	 * richer sectioned help via its own `help` verb in self::$C.
	 *
	 * @return string Newline-separated sorted verb names.
	 */
	protected function default_help(): string {
		$names = \array_keys( $this->commands() );
		\sort( $names );
		return \implode( "\n", $names );
	}

	private static function init_C(): void {
		if ( null !== self::$C ) {
			return;
		}
		self::$H = [
			// interpreter-dispatched verbs.
			'make_node' => "make_node <type> <name> [<arguments>]\n    alias: make\n",
			'set_sink'  => "set_sink <node> <target>\n",
			'connect_node' => "connect_node <node> [<target>]\n    alias: connect\n    note: <target> defaults to the issuing message's FROM — tails the node's flow back to your own cli/SSE session.\n",
			'disconnect_node' => "disconnect_node <node> [<target>]\n    alias: disconnect\n    note: for a Tee, <target> defaults to the issuing message's FROM — undoes a default `connect_node <tee>` for this session.\n",
			'remove_node' => "remove_node <node name> [<more names>...]\n"
				. "remove_node -a <anchored regex glob>\n"
				. "    aliases: remove, rm\n",
			'list_nodes' => "list_nodes [ -clst ] [ <node name> ]\n"
				. "list_nodes -a [ -clst ] [ <regex glob> ]\n"
				. "    -c show message counters\n"
				. "    -l show counters and targets\n"
				. "    -s show sinks\n"
				. "    -t show targets\n"
				. "    -a show all nodes matching regex glob\n"
				. "       show all nodes if regex glob is omitted\n"
				. "    note: Without -a, the argument specifies a node;\n"
				. "          all nodes sinking into the specified node are displayed.\n"
				. "    alias: ls\n",
			'dump_node' => "dump_node <node name> [<keys>]\n    alias: dump\n",
			'dump_config' => "dump_config\n",
			'dump_metadata' => "dump_metadata\n    note: returns a JSON object keyed by node name with `class`, `counter`, `sink`, `target`, `debug_state`, `arguments` — one round-trip gives a GUI/visualizer everything it needs to render the graph.\n",
			'debug_state' => "debug_state [ <node name> [ <level> ] ]\n"
				. "    no args:      toggle this CommandInterpreter's debug_state.\n"
				. "    name only:    toggle that node's debug_state.\n"
				. "    name <n>:     set that node's debug_state to <n>.\n"
				. "    note: when set, the node emits a TM_STRUCT trace to _repl\n"
				. "          on every set_state() call.\n"
				. "          cli sessions and the SSE controller see the trace in real time.\n"
				. "          New nodes created by `make_node` inherit this interpreter's level.\n",
			'pwd' => "pwd\n",
			'log' => "log <message>\n    note: prints <message> to stderr (server-side debug log).\n",
			'dmesg' => "dmesg\n    note: print the recent server-side stderr tail (last 100 lines).\n",
			'help' => "help [ <topic> ]\n",

			// Shell-level builtins — Shell intercepts these; listed here so `help` is complete.
			'cd' => "cd [ <path> ]\n    alias: chdir\n    note: empty path resets cwd to the local interpreter.\n",
			'tell_node' => "tell_node <path> <info>\n    alias: tell\n    note: emits TM_INFO at prefix(<path>); fire-and-forget broadcast.\n",
			'send_node' => "send_node <path> <bytes>\n    alias: send\n    note: emits TM_BYTESTREAM at prefix(<path>).\n",
			'send_eof' => "send_eof <path>\n    note: emits TM_EOF at prefix(<path>).\n",
			'command_node' => "command_node <path> <verb> [<arguments>]\n    aliases: command, cmd\n    note: dispatches a TM_COMMAND at prefix(<path>) without changing cwd.\n",
			'request_node' => "request_node <path> [<value>]\n    alias: request\n    note: emits TM_REQUEST at prefix(<path>); receiver replies via TO=FROM.\n",
			'reply_to' => "reply_to <node path> <command>\n    note: runs <command> HERE but routes its reply to <node path> (inverse of command_node). Lets a worker drive a remote interpreter's output to one session.\n",
			'ping' => "ping <path>\n    note: round-trips a TM_PING; receiver bounces TO=FROM. Output shows RTT.\n",
			'include' => "include <file>\n    note: read commands from <file>, parse each line as if typed.\n",
			'uptime' => "uptime\n    note: clock-time, plus days+HH:MM:SS since Core::reset() (worker spawn).\n",
			'stats' => "stats [-a] [<regex>]\n    columns: NAME COUNT LGST_MSG READ WRITTEN. Default: sibling nodes of this interpreter; -a: all nodes.\n",
		];
		self::$C = [
			'make_node'       => fn ( Command_Interpreter_Node $self, string $args ): string => self::cmd_make_node( $self, $args ),
			'make'            => fn ( Command_Interpreter_Node $self, string $args ): string => self::cmd_make_node( $self, $args ),
			'pwd'             => fn ( Command_Interpreter_Node $self, string $args, array $message ): string => self::cmd_pwd( $args, $message ),
			'set_sink'        => fn ( Command_Interpreter_Node $self, string $args ): string => self::cmd_set_sink( $args ),
			'connect_node'    => fn ( Command_Interpreter_Node $self, string $args, array $envelope = [] ): string => self::cmd_connect_node( $args, $envelope ),
			'connect'         => fn ( Command_Interpreter_Node $self, string $args, array $envelope = [] ): string => self::cmd_connect_node( $args, $envelope ),
			'disconnect_node' => fn ( Command_Interpreter_Node $self, string $args, array $envelope = [] ): string => self::cmd_disconnect_node( $args, $envelope ),
			'disconnect'      => fn ( Command_Interpreter_Node $self, string $args, array $envelope = [] ): string => self::cmd_disconnect_node( $args, $envelope ),
			'remove_node'     => fn ( Command_Interpreter_Node $self, string $args ): string => self::cmd_remove_node( $self, $args ),
			'remove'          => fn ( Command_Interpreter_Node $self, string $args ): string => self::cmd_remove_node( $self, $args ),
			'rm'              => fn ( Command_Interpreter_Node $self, string $args ): string => self::cmd_remove_node( $self, $args ),
			'list_nodes'      => fn ( Command_Interpreter_Node $self, string $args, array $envelope = [] ): string => self::cmd_list_nodes( $self, $args, $envelope ),
			'ls'              => fn ( Command_Interpreter_Node $self, string $args, array $envelope = [] ): string => self::cmd_list_nodes( $self, $args, $envelope ),
			'log'             => fn ( Command_Interpreter_Node $self, string $args ): string => self::cmd_log( $self, $args ),
			'dmesg'           => fn ( Command_Interpreter_Node $self, string $args ): string => self::cmd_dmesg(),
			'dump_node'       => fn ( Command_Interpreter_Node $self, string $args ): mixed => self::cmd_dump_node( $args ),
			'dump'            => fn ( Command_Interpreter_Node $self, string $args ): mixed => self::cmd_dump_node( $args ),
			'dump_config'     => fn ( Command_Interpreter_Node $self, string $args ): string => self::cmd_dump_config(),
			'dump_metadata'   => fn ( Command_Interpreter_Node $self, string $args ): mixed => self::cmd_dump_metadata( \trim( $args ) ),
			'stats'           => fn ( Command_Interpreter_Node $self, string $args ): string => self::cmd_stats( $self, $args ),
			'uptime'          => fn ( Command_Interpreter_Node $self, string $args ): string => self::cmd_uptime(),
			'debug_state'     => fn ( Command_Interpreter_Node $self, string $args ): string => self::cmd_debug_state( $self, $args ),
			'help'            => fn ( Command_Interpreter_Node $self, string $args, array $envelope = [] ): string => self::cmd_help( $args, $envelope ),
			'reply_to'        => fn ( Command_Interpreter_Node $self, string $args, array $envelope = [] ): string => self::cmd_reply_to( $self, $args ),
		];
	}

	/**
	 * `uptime` — UTC clock-time, plus elapsed-since-Core::reset() scaled by magnitude.
	 */
	private static function cmd_uptime(): string {
		$uptime = (int) ( Core::$now - Core::$init_time );
		// gmdate (UTC) over date() for predictability across worker timezones.
		$clock   = \gmdate( 'H:i:s', (int) Core::$now );
		$elapsed = self::format_uptime( $uptime );
		return "{$clock}  up {$elapsed}\n";
	}

	private static function format_uptime( int $seconds ): string {
		// Trailing components zero-pad to 2 digits so the width stays steady across ticks.
		if ( $seconds < 60 ) {
			return \sprintf( '%02ds', $seconds );
		}
		if ( $seconds < 3600 ) {
			$m = (int) ( $seconds / 60 );
			$s = $seconds % 60;
			return \sprintf( '%dm %02ds', $m, $s );
		}
		if ( $seconds < 86400 ) {
			$h = (int) ( $seconds / 3600 );
			$m = (int) ( ( $seconds % 3600 ) / 60 );
			return \sprintf( '%dh %02dm', $h, $m );
		}
		$d   = (int) ( $seconds / 86400 );
		$rem = $seconds - ( $d * 86400 );
		return "{$d}d " . \gmdate( 'H:i:s', $rem );
	}

	/**
	 * Shell entry: parse `<type> <name> [<ctor_args>...]` and delegate to make_node().
	 *
	 * No strict_types, so string tokens coerce to the ctor's typed params.
	 */
	private static function cmd_make_node( Command_Interpreter_Node $self, string $args ): string {
		/** @var list<string> $parts Whitespace-split tokens; the /\s+/ split of a string never yields false. */
		$parts = \preg_split( '/\s+/', \trim( $args ) );
		if ( \count( $parts ) < 2 ) {
			return 'usage: make_node <type> <name> [<ctor_args>...]';
		}
		$type = $parts[0];
		$name = $parts[1];
		$node = $self->make_node( $type, $name, ...\array_slice( $parts, 2 ) );
		return null === $node ? "unknown class: $type" : 'ok';
	}

	/**
	 * Construct a registered Node subclass, name it, sink it to this interpreter, and return it.
	 *
	 * @param string $type      Shell name (resolved as `{$prefix}{$type}_Node`, or the bare base `Node`).
	 * @param string $name      Unique name for the new node (registered with Core).
	 * @param mixed  ...$ctor_args Positional constructor arguments.
	 * @return Node|null Null when no registered namespace yields a matching Node.
	 */
	public function make_node( string $type, string $name, ...$ctor_args ): ?Node {
		foreach ( self::registered_namespaces() as $prefix ) {
			// The base Node carries no `_Node` suffix; `make_node Node` resolves it
			// directly (its default fill() stamps TO=target and forwards to sink — a
			// bare routing/fan-in primitive, e.g. the SSE-stream `_default_route`).
			// `is_a(..., true)` accepts Node itself as well as its subclasses.
			$fqcn = ( 'Node' === $type ) ? $prefix . 'Node' : $prefix . $type . '_Node';
			if ( ! \class_exists( $fqcn ) || ! \is_a( $fqcn, Node::class, true ) ) {
				continue;
			}
			// Reflection instantiation (vs `new $fqcn`) keeps the variadic ctor-arg
			// spread working for any Node subclass without PHPStan narrowing the
			// FQCN to the abstract base Node (which has no constructor).
			$ref = new \ReflectionClass( $fqcn );
			// Abstract Node subclasses (e.g. Service_CI_Node) resolve under a prefix
			// but can't be instantiated — return null gracefully rather than fatal.
			if ( $ref->isAbstract() ) {
				continue;
			}
			// Tachikoma sequence — uniform across every Node subclass. The
			// no-arg ctor returns a Node in declaration-default state; arguments()
			// walks node_schema()['arguments'] and assigns each declared
			// positional arg from the trailing tokens. Service interpreters that depend
			// on programmatic objects (cli, registry, etc.) expose them as
			// public properties set by the bootstrap AFTER construction —
			// not through arguments() (which only handles scalar config).
			$node = new $fqcn();
			$node->name( $name );
			// Only scalar tokens round-trip through arguments(); object deps belong on public properties (warn so a forgotten assignment isn't silently dropped).
			$scalar_args = \array_filter( $ctor_args, '\is_scalar' );
			if ( \count( $scalar_args ) !== \count( $ctor_args ) ) {
				Core::print_less_often(
					"make_node {$type} {$name}: non-scalar positional arg filtered (assign object deps as public properties)"
				);
			}
			$node->arguments( \implode( ' ', $scalar_args ) );
			$node->sink( $this );
			// Inherit debug_state so new nodes trace from birth.
			if ( $this->debug_state() > 0 ) {
				$node->debug_state( $this->debug_state() );
			}
			return $node;
		}
		return null;
	}

	/**
	 * `pwd` verb: return ` <cwd> -> <envelope.from>`.
	 *
	 * @param array<array-key, mixed> $envelope The command Message.
	 */
	private static function cmd_pwd( string $args, array $envelope ): string {
		$cwd      = '' === $args ? '/' : $args;
		$from_raw = $envelope[ Message::FROM ] ?? '';
		$from     = \is_scalar( $from_raw ) ? (string) $from_raw : '';
		return ' ' . $cwd . ' -> ' . $from;
	}

	private static function cmd_set_sink( string $args ): string {
		[ $name, $target ] = \array_pad( \preg_split( '/\s+/', \trim( $args ), 2 ) ?: [], 2, '' );
		if ( '' === $name || '' === $target ) {
			return 'usage: set_sink <node> <target>';
		}
		/** @var \Newspack_Nodes\Node|null $src Source node from the registry. */
		$src = Core::node( $name );
		/** @var \Newspack_Nodes\Node|null $dst Target node from the registry. */
		$dst = Core::node( $target );
		if ( null === $src || null === $dst ) {
			return 'unknown node';
		}
		$src->sink( $dst );
		return 'ok';
	}

	/** @param array<array-key, mixed> $envelope The command Message. */
	private static function cmd_connect_node( string $args, array $envelope = [] ): string {
		[ $name, $target ] = \array_pad( \preg_split( '/\s+/', \trim( $args ), 2 ) ?: [], 2, '' );
		if ( '' === $name ) {
			return 'usage: connect_node <node> [<target>]';
		}
		/** @var \Newspack_Nodes\Node|null $src Source node from the registry. */
		$src = Core::node( $name );
		if ( null === $src ) {
			return "unknown node: $name";
		}
		// No target defaults to the issuing message's FROM — tees the node's flow back to that session.
		if ( '' === $target ) {
			$from   = $envelope[ Message::FROM ] ?? '';
			$target = \is_scalar( $from ) ? (string) $from : '';
			if ( '' === $target ) {
				return 'usage: connect_node <node> [<target>]';
			}
		}
		$src->connect_node( $target );
		return 'ok';
	}

	/** @param array<array-key, mixed> $envelope The command Message. */
	private static function cmd_disconnect_node( string $args, array $envelope = [] ): string {
		[ $name, $target ] = \array_pad( \preg_split( '/\s+/', \trim( $args ), 2 ) ?: [], 2, '' );
		if ( '' === $name ) {
			return 'usage: disconnect_node <node> [<target>]';
		}
		/** @var \Newspack_Nodes\Node|null $src Source node from the registry. */
		$src = Core::node( $name );
		if ( null === $src ) {
			return "unknown node: $name";
		}
		// For a Tee, no target removes the issuing FROM from the fan-out (undoes a default connect).
		if ( '' === $target && \is_array( $src->target() ) ) {
			$from   = $envelope[ Message::FROM ] ?? '';
			$target = \is_scalar( $from ) ? (string) $from : '';
			if ( '' === $target ) {
				return 'usage: disconnect_node <node> [<target>]';
			}
		}
		$src->disconnect_node( $target );
		return 'ok';
	}

	/**
	 * `remove_node <name>...` or `remove_node -a <regex>`. Refuses to destroy baseline scaffolding.
	 */
	private static function cmd_remove_node( Command_Interpreter_Node $self, string $args ): string {
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
			// Anchored `@regex@` so user-supplied / and ^$ don't need escaping.
			$names = [];
			foreach ( \array_keys( Core::$nodes_by_name ) as $candidate ) {
				if ( @\preg_match( '@^' . $args . '$@', $candidate ) ) {
					$names[] = $candidate;
				}
			}
			\sort( $names );
		} else {
			/** @var non-empty-list<string> $names Whitespace-split tokens; the /\s+/ split of a string never yields false. */
			$names = \preg_split( '/\s+/', $args );
		}

		$removed   = [];
		$errors    = [];
		$protected = [ Node_Names::COMMAND_INTERPRETER, Node_Names::ROUTER, Node_Names::OUTPUT ];
		foreach ( $names as $name ) {
			if ( '' === $name ) {
				continue;
			}
			/** @var \Newspack_Nodes\Node|null $node Node from the registry. */
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
	 * `list_nodes` (alias `ls`): default=siblings, `-a [glob]`=all, `<name>`=that sink's children.
	 *
	 * Flags: `-c` count, `-s` sink, `-t` target, `-l` = -ct.
	 *
	 * @param array<array-key, mixed> $envelope The command Message.
	 */
	private static function cmd_list_nodes( Command_Interpreter_Node $self, string $args, array $envelope = [] ): string {
		// Completion mode: emit bare node names only, ignoring all -clst column
		// flags so the tab-completion parser gets clean candidates.
		$is_completion = 'completion' === ( $envelope[ Message::KEY ] ?? '' );
		$list_matches  = false;
		$show_count    = false;
		$show_sink     = false;
		$show_target   = false;
		$argv          = [];

		foreach ( \preg_split( '/\s+/', \trim( $args ) ) ?: [] as $tok ) {
			if ( '' === $tok ) {
				continue;
			}
			if ( \preg_match( '/^-([aclst]+)$/', $tok, $m ) ) {
				$len = \strlen( $m[1] );
				for ( $i = 0; $i < $len; ++$i ) {
					$opt = $m[1][ $i ];
					if ( 'a' === $opt ) { $list_matches = true; }
					if ( 'c' === $opt ) { $show_count   = true; }
					if ( 'l' === $opt ) { $show_count   = true; $show_target = true; }
					if ( 's' === $opt ) { $show_sink    = true; }
					if ( 't' === $opt ) { $show_target  = true; }
				}
				continue;
			}
			$argv[] = $tok;
		}

		// Completion mode shows bare names only: drop any column flags, and list
		// ALL nodes (like `-a`) so `cd <tab>` can reach _-prefixed nodes too.
		if ( $is_completion ) {
			$show_count   = false;
			$show_sink    = false;
			$show_target  = false;
			$list_matches = true;
		}

		$dirs   = [];
		$header = [];
		$any_extra = $show_count || $show_sink || $show_target;
		if ( $show_count ) { $dirs[] = 'right'; $header[] = 'COUNT'; }
		$dirs[]   = 'left';
		$header[] = 'NAME';
		if ( $show_sink )   { $dirs[] = 'left'; $header[] = 'SINK';   }
		if ( $show_target ) { $dirs[] = 'left'; $header[] = 'TARGET'; }

		$rows = [];

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
				/** @var \Newspack_Nodes\Node|null $node Node from the registry. */
				$node = Core::node( $name );
				if ( null === $node ) {
					continue;
				}
				$sink_name  = $node->sink() ? $node->sink()->name() : '';
				$target_val = $node->target();
				$target_str = '';
				if ( \is_array( $target_val ) ) {
					$target_str = \implode( ', ', $target_val );
				} elseif ( '' !== $target_val ) {
					$target_str = $target_val;
				}

				if ( $list_matches ) {
					if ( null !== $glob && ! @\preg_match( "/$glob/", $name ) ) {
						continue;
					}
				} else {
					if ( null === $glob ) {
						// Default: siblings — nodes whose sink IS this interpreter.
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
				if ( $show_sink )   { $row[] = '' !== $sink_name ? "> $sink_name"    : '- '; }
				if ( $show_target ) { $row[] = '' !== $target_str ? "-> $target_str" : '- '; }
				$rows[] = $row;
			}

			if ( $list_matches && null !== $glob && ! $matched ) {
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
	 * `log <message>` builtin — BROADCAST `$args` through Core's stderr pipeline
	 * (that's what distinguishes it from `echo`, which replies). Returns nothing;
	 * the broadcast reaches the session via the wired stderr sink (worker `_repl`,
	 * REPL `_output` JSONL body for POST /command).
	 */
	private static function cmd_log( Command_Interpreter_Node $self, string $args ): string {
		$self->stderr( $args );
		return '';
	}

	/**
	 * `reply_to <node path> <command>` — run `<command>` in THIS interpreter but
	 * route its reply to `<node path>` (the inverse of `command_node`, which runs
	 * it AT the path). Mints the sub-command stamped FROM=<path> — interpret()
	 * replies TO=FROM — and re-enters via fill(). The LOCAL taint authorizes the
	 * in-process mint (the `reply_to` command itself already passed the auth gate).
	 * `reply_to` itself returns nothing; the output went to <path>.
	 */
	private static function cmd_reply_to( Command_Interpreter_Node $self, string $args ): string {
		[ $path, $rest ] = \array_pad( \preg_split( '/\s+/', \trim( $args ), 2 ) ?: [], 2, '' );
		[ $verb, $verb_args ] = \array_pad( \preg_split( '/\s+/', $rest, 2 ) ?: [], 2, '' );
		if ( '' === $path || '' === $verb ) {
			return 'usage: reply_to <node path> <command>';
		}
		// reply_to is the only verb that re-enters interpret() with a fresh
		// sub-command, so refuse to nest it — otherwise `reply_to p reply_to p
		// reply_to p ... <verb>` recurses synchronously (FROM is set raw, never
		// stamped, so MAX_FROM_SIZE can't bound it) until the stack blows.
		if ( 'reply_to' === $verb ) {
			return 'reply_to cannot invoke reply_to';
		}
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_COMMAND;
		$m[ Message::FROM ]  = $path;
		$m[ Message::VALUE ] = [ 'name' => $verb, 'arguments' => $verb_args ];
		$m[ Message::LOCAL ] = true;
		$self->fill( $m );
		return '';
	}

	/**
	 * `dmesg` builtin — dump Core's recent stderr ring buffer.
	 */
	private static function cmd_dmesg(): string {
		return \implode( '', Core::$recent_log );
	}

	/**
	 * Snapshot a node's state via Node::dump_node(), optionally key-filtered and
	 * sorted for stability, stringified with a class-name header (display-only).
	 */
	private static function cmd_dump_node( string $args ): string {
		/** @var list<string> $parts Whitespace-split tokens; the /\s+/ split of a string never yields false. */
		$parts = \preg_split( '/\s+/', \trim( $args ) );
		$name  = $parts[0] ?? '';
		if ( '' === $name ) {
			return 'no node specified';
		}
		/** @var \Newspack_Nodes\Node|null $node Node from the registry. */
		$node = Core::node( $name );
		if ( null === $node ) {
			return "can't find node \"$name\"";
		}
		$wanted   = \array_slice( $parts, 1 );
		$snapshot = $node->dump_node();

		// The class heads the dump (first line, before the body); the rest is the
		// node's state. Pulled out so it isn't also a body key / a filter target.
		$class_raw = $snapshot['class'] ?? '';
		$class     = \is_scalar( $class_raw ) ? (string) $class_raw : '';
		unset( $snapshot['class'] );
		// `class` is always shown in the header, so requesting it as a key is a
		// no-op rather than a "can't find key" error.
		$wanted = \array_values( \array_filter( $wanted, static fn ( $k ): bool => 'class' !== $k ) );

		// Alphabetical so output is stable across nodes with different ancestors.
		\ksort( $snapshot );

		if ( ! empty( $wanted ) ) {
			foreach ( $wanted as $k ) {
				if ( ! \array_key_exists( $k, $snapshot ) ) {
					return "can't find key \"$k\"";
				}
			}
			$snapshot = \array_intersect_key( $snapshot, \array_flip( $wanted ) );
		}

		// Stringify here (the result rides as a display-only string payload — not
		// json_decode'd downstream): the class name, then the pretty snapshot.
		return $class . ' ' . (string) \wp_json_encode( $snapshot, \JSON_PRETTY_PRINT | \JSON_UNESCAPED_SLASHES );
	}

	private static function cmd_dump_config(): string {
		$out = '';
		foreach ( \array_keys( Core::$nodes_by_name ) as $name ) {
			if ( Node_Names::COMMAND_INTERPRETER === $name || Node_Names::ROUTER === $name || Node_Names::OUTPUT === $name ) {
				continue; // Skip baseline scaffolding.
			}
			// $name comes from array_keys( Core::$nodes_by_name ), so the lookup is always present.
			/** @var \Newspack_Nodes\Node $node Node from the registry. */
			$node = Core::node( $name );
			$out .= $node->dump_config();
		}
		return $out;
	}

	/**
	 * `dump_metadata [<node>]` — per-node stats snapshot for the GUI canvas. With a
	 * node name, returns just that node (empty map if it's gone) so a post-mutation
	 * refresh is a one-node round-trip; bare = the full map.
	 *
	 * @param string $only Optional single node name to return.
	 * @return array<string,array<string,mixed>>
	 */
	private static function cmd_dump_metadata( string $only = '' ): array {
		$out = [];
		/** @var \Newspack_Nodes\Node $node Each registered node. */
		foreach ( Core::$nodes_by_name as $name => $node ) {
			if ( '' !== $only && $name !== $only ) {
				continue;
			}
			// Patron-linked nodes are plumbing; the canvas shouldn't render them.
			if ( null !== $node->patron() ) {
				continue;
			}
			// SHELL name (what the GUI catalog keys on), not the class short-name
			// — the two diverge under the _Node convention (Echo_Node → 'Echo'),
			// and the JS Inspector matches catalog.shell_name against this field.
			$class = self::shell_name_for( $node );
			$sink  = $node->sink();
			// Per-node port flags from the node's own schema; default true so the
			// canvas draws both ports when a subclass omits them (base declares both).
			$schema       = $node::node_schema();
			$out[ $name ] = [
				'class'         => $class,
				'counter'       => $node->counter(),
				'sink'          => $sink instanceof Node ? $sink->name() : '',
				'target'        => $node->target(),
				'debug_state'   => $node->debug_state(),
				'arguments'     => $node->arguments(),
				'lgst_msg'      => $node->largest_msg_sent(),
				'bytes_read'    => $node->bytes_read(),
				'bytes_written' => $node->bytes_written(),
				'accepts_fill'  => $schema['accepts_fill'] ?? true,
				'has_target'    => $schema['has_target'] ?? true,
			];
		}
		return $out;
	}

	/**
	 * `stats [-a] [<regex>]` — tabular per-node counters (NAME, COUNT, LGST_MSG, READ, WRITTEN).
	 *
	 * Scope matches `cmd_list_nodes`: default=siblings, `-a`=all, `<name>`=that sink's children.
	 */
	private static function cmd_stats( Command_Interpreter_Node $self, string $args ): string {
		$list_matches = false;
		$argv         = [];
		foreach ( \preg_split( '/\s+/', \trim( $args ) ) ?: [] as $tok ) {
			if ( '' === $tok ) {
				continue;
			}
			if ( '-a' === $tok ) {
				$list_matches = true;
				continue;
			}
			$argv[] = $tok;
		}
		$glob      = $argv[0] ?? null;
		$header    = [ 'NAME', 'COUNT', 'LGST_MSG', 'READ', 'WRITTEN' ];
		$dirs      = [ 'left', 'right', 'right', 'right', 'right' ];
		$rows      = [];
		$all_names = \array_keys( Core::$nodes_by_name );
		\sort( $all_names );
		foreach ( $all_names as $name ) {
			// $name comes from array_keys( Core::$nodes_by_name ), so the lookup is always present.
			/** @var \Newspack_Nodes\Node $node Node from the registry. */
			$node      = Core::node( $name );
			$sink_name = $node->sink() ? $node->sink()->name() : '';
			if ( $list_matches ) {
				if ( null !== $glob && ! @\preg_match( "/$glob/", $name ) ) {
					continue;
				}
			} else {
				$expected = $glob ?? $self->name();
				if ( $expected !== $sink_name ) {
					continue;
				}
			}
			$rows[] = [
				$name,
				(string) $node->counter(),
				(string) $node->largest_msg_sent(),
				(string) $node->bytes_read(),
				(string) $node->bytes_written(),
			];
		}
		return self::tabulate( $dirs, $header, $rows );
	}

	/**
	 * `debug_state [ <node name> [ <level> ] ]` — toggle or set a node's debug_state level.
	 *
	 * No args toggles this interpreter; numeric arg sets this interpreter; a name targets that node.
	 */
	private static function cmd_debug_state( Command_Interpreter_Node $self, string $args ): string {
		[ $first, $second ] = \array_pad( \preg_split( '/\s+/', \trim( $args ), 2 ) ?: [], 2, '' );

		if ( '' === $first ) {
			$new = $self->debug_state() > 0 ? 0 : 1;
			$self->debug_state( $new );
			return "_command_interpreter debug_state: $new";
		}

		if ( \ctype_digit( $first ) && '' === $second ) {
			$self->debug_state( (int) $first );
			return '_command_interpreter debug_state: ' . $self->debug_state();
		}

		/** @var \Newspack_Nodes\Node|null $node Node from the registry. */
		$node = Core::node( $first );
		if ( null === $node ) {
			return "unknown node: $first";
		}
		$new = '' === $second
			? ( $node->debug_state() > 0 ? 0 : 1 )
			: (int) $second;
		$node->debug_state( $new );
		return "$first debug_state: " . $node->debug_state();
	}

	/**
	 * `help` — no args lists all command names tabulated; a topic returns that command's help.
	 *
	 * @param array<array-key, mixed> $envelope The command Message.
	 */
	private static function cmd_help( string $args, array $envelope = [] ): string {
		// Completion mode: bare sorted verb names, newline-separated — no section
		// headers, no per-topic help text — so the tab-completion parser gets clean
		// candidates.
		if ( 'completion' === ( $envelope[ Message::KEY ] ?? '' ) ) {
			// Source from the verb dispatch table, not the help-topic table, so
			// aliases (ls, rm, make, ...) are offered alongside the canonicals.
			$names = \array_keys( self::$C ?? [] );
			\sort( $names );
			return \implode( "\n", $names );
		}
		$topic = \trim( $args );
		if ( '' === $topic ) {
			$names = \array_keys( self::$H ?? [] );
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
			return implode( "\n", [
				'### SHELL BUILTINS ###',
				'  debug_level [0|1|2]            — local Dumper verbosity',
				'  ping [<path>]                  — TM_PING (RTT measured locally)',
				'  tell <path> <bytes>            — TM_INFO',
				'  send <path> <bytes>            — TM_BYTESTREAM',
				'  send_eof <path>                — TM_EOF',
				'  request <path> <args>          — TM_REQUEST',
				'  cmd <path> <verb> [<args>]     — TM_COMMAND at <path>',
				'  status                         — local cli mode summary (no command sent)',
				"### SERVER COMMANDS ###",
				self::tabulate( [ 'left', 'left', 'left', 'left' ], null, $rows )
			] );
		}
		// Keep aliases in lockstep with the $C alias entries and Shell builtin dispatch.
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
	 * Column-aligned table rendering; the last left-aligned column isn't padded.
	 *
	 * @param array<int,string>            $dirs   One per column ('left' or 'right').
	 * @param array<int,string>|null       $header Optional header row; null skips it.
	 * @param array<int,array<int,string>> $rows
	 */
	private static function tabulate( array $dirs, ?array $header, array $rows ): string {
		$ncols = \count( $dirs );
		$max   = \array_fill( 0, $ncols, 0 );
		if ( null !== $header ) {
			foreach ( $header as $col => $val ) {
				$max[ $col ] = \max( $max[ $col ], \strlen( $val ) );
			}
		}
		foreach ( $rows as $row ) {
			foreach ( $row as $col => $val ) {
				if ( $col >= $ncols ) {
					continue;
				}
				$max[ $col ] = \max( $max[ $col ], \strlen( $val ) );
			}
		}

		$format_row = function ( array $row ) use ( $dirs, $max, $ncols ): string {
			$parts = [];
			for ( $col = 0; $col < $ncols; ++$col ) {
				// Cells arrive pre-stringified per @param; guard narrows the bare-array element before str_pad.
				$cell = $row[ $col ] ?? '';
				$val  = \is_scalar( $cell ) ? (string) $cell : '';
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

	public static function node_schema(): array {
		return [
			'category'    => 'Hidden',
			'description' => 'Command dispatch — placed implicitly as sibling of patron nodes; not draggable.',
			'arguments'   => [],
			'commands'    => [],
		];
	}
}
