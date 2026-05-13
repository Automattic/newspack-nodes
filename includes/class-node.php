<?php
/**
 * Node: base class for the substrate.
 *
 * Every component that participates in the node-graph runtime extends Node.
 * Subclasses override fill() with their actual behavior; the base class
 * provides forwarding-to-sink as the default.
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

	/**
	 * Largest VALUE size, in bytes, of any message that has flowed through
	 * fill(). Tachikoma-equivalent of `$node->{largest_msg_sent}`; used by
	 * the `stats` verb and the topology console's Inspector to surface
	 * outliers without storing a full histogram.
	 */
	protected int $largest_msg_sent = 0;

	/**
	 * Bytes consumed from / written to backing storage by this node. Only
	 * I/O nodes (Partition, Consumer) populate these; logic nodes (Tee,
	 * Hook, app subclasses) leave them at zero — same shape as Tachikoma's
	 * `$node->{bytes_read}` / `$node->{bytes_written}`.
	 */
	protected int $bytes_read    = 0;
	protected int $bytes_written = 0;

	/**
	 * Cached configuration string set by `arguments()`. Mirrors real Tachikoma's
	 * `$self->{arguments}` slot — `dump_config` round-trips this back into the
	 * `make_node` line so a graph snapshot reproduces the original wiring.
	 */
	protected string $arguments = '';

	/**
	 * @var array<string,array<string,callable|string>> Pre-declared events keyed by event name.
	 */
	protected array $registrations = [];

	/**
	 * Per-node state-tracing dial. Mirrors Perl Tachikoma `Tachikoma::Node`
	 * `$self->{debug_state}`:
	 *
	 *   0 (default) — set_state notifies as usual; no diagnostic emission.
	 *   1+          — set_state additionally emits a TM_STRUCT to
	 *                 `TO=_repl` so cli sessions and the SSE controller both
	 *                 pick up state transitions as they happen. Higher integer
	 *                 levels are reserved for finer-grained tracing per subclass
	 *                 — base Node only differentiates 0 vs not-0.
	 *
	 * Toggled via the `debug_state` CommandInterpreter verb; auto-propagates
	 * from a CI to make_node children (so `debug_state CI 1` followed by
	 * `make_node Foo bar` makes bar inherit the level).
	 */
	protected int $debug_state = 0;

	/**
	 * Sibling CommandInterpreter when this node opts into the
	 * Ruleset pattern (Partition, RequestBuilder, …). Constructors
	 * instantiate it, set its patron pointer back at $this, and
	 * call `commands(static::config_verbs())`. `name()` keeps the
	 * sibling registered at `{patron_name}:config`. Null on
	 * nodes that have no runtime configuration verbs.
	 */
	protected ?CommandInterpreter $interpreter = null;

	/**
	 * Attach a sibling CommandInterpreter. Patron Node ctors call
	 * this after building the sibling so the base class can take
	 * over name propagation; the sibling adopts
	 * `{patron_name}:config` immediately if the patron is already
	 * named, otherwise the next `name()` call propagates.
	 */
	public function attach_interpreter( CommandInterpreter $ci ): void {
		$this->interpreter = $ci;
		if ( '' !== $this->name ) {
			$this->interpreter->name( $this->name . ':config' );
		}
	}

	public function interpreter(): ?CommandInterpreter {
		return $this->interpreter;
	}

	public function debug_state( ?int $level = null ): int {
		if ( null !== $level ) {
			$this->debug_state = \max( 0, $level );
		}
		return $this->debug_state;
	}

	/**
	 * Default: forward the message to the sink, incrementing counter first
	 * (so the message is counted even if the sink throws).
	 *
	 * @param array $message Reference; subclasses may mutate before forwarding.
	 */
	public function fill( array &$message ): void {
		// Mirror real Tachikoma `Node.pm:fill`: if the message has no TO,
		// stamp it from $this->target so subclasses that forward via
		// `parent::fill( $message )` get TO=owner routing for free. Tee
		// overrides this with per-target dispatch in its own fill.
		if ( '' === $message[ Message::TO ] && \is_string( $this->target ) && '' !== $this->target ) {
			$message[ Message::TO ] = $this->target;
		}
		++$this->counter;
		$size = Message::value_size( $message );
		if ( $size > $this->largest_msg_sent ) {
			$this->largest_msg_sent = $size;
		}
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
			// Sibling-CI naming convention: `{patron_name}:config`.
			// Propagates on every rename so editor-driven node
			// renames keep the sibling in lockstep.
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

	/**
	 * Get/set target. String or array (Tee uses array form for fan-out).
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
	 * Get/set the node's argument string. Mirrors real Tachikoma `arguments()`:
	 * `make_node Tail mytail /var/log/foo` → CommandInterpreter calls
	 * `$node->arguments('/var/log/foo')`. Subclasses that take configuration
	 * override this to parse the string and apply it to typed slots.
	 *
	 * Default behavior just stores the string so `dump_config` can round-trip it.
	 */
	public function arguments( ?string $args = null ): string {
		if ( null !== $args ) {
			$this->arguments = $args;
		}
		return $this->arguments;
	}

	public const MAX_FROM_SIZE = 1024;

	/**
	 * Prepend $name to message FROM. Returns false if FROM would exceed MAX_FROM_SIZE.
	 */
	public function stamp_message( array &$message, string $name ): bool {
		if ( '' === $name ) {
			Core::print_less_often( 'ERROR: ' . static::class . ' stamp_message() called with empty name' );
			return false;
		}
		$from = $message[ Message::FROM ];
		$new  = '' === $from ? $name : ( $name . '/' . $from );
		if ( \strlen( $new ) > self::MAX_FROM_SIZE ) {
			Core::print_less_often( 'ERROR: path exceeded ' . self::MAX_FROM_SIZE . " bytes; dropping from: $new" );
			return false;
		}
		$message[ Message::FROM ] = $new;
		return true;
	}

	private const PAYLOAD_TYPES = Message::TM_INFO | Message::TM_REQUEST | Message::TM_ERROR | Message::TM_COMMAND;

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

		// Replay cached state.
		if ( \array_key_exists( $event, $this->set_state ) ) {
			$this->dispatch_listener( $event, $listener, $this->set_state[ $event ] );
		}
	}

	public function unregister( string $event, string $listener ): void {
		unset( $this->registrations[ $event ][ $listener ] );
	}

	/**
	 * Fire the event to all currently-registered listeners.
	 */
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

	/**
	 * Notify + cache. New registrants get the cached payload immediately at register-time.
	 *
	 * When `debug_state` is on, ALSO emit a TM_STRUCT trace message addressed
	 * to `_repl` so cli sessions and the SSE controller both see state transitions
	 * in real time. The trace doesn't replace the normal `notify()` — that still
	 * fires for registered listeners. Trace is purely additive observability.
	 */
	public function set_state( string $event, mixed $payload = null ): void {
		$this->set_state[ $event ] = $payload;
		if ( $this->debug_state > 0 ) {
			$this->emit_debug_state_trace( $event, $payload );
		}
		$this->notify( $event, $payload );
	}

	/**
	 * Build and route a TM_STRUCT trace message for a single state transition.
	 * Addressed to `_repl` — `_router` on the worker side strips `_repl`
	 * before the Partition write, so cli/SSE readers see `TO=""`. Routed via
	 * Core::node('_router') so workers without a wired sink chain still get
	 * the trace through. Safe no-op when `_router` isn't registered (e.g.
	 * unit tests constructing nodes in isolation).
	 */
	private function emit_debug_state_trace( string $event, mixed $payload ): void {
		$router = Core::node( '_router' );
		if ( null === $router ) {
			return;
		}
		$msg                       = Message::new_message();
		$msg[ Message::TYPE ]      = Message::TM_STRUCT;
		$msg[ Message::TIMESTAMP ] = Core::$now;
		$msg[ Message::FROM ]      = $this->name;
		$msg[ Message::TO ]        = '_repl';
		$msg[ Message::VALUE ]     = [
			'k'     => 'debug_state',
			'node'  => $this->name,
			'class' => static::class,
			'event' => $event,
			'value' => $payload,
		];
		$router->fill( $msg );
	}

	/**
	 * Dispatch a single listener by its identity.
	 *
	 * Two dispatch modes: closure or Node-name. Node-name resolves via
	 * Core::node() and forwards a TM_INFO message; closures get invoked
	 * with the payload directly.
	 *
	 * Returns: closure return value (truthy=keep, falsy=unregister) for closures;
	 * always true for node-name dispatch.
	 */
	private function dispatch_listener( string $event, string $listener, mixed $payload ): mixed {
		$cb = $this->registrations[ $event ][ $listener ] ?? null;
		if ( null !== $cb && \is_callable( $cb ) ) {
			// Closure mode.
			return $cb( $payload );
		}
		// Node-name mode: fill TM_INFO into the named node.
		$target = Core::node( $listener );
		if ( null === $target ) {
			Core::print_less_often( "WARNING: $listener forgot to unregister from $event on " . $this->name );
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

	/**
	 * Set or append target. Polymorphic: regular Node sets single string; Tee overrides to append to array.
	 */
	public function connect_node( string $target ): void {
		$this->target = $target;
	}

	public function disconnect_node( string $target = '' ): void {
		$this->target = '';
	}

	/**
	 * Cleanup ordering matters: registrations → sink → target → registry → name (LAST).
	 * Registry-delete-before-name-clear means in-flight Core::node($name) lookups during
	 * teardown correctly return null (so the "forgot to unregister" warning fires) instead
	 * of finding a half-torn-down self.
	 */
	public function remove_node(): void {
		$this->registrations = [];
		$this->set_state     = [];
		$this->sink          = null;
		$this->target        = '';
		if ( '' !== $this->name ) {
			Core::unregister_node( $this->name );
			$this->name = '';
		}
	}

	/**
	 * Round-trippable graph snippet. Emits make_node + (optionally) set_sink + connect_node lines.
	 *
	 * Suppresses set_sink when sink is the default _command_interpreter (matches real Tachikoma
	 * CommandInterpreter.pm:1747-1769).
	 */
	public function dump_config(): string {
		$short = ( new \ReflectionClass( $this ) )->getShortName();
		$out   = "make_node $short {$this->name}";
		if ( '' !== $this->arguments ) {
			$out .= " {$this->arguments}";
		}
		$out .= "\n";

		if ( null !== $this->sink ) {
			$sink_name = $this->sink->name();
			if ( '' !== $sink_name && '_command_interpreter' !== $sink_name ) {
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

		return $out;
	}

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
			$parts[] = 'payload: ' . (string) $message[ Message::VALUE ];
		}

		$line = \implode( ' ', $parts );

		// First-300s NOT_AVAILABLE rule.
		if ( 'NOT_AVAILABLE' === $error && Core::$now < 300.0 ) {
			Core::print_least_often( $line );
			return;
		}
		Core::print_less_often( $line );
	}
}
