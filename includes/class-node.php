<?php
/**
 * Node: base class for the substrate. Subclasses override fill(); the base default forwards to sink.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Node {

	/** Stand-in for a masked credential in diagnostics. */
	public const REDACTED = '<redacted>';

	public const MAX_FROM_SIZE = 1024;

	/** Message types whose payload is included in the drop_message() audit line. */
	private const PAYLOAD_TYPES = Message::TM_INFO | Message::TM_REQUEST | Message::TM_ERROR | Message::TM_COMMAND;

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
		Message::TM_NOREPLY    => 'TM_NOREPLY',
		Message::TM_UNTYPED    => 'TM_UNTYPED',
	];

	/** @var list<string> Constructor argument tokens (Tachikoma's raw `arguments`). */
	protected array $arguments = [];

	/** Only I/O nodes (Partition, Consumer) populate these; logic nodes stay at zero. */
	protected int $bytes_read    = 0;
	protected int $bytes_written = 0;

	protected int $counter = 0;

	/** Per-node state-tracing dial: 0 = quiet, 1+ = also emit TM_STRUCT to _repl. */
	protected int $debug_state = 0;

	/** Sibling CommandInterpreter (`:config`) for nodes with runtime config verbs; else null. */
	protected ?Command_Interpreter_Node $interpreter = null;

	protected int $largest_msg_sent = 0;

	protected string $name = '';

	/** Non-null marks this node as plumbing for the patron; dump_metadata hides it from the canvas. */
	protected ?Node $patron = null;

	/**
	 * @var array<string,array<string,callable|string|null>> Pre-declared events keyed by event name. Null listener value = Node-name dispatch.
	 */
	protected array $registrations = [];

	/** @var array<string,string> */
	protected array $set_state = [];
	protected ?Node  $sink = null;
	/** @var string|array<int, string> */
	protected $target = '';

	/**
	 * No-op chain anchor: a node only acquires schema-reflection behavior (positional
	 * arg parsing, the `{name}:config` interpreter auto-wire) by `use`-ing the
	 * Schema_Reflection trait and calling its helpers — Node itself carries none.
	 * This empty ctor exists so subclasses can `parent::__construct()` regardless of
	 * what intermediate classes do; node-specific setup lives in the subclass ctor.
	 */
	public function __construct() {
		$this->seed_registrations();
	}

	/**
	 * Get/set the node's raw argument string — the trivial Tachikoma getter/setter
	 * (`if (@_) { $self->{arguments} = shift } return $self->{arguments}`). It does
	 * NOT parse the string. A node that wants positional config calls the
	 * Schema_Reflection trait's parse_schema_args() from its own arguments()
	 * override, then derives — gating both on a non-empty string so a bare
	 * `make_node Foo` assigns nothing and triggers no side-effects.
	 *
	 * @param list<string>|null $args New argument tokens (null = pure getter).
	 * @return list<string> Last-set argument tokens.
	 */
	public function arguments( ?array $args = null ): array {
		if ( null !== $args ) {
			$this->arguments = $args;
		}
		return $this->arguments;
	}

	/**
	 * Default: stamp TO from target if empty, then forward to sink.
	 *
	 * @param array<int, mixed> $message Message reference.
	 */
	public function fill( array $message ): void {
		if ( null === $this->sink ) {
			throw new \RuntimeException( 'fill requires a wired sink' );
		}
		if ( '' === $message[ Message::TO ] && \is_string( $this->target ) && '' !== $this->target ) {
			$message[ Message::TO ] = $this->target;
		}
		++$this->counter;
		$this->sink->fill( $message );
	}

	public function name( ?string $name = null ): string {
		if ( \func_num_args() > 0 ) {
			if ( ! Core::has_value( $name ) ) {
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
		$from = Core::as_string( $message[ Message::FROM ] );
		$new  = '' === $from ? $name : ( $name . '/' . $from );
		if ( \strlen( $new ) > self::MAX_FROM_SIZE ) {
			$this->print_less_often( 'ERROR: path exceeded ' . self::MAX_FROM_SIZE . ' bytes; dropping from: ', $new );
			return false;
		}
		$message[ Message::FROM ] = $new;
		return true;
	}

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
		// null means "Node-name dispatch".
		$this->registrations[ $event ][ $listener ] = $cb;

		if ( \array_key_exists( $event, $this->set_state ) ) {
			$this->_notify_registered( $event, $listener, $this->set_state[ $event ] );
		}
	}

	/**
	  * Notify + cache so new registrants get the payload at register-time.
	  * With debug_state on, emit a flat Tachikoma-style `DEBUG: <event> <payload>`
	  */
	protected function set_state( string $event, string $payload = '' ): void {
		$this->set_state[ $event ] = $payload;
		if ( $this->debug_state > 0 ) {
			$router = Core::node( Node_Names::ROUTER );
			if ( null !== $router ) {
				$detail = Core::as_string( $payload );
				$this->stderr( 'DEBUG: ' . $event . ( '' !== $detail ? ' ' . $detail : '' ) );
			}
		}
		$this->notify( $event, $payload );
	}

	/** Fire the event to all currently-registered listeners. */
	public function notify( string $event, mixed $payload = '' ): void {
		if ( ! isset( $this->registrations[ $event ] ) ) {
			return;
		}
		foreach ( $this->registrations[ $event ] as $listener => $cb ) {
			$keep = $this->_notify_registered( $event, $listener, $payload );
			if ( false === $keep ) {
				unset( $this->registrations[ $event ][ $listener ] );
			}
		}
	}

	/** Dispatch a single listener: closure (return value gates keep/unregister) or Node-name (TM_INFO). */
	private function _notify_registered( string $event, string $listener, mixed $payload ): mixed {
		$cb = $this->registrations[ $event ][ $listener ] ?? null;
		if ( null !== $cb && \is_callable( $cb ) ) {
			return $cb( $payload );
		}
		$target = Core::node( $listener );
		if ( null === $target ) {
			$this->print_less_often( "WARNING: $listener forgot to unregister from $event on " . $this->name );
			return false; // Drop the dead registration.
		}
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_INFO;
		$message[ Message::FROM ]  = $this->name;
		$message[ Message::KEY ]   = $event;
		// Never null — TM_INFO VALUEs are strings.
		$message[ Message::VALUE ] = $payload ?? '';
		$target->fill( $message );
		return true;
	}

	/**
	 * Drop a message with an audit trail.
	 *
	 * @param array<int, mixed> $message Message reference.
	 */
	public function drop_message( array $message, string $error ): void {
		$type_raw = $message[ Message::TYPE ];
		$type     = Core::num_int( $type_raw );
		$labels   = [];
		foreach ( self::$type_names as $bit => $label ) {
			if ( $type & $bit ) {
				$labels[] = $label;
			}
		}
		$type_str = empty( $labels ) ? 'TYPE_UNKNOWN' : \implode( '|', $labels );

		// NOT_AVAILABLE keeps no "WARNING:" prefix (matches Perl drop_message).
		$prefix   = 'NOT_AVAILABLE' === $error ? "$error - " : "WARNING: $error - ";
		$parts    = [ "$prefix$type_str" ];
		$from     = Core::as_string( $message[ Message::FROM ] );
		if ( '' !== $from ) {
			$parts[] = 'from: ' . $from;
		}
		$to = Core::as_string( $message[ Message::TO ] );
		if ( '' !== $to ) {
			$parts[] = 'to: ' . $to;
		}
		$value = $message[ Message::VALUE ];
		if ( ( $type & self::PAYLOAD_TYPES ) && '' !== $value ) {
			// @longform json-encode array VALUEs, substituting bad bytes: this
			// line IS the drop diagnostic, so a blank payload hides the cause.
			$redacted  = self::redact_secrets( $value );
			$value_str = \is_array( $redacted )
				? (string) \wp_json_encode( $redacted, \JSON_UNESCAPED_SLASHES | \JSON_INVALID_UTF8_SUBSTITUTE )
				: Core::as_string( $redacted );
			$parts[] = 'payload: ' . $value_str;
		}

		// Key on $parts[0] (stable category); tail prints once, unkeyed.
		$head = \array_shift( $parts );
		$tail = empty( $parts ) ? '' : ' ' . \implode( ' ', $parts );
		$this->print_less_often( $head, $tail );
	}

	/**
	 * Mask credentials in a dropped message's VALUE, by the same rule
	 * `dump_node()` uses — `Core::is_secret_property()`. Two shapes carry them:
	 * a secret-named array key, and a `--auth_password=…` argument token, which
	 * is how the Vault admin UI sends them. The key survives; only the value
	 * goes, because the drop line is a diagnostic.
	 *
	 * @param mixed $value Message VALUE, any depth.
	 * @return mixed The same shape with secrets masked.
	 */
	private static function redact_secrets( $value ) {
		if ( \is_array( $value ) ) {
			$out = [];
			foreach ( $value as $key => $item ) {
				$out[ $key ] = \is_string( $key ) && Core::is_secret_property( $key )
					? self::REDACTED
					: self::redact_secrets( $item );
			}
			return $out;
		}
		if ( \is_string( $value ) && \str_starts_with( $value, '--' ) ) {
			$eq = \strpos( $value, '=' );
			if ( false !== $eq && Core::is_secret_property( \substr( $value, 2, $eq - 2 ) ) ) {
				return \substr( $value, 0, $eq + 1 ) . self::REDACTED;
			}
		}
		return $value;
	}

	/**
	 * Emit a stderr line tagged with this node's midfix, via Core's stderr
	 * pipeline (which adds the process-identity midfix and timestamp prefix once).
	 * Empty text is a no-op (Tachikoma Node::stderr).
	 */
	public function stderr( string $text ): void {
		if ( '' === $text ) {
			return;
		}
		Core::stderr( $this->log_midfix( $text ) );
	}

	/** Emit text on first sight; suppress identical text thereafter. Keyed per-node via log_midfix (shares Core::$recent_log_timers). */
	public function print_less_often( string $text, string ...$extra ): void {
		// Key on $text only; $extra is printed payload, not keyed.
		$key = $this->log_midfix( $text );
		$timestamp = Core::$recent_log_timers[ $key ] ?? null;
		if ( null === $timestamp ) {
			Core::stderr( $this->log_midfix( $text . \implode( '', $extra ) ) );
			Core::$recent_log_timers[ $key ] = Core::$now;
		}
	}

	/**
	 * Per-node mid-line tag: "<name>: " prepended to every line. Empty when
	 * the node is unnamed, or when the process identity ($0 / Core::argv0())
	 * already starts with the node name (so the tag would be redundant). With
	 * text, chomps a trailing newline, prepends the tag to every line,
	 * and appends one trailing newline.
	 */
	public function log_midfix( ?string $text = null ): string {
		$midfix = '';
		if ( '' !== $this->name
			&& 1 !== \preg_match( '/^' . \preg_quote( $this->name, '/' ) . '\b/', Core::argv0() ) ) {
			$midfix = $this->name . ': ';
		}
		if ( null === $text ) {
			return $midfix;
		}
		$text = \rtrim( $text, "\n" );
		$text = $midfix . \str_replace( "\n", "\n" . $midfix, $text );
		return $text . "\n";
	}

	/**
	 * Seed the runtime registration allow-list from node_schema()['registrations']
	 * — the single source of valid events. A registration-capable node calls this
	 * in its constructor instead of hand-assigning $this->registrations.
	 */
	protected function seed_registrations(): void {
		$events = static::node_schema()['registrations'] ?? [];
		if ( ! \is_array( $events ) ) {
			return;
		}
		foreach ( $events as $event ) {
			if ( \is_string( $event ) ) {
				$this->registrations[ $event ] = [];
			}
		}
	}

	/** Round-trippable graph snippet: make_node + optional set_sink + connect_node lines (suppresses set_sink for the default _command_interpreter). */
	public function dump_config(): string {
		$short = Command_Interpreter_Node::shell_name_for( $this );
		$out   = "make_node $short {$this->name}";
		if ( ! empty( $this->arguments ) ) {
			$out .= ' ' . self::serialize_args( $this->arguments );
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

		// Verb-configured nodes override dump_config() to emit their own lines.
		return $out;
	}

	/**
	 * Serialize argument tokens back to a single line, single-quoting any token
	 * that contains whitespace so it re-parses as one token (mirrors the JS
	 * serializeArg + the Shell's quote-aware tokenizer). The one place tokens
	 * are re-joined — every other layer carries them as a list.
	 *
	 * `<` is a metachar here for a reason that is not about tokenizing: a
	 * stored argument may hold an UNEXPANDED `<…>`, which is what the deferred
	 * idiom (`<config:logs_dir>/jobs.p'<partition>'`) hands a node. Emitted
	 * bare it would be expanded on the next load, because `interpolate()` runs
	 * before `tokenize()` — so quoting is what preserves the deferral.
	 *
	 * @param list<string> $tokens
	 */
	public static function serialize_args( array $tokens ): string {
		return \implode(
			' ',
			\array_map(
				static function ( string $t ): string {
					// Quote empty or any metachar; `#`/`;` end the LINE.
					if ( '' !== $t && ! \preg_match( '/[\s\'"`\\\\#;<]/', $t ) ) {
						return $t;
					}
					return "'" . \str_replace( [ '\\', "'" ], [ '\\\\', "\\'" ], $t ) . "'";
				},
				$tokens
			)
		);
	}

	/** Patron getter/setter. */
	public function patron( ?Node $node = null ): ?Node {
		if ( null !== $node ) {
			$this->patron = $node;
			// Sidecar needs no `{name}:config`; drop auto-wired interpreter.
			if ( null !== $this->interpreter ) {
				if ( '' !== $this->interpreter->name() ) {
					$this->interpreter->remove_node();
				}
				$this->interpreter = null;
			}
		}
		return $this->patron;
	}

	public function debug_state( ?int $level = null ): int {
		if ( null !== $level ) {
			$this->debug_state = \max( 0, $level );
		}
		return $this->debug_state;
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

	public function unregister( string $event, string $listener ): void {
		unset( $this->registrations[ $event ][ $listener ] );
	}

	/**
	 * Return a value from the set_state cache. Returns null if the event has never been set.
	 * @param string $event Event name.
	 * @return string|null
	 */
	public function get_state( string $event ): ?string {
		return $this->set_state[ $event ] ?? null;
	}

	/**
	 * Node-name listeners (null-callback registrations) keyed by event; closures excluded, empty events omitted. For dump_metadata registration edges.
	 *
	 * @return array<string, list<string>> Event name => listener Node names.
	 */
	public function registered_listeners(): array {
		$out = [];
		foreach ( $this->registrations as $event => $listeners ) {
			$names = [];
			foreach ( $listeners as $listener => $cb ) {
				if ( null === $cb ) {
					$names[] = $listener;
				}
			}
			if ( [] !== $names ) {
				$out[ $event ] = $names;
			}
		}
		return $out;
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
		// Cascade-unregister sibling interpreter so a rename can't collide.
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
	 * Snapshot of this node's state for the REPL `dump_node` verb. Secret-named
	 * properties are redacted for every node (see SECRET_NAME_PATTERNS).
	 *
	 * @return array<string, mixed>
	 */
	public function dump_node(): array {
		$ref      = new \ReflectionObject( $this );
		$snapshot = [];
		foreach ( $ref->getProperties() as $prop ) {
			$key   = $prop->getName();
			if ( $prop->isInitialized( $this ) ) {
				$value = $prop->getValue( $this );
			} else {
				$value = 'null';
			}
			if ( 'sink' === $key && $value instanceof Node ) {
				$value = $value->name();
			}
			// Redact a non-empty credential; an empty one stays visible.
			if ( Core::is_secret_property( $key )
				&& ( ( \is_string( $value ) && '' !== $value ) || ( \is_array( $value ) && [] !== $value ) ) ) {
				$value = '[REDACTED]';
			}
			if ( \is_object( $value ) ) {
				$value = '(' . \get_class( $value ) . ')';
			}
			// Resources aren't JSON-encodable; coerce so encode won't fail.
			if ( \is_resource( $value ) ) {
				$value = '(resource:' . \get_resource_type( $value ) . ')';
			}
			$snapshot[ $key ] = $value;
		}
		// Subclass-aware class name; cmd_dump_node surfaces it as dump header.
		$snapshot['class'] = $ref->getShortName();
		return $snapshot;
	}

	/**
	 * Hook for a node to contribute extra fields into its dump_metadata row. The
	 * interpreter merges the return with `+=`, so the fixed dump_metadata keys win
	 * and the hook can only add. Base returns nothing.
	 *
	 * @return array<string, mixed>
	 */
	public function dump_metadata(): array {
		return [];
	}

	/**
	 * Topology console manifest: palette entry + node configuration form. Subclasses override to declare ctor params, verbs, category, description.
	 *
	 * @return array<string, mixed>
	 */
	public static function node_schema(): array {
		return [
			'category'      => '',
			'description'   => '',
			'arguments'     => [],
			'commands'      => [],
			'registrations' => [],
			'accepts_fill'  => true,
			'has_target'    => true,
		];
	}
}
