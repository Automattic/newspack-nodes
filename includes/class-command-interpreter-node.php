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
	 * Process-wide default command-authorization policy. A verifier process
	 * (worker, /command request) sets this ONCE at bootstrap so EVERY interpreter in the
	 * process — the main `_command_interpreter` plus the patron interpreters embedded in
	 * Partitions and other config-bearing nodes — inherits it without per-instance
	 * wiring. Null → the built-in LOCAL-provenance check (client tier).
	 * Signature: `function ( Command_Interpreter_Node $ci, array $message ): bool`
	 * (true = allow). The interpreter comes first so a refusal is logged through
	 * the node that actually handled the command — the reason and the generic
	 * "unauthorized" suppression must land on ONE object, or every refusal logs
	 * twice under two different node names.
	 *
	 * @var \Closure|null
	 */
	public static ?\Closure $default_authorize = null;

	/**
	 * Verb classes disabled at each secure level, modeled on Tachikoma's
	 * %DISABLED. Indexed by the CURRENT level, not a union: each level says
	 * what is off AT that level, which is how Ruleset and Scheduler declare
	 * only their own level-3 verbs.
	 *
	 * The ladder freezes definitions and never disables the machine: reads
	 * still read, wired flow still flows, defined verbs still run.
	 *
	 * @var array<int, list<string>>
	 */
	private const DISABLED_CLASSES = [
		1 => [ 'make_node' ],
		2 => [ 'command_node' ],
		3 => [ 'connect_node' ],
	];

	/**
	 * Verb name => class, for the substrate's own verbs. A node classifies its
	 * own verbs through `node_schema()['verb_classes']`, so a consumer plugin
	 * joins a class without editing this file.
	 *
	 * @var array<string, string>
	 */
	private const VERB_CLASSES = [
		'make_node'       => 'make_node',
		'make'            => 'make_node',
		'connect_node'    => 'connect_node',
		'connect'         => 'connect_node',
		'disconnect_node' => 'connect_node',
		'disconnect'      => 'connect_node',
		'set_sink'        => 'connect_node',
		'reply_to'        => 'command_node',
	];

	/**
	 * Registered class namespace prefixes. `make_node('Tee')` resolves the
	 * first `{$prefix}Tee_Node` that exists and is a Node subclass. The catalog
	 * (Classes_CI) scans the composer classmap for FQCNs under these prefixes.
	 *
	 * @var array<string,bool> Prefix → true (set semantics).
	 */
	protected static array $namespaces = [];

	/**
	 * Shared default verb table the bare `_command_interpreter` starts from.
	 *
	 * @var array<string, \Closure(Command_Interpreter_Node, list<string>, array<int,mixed>): mixed>|null Verb → handler. Initialized lazily.
	 */
	private static ?array $C = null;

	/**
	 * Per-command help text shown by `help`, keyed by canonical verb.
	 *
	 * @var array<string,string>|null
	 */
	private static ?array $H = null;

	/**
	 * Memoized `resolve_class()` SUCCESSES: shell type → resolved FQCN. Misses are
	 * never stored (so a type resolvable only after a later register_namespace()
	 * still resolves), so the value is never null.
	 *
	 * @var array<string,class-string<Node>>
	 */
	private static array $resolve_cache = [];

	/**
	 * Per-instance override of $default_authorize (tests / special cases). Null →
	 * fall back to the static default. Same signature.
	 *
	 * @var \Closure|null
	 */
	public ?\Closure $authorize = null;

	/**
	 * Per-instance verb table; defaults to self::$C, siblings install their own via commands().
	 *
	 * @var array<string,callable>|null
	 */
	protected ?array $commands = null;

	public function fill( array $message ): void {
		if ( null === $this->sink ) {
			throw new \RuntimeException( 'fill requires a wired sink' );
		}
		++$this->counter;

		$type_raw = $message[ Message::TYPE ];
		$type     = Core::num_int( $type_raw );

		// TM_PING / TM_EOF with empty TO: bounce along FROM (drain marker).
		if ( ( $type & ( Message::TM_PING | Message::TM_EOF ) ) && '' === $message[ Message::TO ] ) {
			$message[ Message::TO ] = $message[ Message::FROM ];
			$this->sink->fill( $message );
			return;
		}

		// Only handle empty-TO commands; non-empty TO forwards downstream.
		if ( ( $type & Message::TM_COMMAND ) && ! ( $type & Message::TM_RESPONSE ) && '' === $message[ Message::TO ] ) {
			$this->interpret( $message );
			return;
		}
		$this->sink->fill( $message );
	}

	/** @param array<int, mixed> $message Incoming command Message to interpret. */
	private function interpret( array $message ): void {
		$cmd = $message[ Message::VALUE ];
		if ( ! \is_array( $cmd ) || ! isset( $cmd['name'] ) ) {
			$this->drop_message( $message, 'invalid command struct' );
			return;
		}
		$name_raw  = $cmd['name'];
		$args_raw  = $cmd['arguments'] ?? [];
		$cmd_name  = Core::as_string( $name_raw );
		$cmd_args  = \is_array( $args_raw ) ? \array_values( \array_map( static fn ( $v ): string => Core::as_string( $v ), $args_raw ) ) : [];

		// Authorize every command (LOCAL taint client-side, HMAC on verifiers).
		$authorize = $this->authorize ?? self::$default_authorize
			?? static fn ( self $ci, array $m ): bool => isset( $m[ Message::LOCAL ] );
		if ( ! $authorize( $this, $message ) ) {
			$result    = 'unauthorized: ' . $cmd_name;
			$resp_type = Message::TM_COMMAND | Message::TM_ERROR;
			// authorize may have logged the reason; skip the generic one.
		} else {
			// Verb handlers throw freely; wrap as TM_COMMAND|TM_ERROR for cli.
			try {
				$result = $this->dispatch(
					$cmd_name,
					$cmd_args,
					$message
				);
				$resp_type = Message::TM_COMMAND | Message::TM_RESPONSE;
			} catch ( Worker_Should_Stop $e ) {
				throw $e; // control flow, not a verb error (ADR-14).
			} catch ( \Throwable $e ) {
				// Decode: handler errors are pre-escaped; sink re-escapes raw.
				$result    = \html_entity_decode( $e->getMessage(), \ENT_QUOTES ) . "\n";
				$resp_type = Message::TM_COMMAND | Message::TM_ERROR;
			}
		}

		// One terminator per string reply; structs pass through untouched.
		if ( \is_string( $result ) && '' !== $result && ! \str_ends_with( $result, "\n" ) ) {
			$result .= "\n";
		}

		if ( null === $this->sink ) {
			throw new \RuntimeException( 'fill requires a wired sink' );
		}

		// TM_NOREPLY: suppress the reply, but still surface errors via stderr.
		$in_type = $message[ Message::TYPE ];
		if ( Core::int( $in_type ) & Message::TM_NOREPLY ) {
			if ( ( $resp_type & Message::TM_ERROR ) && '' !== $result ) {
				$this->stderr( 'error from TM_NOREPLY command: ' . ( Core::as_string( $result ) ) );
			}
			return;
		}

		// Route TO=FROM (walk breadcrumb back); KEY is client correlation.
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
	 * @param list<string>            $args     Pre-split argument tokens (verbs classify via Command_Args).
	 * @param array<int,mixed>        $envelope Inbound TM_COMMAND message, or [] for inline calls.
	 * @return mixed Verb result (string for most verbs; array for dump_metadata).
	 */
	public function dispatch( string $name, array $args = [], array $envelope = [] ): mixed {
		$refusal = $this->refuse_at_secure_level( $name );
		if ( null !== $refusal ) {
			return $refusal;
		}
		$commands = $this->commands();
		if ( ! isset( $commands[ $name ] ) ) {
			throw new \InvalidArgumentException( \esc_html( "unknown command: {$name}" ) );
		}
		return ( $commands[ $name ] )( $this, $args, $envelope );
	}

	/**
	 * Construct a registered Node subclass, name it, sink it to this interpreter, and return it.
	 *
	 * @param string $type    Shell name (resolved as `{$prefix}{$type}_Node`, or the bare base `Node`).
	 * @param string $name    Unique name for the new node (registered with Core).
	 * @param mixed  ...$args Positional constructor arguments.
	 * @return Node|null Null when no registered namespace yields a matching Node.
	 */
	public function make_node( string $type, string $name, ...$args ): ?Node {
		$fqcn = self::resolve_class( $type );
		if ( null === $fqcn ) {
			return null;
		}
		$ref = new \ReflectionClass( $fqcn );
		// Abstract subclass (e.g. Service_CI_Node) not instantiable; null.
		if ( $ref->isAbstract() ) {
			return null;
		}
		$scalar_args = \array_filter( $args, '\is_scalar' );
		if ( \count( $scalar_args ) !== \count( $args ) ) {
			Core::print_less_often(
				'make_node ',
				"{$type} {$name}",
				': non-scalar positional arg filtered (assign object deps as public properties)'
			);
		}
		$arg_tokens = \array_map( static fn ( $a ): string => (string) $a, \array_values( $scalar_args ) );

		// Identical redeclaration collapses; a conflict throws.
		$existing = Core::node( $name );
		if ( null !== $existing ) {
			if ( $existing::class === $fqcn && $existing->arguments() === $arg_tokens ) {
				return $existing;
			}
			$prior = \implode( ' ', $existing->arguments() );
			$next  = \implode( ' ', $arg_tokens );
			throw new \RuntimeException(
				\esc_html( "make_node conflict: '$name' already declared as " . $existing::class . " '$prior', redeclared as $type '$next'" )
			);
		}

		// Tachikoma sequence; object deps public props set post-construction.
		$node = new $fqcn();
		try {
			$node->name( $name );
			$node->arguments( $arg_tokens );
			$node->sink( $this );
			if ( $this->debug_state() > 0 ) {
				$node->debug_state( $this->debug_state() );
			}
		} catch ( \Throwable $e ) {
			// name() registers first, so a reject orphans. Tachikoma CI:2701.
			try {
				$node->remove_node();
			} catch ( \Throwable $cleanup ) {
				Core::print_less_often( 'ERROR: ', "can't remove_node {$name}: ", $cleanup->getMessage() );
			}
			throw $e;
		}
		return $node;
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
		return \implode( "\n", $names ) . "\n";
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
		// Every interpreter answers `help`; base's richer one never overridden.
		if ( ! isset( $this->commands['help'] ) ) {
			$this->commands['help'] = static fn ( Command_Interpreter_Node $self, array $args = [], array $envelope = [] ): string => $self->default_help();
		}
		return $this->commands;
	}

	private static function init_C(): void {
		if ( null !== self::$C ) {
			return;
		}
		self::$H = [
			// interpreter-dispatched verbs.
			'secure'   => "secure [<level>]\n    note: climbs 1..3 and never descends; each level removes management verbs.\n",
			'insecure' => "insecure\n    note: declares this process deliberately unratcheted; refused once secured.\n",
			'make_node' => "make_node <type> <name> [<arguments>]\n    alias: make\n",
			'set_sink'  => "set_sink <node> <target>\n",
			'connect_node' => "connect_node <node> [<target>]\n    alias: connect\n    note: <target> defaults to the issuing message's FROM — tails\n          the node's flow back to your own cli/SSE session.\n",
			'disconnect_node' => "disconnect_node <node> [<target>]\n    alias: disconnect\n    note: for a Tee, <target> defaults to the issuing message's FROM\n          — undoes a default `connect_node <tee>` for this session.\n",
			'register' => "register <source name> <target name> <event>\n",
			'unregister' => "unregister <source name> <target name> <event>\n",
			'remove_node' => "remove_node <node name> [<more names>...]\nremove_node -a <anchored regex glob>\n    aliases: remove, rm\n",
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
			'list_timers' => "list_timers [-s]\n    note: all timers (ID, ACTIVE, INTERVAL ms, MODE, NEXT ms,\n          ONESHOT, FIRES, TYPE, NAME). NEXT <= 0 with a climbing\n          FIRES = a spinner.\n    -s: the same rows as a struct, for a view that wants to sort them.\n",
			'list_handles' => "list_handles [-s]\n    note: registered cURL multi handles the drain loop selects on\n          (ID, COUNT msgs, TYPE, NAME).\n    -s: the same rows as a struct, for a view that wants to sort them.\n",
			'profile' => "profile [ on | off ]\n"
				. "    no args: toggle _router dispatch profiling (per-node self time).\n"
				. "    on|off:  idempotent set — the form scripts and UI use, since\n"
				. "             a known desired state never races a stale toggle.\n"
				. "    note: while on, _router times each dispatch; read the table\n"
				. "          with list_profiles.\n",
			'list_profiles' => "list_profiles [-s] [ <regex glob> ]\n    note: per-node self-time table, slowest average first; `total`\n          shows only the --total-- row.\n    -s: the same rows as a struct, --total-- included, for a view\n        that wants to sort them.\n",
			'dump_node' => "dump_node <node name> [<keys>]\n    alias: dump\n",
			'dump_config' => "dump_config [ <regex glob> ]\n",
			'dump_metadata' => "dump_metadata\n    note: a JSON object keyed by node name, carrying `class`,\n          `counter`, `sink`, `target`, `debug_state` and `arguments`.\n          One round-trip gives a GUI everything it needs to render\n          the graph.\n",
			'trace' => "trace [ <node name> [ <level> ] ]\n"
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
			'taillog' => "taillog <source> [max_kb]\n    note: tail a durable aggregated log FILE by registry NAME\n          (php | debug), never a path — no traversal. Returns the\n          last min(max_kb, 64)KB (default 16), partial first line\n          dropped. No args lists the sources with availability; the\n          reserved name `sources` returns them as a\n          { name, path, mode, available, bytes } struct for a picker.\n",
			'uptime' => "uptime\n    note: clock-time, plus days+HH:MM:SS since Core::reset() (worker spawn).\n",
			'stats' => "stats [-a] [<regex>]\n    columns: NAME COUNT LGST_MSG READ WRITTEN.\n    default: sibling nodes of this interpreter; -a: all nodes.\n",
			'help' => "help [ <topic> ]\n",

			// Shell-level builtins: Shell intercepts; listed for `help`.
			'cd' => "cd [ <path> ]\n    alias: chdir\n    note: empty path resets cwd to the local interpreter.\n",
			'include' => "include <file>\n    note: shell builtin — reads <file> and evals each line through\n          THIS shell, as though piped into the REPL (cwd and vars\n          apply). Never a wire command.\n",
			'debug_level' => "debug_level [0|1|2]\n    note: sets the local Dumper verbosity level.\n",
			'tell_node' => "tell_node <path> <info>\n    alias: tell\n    note: emits TM_INFO at prefix(<path>); fire-and-forget broadcast.\n",
			'send_node' => "send_node <path> <bytes>\n    alias: send\n    note: emits TM_BYTESTREAM at prefix(<path>).\n",
			'send_struct' => "send_struct <path> <json>\n    note: emits TM_STRUCT at prefix(<path>).\n",
			'send_eof' => "send_eof <path>\n    note: emits TM_EOF at prefix(<path>).\n",
			'command_node' => "command_node <path> <verb> [<arguments>]\n    aliases: command, cmd\n    note: dispatches a TM_COMMAND at prefix(<path>) without changing cwd.\n",
			'request_node' => "request_node <path> [<value>]\n    alias: request\n    note: emits TM_REQUEST at prefix(<path>); receiver replies via TO=FROM.\n",
			'reply_to' => "reply_to <node path> <command>\n    note: runs <command> HERE but routes its reply to <node path>\n          (inverse of command_node). Lets a worker drive a remote\n          interpreter's output to one session.\n",
			'ping' => "ping <path>\n    note: round-trips a TM_PING; receiver bounces TO=FROM. Output shows RTT.\n",
			'show_parse' => "show_parse\n   note: toggles parsed command dump for every command.\n",
			'status' => "status\n    note: local cli mode summary (no command sent).\n",
		];
		self::$C = [
			'secure'          => fn ( Command_Interpreter_Node $self, array $args ): string => self::cmd_secure( self::arg_strings( $args ) ),
			'insecure'        => fn ( Command_Interpreter_Node $self, array $args ): string => self::cmd_insecure(),
			'make_node'       => fn ( Command_Interpreter_Node $self, array $args ): string => self::cmd_make_node( $self, self::arg_strings( $args ) ),
			'make'            => fn ( Command_Interpreter_Node $self, array $args ): string => self::cmd_make_node( $self, self::arg_strings( $args ) ),
			'pwd'             => fn ( Command_Interpreter_Node $self, array $args, array $message ): string => self::cmd_pwd( self::arg_strings( $args ), $message ),
			'set_sink'        => fn ( Command_Interpreter_Node $self, array $args ): string => self::cmd_set_sink( self::arg_strings( $args ) ),
			'connect_node'    => fn ( Command_Interpreter_Node $self, array $args, array $envelope = [] ): string => self::cmd_connect_node( self::arg_strings( $args ), $envelope ),
			'connect'         => fn ( Command_Interpreter_Node $self, array $args, array $envelope = [] ): string => self::cmd_connect_node( self::arg_strings( $args ), $envelope ),
			'disconnect_node' => fn ( Command_Interpreter_Node $self, array $args, array $envelope = [] ): string => self::cmd_disconnect_node( self::arg_strings( $args ), $envelope ),
			'disconnect'      => fn ( Command_Interpreter_Node $self, array $args, array $envelope = [] ): string => self::cmd_disconnect_node( self::arg_strings( $args ), $envelope ),
			'register'        => fn ( Command_Interpreter_Node $self, array $args ): string => self::cmd_register( self::arg_strings( $args ) ),
			'unregister'      => fn ( Command_Interpreter_Node $self, array $args ): string => self::cmd_unregister( self::arg_strings( $args ) ),
			'remove_node'     => fn ( Command_Interpreter_Node $self, array $args ): string => self::cmd_remove_node( $self, self::arg_strings( $args ) ),
			'remove'          => fn ( Command_Interpreter_Node $self, array $args ): string => self::cmd_remove_node( $self, self::arg_strings( $args ) ),
			'rm'              => fn ( Command_Interpreter_Node $self, array $args ): string => self::cmd_remove_node( $self, self::arg_strings( $args ) ),
			'list_nodes'      => fn ( Command_Interpreter_Node $self, array $args, array $envelope = [] ): string => self::cmd_list_nodes( $self, self::arg_strings( $args ), $envelope ),
			'ls'              => fn ( Command_Interpreter_Node $self, array $args, array $envelope = [] ): string => self::cmd_list_nodes( $self, self::arg_strings( $args ), $envelope ),
			'list_timers'     => fn ( Command_Interpreter_Node $self, array $args ): string|array => self::cmd_list_timers( \in_array( '-s', $args, true ) ),
			'list_handles'    => fn ( Command_Interpreter_Node $self, array $args ): string|array => self::cmd_list_handles( \in_array( '-s', $args, true ) ),
			'profile'         => fn ( Command_Interpreter_Node $self, array $args ): string => self::cmd_profile( Core::as_string( $args[0] ?? '' ) ),
			'list_profiles'   => fn ( Command_Interpreter_Node $self, array $args ): string|array => self::cmd_list_profiles(
				Core::as_string( \current( \array_filter( $args, static fn ( $a ): bool => '-s' !== $a ) ) ?: '' ),
				\in_array( '-s', $args, true )
			),
			'log'             => fn ( Command_Interpreter_Node $self, array $args ): string => self::cmd_log( $self, self::arg_strings( $args ) ),
			'dmesg'           => fn ( Command_Interpreter_Node $self, array $args ): string => self::cmd_dmesg(),
			'taillog'         => fn ( Command_Interpreter_Node $self, array $args ): mixed => Log_Sources::taillog( self::arg_strings( $args ) ),
			'dump_node'       => fn ( Command_Interpreter_Node $self, array $args ): mixed => self::cmd_dump_node( self::arg_strings( $args ) ),
			'dump'            => fn ( Command_Interpreter_Node $self, array $args ): mixed => self::cmd_dump_node( self::arg_strings( $args ) ),
			'dump_config'     => fn ( Command_Interpreter_Node $self, array $args ): string => self::cmd_dump_config( Core::as_string( $args[0] ?? '' ) ),
			'dump_metadata'   => fn ( Command_Interpreter_Node $self, array $args, array $envelope = [] ): mixed => self::cmd_dump_metadata( Core::as_string( $args[0] ?? '' ), \is_string( $envelope[ Message::FROM ] ?? null ) ? $envelope[ Message::FROM ] : '' ),
			'stats'           => fn ( Command_Interpreter_Node $self, array $args ): string => self::cmd_stats( $self, self::arg_strings( $args ) ),
			'uptime'          => fn ( Command_Interpreter_Node $self, array $args ): string => self::cmd_uptime(),
			'trace'           => fn ( Command_Interpreter_Node $self, array $args ): string => self::cmd_trace( $self, self::arg_strings( $args ) ),
			'help'            => fn ( Command_Interpreter_Node $self, array $args, array $envelope = [] ): string => self::cmd_help( self::arg_strings( $args ), $envelope ),
			'reply_to'        => fn ( Command_Interpreter_Node $self, array $args, array $envelope = [] ): string => self::cmd_reply_to( $self, self::arg_strings( $args ) ),
		];
	}

	/**
	 * Coerce a dispatch closure's raw `array $args` to the canonical argv shape —
	 * a re-indexed list of strings. The verb dispatch closures are declared
	 * `array $args` (an inline closure param can't carry a narrower phpdoc type),
	 * so each verb handler normalizes at entry. The tokens are already strings at
	 * runtime — interpret() coerces the wire arguments before dispatch — so this
	 * is a static-analysis pin, not a behavioral coercion.
	 *
	 * @param array<array-key, mixed> $args
	 * @return list<string>
	 */
	protected static function arg_strings( array $args ): array {
		return \array_values( \array_map( static fn ( $v ): string => Core::as_string( $v ), $args ) );
	}

	/**
	 * Refuse a verb whose class is disabled at the current secure level, or
	 * null to proceed. A node's own verbs classify themselves through
	 * `node_schema()['verb_classes']`.
	 */
	private function refuse_at_secure_level( string $verb ): ?string {
		$level = Core::$secure_level ?? 0;
		if ( ! isset( self::DISABLED_CLASSES[ $level ] ) ) {
			return null;
		}
		$class = self::VERB_CLASSES[ $verb ] ?? $this->schema_verb_class( $verb );
		if ( '' === $class || ! \in_array( $class, self::DISABLED_CLASSES[ $level ], true ) ) {
			return null;
		}
		return "{$verb} is disabled at secure level {$level}";
	}

	/** This node's own class for a verb, from node_schema; '' when unclassified. */
	private function schema_verb_class( string $verb ): string {
		$schema = static::node_schema();
		$map    = \is_array( $schema['verb_classes'] ?? null ) ? $schema['verb_classes'] : [];
		return Core::as_string( $map[ $verb ] ?? '' );
	}

	/**
	 * `secure [<level>]` — climb the ratchet. Bare climbs one level, capped at
	 * 3; an explicit level must be >= 1 and may never descend. Follows
	 * Tachikoma's $C{secure}.
	 *
	 * @param list<string> $args Verb arguments.
	 */
	private static function cmd_secure( array $args ): string {
		$current = Core::$secure_level ?? 0;
		$raw     = $args[0] ?? '';
		if ( '' !== $raw ) {
			if ( ! \ctype_digit( $raw ) || (int) $raw < 1 ) {
				return "invalid secure level\n";
			}
			$want = \min( 3, (int) $raw );
			if ( $want < $current ) {
				return "cannot lower secure level from {$current}\n";
			}
			if ( $want === $current ) {
				return "already at secure level {$current}\n";
			}
			Core::$secure_level = $want;
			return '';
		}
		Core::$secure_level = $current < 1 ? 1 : \min( 3, $current + 1 );
		return '';
	}

	/**
	 * `insecure` — declare this process deliberately unratcheted. Refused once
	 * secured, so the declaration cannot be walked back. Mirrors
	 * Tachikoma's $C{insecure}.
	 */
	private static function cmd_insecure(): string {
		if ( ( Core::$secure_level ?? 0 ) > 0 ) {
			return "process already secured\n";
		}
		Core::$secure_level = -1;
		return '';
	}

	/**
	 * Shell entry: parse `<type> <name> [<args>...]` and delegate to make_node().
	 *
	 * No strict_types, so string tokens coerce to the ctor's typed params.
	 *
	 * @param list<string> $args
	 */
	private static function cmd_make_node( Command_Interpreter_Node $self, array $args ): string {
		if ( \count( $args ) < 2 ) {
			return "usage: make_node <type> <name> [<args>...]\n";
		}
		$type = $args[0];
		$name = $args[1];
		$node = $self->make_node( $type, $name, ...\array_slice( $args, 2 ) );
		return null === $node ? "unknown class: $type\n" : "ok\n";
	}

	/**
	 * `pwd` verb: return ` <cwd> -> <envelope.from>`.
	 *
	 * @param list<string>            $args     Verb arguments.
	 * @param array<array-key, mixed> $envelope The command Message.
	 */
	private static function cmd_pwd( array $args, array $envelope ): string {
		$path = $args[0] ?? '';
		$cwd  = '' === $path ? '/' : $path;
		$from = Core::as_string( $envelope[ Message::FROM ] ?? '' );
		return ' ' . $cwd . ' -> ' . $from . "\n";
	}

	/** @param list<string> $args */
	private static function cmd_set_sink( array $args ): string {
		[ $name, $target ] = \array_pad( $args, 2, '' );
		if ( '' === $name || '' === $target ) {
			return "usage: set_sink <node> <target>\n";
		}
		/** @var \Newspack_Nodes\Node|null $src Source node from the registry. */
		$src = Core::node( $name );
		/** @var \Newspack_Nodes\Node|null $dst Target node from the registry. */
		$dst = Core::node( $target );
		if ( null === $src || null === $dst ) {
			return "unknown node\n";
		}
		$src->sink( $dst );
		return "ok\n";
	}

	/**
	 * @param list<string>            $args     Verb arguments.
	 * @param array<array-key, mixed> $envelope The command Message.
	 */
	private static function cmd_connect_node( array $args, array $envelope = [] ): string {
		[ $name, $target ] = \array_pad( $args, 2, '' );
		if ( '' === $name ) {
			return "usage: connect_node <node> [<target>]\n";
		}
		/** @var \Newspack_Nodes\Node|null $src Source node from the registry. */
		$src = Core::node( $name );
		if ( null === $src ) {
			return "unknown node: $name\n";
		}
		// No target defaults to the issuing FROM; tees the node's flow back.
		if ( '' === $target ) {
			$target = Core::as_string( $envelope[ Message::FROM ] ?? '' );
			if ( '' === $target ) {
				return "usage: connect_node <node> [<target>]\n";
			}
		}
		$src->connect_node( $target );
		return "ok\n";
	}

	/**
	 * @param list<string>            $args     Verb arguments.
	 * @param array<array-key, mixed> $envelope The command Message.
	 */
	private static function cmd_disconnect_node( array $args, array $envelope = [] ): string {
		[ $name, $target ] = \array_pad( $args, 2, '' );
		if ( '' === $name ) {
			return "usage: disconnect_node <node> [<target>]\n";
		}
		/** @var \Newspack_Nodes\Node|null $src Source node from the registry. */
		$src = Core::node( $name );
		if ( null === $src ) {
			return "unknown node: $name\n";
		}
		// For a Tee, no target removes the issuing FROM from the fan-out.
		if ( '' === $target && \is_array( $src->target() ) ) {
			$target = Core::as_string( $envelope[ Message::FROM ] ?? '' );
			if ( '' === $target ) {
				return "usage: disconnect_node <node> [<target>]\n";
			}
		}
		$src->disconnect_node( $target );
		return "ok\n";
	}

	/**
	 * `register <source> <target> <event>` — source registers target as a node-name listener for event (Tachikoma register).
	 *
	 * @param list<string> $args
	 */
	private static function cmd_register( array $args ): string {
		[ $source, $target, $event ] = \array_pad( $args, 3, '' );
		if ( '' === $source ) {
			return "usage: register <source name> <target name> <event>\n";
		}
		$node = Core::node( $source );
		if ( null === $node ) {
			return "unknown node: $source\n";
		}
		if ( '' === $target ) {
			return "usage: register <source name> <target name> <event>\n";
		}
		if ( null === Core::node( $target ) ) {
			return "unknown node: $target\n";
		}
		$node->register( $event, $target );
		return "ok\n";
	}

	/**
	 * `unregister <source> <target> <event>` — drop target's node-name registration for event on source (Tachikoma unregister).
	 *
	 * @param list<string> $args
	 */
	private static function cmd_unregister( array $args ): string {
		[ $source, $target, $event ] = \array_pad( $args, 3, '' );
		if ( '' === $source ) {
			return "usage: unregister <source name> <target name> <event>\n";
		}
		$node = Core::node( $source );
		if ( null === $node ) {
			return "unknown node: $source\n";
		}
		if ( '' === $target ) {
			return "usage: unregister <source name> <target name> <event>\n";
		}
		$node->unregister( $event, $target );
		return "ok\n";
	}

	/**
	 * `remove_node <name>...` or `remove_node -a <regex>`. Refuses to destroy baseline scaffolding.
	 *
	 * @param list<string> $args
	 */
	private static function cmd_remove_node( Command_Interpreter_Node $self, array $args ): string {
		if ( empty( $args ) ) {
			return "usage: remove_node <node name>\n";
		}

		$list_matches = false;
		$glob         = '';
		if ( '-a' === $args[0] ) {
			$list_matches = true;
			$glob         = $args[1] ?? '';
			if ( '' === $glob ) {
				return "usage: remove_node -a <anchored regex glob>\n";
			}
		}

		if ( $list_matches ) {
			// Anchored `@regex@` so user-supplied / and ^$ don't need escaping.
			$names = [];
			foreach ( \array_keys( Core::$nodes_by_name ) as $candidate ) {
				if ( @\preg_match( '@^' . $glob . '$@', $candidate ) ) {
					$names[] = $candidate;
				}
			}
			\sort( $names );
		} else {
			$names = $args;
		}

		$removed   = [];
		$errors    = [];
		$protected = Node_Names::SESSION_SCAFFOLDING;
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
			return "no matches\n";
		}
		return '' === $out ? "ok\n" : $out . "\n";
	}

	/**
	 * `list_nodes` (alias `ls`): default=siblings, `-a [glob]`=all, `<name>`=that sink's children.
	 *
	 * Flags: `-c` count, `-s` sink, `-t` target, `-l` = -ct.
	 *
	 * @param list<string>            $args     Verb arguments.
	 * @param array<array-key, mixed> $envelope The command Message.
	 */
	private static function cmd_list_nodes( Command_Interpreter_Node $self, array $args, array $envelope = [] ): string {
		// Completion mode: bare node names only, ignoring -clst flags.
		$is_completion = 'completion' === ( $envelope[ Message::KEY ] ?? '' );
		$list_matches  = false;
		$show_count    = false;
		$show_sink     = false;
		$show_target   = false;
		$argv          = [];

		foreach ( $args as $tok ) {
			if ( '' === $tok ) {
				continue;
			}
			if ( \preg_match( '/^-([aclst]+)$/', $tok, $m ) ) {
				$length = \strlen( $m[1] );
				for ( $i = 0; $i < $length; ++$i ) {
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

		// Completion mode: bare names, all nodes (like -a) for `cd <tab>`.
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
					return "can't find node \"$name\"\n";
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
						// Default: siblings — sink IS this interpreter.
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

		// Render: with column flags, include header. Otherwise plain names.
		if ( ! $any_extra ) {
			$names = [];
			foreach ( $rows as $r ) {
				$names[] = $r[0];
			}
			return \implode( "\n", $names ) . "\n";
		}
		return self::tabulate( $dirs, $header, $rows );
	}

	/**
	 * `log <message>` builtin — BROADCAST `$args` through this node's stderr pipeline
	 * (that's what distinguishes it from `echo`, which replies). Returns nothing;
	 * the broadcast reaches the session via the wired stderr sink (worker `_repl`,
	 * REPL `_output` JSONL body for POST /command).
	 *
	 * @param list<string> $args
	 */
	private static function cmd_log( Command_Interpreter_Node $self, array $args ): string {
		$self->stderr( \implode( ' ', $args ) );
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
	 *
	 * @param list<string> $args
	 */
	private static function cmd_dump_node( array $args ): string {
		/** @var list<string> $parts Whitespace-split tokens; the /\s+/ split of a string never yields false. */
		$parts = $args;
		$name  = $parts[0] ?? '';
		if ( '' === $name ) {
			return "no node specified\n";
		}
		/** @var \Newspack_Nodes\Node|null $node Node from the registry. */
		$node = Core::node( $name );
		if ( null === $node ) {
			return "can't find node \"$name\"\n";
		}
		$wanted   = \array_slice( $parts, 1 );
		$snapshot = $node->dump_node();

		// class heads the dump; pulled out so not a body key / filter target.
		$class_raw = $snapshot['class'] ?? '';
		$class     = Core::as_string( $class_raw );
		unset( $snapshot['class'] );
		// `class` is in the header, so requesting it as a key is a no-op.
		$wanted = \array_values( \array_filter( $wanted, static fn ( $k ): bool => 'class' !== $k ) );

		// Alphabetical so output stable across nodes with different ancestors.
		\ksort( $snapshot );

		if ( ! empty( $wanted ) ) {
			foreach ( $wanted as $k ) {
				if ( ! \array_key_exists( $k, $snapshot ) ) {
					return "can't find key \"$k\"\n";
				}
			}
			$snapshot = \array_intersect_key( $snapshot, \array_flip( $wanted ) );
		}

		// Stringify: display-only payload (not json_decode'd downstream).
		return $class . ' ' . (string) \wp_json_encode( $snapshot, \JSON_PRETTY_PRINT | \JSON_UNESCAPED_SLASHES );
	}

	private static function cmd_dump_config( string $glob = '' ): string {
		$glob = \trim( $glob );
		// Arg is a regex glob on node names; malformed pattern matches nothing.
		$out = '';
		foreach ( \array_keys( Core::$nodes_by_name ) as $name ) {
			if ( \in_array( $name, Node_Names::SESSION_SCAFFOLDING, true ) ) {
				continue; // Skip baseline scaffolding.
			}
			if ( '' !== $glob && 1 !== \preg_match( '{' . $glob . '}', $name ) ) {
				continue; // regex-glob filter — skip names not matching.
			}
			// $name from Core::$nodes_by_name keys; lookup always present.
			/** @var \Newspack_Nodes\Node $node Node from the registry. */
			$node = Core::node( $name );
			// Omit patron sidecars; patron's config line recreates them.
			if ( null !== $node->patron() ) {
				continue;
			}
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
	 * @param string $pwd  Requesting session's reverse_cwd (inbound FROM); stamped into `_header` on a full snapshot.
	 * @return array<string,array<string,mixed>>
	 */
	private static function cmd_dump_metadata( string $only = '', string $pwd = '' ): array {
		$out = [];
		/** @var \Newspack_Nodes\Node $node Each registered node. */
		foreach ( Core::$nodes_by_name as $name => $node ) {
			if ( '' !== $only && $name !== $only ) {
				continue;
			}
			// Patron-linked nodes are plumbing; canvas shouldn't render them.
			if ( null !== $node->patron() ) {
				continue;
			}
			$schema = $node::node_schema();
			// @longform Hook-mounted infrastructure has no owner to patron it —
			// the connect-queue timer is shared by every Remote_Link — so a
			// schema saying hidden is the only signal it can give. The palette
			// already honours it; the canvas has to as well.
			if ( true === ( $schema['hidden'] ?? false ) ) {
				continue;
			}
			// SHELL name (GUI key), not class short-name (Echo_Node -> 'Echo').
			$class = self::shell_name_for( $node );
			$sink  = $node->sink();
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
				// Has a `:config` sidecar; GUI must not synthesize it.
				'has_config'    => isset( Core::$nodes_by_name[ "{$name}:config" ] ),
			];
			// Emit when non-empty, matching JS producer (PHP [] vs JS {}).
			$registrations = $node->registered_listeners();
			if ( [] !== $registrations ) {
				$out[ $name ]['registrations'] = $registrations;
			}
			// `+=` so the hook can only add, never clobber a fixed key.
			$extra = $node->dump_metadata();
			if ( [] !== $extra ) {
				$out[ $name ] += $extra;
			}
		}
		// Full-snapshot header: Profiling-toggle truth + reverse_cwd for GUIs.
		if ( '' === $only ) {
			$out['_header'] = [ 'profiling' => null !== Router_Node::profiles() ];
			if ( '' !== $pwd ) {
				$out['_header']['pwd'] = $pwd;
			}
		}
		return $out;
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
	 * `stats [-a] [<regex>]` — tabular per-node counters (NAME, COUNT, LGST_MSG, READ, WRITTEN).
	 *
	 * Scope matches `cmd_list_nodes`: default=siblings, `-a`=all, `<name>`=that sink's children.
	 *
	 * @param list<string> $args
	 */
	private static function cmd_stats( Command_Interpreter_Node $self, array $args ): string {
		$list_matches = false;
		$argv         = [];
		foreach ( $args as $tok ) {
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
			// $name from Core::$nodes_by_name keys; lookup always present.
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
	 * `list_timers` — tabulate the Event_Framework's registered timers. NEXT is ms
	 * until the next fire (<=0 = due every tick, i.e. a spinner); INTERVAL is the
	 * re-arm period; MODE is the scheduling mode ('event_framework' own slot vs
	 * 'router' hitchhike). Modeled on Tachikoma CommandInterpreter's list_ids/list_timers.
	 *
	 * @param  bool $structured Return timer_rows() instead of the text table.
	 * @return string|list<array{id:int,active:bool,interval_ms:int,mode:string,next_ms:int|null,oneshot:bool,fires:int,type:string,name:string}>
	 */
	private static function cmd_list_timers( bool $structured = false ): string|array {
		if ( $structured ) {
			return self::timer_rows();
		}
		$rows = [];
		foreach ( self::timer_rows() as $r ) {
			$rows[] = [
				(string) $r['id'],
				$r['active'] ? 'yes' : 'no',
				(string) $r['interval_ms'],
				$r['mode'],
				null === $r['next_ms'] ? '-' : (string) $r['next_ms'], // inactive/hitchhike -> no own next_fire
				$r['oneshot'] ? 'yes' : 'no',
				(string) $r['fires'],
				$r['type'],
				$r['name'],
			];
		}
		\usort( $rows, static fn ( array $a, array $b ): int => $a[8] <=> $b[8] );
		return self::tabulate(
			[ 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'left' ],
			[ 'ID', 'ACTIVE', 'INTERVAL', 'MODE', 'NEXT', 'ONESHOT', 'FIRES', 'TYPE', 'NAME' ],
			$rows
		);
	}

	/**
	 * `list_handles` — tabulate the Event_Framework's registered cURL multi handles
	 * (the SSE/HTTP egress nodes the drain loop selects on). Analogous to
	 * Tachikoma CommandInterpreter's list_fds.
	 *
	 * @param  bool $structured Return handle_rows() instead of the text table.
	 * @return string|list<array{id:int,count:int,type:string,name:string}>
	 */
	private static function cmd_list_handles( bool $structured = false ): string|array {
		if ( $structured ) {
			return self::handle_rows();
		}
		$rows = [];
		foreach ( self::handle_rows() as $r ) {
			$rows[] = [ (string) $r['id'], (string) $r['count'], $r['type'], $r['name'] ];
		}
		\usort( $rows, static fn ( array $a, array $b ): int => $a[3] <=> $b[3] );
		return self::tabulate(
			[ 'right', 'right', 'right', 'left' ],
			[ 'ID', 'COUNT', 'TYPE', 'NAME' ],
			$rows
		);
	}

	/**
	 * Structured rows for every registered Timer_Node — the one loop the
	 * list_timers table and its `-s` form both build from. `next_ms` is ms until
	 * the next fire, or null when there's no own next_fire (inactive/hitchhike).
	 *
	 * @return list<array{id:int,active:bool,interval_ms:int,mode:string,next_ms:int|null,oneshot:bool,fires:int,type:string,name:string}>
	 */
	private static function timer_rows(): array {
		$rows = [];
		foreach ( Core::$nodes_by_name as $name => $node ) {
			if ( ! $node instanceof Timer_Node ) {
				continue;
			}
			$active  = $node->timer_is_active();
			$next_ms = ( $active && $node->next_fire > 0.0 )
				? (int) \round( ( $node->next_fire - Core::$now ) * 1000 )
				: null;
			$rows[] = [
				'id'          => \spl_object_id( $node ),
				'active'      => $active,
				'interval_ms' => $node->interval_ms,
				'mode'        => $node->timer_mode(),
				'next_ms'     => $next_ms,
				'oneshot'     => $node->oneshot,
				'fires'       => $node->get_fire_count(),
				'type'        => ( new \ReflectionClass( $node ) )->getShortName(),
				'name'        => $name,
			];
		}
		return $rows;
	}

	/**
	 * Structured rows for every registered cURL multi handle — the one loop the
	 * list_handles table and its `-s` form both build from.
	 *
	 * @return list<array{id:int,count:int,type:string,name:string}>
	 */
	private static function handle_rows(): array {
		$rows = [];
		foreach ( Event_Framework::instance()->curl_handles() as $id => $entry ) {
			$node   = $entry['node'];
			$rows[] = [
				'id'    => $id,
				'count' => $entry['counter'],
				'type'  => ( new \ReflectionClass( $node ) )->getShortName(),
				'name'  => Core::as_string( $node->name() ),
			];
		}
		return $rows;
	}

	/**
	 * `profile [on|off]` — toggle or set _router dispatch profiling.
	 *
	 * Bare `profile` toggles (Tachikoma's `debug_state`-precedent); explicit
	 * `on`/`off` is an idempotent set the form scripts + UI use, so a caller
	 * that knows its desired state never races a stale toggle. A deliberate
	 * single-verb divergence from Tachikoma's enable_profiling/disable_profiling
	 * pair; the reply strings are preserved.
	 */
	private static function cmd_profile( string $arg ): string {
		if ( null === Core::node( Node_Names::ROUTER ) ) {
			throw new \RuntimeException( "can't find _router" );
		}
		$on = null !== Router_Node::profiles();
		if ( '' === $arg ) {
			$want = ! $on;
		} elseif ( 'on' === $arg ) {
			$want = true;
		} elseif ( 'off' === $arg ) {
			$want = false;
		} else {
			return "usage: profile [ on | off ]\n";
		}
		if ( $want === $on ) {
			return $want ? "profiling already enabled\n" : "profiling already disabled\n";
		}
		Router_Node::profiles( $want ? [] : null );
		return $want ? "profiling enabled\n" : "profiling disabled\n";
	}

	/**
	 * `list_profiles [glob]` — per-node self-time, slowest average first, with a
	 * --total-- row (Tachikoma CommandInterpreter.pm list_profiles).
	 *
	 * @param  string $glob       Regex filter; `total` shows only --total--.
	 * @param  bool   $structured Return the same rows instead of the text table.
	 * @return string|list<array{avg:float,time:float,count:int,window:float,rate:float,age:int,what:string}>
	 */
	private static function cmd_list_profiles( string $glob, bool $structured = false ): string|array {
		if ( null === Core::node( Node_Names::ROUTER ) ) {
			throw new \RuntimeException( "can't find _router" );
		}
		$start    = Core::right_now();
		$profiles = Router_Node::profiles() ?? [];
		\uasort( $profiles, static fn ( array $a, array $b ): int => $b['avg'] <=> $a['avg'] );

		$matched = [];
		foreach ( $profiles as $key => $info ) {
			if ( '' !== $glob && 'total' !== $glob && 1 !== @\preg_match( '{' . $glob . '}', $key ) ) {
				continue;
			}
			$matched[ $key ] = $info;
		}
		$totals = self::profile_stats( self::profile_total( $matched ), $start );
		$listed = 'total' === $glob ? [] : $matched;

		if ( $structured ) {
			$out = [];
			foreach ( $listed as $key => $info ) {
				$out[] = self::profile_stats( $info, $start ) + [ 'what' => $key ];
			}
			$out[] = $totals + [ 'what' => '--total--' ];
			return $out;
		}

		$rows = [];
		foreach ( $listed as $key => $info ) {
			$rows[] = self::profile_row( self::profile_stats( $info, $start ), $key );
		}
		$rows[] = self::profile_row( $totals, '--total--' );

		return self::tabulate(
			[ 'right', 'right', 'right', 'right', 'right', 'right', 'left' ],
			[ 'AVERAGE', 'TIME', 'COUNT', 'WINDOW', 'RATE', 'AGE', 'WHAT' ],
			$rows
		) . \sprintf( "\nreturned %d profiles in %.4f seconds\n", \count( $listed ), Core::right_now() - $start );
	}

	/**
	 * The seven facts list_profiles prints, from one raw record. Text and -s
	 * render THIS one derivation, so the two can never disagree.
	 *
	 * @param  array{avg:float,time:float,count:int,timestamp:float,oldest:float} $info Raw record.
	 * @return array{avg:float,time:float,count:int,window:float,rate:float,age:int}
	 */
	private static function profile_stats( array $info, float $now ): array {
		$window = $info['timestamp'] - $info['oldest'];
		return [
			'avg'    => $info['avg'],
			'time'   => $info['time'],
			'count'  => $info['count'],
			'window' => $window,
			'rate'   => ( $window > 0.0 && $info['count'] > 1 ) ? $info['count'] / $window : 1.0,
			'age'    => (int) ( $info['timestamp'] > 0.0 ? \max( 0.0, $now - $info['timestamp'] ) : 0 ),
		];
	}

	/**
	 * --total--: summed time/count, widest timestamp..oldest span.
	 *
	 * @param  array<string,array{avg:float,time:float,count:int,timestamp:float,oldest:float}> $infos Raw records.
	 * @return array{avg:float,time:float,count:int,timestamp:float,oldest:float}
	 */
	private static function profile_total( array $infos ): array {
		$time      = 0.0;
		$count     = 0;
		$timestamp = 0.0;
		$oldest    = 0.0;
		foreach ( $infos as $info ) {
			$time      += $info['time'];
			$count     += $info['count'];
			$timestamp  = \max( $timestamp, $info['timestamp'] );
			$oldest     = 0.0 === $oldest ? $info['oldest'] : \min( $oldest, $info['oldest'] );
		}
		return [
			'avg'       => $count > 0 ? $time / $count : 0.0,
			'time'      => $time,
			'count'     => $count,
			'timestamp' => $timestamp,
			'oldest'    => $oldest,
		];
	}

	/**
	 * One list_profiles table row: the shared stats struct, formatted.
	 *
	 * @param  array{avg:float,time:float,count:int,window:float,rate:float,age:int} $r Stats.
	 * @return list<string>
	 */
	private static function profile_row( array $r, string $what ): array {
		return [
			\sprintf( '%.6f', $r['avg'] ),
			\sprintf( '%.2f', $r['time'] ),
			(string) $r['count'],
			\sprintf( '%.2f', $r['window'] ),
			\sprintf( '%.2f', $r['rate'] ),
			(string) $r['age'],
			$what,
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
		// Trailing components zero-pad to 2 digits for steady width.
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
	 * `trace [ <node name> [ <level> ] ]` — toggle or set a node's debug_state level.
	 *
	 * No args toggles this interpreter; numeric arg sets this interpreter; a name targets that node.
	 * Renamed from the `debug_state` verb; the reply strings still report the unchanged property.
	 *
	 * @param list<string> $args
	 */
	private static function cmd_trace( Command_Interpreter_Node $self, array $args ): string {
		[ $first, $second ] = \array_pad( $args, 2, '' );

		if ( '' === $first ) {
			$new = $self->debug_state() > 0 ? 0 : 1;
			$self->debug_state( $new );
			return "_command_interpreter debug_state: $new\n";
		}

		if ( '*' === $first ) {
			$new = '' === $second
				? ( $self->debug_state() > 0 ? 0 : 1 )
				: \max( 0, (int) $second );
			$all_names = \array_keys( Core::$nodes_by_name );
			foreach ( $all_names as $name ) {
				/** @var \Newspack_Nodes\Node $node Node from the registry. */
				$node = Core::node( $name );
				$node->debug_state( $new );
			}
			// Terse summary, not a per-node roster (ls lists them).
			return \sprintf( "debug_state %d on %d nodes\n", $new, \count( $all_names ) );
		}

		if ( \ctype_digit( $first ) && '' === $second ) {
			$self->debug_state( (int) $first );
			return '_command_interpreter debug_state: ' . $self->debug_state() . "\n";
		}

		/** @var \Newspack_Nodes\Node|null $node Node from the registry. */
		$node = Core::node( $first );
		if ( null === $node ) {
			return "unknown node: $first\n";
		}
		$new = '' === $second
			? ( $node->debug_state() > 0 ? 0 : 1 )
			: (int) $second;
		$node->debug_state( $new );
		return "$first debug_state: " . $node->debug_state() . "\n";
	}

	/**
	 * `help` — no args lists all command names tabulated; a topic returns that command's help.
	 *
	 * @param list<string>            $args     Verb arguments.
	 * @param array<array-key, mixed> $envelope The command Message.
	 */
	private static function cmd_help( array $args, array $envelope = [] ): string {
		// Completion: sorted verb names, newline-separated, no help text.
		if ( 'completion' === ( $envelope[ Message::KEY ] ?? '' ) ) {
			// From dispatch table, not help-topic, so aliases offered too.
			$names = \array_keys( self::$C ?? [] );
			\sort( $names );
			return \implode( "\n", $names ) . "\n";
		}
		$topic = ( $args[0] ?? '' );
		if ( '' === $topic ) {
			$names = \array_keys( self::$H ?? [] );
			\sort( $names );
			$rows = \array_chunk( $names, 4 );
			return \implode( "\n", [
				'### COMMANDS ###',
				self::tabulate( [ 'left', 'left', 'left', 'left' ], null, $rows ),
			] );
		}
		// Keep aliases in lockstep with $C entries and Shell builtin dispatch.
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
		// Not a command — maybe a node TYPE: surface its node_schema().
		$fqcn = self::resolve_class( $topic );
		if ( null !== $fqcn ) {
			return Node_Schema_Help::render( $topic, $fqcn::node_schema() );
		}
		return "no such topic: \"$topic\"\n";
	}

	/**
	 * Resolve a shell type token to the first registered concrete Node-subclass FQCN.
	 *
	 * Walks the registered namespace prefixes and returns the first
	 * `{$prefix}{$type}_Node` (or the bare `{$prefix}Node` for the base type)
	 * that exists, is a Node, and is NOT abstract. Abstract matches are skipped so
	 * a concrete `{$type}_Node` under a later-scanned prefix still resolves —
	 * otherwise `make_node` would see the abstract first and return null. Null when
	 * no namespace yields a concrete match.
	 *
	 * @param string $type Shell name (e.g. `Tee`, `Tap`, or the bare `Node`).
	 * @return class-string<Node>|null
	 */
	public static function resolve_class( string $type ): ?string {
		// Cache hits only; a miss resolves after later register_namespace().
		if ( isset( self::$resolve_cache[ $type ] ) ) {
			return self::$resolve_cache[ $type ];
		}
		foreach ( self::registered_namespaces() as $prefix ) {
			// Base Node lacks `_Node`; `make_node Node` resolves directly.
			$fqcn = ( 'Node' === $type ) ? $prefix . 'Node' : $prefix . $type . '_Node';
			if ( \class_exists( $fqcn ) && \is_a( $fqcn, Node::class, true ) && ! ( new \ReflectionClass( $fqcn ) )->isAbstract() ) {
				return self::$resolve_cache[ $type ] = $fqcn;
			}
		}
		return null;
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
	 * Column-aligned table rendering; the last left-aligned column isn't padded.
	 * Public so the substrate's other text-table consumers (Log_Sources' taillog
	 * listing, Node_Schema_Help, Service_CI subclasses) share the ONE renderer
	 * rather than growing copies. Tachikoma keeps tabulate in CI; so do we.
	 *
	 * @param array<int,string>            $dirs   One per column ('left' or 'right').
	 * @param array<int,string>|null       $header Optional header row; null skips it.
	 * @param array<int,array<int,string>> $rows
	 */
	public static function tabulate( array $dirs, ?array $header, array $rows ): string {
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
				// Cells arrive pre-stringified; guard narrows before str_pad.
				$cell = $row[ $col ] ?? '';
				$val  = Core::as_string( $cell );
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
		return $out;
	}

	/**
	 * `reply_to <node path> <command>` — run `<command>` in THIS interpreter but
	 * route its reply to `<node path>` (the inverse of `command_node`, which runs
	 * it AT the path). Mints the sub-command stamped FROM=<path> — interpret()
	 * replies TO=FROM — and re-enters via fill(). The LOCAL taint authorizes the
	 * in-process mint (the `reply_to` command itself already passed the auth gate).
	 * `reply_to` itself returns nothing; the output went to <path>.
	 *
	 * @param list<string> $args
	 */
	private static function cmd_reply_to( Command_Interpreter_Node $self, array $args ): string {
		$path      = $args[0] ?? '';
		$verb      = $args[1] ?? '';
		$verb_args = \array_slice( $args, 2 );
		if ( '' === $path || '' === $verb ) {
			return "usage: reply_to <node path> <command>\n";
		}
		// Refuse nested reply_to: FROM is set raw, so recursion is unbounded.
		if ( 'reply_to' === $verb ) {
			return "reply_to cannot invoke reply_to\n";
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
	 * Naming an interpreter is the moment this process gains a command surface,
	 * so it is the moment the policy becomes something someone has to declare.
	 * Follows Tachikoma's CommandInterpreter::name().
	 */
	public function name( ?string $name = null ): string {
		// Parent splits getter/setter on func_num_args(); null would write.
		if ( 0 === \func_num_args() ) {
			return parent::name();
		}
		if ( null === Core::$secure_level ) {
			Core::$secure_level = 0;
		}
		return parent::name( $name );
	}

	/**
	 * Register a class-namespace prefix for `make_node` resolution. Plugins
	 * call this once at boot (e.g. `register_namespace( 'Newspack_Nodes\\' )`);
	 * `make_node('Tee')` then resolves `Newspack_Nodes\Tee_Node`.
	 */
	public static function register_namespace( string $prefix ): void {
		self::$namespaces[ $prefix ] = true;
	}

	public static function node_schema(): array {
		return [
			'category'     => 'Hidden',
			'description'  => 'Command dispatch — placed implicitly as sibling of patron nodes; not draggable.',
			'arguments'    => [],
			'commands'     => [],
			'accepts_fill' => false,
			'has_target'   => false,
		];
	}
}
