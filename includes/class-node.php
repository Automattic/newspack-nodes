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

	/**
	 * The nodes this one built for itself, keyed by the KIND each was built for
	 * — the collision pre-check, the rename, the sink and the teardown all walk
	 * this. Written only by `publish_sibling()` / `retract_sibling()`, so
	 * publishing IS declaring and there is no declaration to forget.
	 *
	 * @var array<string,Node>
	 */
	private array $siblings = [];
	protected ?Node  $sink = null;
	/** @var string|array<int,string> */
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
	 * Get/set the node's raw argument tokens — Tachikoma's plain getter/setter,
	 * which does NOT parse them. A node wanting positional config runs the
	 * tokens through the Schema_Reflection trait's parse_schema_args() from its
	 * own arguments() override, then derives.
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
	 * @param array<int,mixed> $message Message reference.
	 */
	public function fill( array $message ): void {
		$sink = $this->require_sink();
		if ( '' === $message[ Message::TO ] && \is_string( $this->target ) && '' !== $this->target ) {
			$message[ Message::TO ] = $this->target;
		}
		++$this->counter;
		$sink->fill( $message );
	}

	/**
	 * The wired sink, or a loud refusal — a node with no sink cannot emit.
	 *
	 * @throws \RuntimeException When no sink is wired.
	 */
	protected function require_sink(): Node {
		return $this->sink ?? throw new \RuntimeException( 'fill requires a wired sink' );
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
			$this->set_sibling_names();
		}
		return $this->name;
	}

	/**
	 * Pre-check each owned sibling's slot and then the node's own, so a
	 * collision throws before anything is registered. The recursion has to
	 * reach exactly as far as the rename cascade does, since
	 * `set_sibling_names()` calls `$sibling->name()`: stop at the direct slots
	 * and a deeper squat throws from the middle of a half-applied rename.
	 * Siblings rank first because a squatted sibling slot is the harder
	 * collision to diagnose from outside — the patron's own name is right there
	 * in the topology — and the constructor-published `:config` interpreter
	 * ranks LAST despite coming first by insertion order, derived scaffolding
	 * being the least useful collision to report.
	 *
	 * It checks the siblings that EXIST, so it covers a RENAME fully and a lazy
	 * patron's FIRST naming not at all: `make_node` runs `name()` before
	 * `arguments()`, so `Topic_Node` cannot know its partition count that early
	 * and has nothing to check. That collision surfaces a step later, from the
	 * sibling's own `name()`; `make_node` unwinds either way, so only the
	 * timing differs.
	 *
	 * Pre-checking rather than unwinding is sound only because the registry is
	 * a per-process array mutated synchronously (`Core::register_node()`), so
	 * nothing can take a name between the check and the cascade. Give it an
	 * out-of-process source and this becomes TOCTOU and the unwind returns.
	 *
	 * @param string $name Name the node is about to take.
	 * @throws \RuntimeException When the node's or a sibling's slot is taken.
	 */
	protected function check_name_availability( string $name ): void {
		$deferred = $this->siblings['config'] ?? null;
		foreach ( $this->siblings as $kind => $sibling ) {
			if ( $sibling !== $deferred ) {
				$sibling->check_name_availability( "{$name}:{$this->sibling_suffix( $kind )}" );
			}
		}
		$deferred?->check_name_availability( "{$name}:{$this->sibling_suffix( 'config' )}" );
		if ( Core::node( $name ) !== null ) {
			throw new \RuntimeException( \esc_html( "node name collision: {$name} already registered" ) );
		}
	}

	/**
	 * Publish a FINISHED sibling into the slot it was built for, then name it
	 * `{name}:{suffix}`. Publishing is what enrols the sibling in the four
	 * cascades — the collision pre-check, the rename, the sink and teardown —
	 * so a builder that publishes cannot leave one unnamed, unreachable from
	 * the registry, `ls` and `command_node`, and still writing to disk.
	 *
	 * A refused name empties the slot again, so a caller's idempotency guard
	 * rebuilds rather than serving a half-published sibling.
	 *
	 * An OCCUPIED slot is refused rather than overwritten: overwriting strands
	 * the displaced node, still registered and still holding whatever handle it
	 * opened, but reached by no cascade. A publisher that means to REPLACE
	 * empties the slot with `retract_sibling()` first.
	 *
	 * @param string $kind    What the builder built; the slot key.
	 * @param Node   $sibling The finished sibling.
	 * @throws \RuntimeException When the slot is occupied or the name is refused.
	 */
	protected function publish_sibling( string $kind, Node $sibling ): void {
		if ( isset( $this->siblings[ $kind ] ) ) {
			throw new \RuntimeException( \esc_html( "sibling slot occupied: {$kind}; retract_sibling() to replace it" ) );
		}
		$this->siblings[ $kind ] = $sibling;
		try {
			$this->set_sibling_names();
		} catch ( \Throwable $e ) {
			unset( $this->siblings[ $kind ] );
			throw $e;
		}
	}

	/**
	 * Name every owned sibling `{name}:{suffix}`, resolving the suffix from the
	 * slot's stable KIND — the ONE place a sibling's name is spelled, reached
	 * from `name()` on a rename, from `publish_sibling()` on a new slot and
	 * from a schema-arg replay, so a re-keyed suffix cannot leave a sibling
	 * answering to a superseded name. One live exception: `Raw_Logs_CI_Node`
	 * spells `{name}:status` inline for a probe it builds, reads and tears down
	 * inside a single verb call, which no rename can reach. A no-op while the
	 * patron is unnamed, which is what lets a builder publish from a
	 * constructor.
	 */
	protected function set_sibling_names(): void {
		if ( '' === $this->name ) {
			return;
		}
		foreach ( $this->siblings as $kind => $sibling ) {
			$sibling->name( "{$this->name}:{$this->sibling_suffix( $kind )}" );
		}
	}

	/**
	 * Prepend $name to message FROM. Returns false if FROM would exceed MAX_FROM_SIZE.
	 *
	 * @param array<int,mixed> $message Message reference.
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
	 * A node that registers ITSELF by name at another node owes that
	 * registration a move in its own `name()` and a drop in `remove_node()` —
	 * the entry lives in the emitter's table, so nothing here follows a
	 * rename. A closure listener has no self-heal at all: `notify()` keeps
	 * anything that does not return exactly false. `Timer_Node` (the router's
	 * TIMER list) and `Remote_Link_Node` (the fleet's RELOAD) are both this
	 * shape.
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
	 * @param array<int,mixed> $message Message reference.
	 */
	public function drop_message( array $message, string $error ): void {
		$type_raw = $message[ Message::TYPE ];
		$type     = Core::num_int( $type_raw );
		$labels   = Message::type_labels( $type );
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
		return Core::apply_midfix( $midfix, $text );
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
		$out   = self::command_line( 'make_node', $short, $this->name, ...$this->arguments );

		if ( null !== $this->sink ) {
			$sink_name = $this->sink->name();
			if ( '' !== $sink_name && Node_Names::COMMAND_INTERPRETER !== $sink_name ) {
				$out .= self::command_line( 'set_sink', $this->name, $sink_name );
			}
		}

		if ( \is_array( $this->target ) ) {
			foreach ( $this->target as $owner ) {
				$out .= self::command_line( 'connect_node', $this->name, $owner );
			}
		} elseif ( '' !== $this->target ) {
			$out .= self::command_line( 'connect_node', $this->name, $this->target );
		}

		// Verb-configured nodes override dump_config() to emit their own lines.
		return $out;
	}

	/** A `command_node <name>:<config-slot> …` line addressed to this node's own sibling interpreter. */
	protected function config_line( string ...$tokens ): string {
		return self::command_line( 'command_node', $this->sibling_name( 'config' ), ...$tokens );
	}

	/**
	 * One replayable TSL line from its tokens. A command line IS an argv — the
	 * verb, the type, the name and the arguments are all just tokens, so every
	 * one of them goes through the same quoting. `make_node Echo echo foo bar`
	 * reads as if `echo` were the name and `foo bar` the arguments; the command's
	 * actual arguments are all four.
	 */
	public static function command_line( string ...$tokens ): string {
		return self::serialize_args( \array_values( $tokens ) ) . "\n";
	}

	/**
	 * Serialize argument tokens back to a single line. The one place tokens are
	 * re-joined — every other layer carries them as a list.
	 *
	 * @param list<string> $tokens
	 */
	public static function serialize_args( array $tokens ): string {
		return \implode( ' ', \array_map( [ self::class, 'serialize_arg' ], $tokens ) );
	}

	/**
	 * Snapshot of this node's state for the REPL `dump_node` verb. Credentials
	 * are masked by the same one rule the drop audit uses — redact_secrets(),
	 * which reaches a secret nested inside an ordinary property (an
	 * `--auth_password=…` token in $arguments) as well as a secret-named one.
	 *
	 * @return array<string,mixed>
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
			// Mask a non-empty credential whole; an empty one stays visible.
			if ( Core::is_secret_property( $key )
				&& ( ( \is_string( $value ) && '' !== $value ) || ( \is_array( $value ) && [] !== $value ) ) ) {
				$value = self::REDACTED;
			} else {
				$value = self::redact_secrets( $value );
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
	 * Patron getter/setter. Setting one is both the canvas-visibility flag and
	 * the auto-wired interpreter's drop, so it MUST run before name(): a named
	 * node has already registered `{name}:{config-slot}`, and taking a patron
	 * then registers it only to tear it straight down again. Refused rather
	 * than tolerated, because nothing else enforces that order.
	 *
	 * @throws \RuntimeException When the node is already named and wired.
	 */
	public function patron( ?Node $node = null ): ?Node {
		if ( null !== $node ) {
			if ( '' !== $this->name && null !== $this->interpreter ) {
				throw new \RuntimeException(
					\esc_html(
						static::class . '::patron() must be set before name(): '
						. $this->sibling_name( 'config' )
						. ' is registered already and would be torn down.'
					)
				);
			}
			$this->patron = $node;
			// Sidecar needs no `{name}:config`; drop auto-wired interpreter.
			$this->retract_sibling( 'config' );
			$this->interpreter = null;
		}
		return $this->patron;
	}

	/**
	 * Tear the sibling in a slot down and empty the slot — the exact inverse of
	 * `publish_sibling()`, which owns the name as well as the slot. Forgetting
	 * one without unregistering the other is the bug in both directions: a slot
	 * the four cascades still reach re-registers a dead sibling under the new
	 * name, and a name the registry still holds refuses the slot's next
	 * occupant for the life of the process. A no-op on an empty slot.
	 *
	 * @param string $kind The kind the slot was published under.
	 */
	protected function retract_sibling( string $kind ): void {
		( $this->siblings[ $kind ] ?? null )?->remove_node();
		unset( $this->siblings[ $kind ] );
	}

	/**
	 * The name the sibling in $kind's slot answers to. Anything ADDRESSING a
	 * sibling reads it here rather than spelling the suffix again, so a
	 * re-keyed slot cannot leave a message routed at a name nothing holds.
	 *
	 * @param string $kind What the builder built, resolved through `sibling_suffix()`.
	 */
	protected function sibling_name( string $kind ): string {
		return $this->name . ':' . $this->sibling_suffix( $kind );
	}

	/**
	 * The NAME suffix a builder's $kind takes, `{patron}:{suffix}`. A class
	 * re-spelling an inherited sibling's name overrides this one method — the
	 * rename, the collision pre-check and `sibling_name()` all read it here.
	 * The slot KEY stays the kind and never moves, or a re-spelling would
	 * strand the incumbent in a slot the next retract computes past. The suffix
	 * is interpolated, never parsed, so a COMPOUND one is fine:
	 * `Remote_Source_Node` names its sidecars `{remote_partition}:offsetlog`.
	 *
	 * @param string $kind What a builder built — `source`, `offsetlog`, `deadletter`.
	 */
	protected function sibling_suffix( string $kind ): string {
		return $kind;
	}

	/**
	 * Every destination the console draws an edge for: the routing target plus
	 * the declared extras, primary first, de-duplicated and without empties.
	 *
	 * @return list<string>
	 */
	public function display_targets(): array {
		$extras = \array_filter( $this->extra_targets(), static fn ( string $extra ): bool => '' !== $extra );
		return \array_values( \array_unique( [ ...self::target_list( $this->target() ), ...$extras ] ) );
	}

	/**
	 * Get/set target — the ROUTING contract. String or array (Tee uses the
	 * array form for fan-out), so an array answer means this node fans out.
	 *
	 * @param string|array<int,string>|null $value New target (null = getter).
	 * @return string|array<int,string>
	 */
	public function target( $value = null ) {
		if ( null !== $value ) {
			$this->target = $value;
		}
		return $this->target;
	}

	/**
	 * A target value as a list: the array form as-is, a non-empty scalar
	 * wrapped, an unset scalar dropped.
	 *
	 * @param string|array<int,string> $value Scalar or fan-out target.
	 * @return list<string>
	 */
	public static function target_list( $value ): array {
		return \is_array( $value ) ? \array_values( $value ) : ( '' !== $value ? [ $value ] : [] );
	}

	/**
	 * The destinations this node writes to WITHOUT routing through `target` — a
	 * sibling's own target, a partition written straight at flush. The console
	 * draws one edge per entry, so an omitted destination renders disconnected
	 * on the canvas while it fills. Declare the fields; empties and duplicates
	 * are `display_targets()`'s problem, not the declaration's.
	 *
	 * @return list<string>
	 */
	protected function extra_targets(): array {
		return [];
	}

	/**
	 * Quote+escape ONE token so the Shell's tokenizer recovers it exactly.
	 * Mirror of the JS serializeArg; the inverse of tokenize().
	 *
	 * `<` is a metachar here for a reason that is not about tokenizing: a
	 * stored argument may hold an UNEXPANDED `<…>`, which is what the deferred
	 * idiom (`<config:logs_dir>/jobs.p'<partition>'`) hands a node. Emitted
	 * bare it would be expanded on the next load, because `interpolate()` runs
	 * before `tokenize()` — so quoting is what preserves the deferral.
	 */
	public static function serialize_arg( string $token ): string {
		// Quote empty or any metachar; `#`/`;` end the LINE.
		if ( '' !== $token && ! \preg_match( '/[\s\'"`\\\\#;<]/', $token ) ) {
			return $token;
		}
		return "'" . \str_replace( [ '\\', "'" ], [ '\\\\', "\\'" ], $token ) . "'";
	}

	public function debug_state( ?int $level = null ): int {
		if ( null !== $level ) {
			$this->debug_state = \max( 0, $level );
		}
		return $this->debug_state;
	}

	/**
	 * Set/get the sink, cascading a set to every owned sibling so it too sinks
	 * into `_command_interpreter` like any other node (Rule 2c). Without the
	 * cascade a sibling's emits drop on the floor.
	 *
	 * @param Node|null $node New sink; omit the argument entirely to read.
	 * @return Node|null The current sink.
	 */
	public function sink( ?Node $node = null ): ?Node {
		if ( \func_num_args() > 0 ) {
			$this->sink = $node;
			foreach ( $this->siblings as $sibling ) {
				$sibling->sink( $node );
			}
		}
		return $this->sink;
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
	 * @return array<string,list<string>> Event name => listener Node names.
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

	/**
	 * Teardown, cascading a full remove_node() to each owned sibling first so a
	 * same-name respawn cannot collide with a leftover slot.
	 */
	public function remove_node(): void {
		foreach ( $this->siblings as $sibling ) {
			$sibling->remove_node();
		}
		$this->siblings      = [];
		$this->registrations = [];
		$this->set_state     = [];
		$this->sink          = null;
		$this->target        = '';
		$this->patron        = null;
		$this->interpreter   = null;
		if ( '' !== $this->name ) {
			Core::unregister_node( $this->name );
			$this->name = '';
		}
	}

	/**
	 * Hook for a node to contribute extra fields into its dump_metadata row. The
	 * interpreter merges the return with `+=`, so the fixed dump_metadata keys win
	 * and the hook can only add. Base returns nothing.
	 *
	 * @return array<string,mixed>
	 */
	public function dump_metadata(): array {
		return [];
	}

	/**
	 * Topology console manifest: palette entry + node configuration form. Subclasses override to declare ctor params, verbs, category, description.
	 *
	 * @return array<string,mixed>
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
