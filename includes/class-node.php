<?php
/**
 * Node: base class for the substrate. Subclasses override fill(); the base default forwards to sink.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Node {
	protected string $name = '';
	protected ?Node  $sink = null;
	/** @var string|array<string> */
	protected $target = '';

	protected int $counter = 0;

	protected int $largest_msg_sent = 0;

	/** Only I/O nodes (Partition, Consumer) populate these; logic nodes stay at zero. */
	protected int $bytes_read    = 0;
	protected int $bytes_written = 0;

	/** Cached config string; dump_config round-trips it back into the make_node line. */
	protected string $arguments = '';

	/**
	 * @var array<string,array<string,callable|string|null>> Pre-declared events keyed by event name. Null listener value = Node-name dispatch.
	 */
	protected array $registrations = [];

	/** Per-node state-tracing dial: 0 = quiet, 1+ = also emit TM_STRUCT to _repl. */
	protected int $debug_state = 0;

	/** Sibling CommandInterpreter (`:config`) for nodes with runtime config verbs; else null. */
	protected ?Command_Interpreter_Node $interpreter = null;

	/** Non-null marks this node as plumbing for the patron; dump_metadata hides it from the canvas. */
	protected ?Node $patron = null;

	/**
	 * Auto-wire the sibling `:config` interpreter from the concrete subclass's node_schema().
	 * A node declares its runtime config verbs ONCE — in `node_schema()['commands']`,
	 * each carrying a `handler` — and the base ctor builds the `{node}:config`
	 * interpreter from the handler-bearing entries (late static binding reads the subclass
	 * schema). No verbs with handlers → no sibling. A interpreter dispatches its own verbs,
	 * so it never gets one (and Command_Interpreter_Node / Service_CI_Node build
	 * their own table in their own ctors). Subclasses with a constructor of their
	 * own must call `parent::__construct()` (PHP doesn't auto-chain); set props
	 * first if the handler closures capture them.
	 */
	public function __construct() {
		if ( $this instanceof Command_Interpreter_Node ) {
			return;
		}
		// Idempotent: a subclass that chains parent::__construct() more than once,
		// or one that manually attached its own interpreter, keeps the existing interpreter.
		if ( null !== $this->interpreter ) {
			return;
		}
		$verbs = self::verbs_with_handlers( static::node_schema() );
		if ( empty( $verbs ) ) {
			return;
		}
		$interpreter = new Command_Interpreter_Node();
		$interpreter->patron( $this );
		$interpreter->commands( $verbs );
		$this->attach_interpreter( $interpreter );
	}

	/**
	 * Collect the node_schema verbs[] that carry a callable handler — the
	 * `{node}:config` dispatch table. Silent: catalog-only verbs (no handler)
	 * are skipped, not flagged, because a plain node legitimately declares
	 * description-only verbs for the palette. (Service_CI_Node, where every verb
	 * MUST dispatch, keeps its own warn-on-missing-handler builder.)
	 *
	 * @param array<string,mixed> $schema
	 * @return array<string,callable>
	 */
	private static function verbs_with_handlers( array $schema ): array {
		$table    = [];
		$commands = $schema['commands'] ?? [];
		if ( ! \is_array( $commands ) ) {
			return $table;
		}
		foreach ( $commands as $verb ) {
			if ( ! \is_array( $verb ) ) {
				continue;
			}
			$name_raw = $verb['name'] ?? '';
			$name     = \is_scalar( $name_raw ) ? (string) $name_raw : '';
			if ( '' === $name || ! isset( $verb['handler'] ) || ! \is_callable( $verb['handler'] ) ) {
				continue;
			}
			$table[ $name ] = $verb['handler'];
		}
		return $table;
	}

	/** Attach a sibling CommandInterpreter, adopting `{patron_name}:config`. */
	public function attach_interpreter( Command_Interpreter_Node $interpreter ): void {
		$this->interpreter = $interpreter;
		if ( '' !== $this->name ) {
			$this->interpreter->name( $this->name . ':config' );
		}
	}

	public function interpreter(): ?Command_Interpreter_Node {
		return $this->interpreter;
	}

	/** Patron getter/setter. */
	public function patron( ?Node $node = null ): ?Node {
		if ( null !== $node ) {
			$this->patron = $node;
		}
		return $this->patron;
	}

	public function debug_state( ?int $level = null ): int {
		if ( null !== $level ) {
			$this->debug_state = \max( 0, $level );
		}
		return $this->debug_state;
	}

	/**
	 * Default: stamp TO from target if empty, then forward to sink.
	 *
	 * @param array<int, mixed> $message Message reference.
	 */
	public function fill( array &$message ): void {
		if ( '' === $message[ Message::TO ] && \is_string( $this->target ) && '' !== $this->target ) {
			$message[ Message::TO ] = $this->target;
		}
		++$this->counter;
		$this->sink?->fill( $message );
	}

	/**
	 * Perl length()-style presence: false for null and '', true for '0'.
	 *
	 * @phpstan-assert-if-true non-empty-string $s
	 */
	protected static function has_value( ?string $s ): bool {
		return null !== $s && '' !== $s;
	}

	public function name( ?string $name = null ): string {
		if ( \func_num_args() > 0 ) {
			// A node is committed to a name once set: name(null)/name('') is not
			// an unregister path — use remove_node() for that. This also turns the
			// classic getter-passthrough mistake (an override doing
			// `parent::name( $name )` with a null default) into a loud failure
			// instead of a silent unregister.
			if ( ! self::has_value( $name ) ) {
				throw new \RuntimeException( 'name() requires a non-empty name; use remove_node() to unregister' );
			}
			if ( $name === $this->name ) {
				return $this->name;
			}
			$this->check_name_availability( $name );
			if ( '' !== $this->name ) {
				Core::unregister_node( $this->name );
			}
			$this->name = $name;
			Core::register_node( $name, $this );
			$this->set_sibling_names( $name );
		}
		return $this->name;
	}

	protected function check_name_availability( string $name ): void {
		if ( Core::node( $name ) !== null ) {
			throw new \RuntimeException( \esc_html( "node name collision: {$name} already registered" ) );
		}
		if ( null !== $this->interpreter && Core::node( "{$name}:config" ) !== null ) {
			throw new \RuntimeException( \esc_html( "node name collision: {$name}:config already registered" ) );
		}
	}

	/**
	 * Cascade the node's name to owned siblings. Only ever called from name()
	 * with a non-empty $name (name() throws on null/''), so overrides can use
	 * the bare "{$name}:suffix" form without a presence guard. Sibling teardown
	 * lives in remove_node(), not here.
	 */
	protected function set_sibling_names( ?string $name = null ): void {
		$this->interpreter?->name( "{$name}:config" );
	}

	public function sink( ?Node $node = null ): ?Node {
		if ( \func_num_args() > 0 ) {
			$this->sink = $node;
			if ( null !== $this->interpreter ) {
				$this->interpreter->sink( $node );
			}
		}
		return $this->sink;
	}

	/**
	 * Get/set target. String or array (Tee uses array form for fan-out).
	 *
	 * @param string|array<int, string>|null $value New target (null = getter).
	 * @return string|array<int, string>
	 */
	public function target( $value = null ) {
		if ( null !== $value ) {
			$this->target = $value;
		}
		return $this->target;
	}

	public function counter(): int {
		return $this->counter;
	}

	public function largest_msg_sent(): int {
		return $this->largest_msg_sent;
	}

	public function bytes_read(): int {
		return $this->bytes_read;
	}

	public function bytes_written(): int {
		return $this->bytes_written;
	}

	/**
	 * Get/set the node's argument string. The setter ALSO parses the string
	 * against node_schema()['arguments'] and assigns each declared positional
	 * argument to the matching $this->{$name} property. Tokens beyond the
	 * declared positions are ignored; missing optional tokens use their
	 * schema-declared defaults. Mirrors Tachikoma::Node::arguments.
	 *
	 * Subclasses override the whole method when the default schema walk isn't
	 * enough (multi-token args, derived state, validation).
	 *
	 * @param string|null $args New raw arguments string (null = pure getter).
	 * @return string Last-set raw arguments string.
	 */
	public function arguments( ?string $args = null ): string {
		if ( null === $args ) {
			return $this->arguments;
		}
		$this->arguments = $args;
		$schema   = static::node_schema();
		$declared = $schema['arguments'] ?? [];
		if ( ! \is_array( $declared ) || empty( $declared ) || '' === $args ) {
			return $this->arguments;
		}
		$tokens = \preg_split( '/\s+/', \trim( $args ), -1, \PREG_SPLIT_NO_EMPTY );
		foreach ( $declared as $i => $arg_spec ) {
			if ( ! \is_array( $arg_spec ) ) {
				continue;
			}
			$name_raw = $arg_spec['name'] ?? '';
			$name     = \is_scalar( $name_raw ) ? (string) $name_raw : '';
			$type_raw = $arg_spec['type'] ?? 'string';
			$type     = \is_string( $type_raw ) ? $type_raw : 'string';
			if ( '' === $name || ! \property_exists( $this, $name ) ) {
				continue;
			}
			if ( isset( $tokens[ $i ] ) ) {
				$this->{$name} = self::coerce_argument( $tokens[ $i ], $type );
			} elseif ( \array_key_exists( 'default', $arg_spec ) ) {
				$this->{$name} = $arg_spec['default'];
			}
		}
		return $this->arguments;
	}

	/**
	 * Coerce a raw string token to the declared schema type. Unknown types
	 * fall through as string.
	 *
	 * @param string $token Raw token from the arguments string.
	 * @param string $type  Schema-declared type ('string'|'int'|'bool'|'float').
	 * @return mixed
	 */
	private static function coerce_argument( string $token, string $type ): mixed {
		return match ( $type ) {
			'int'   => (int) $token,
			'float' => (float) $token,
			'bool'  => \in_array( \strtolower( $token ), [ '1', 'true', 'yes', 'on' ], true ),
			default => $token,
		};
	}

	/**
	 * Build a TM_COMMAND message envelope. Mirrors Tachikoma::Node::command —
	 * available on every Node so Shell::send_command and overlay callers can
	 * issue commands without hand-building messages.
	 *
	 * @param string $name      Command verb (e.g. 'connect_node').
	 * @param string $arguments Positional argument string (verbs parse it via Command_Args).
	 * @return array<int, mixed> A TM_COMMAND Message (the 7-field positional array).
	 */
	public function command( string $name, string $arguments = '' ): array {
		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_COMMAND;
		$msg[ Message::VALUE ] = [
			'name'      => $name,
			'arguments' => $arguments,
		];
		return $msg;
	}

	public const MAX_FROM_SIZE = 1024;

	/**
	 * Prepend $name to message FROM. Returns false if FROM would exceed MAX_FROM_SIZE.
	 *
	 * @param array<int, mixed> $message Message reference.
	 */
	public function stamp_message( array &$message, string $name ): bool {
		if ( '' === $name ) {
			$this->print_less_often( 'ERROR: ' . static::class . ' stamp_message() called with empty name' );
			return false;
		}
		$from_raw = $message[ Message::FROM ];
		$from     = \is_scalar( $from_raw ) ? (string) $from_raw : '';
		$new      = '' === $from ? $name : ( $name . '/' . $from );
		if ( \strlen( $new ) > self::MAX_FROM_SIZE ) {
			$this->print_less_often( 'ERROR: path exceeded ' . self::MAX_FROM_SIZE . " bytes; dropping from: $new" );
			return false;
		}
		$message[ Message::FROM ] = $new;
		return true;
	}

	/** @var array<string,mixed> */
	protected array $set_state = [];

	/**
	 * Multi-modal listener: store either a closure (with callable) or a Node name string.
	 *
	 * @param string        $event    Must be pre-declared in registrations.
	 * @param string        $listener Identity (closure ID or Node name).
	 * @param callable|null $cb       Closure. If null, $listener is a Node name.
	 */
	public function register( string $event, string $listener, ?callable $cb = null ): void {
		if ( ! isset( $this->registrations[ $event ] ) ) {
			throw new \RuntimeException( \esc_html( "no such event: $event" ) );
		}
		$this->registrations[ $event ][ $listener ] = $cb; // null means "Node-name dispatch".

		if ( \array_key_exists( $event, $this->set_state ) ) {
			$this->dispatch_listener( $event, $listener, $this->set_state[ $event ] );
		}
	}

	public function unregister( string $event, string $listener ): void {
		unset( $this->registrations[ $event ][ $listener ] );
	}

	/** Fire the event to all currently-registered listeners. */
	public function notify( string $event, mixed $payload = null ): void {
		if ( ! isset( $this->registrations[ $event ] ) ) {
			return;
		}
		foreach ( $this->registrations[ $event ] as $listener => $cb ) {
			$keep = $this->dispatch_listener( $event, $listener, $payload );
			if ( false === $keep ) {
				unset( $this->registrations[ $event ][ $listener ] );
			}
		}
	}

	/** Dispatch a single listener: closure (return value gates keep/unregister) or Node-name (TM_INFO). */
	private function dispatch_listener( string $event, string $listener, mixed $payload ): mixed {
		$cb = $this->registrations[ $event ][ $listener ] ?? null;
		if ( null !== $cb && \is_callable( $cb ) ) {
			return $cb( $payload );
		}
		$target = Core::node( $listener );
		if ( null === $target ) {
			$this->print_less_often( "WARNING: $listener forgot to unregister from $event on " . $this->name );
			return false; // Drop the dead registration.
		}
		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_INFO;
		$msg[ Message::FROM ]  = $this->name;
		$msg[ Message::TO ]    = $listener;
		$msg[ Message::KEY ]   = $event;
		$msg[ Message::VALUE ] = $payload;
		$target->fill( $msg );
		return true;
	}

	/** Notify + cache so new registrants get the payload at register-time. Emits a debug trace if enabled. */
	public function set_state( string $event, mixed $payload = null ): void {
		$this->set_state[ $event ] = $payload;
		if ( $this->debug_state > 0 ) {
			$this->emit_debug_state_trace( $event, $payload );
		}
		$this->notify( $event, $payload );
	}

	/** Build and route a TM_STRUCT debug trace to `_repl`. No-op when `_router` isn't registered. */
	private function emit_debug_state_trace( string $event, mixed $payload ): void {
		$router = Core::node( Node_Names::ROUTER );
		if ( null === $router ) {
			return;
		}
		$msg                       = Message::new_message();
		$msg[ Message::TYPE ]      = Message::TM_STRUCT;
		$msg[ Message::TIMESTAMP ] = Core::$now;
		$msg[ Message::FROM ]      = $this->name;
		$msg[ Message::TO ]        = Node_Names::REPL;
		$msg[ Message::VALUE ]     = [
			'k'     => 'debug_state',
			'node'  => $this->name,
			'class' => static::class,
			'event' => $event,
			'value' => $payload,
		];
		$router->fill( $msg );
	}

	/** Set target. Tee overrides to append to its fan-out array. */
	public function connect_node( string $target ): void {
		$this->target = $target;
	}

	public function disconnect_node( string $target = '' ): void {
		$this->target = '';
	}

	/** Teardown. Order matters: name LAST, so in-flight Core::node() lookups see null not a half-torn-down self. */
	public function remove_node(): void {
		$this->registrations = [];
		$this->set_state     = [];
		$this->sink          = null;
		$this->target        = '';
		$this->patron        = null;
		// Cascade-unregister the sibling interpreter so a name-recycle doesn't collide with an orphan.
		if ( null !== $this->interpreter && '' !== $this->interpreter->name() ) {
			Core::unregister_node( $this->interpreter->name() );
		}
		$this->interpreter = null;
		if ( '' !== $this->name ) {
			Core::unregister_node( $this->name );
			$this->name = '';
		}
	}

	/**
	 * Snapshot of this node's state for the REPL `dump_node` verb; subclasses override to redact secrets.
	 *
	 * @return array<string, mixed>
	 */
	public function dump_node(): array {
		$ref      = new \ReflectionObject( $this );
		$snapshot = [];
		foreach ( $ref->getProperties() as $prop ) {
			$prop->setAccessible( true );
			$key   = $prop->getName();
			if ( $prop->isInitialized( $this ) ) {
				$value = $prop->getValue( $this );
			} else {
				$value = 'null';
			}
			if ( 'sink' === $key && $value instanceof Node ) {
				$value = $value->name();
			}
			if ( \is_object( $value ) ) {
				$value = '(' . \get_class( $value ) . ')';
			}
			// Resources aren't JSON-encodable; coerce so json_encode doesn't fail the whole snapshot.
			if ( \is_resource( $value ) ) {
				$value = '(resource:' . \get_resource_type( $value ) . ')';
			}
			$snapshot[ $key ] = $value;
		}
		// The node's own class (subclass-aware via ReflectionObject). cmd_dump_node
		// surfaces this as the dump header; overrides that build their own snapshot
		// should include it too.
		$snapshot['class'] = $ref->getShortName();
		return $snapshot;
	}

	/** Round-trippable graph snippet: make_node + optional set_sink + connect_node lines (suppresses set_sink for the default _command_interpreter). */
	public function dump_config(): string {
		$short = Command_Interpreter_Node::shell_name_for( $this );
		$out   = "make_node $short {$this->name}";
		if ( '' !== $this->arguments ) {
			$out .= " {$this->arguments}";
		}
		$out .= "\n";

		if ( null !== $this->sink ) {
			$sink_name = $this->sink->name();
			if ( '' !== $sink_name && Node_Names::COMMAND_INTERPRETER !== $sink_name ) {
				$out .= "set_sink {$this->name} $sink_name\n";
			}
		}

		if ( \is_array( $this->target ) ) {
			foreach ( $this->target as $owner ) {
				$out .= "connect_node {$this->name} $owner\n";
			}
		} elseif ( '' !== $this->target ) {
			$out .= "connect_node {$this->name} {$this->target}\n";
		}

		// Verb-configured nodes (e.g. Partition) override dump_config() to emit
		// their own `cmd {name}:config <verb>` lines from their STATE — no generic
		// invoked-verb recording.
		return $out;
	}

	/**
	 * Human-readable message-type labels.
	 *
	 * @var array<int, string>
	 */
	private static array $type_names = [
		Message::TM_BYTESTREAM => 'TM_BYTESTREAM',
		Message::TM_EOF        => 'TM_EOF',
		Message::TM_PING       => 'TM_PING',
		Message::TM_COMMAND    => 'TM_COMMAND',
		Message::TM_RESPONSE   => 'TM_RESPONSE',
		Message::TM_ERROR      => 'TM_ERROR',
		Message::TM_INFO       => 'TM_INFO',
		Message::TM_STRUCT     => 'TM_STRUCT',
		Message::TM_REQUEST    => 'TM_REQUEST',
	];

	/** Message types whose payload is included in the drop_message() audit line. */
	private const PAYLOAD_TYPES = Message::TM_INFO | Message::TM_REQUEST | Message::TM_ERROR | Message::TM_COMMAND;

	/**
	 * Drop a message with an audit trail.
	 *
	 * @param array<int, mixed> $message Message reference.
	 */
	public function drop_message( array &$message, string $error ): void {
		$type_raw = $message[ Message::TYPE ];
		$type     = \is_numeric( $type_raw ) ? (int) $type_raw : 0;
		$labels   = [];
		foreach ( self::$type_names as $bit => $label ) {
			if ( $type & $bit ) {
				$labels[] = $label;
			}
		}
		$type_str = empty( $labels ) ? 'unknown' : \implode( '|', $labels );

		// NOT_AVAILABLE keeps no "WARNING:" prefix (matches Perl drop_message).
		$prefix   = 'NOT_AVAILABLE' === $error ? "$error - " : "WARNING: $error - ";
		$parts    = [ "$prefix$type_str" ];
		$from_raw = $message[ Message::FROM ];
		$from     = \is_scalar( $from_raw ) ? (string) $from_raw : '';
		if ( '' !== $from ) {
			$parts[] = 'from: ' . $from;
		}
		$to_raw = $message[ Message::TO ];
		$to     = \is_scalar( $to_raw ) ? (string) $to_raw : '';
		if ( '' !== $to ) {
			$parts[] = 'to: ' . $to;
		}
		$value = $message[ Message::VALUE ];
		if ( ( $type & self::PAYLOAD_TYPES ) && '' !== $value ) {
			// json-encode array VALUEs for the audit line; (string) would emit "Array" and warn.
			$value_str = \is_array( $value )
				? (string) \wp_json_encode( $value, \JSON_UNESCAPED_SLASHES )
				: ( \is_scalar( $value ) ? (string) $value : '' );
			$parts[] = 'payload: ' . $value_str;
		}

		$line = \implode( ' ', $parts );

		if ( 'NOT_AVAILABLE' === $error && Core::$now - Core::$init_time < 300.0 ) {
			$this->print_least_often( $line );
			return;
		}
		$this->print_less_often( $line );
	}

	/**
	 * Per-node mid-line tag (Tachikoma Node::log_midfix): "<name>: " prepended
	 * to every line. Empty when the node is unnamed, or when the process
	 * identity ($0 / Core::argv0()) already starts with the node name (so the
	 * tag would be redundant). With a message, chomps a trailing newline,
	 * prepends the tag to every line, and appends one trailing newline.
	 */
	public function log_midfix( ?string $msg = null ): string {
		$midfix = '';
		if ( '' !== $this->name
			&& 1 !== \preg_match( '/^' . \preg_quote( $this->name, '/' ) . '\b/', Core::argv0() ) ) {
			$midfix = $this->name . ': ';
		}
		if ( null === $msg ) {
			return $midfix;
		}
		$msg = \rtrim( $msg, "\n" );
		$msg = $midfix . \str_replace( "\n", "\n" . $midfix, $msg );
		return $msg . "\n";
	}

	/**
	 * Emit a stderr line tagged with this node's midfix, via Core's stderr
	 * pipeline. Already-dated lines pass through Core verbatim (its
	 * /^\d{4}-\d\d-\d\d/ guard), so the line this method midfixes isn't
	 * double-prefixed. Empty text is a no-op (Tachikoma Node::stderr).
	 */
	public function stderr( string $text ): void {
		if ( '' === $text ) {
			return;
		}
		if ( 1 === \preg_match( '/^\d{4}-\d\d-\d\d/', $text ) ) {
			Core::stderr( $text );
			return;
		}
		Core::stderr( Core::log_prefix( $this->log_midfix( $text ) ) );
	}

	/** Emit text on first sight; suppress identical text thereafter. Keyed per-node via log_midfix (shares Core::$recent_log_timers). */
	public function print_less_often( string $text ): void {
		$key = $this->log_midfix( $text );
		$row = Core::$recent_log_timers[ $key ] ?? null;
		if ( null !== $row ) {
			++$row['count'];
		} else {
			$this->stderr( $text );
			$row = [ 'timestamp' => Core::$now, 'count' => 1, ];
		}
		Core::$recent_log_timers[ $key ] = $row;
	}

	/** Emit once at the 10th identical occurrence; suppress otherwise. Keyed per-node via log_midfix (shares Core::$recent_log_timers). */
	public function print_least_often( string $text ): void {
		$key = $this->log_midfix( $text );
		$row = Core::$recent_log_timers[ $key ] ?? null;
		if ( null !== $row ) {
			++$row['count'];
			if ( 10 === $row['count'] ) {
				$this->stderr( $text );
			}
		} else {
			$row = [ 'timestamp' => Core::$now, 'count' => 1, ];
		}
		Core::$recent_log_timers[ $key ] = $row;
	}

	/**
	 * Topology console manifest: palette entry + node configuration form. Subclasses override to declare ctor params, verbs, category, description.
	 *
	 * @return array<string, mixed>
	 */
	public static function node_schema(): array {
		return [
			'category'     => '',
			'description'  => '',
			'arguments'    => [],
			'commands'     => [],
			'accepts_fill' => true,
			'has_target'   => true,
		];
	}
}
