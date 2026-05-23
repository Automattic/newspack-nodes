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
	 * @var array<string,array<string,callable|string>> Pre-declared events keyed by event name.
	 */
	protected array $registrations = [];

	/** Per-node state-tracing dial: 0 = quiet, 1+ = also emit TM_STRUCT to _repl. */
	protected int $debug_state = 0;

	/** Sibling CommandInterpreter (`:config`) for nodes with runtime config verbs; else null. */
	protected ?Command_Interpreter_Node $interpreter = null;

	/** Non-null marks this node as plumbing for the patron; dump_metadata hides it from the canvas. */
	protected ?Node $patron = null;

	/** Attach a sibling CommandInterpreter, adopting `{patron_name}:config`. */
	public function attach_interpreter( Command_Interpreter_Node $ci ): void {
		$this->interpreter = $ci;
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
	 * @param array $message Message reference.
	 */
	public function fill( array &$message ): void {
		if ( '' === $message[ Message::TO ] && \is_string( $this->target ) && '' !== $this->target ) {
			$message[ Message::TO ] = $this->target;
		}
		++$this->counter;
		$this->sink?->fill( $message );
	}

	public function name( ?string $name = null ): string {
		if ( null !== $name ) {
			if ( '' !== $this->name ) {
				Core::unregister_node( $this->name );
			}
			if ( Core::node( $name ) !== null ) {
				throw new \RuntimeException( \esc_html( "node name collision: $name already registered" ) );
			}
			$this->name = $name;
			Core::register_node( $name, $this );
			// Keep the sibling CI named `{name}:config` on every rename.
			if ( null !== $this->interpreter ) {
				$this->interpreter->name( $name . ':config' );
			}
		}
		return $this->name;
	}

	public function sink( ?Node $node = null ): ?Node {
		if ( \func_num_args() > 0 ) {
			$this->sink = $node;
		}
		return $this->sink;
	}

	/** Get/set target. String or array (Tee uses array form for fan-out). */
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

	/** Get/set the node's argument string. Subclasses override to parse it into typed slots. */
	public function arguments( ?string $args = null ): string {
		if ( null !== $args ) {
			$this->arguments = $args;
		}
		return $this->arguments;
	}

	public const MAX_FROM_SIZE = 1024;

	/** Prepend $name to message FROM. Returns false if FROM would exceed MAX_FROM_SIZE. */
	public function stamp_message( array &$message, string $name ): bool {
		if ( '' === $name ) {
			$this->print_less_often( 'ERROR: ' . static::class . ' stamp_message() called with empty name' );
			return false;
		}
		$from = $message[ Message::FROM ];
		$new  = '' === $from ? $name : ( $name . '/' . $from );
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
		// Cascade-unregister the sibling CI so a name-recycle doesn't collide with an orphan.
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

		// One cmd line per recorded sibling-CI verb invocation; the loader replays them.
		foreach ( $this->invoked_verbs as $verb => $args ) {
			$args_suffix = '' === $args ? '' : ' ' . $args;
			$out        .= "cmd {$this->name}:config {$verb}{$args_suffix}\n";
		}

		return $out;
	}

	/**
	 * Recorded sibling-CI verb invocations (verb => args) for dump_config round-trip. Last value wins.
	 *
	 * @var array<string,string>
	 */
	protected array $invoked_verbs = [];

	public function mark_verb_invoked( string $verb, string $args ): void {
		$this->invoked_verbs[ $verb ] = $args;
	}

	/** Human-readable message-type labels. */
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

	/** Drop a message with an audit trail. */
	public function drop_message( array &$message, string $error ): void {
		$type   = $message[ Message::TYPE ];
		$labels = [];
		foreach ( self::$type_names as $bit => $label ) {
			if ( $type & $bit ) {
				$labels[] = $label;
			}
		}
		$type_str = empty( $labels ) ? 'unknown' : \implode( '|', $labels );

		$parts = [ "WARNING: $error - $type_str" ];
		if ( '' !== $message[ Message::FROM ] ) {
			$parts[] = 'from: ' . $message[ Message::FROM ];
		}
		if ( '' !== $message[ Message::TO ] ) {
			$parts[] = 'to: ' . $message[ Message::TO ];
		}
		if ( ( $type & self::PAYLOAD_TYPES ) && '' !== $message[ Message::VALUE ] ) {
			// json-encode array VALUEs for the audit line; (string) would emit "Array" and warn.
			$value     = $message[ Message::VALUE ];
			$value_str = \is_array( $value )
				? (string) \wp_json_encode( $value, \JSON_UNESCAPED_SLASHES )
				: (string) $value;
			$parts[] = 'payload: ' . $value_str;
		}

		$line = \implode( ' ', $parts );

		if ( 'NOT_AVAILABLE' === $error && Core::$now < 300.0 ) {
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

	/** Topology console manifest: palette entry + node configuration form. Subclasses override to declare ctor params, verbs, category, description. */
	public static function node_schema(): array {
		return [
			'category'    => '',
			'description' => '',
			'ctor'        => [],
			'verbs'       => [],
			// Pure-producers override accepts_fill=false; pure-sinks override has_target=false.
			'accepts_fill' => true,
			'has_target'   => true,
		];
	}
}
