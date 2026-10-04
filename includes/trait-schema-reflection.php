<?php
/**
 * Schema_Reflection: a node's `node_schema()` IS its configuration surface.
 *
 * A node opting in declares its positional arguments and its runtime verbs once,
 * and this trait reads that one declaration four ways. `parse_schema_args()`
 * assigns the positional tokens onto the declared properties (ADR-11).
 * `auto_wire_interpreter()` builds the sibling `{name}:config` interpreter from
 * the declared commands, and `answer_request()` answers a TM_REQUEST from the
 * declared requests. The `dump_declared()` / `declared_setter()` pair turns a
 * `toggle` or `setter` key into both the verb's handler and its `dump_config()`
 * fragment, so a setting is a declaration rather than the hand-rolled trio —
 * handler, dump fragment, argument parse — each class would otherwise carry.
 *
 * Reflection is the whole of it. Wiring, `fill()` and the rate limiters stay on
 * Node.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

trait Schema_Reflection {

	/**
	 * Read the tokens in force, or assign new ones onto the declared
	 * positionals through `parse_schema_args()` (ADR-11), which applies each
	 * schema `default`, refuses a missing `required` token, and leaves the node
	 * unchanged when it refuses. The tokens are then stored as Node stores them,
	 * so `dump_config()` replays them.
	 *
	 * A node that derives state from its positionals — a cadence to arm, a
	 * handle to open — declares its own `arguments()`, which wins over this one.
	 *
	 * @param list<string>|null $args New argument tokens; null reads.
	 * @return list<string> The tokens now in force.
	 * @throws \InvalidArgumentException When `parse_schema_args()` refuses a token.
	 */
	public function arguments( ?array $args = null ): array {
		if ( null !== $args ) {
			$this->parse_schema_args( $args );
		}
		return parent::arguments( $args );
	}

	/**
	 * Assign each declared positional to the matching `$this->{$name}` property,
	 * coerced to its declared type — the assignment half of Tachikoma's per-node
	 * `arguments()` parsing (ADR-11). `schema_values()` checks every token first,
	 * so a refusal raised while validating the tokens leaves the node's fields
	 * as they were. A node declaring no arguments is a no-op.
	 *
	 * Recording the raw tokens into `$this->arguments` is what makes
	 * `dump_config()` round-trip: it emits the `make_node` line from those tokens,
	 * so a walk that assigned the properties without storing them would replay as
	 * a differently-configured node.
	 *
	 * @param list<string> $args Raw positional argument tokens.
	 * @throws \InvalidArgumentException When `schema_values()` refuses a token.
	 */
	protected function parse_schema_args( array $args ): void {
		if ( [] !== self::declared_arguments() ) {
			$this->assign_schema_args( $args, $this->schema_values( $args ) );
		}
	}

	/**
	 * Assign values `schema_values()` already checked and record the tokens
	 * they came from — the step a node takes itself when it must read a
	 * validated value before anything is assigned.
	 *
	 * @param list<string>        $args   Raw positional argument tokens.
	 * @param array<string,mixed> $values Property => value, from `schema_values()`.
	 */
	protected function assign_schema_args( array $args, array $values ): void {
		foreach ( $values as $name => $value ) {
			$this->{$name} = $value;
		}
		$this->arguments = $args;
	}

	/**
	 * Walk `node_schema()['arguments']` and answer the value each declared
	 * positional would assign, assigning nothing — the one place defaults and
	 * required-argument enforcement live (ADR-11). Tokens beyond the declared
	 * positions are ignored; a missing token takes the arg's schema `default`,
	 * throws when the arg is `required` (so an under-argged `make_node` fails
	 * loudly), and otherwise leaves the property's declaration default standing
	 * by answering no value for it.
	 *
	 * A declared name that is not a real property is refused rather than assigned:
	 * PHP would take the typo as a dynamic property, which nothing then reads.
	 *
	 * @param list<string> $args Raw positional argument tokens.
	 * @return array<string,mixed> Property => value.
	 * @throws \InvalidArgumentException When a spec carries no name, names no
	 *                                   property, a required token is missing, or
	 *                                   a token is not of its declared type.
	 */
	protected function schema_values( array $args ): array {
		$values = [];
		foreach ( self::declared_arguments() as $i => $arg_spec ) {
			if ( ! \is_array( $arg_spec ) ) {
				continue;
			}
			$name     = Core::as_string( $arg_spec['name'] ?? '' );
			$type_raw = $arg_spec['type'] ?? 'string';
			$type     = Core::str( $type_raw, 'string' );
			if ( '' === $name ) {
				throw new \InvalidArgumentException( \esc_html( "Invalid argument specification: missing name at position {$i}" ) );
			}
			// A subclass cannot see its parent's private field until it is set.
			if ( ! \property_exists( $this, $name ) && ! \property_exists( self::class, $name ) ) {
				throw new \InvalidArgumentException( \esc_html( "Invalid argument specification: {$name}" ) );
			}
			$token = $args[ $i ] ?? null;
			if ( Command_Args::unsupplied( $token, $arg_spec ) ) {
				$token = null;
			}
			if ( null !== $token ) {
				$values[ $name ] = $this->coerce_argument( $token, $type, $name );
			} elseif ( \array_key_exists( 'default', $arg_spec ) ) {
				$values[ $name ] = Command_Args::default_of( $arg_spec );
			} elseif ( \array_key_exists( 'required', $arg_spec ) && $arg_spec['required'] ) {
				throw new \InvalidArgumentException( \esc_html( "Missing required argument: {$name}" ) );
			}
		}
		return $values;
	}

	/**
	 * The node's declared positional specs; empty when it declares none or
	 * declares something other than a list.
	 *
	 * @return array<array-key,mixed>
	 */
	private static function declared_arguments(): array {
		$declared = static::node_schema()['arguments'] ?? [];
		return \is_array( $declared ) ? $declared : [];
	}

	/**
	 * Coerce a raw token to the declared schema type through
	 * `Command_Args::typed()`, the one type rule verbs are bound by too; an
	 * unknown type passes through as a string.
	 *
	 * The numeric types REFUSE rather than cast, because 0 is a live value for
	 * every retention knob and every timer cadence: a cast would make a mistyped
	 * token indistinguishable from a disabled rule or a free-spinning own slot.
	 *
	 * @param string $token Raw positional token.
	 * @param string $type  Declared schema type.
	 * @param string $name  Argument name, for the refusal.
	 * @return mixed The token as its declared type.
	 * @throws \InvalidArgumentException When a numeric token is not of its declared type.
	 */
	private function coerce_argument( string $token, string $type, string $name ): mixed {
		return Command_Args::typed( $token, $type )
			?? $this->refuse_argument( "{$name} wants " . Command_Args::wanted( $type ) . ", got '{$token}'" );
	}

	/**
	 * THE refusal a node raises for an argument it will not take, naming itself
	 * the way the make_node line does: class as the shell spells it, then
	 * instance name — a boot with five Partitions says which one.
	 *
	 * It throws rather than returning the exception so that the ONE `throw`
	 * carries its own escaping in plain sight; a caller throwing what this
	 * returned would put an unescaped string at every call site instead.
	 *
	 * @param string $detail What was wrong, in the caller's words.
	 * @throws \InvalidArgumentException Always — the caller does not continue.
	 */
	protected function refuse_argument( string $detail ): never {
		$who = Command_Interpreter_Node::shell_name_for( $this );
		if ( '' !== $this->name ) {
			$who .= " '{$this->name}'";
		}
		throw new \InvalidArgumentException( \esc_html( "Bad arguments for {$who}: {$detail}" ) );
	}

	/**
	 * Round-trippable `command_node {name}:config <verb> true` lines for every
	 * schema-declared toggle currently ON — the `dump_config()` half of what a
	 * `toggle` declaration stands for, `declared_setter()` being the handler
	 * half.
	 *
	 * Emits `true`, not `1`: the dump is TSL a person reads, and the arg is
	 * declared `bool`. `Command_Args::typed()` accepts either coming back.
	 *
	 * @return string Zero or more newline-terminated TSL lines.
	 */
	protected function dump_toggles(): string {
		return $this->dump_declared( 'toggle', static fn ( mixed $value ): string => $value ? 'true' : '' );
	}

	/**
	 * Round-trippable `command_node {name}:config <verb> <value>` lines for every
	 * schema-declared setter currently holding one — the string twin of
	 * `dump_toggles()`. An empty setter dumps nothing: replaying its default is
	 * what `make_node` already does.
	 *
	 * @return string Zero or more newline-terminated TSL lines.
	 */
	protected function dump_setters(): string {
		return $this->dump_declared( 'setter', static fn ( mixed $value ): string => Core::as_string( $value ?? '' ) );
	}

	/**
	 * The one walk both dumps make: every verb declaring $schema_key names a
	 * property, and $render turns that property's value into the argument to
	 * emit — '' meaning nothing to say, so the line is skipped. A verb declaring
	 * `dump => false` is skipped outright, for a setting another dump path owns.
	 *
	 * @param string                 $schema_key Verb declaration key naming the property.
	 * @param callable(mixed):string $render     Property value to emitted argument.
	 * @return string Zero or more newline-terminated TSL lines.
	 */
	private function dump_declared( string $schema_key, callable $render ): string {
		$out = '';
		foreach ( Command_Interpreter_Node::declared_verbs( static::class ) as $name => $verb ) {
			if ( ! ( $verb['dump'] ?? true ) ) {
				continue;
			}
			$prop = Core::as_string( $verb[ $schema_key ] ?? '' );
			if ( '' === $prop ) {
				continue;
			}
			$value = $render( $this->{$prop} ?? null );
			if ( '' !== $value ) {
				$out .= $this->config_line( $name, $value );
			}
		}
		return $out;
	}

	/**
	 * Auto-wire the sibling `{name}:config` interpreter from
	 * `node_schema()['commands']` and publish it, which is what enrols it in the
	 * rename, sink and teardown cascades. A consuming node calls this from its own
	 * constructor — Node carries none of this trait's behavior.
	 *
	 * No-op for a Command_Interpreter itself; the rest of the guard lives in
	 * `wire_interpreter()`.
	 */
	protected function auto_wire_interpreter(): void {
		if ( $this instanceof Command_Interpreter_Node ) {
			return;
		}
		$this->wire_interpreter( self::verbs_with_handlers( static::class ) );
	}

	/**
	 * Build a `{name}:config` interpreter from an already-resolved verb table,
	 * patron it and publish it — the half `auto_wire_interpreter()` shares with a
	 * builder that assembles its own verb table rather than reading it straight
	 * off `node_schema()`. No-op for a node that already attached its own
	 * interpreter (so a second call is idempotent) and for an empty verb table.
	 *
	 * @param array<string,callable> $verbs Verb name => handler.
	 */
	protected function wire_interpreter( array $verbs ): void {
		if ( null !== $this->interpreter || [] === $verbs ) {
			return;
		}
		$interpreter = new Command_Interpreter_Node();
		$interpreter->patron( $this );
		$interpreter->commands( $verbs );
		$this->interpreter = $interpreter;
		$this->publish_sibling( 'config', $interpreter );
	}

	/**
	 * Answer a TM_REQUEST from `node_schema()['requests']` — the request-side
	 * twin of `auto_wire_interpreter()`. A node's `fill()` calls this first and
	 * returns when it answers true, so the node itself never tests the flag.
	 *
	 * The verb is VALUE's first space-separated word, upper-cased. The entry of
	 * that name carrying a callable `handler` — `callable( static $node ): array`
	 * — supplies the reply's `data`, and the reply is TM_STRUCT|TM_RESPONSE,
	 * VALUE `{ verb, data }`. Any other verb, a catalog-only entry included, is
	 * refused on the error plane, as Tachikoma's Partition refuses a request
	 * and as the interpreter refuses a command: TM_ERROR, VALUE
	 * `unknown request verb: <VERB>` with one terminating newline.
	 *
	 * Either reply goes from this node TO the request's FROM, with ID and KEY
	 * echoed: the address is the whole correlation, so the asker keeps no
	 * registry of outstanding requests (ADR-7).
	 *
	 * @param array<int,mixed> $message Incoming Message.
	 * @return bool True when the message was a TM_REQUEST, now answered.
	 * @throws \RuntimeException When no sink is wired to carry the reply.
	 */
	protected function answer_request( array $message ): bool {
		if ( ! ( Core::as_int( $message[ Message::TYPE ] ) & Message::TM_REQUEST ) ) {
			return false;
		}
		$sink  = $this->require_sink();
		$verb  = \strtoupper( \explode( ' ', \trim( Core::as_string( $message[ Message::VALUE ] ) ), 2 )[0] );
		$reply = Message::new_message();
		$reply[ Message::TYPE ]  = Message::TM_ERROR;
		$reply[ Message::VALUE ] = "unknown request verb: {$verb}\n";
		$handler = Command_Interpreter_Node::declared_verbs( static::class, 'requests' )[ $verb ]['handler'] ?? null;
		if ( \is_callable( $handler ) ) {
			$reply[ Message::TYPE ]  = Message::TM_STRUCT | Message::TM_RESPONSE;
			$reply[ Message::VALUE ] = [ 'verb' => $verb, 'data' => $handler( $this ) ];
		}

		$reply[ Message::FROM ] = $this->name;
		$reply[ Message::TO ]   = $message[ Message::FROM ];
		$reply[ Message::ID ]   = $message[ Message::ID ];
		$reply[ Message::KEY ]  = $message[ Message::KEY ];
		$sink->fill( $reply );
		return true;
	}

	/**
	 * Build the `{node}:config` dispatch table from $class's declared verbs.
	 * A verb takes its handler from the first of three declarations it carries: a
	 * `toggle`, then a `setter` — each naming a property `declared_setter()`
	 * synthesizes a handler for — then an explicit callable `handler`.
	 *
	 * A verb carrying none of the three is catalog-only and is skipped silently,
	 * not flagged, because a plain node legitimately declares description-only
	 * verbs for the palette. (Service_CI_Node, where every verb MUST dispatch,
	 * keeps its own warn-on-missing-handler builder.)
	 *
	 * @param class-string<Node> $class Class whose schema declares the verbs.
	 * @return array<string,callable> Verb name => handler.
	 */
	private static function verbs_with_handlers( string $class ): array {
		$table = [];
		foreach ( Command_Interpreter_Node::declared_verbs( $class ) as $name => $verb ) {
			$prop = Core::as_string( $verb['toggle'] ?? '' );
			if ( '' !== $prop ) {
				$table[ $name ] = self::declared_setter( $verb, $prop, static fn ( string $token ): bool => true === Command_Args::typed( $token, 'bool' ) );
				continue;
			}
			$prop = Core::as_string( $verb['setter'] ?? '' );
			if ( '' !== $prop ) {
				// The string twin: trim and assign. An empty arg clears it.
				$table[ $name ] = self::declared_setter( $verb, $prop, \trim( ... ) );
				continue;
			}
			$handler = $verb['handler'] ?? null;
			if ( \is_callable( $handler ) ) {
				$table[ $name ] = $handler;
			}
		}
		return $table;
	}

	/**
	 * Synthesize the handler a `toggle` or `setter` declaration stands for:
	 * read the verb's one declared arg, bound by name, coerce it, then hand it
	 * to the patron's `set_{$prop}()` — the class's own typed entry point, so
	 * the coerced value lands under the property's declared type rather than
	 * beside it.
	 *
	 * The handler refuses a patron of any other class. An interpreter re-pointed
	 * at a foreign node would otherwise call a `set_` method that class never
	 * declared, and the fatal would name the method rather than the mis-wiring.
	 *
	 * @param array<array-key,mixed>  $verb   The verb's schema entry.
	 * @param string                  $prop   Property the verb writes, minus the `set_` prefix.
	 * @param callable(string):mixed  $coerce The bound value, as a string, to the setter's type.
	 * @return callable(Command_Interpreter_Node,array<array-key,mixed>):string The verb handler.
	 * @throws \LogicException When the verb declares no arg to carry the value.
	 */
	private static function declared_setter( array $verb, string $prop, callable $coerce ): callable {
		$arg = Core::as_string( Core::arr( Core::arr( $verb['args'] ?? [] )[0] ?? [] )['name'] ?? '' );
		if ( '' === $arg ) {
			throw new \LogicException( \esc_html( "set_{$prop}: the verb declares no arg to carry its value" ) );
		}
		return static function ( Command_Interpreter_Node $interpreter, array $args ) use ( $prop, $arg, $coerce ): string {
			$patron = $interpreter->patron();
			if ( ! $patron instanceof static ) {
				throw new \RuntimeException(
					\esc_html( "set_{$prop}: not a " . static::class )
				);
			}
			$patron->{"set_{$prop}"}( $coerce( Core::as_string( $args[ $arg ] ?? '' ) ) );
			return "ok\n";
		};
	}
}
