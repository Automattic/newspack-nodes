<?php
/**
 * Service_CI_Node: the base every substrate and application service interpreter
 * extends.
 *
 * A service interpreter declares each verb ONCE, in `node_schema()`, and this
 * base turns that declaration into a working command surface: a dispatch table
 * derived from the schema, `Capabilities::require()` wrapped around every
 * handler for the role the schema names, and the argument helpers the verbs
 * share (`split_first_token`, `require_valid_name`, `require_option_int`,
 * `slice_verb`). A hand-built verb table beside the schema names every verb
 * twice, and the two drift.
 *
 * The capability wrap is the substrate's single enforcement point for command
 * authorization, so it lives in `commands()` — the one door a table can enter
 * through — rather than in the constructor.
 *
 * The helpers are `protected static` so a verb-table closure reaches them as
 * `self::method()`. `self::` resolves at compile time inside the closure's
 * containing method, so a STATIC closure — which cannot `use ( $this )` —
 * still finds them. No instance method exists; the helpers need none.
 *
 * The file sits beside `class-command-interpreter-node.php` rather than under
 * `includes/rest/` because application interpreters outside REST inherit it
 * too.
 *
 * Service_CI_Node is inheritance-only: it declares no verbs, and `make_node`
 * skips abstract classes while resolving a type against the registered
 * namespace prefixes, so only the concrete `*_CI_Node` subclasses construct.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Schema-derived, capability-gated verb dispatch for service interpreters.
 */
abstract class Service_CI_Node extends Command_Interpreter_Node {

	/**
	 * Derive the dispatch table from the concrete subclass's `node_schema()`, so
	 * each verb is declared ONCE. Late static binding reads the SUBCLASS schema;
	 * `parent::__construct()` reaches `Node`, which seeds the registrations.
	 */
	public function __construct() {
		parent::__construct();
		$this->commands( self::commands_from_schema( static::node_schema() ) );
	}

	/**
	 * Install or read the verb table, wrapping EVERY handler in its capability
	 * check on the way in.
	 *
	 * Gating on install rather than in the constructor is what makes the gate a
	 * property of the class: `commands()` is public and mutating while
	 * `dispatch()` reads the table at call time, so a table installed after
	 * construction — by a subclass, or by anything holding the node — replaces
	 * the gated handlers wholesale, and the verbs then work for everyone with
	 * nothing thrown and nothing logged. This is also where the parent's
	 * ungated `help` injection is caught: seeding a gated `help` first denies
	 * the parent the chance.
	 *
	 * Gating happens on INSTALL only, so a read never stacks a second check.
	 *
	 * @param array<string,callable>|null $table Table to install, or null to read.
	 * @return array<string,callable> The live, gated table.
	 */
	public function commands( ?array $table = null ): array {
		if ( null === $table ) {
			// A read: whatever is stored was gated when it was installed.
			return parent::commands();
		}
		$gated = self::gate_table( $table, static::node_schema() );
		if ( ! isset( $gated['help'] ) ) {
			// Seed our own; the parent would inject an ungated one.
			$gated['help'] = static function ( Command_Interpreter_Node $self, array $args = [], array $envelope = [] ): string {
				self::require_manage_options();
				return $self->default_help();
			};
		}
		return parent::commands( $gated );
	}

	/**
	 * Wrap each handler in `Capabilities::require()` for the role its schema
	 * declares, defaulting to MANAGE, so a verb that declares nothing demands
	 * the strictest role rather than the loosest.
	 *
	 * Roles are read from the same `commands` entries `commands_from_schema()`
	 * takes handlers from, keyed by verb name, so a table installed by hand is
	 * gated at whatever role the schema declares for that name.
	 *
	 * @param array<string,callable> $table  Verb name => handler.
	 * @param array<string,mixed>    $schema The concrete class's node_schema().
	 * @return array<string,callable> The same verbs, each handler gated.
	 */
	private static function gate_table( array $table, array $schema ): array {
		$roles = [];
		$verbs = $schema['commands'] ?? [];
		if ( \is_array( $verbs ) ) {
			foreach ( $verbs as $verb ) {
				if ( \is_array( $verb ) && isset( $verb['name'] ) ) {
					$roles[ Core::as_string( $verb['name'] ) ] = Core::as_string(
						$verb['capability'] ?? Capabilities::MANAGE,
						Capabilities::MANAGE
					);
				}
			}
		}
		$gated = [];
		foreach ( $table as $name => $handler ) {
			$role           = $roles[ $name ] ?? Capabilities::MANAGE;
			$gated[ $name ] = static function ( ...$args ) use ( $handler, $role ) {
				Capabilities::require( $role );
				return $handler( ...$args );
			};
		}
		return $gated;
	}

	/**
	 * Build the dispatch table (verb name => handler) from a `node_schema()`.
	 * Only `commands[]` entries carry handlers; `requests[]` are answered by the
	 * addressed node's own `fill()`, so they contribute no dispatch entry.
	 *
	 * A named verb without a callable handler is a schema bug: it lists in the
	 * catalog and in `help`, then dispatches to nothing ("unknown command") at
	 * runtime. Emit one rate-limited warning naming the verb and the concrete
	 * class, then skip it, so the table holds only verbs that dispatch.
	 * `is_callable` rather than an `instanceof Closure` test is deliberate:
	 * string and array callables dispatch as well as closures do.
	 *
	 * Handlers come out RAW. `commands()` gates every one on the way in, this
	 * table included.
	 *
	 * @param array<string,mixed> $schema The concrete class's node_schema().
	 * @return array<string,callable> Verb name => ungated handler.
	 */
	private static function commands_from_schema( array $schema ): array {
		$table    = [];
		$commands = $schema['commands'] ?? [];
		if ( ! \is_array( $commands ) ) {
			return $table;
		}
		foreach ( $commands as $verb ) {
			if ( ! \is_array( $verb ) ) {
				continue;
			}
			$verb_name = $verb['name'] ?? '';
			$name      = Core::as_string( $verb_name );
			if ( '' === $name ) {
				continue;
			}
			if ( ! isset( $verb['handler'] ) || ! \is_callable( $verb['handler'] ) ) {
				Core::print_less_often(
					'Service_CI: verb "',
					$name,
					'" on ' . static::class . ' has no callable handler; skipping'
				);
				continue;
			}
			$table[ $name ] = $verb['handler'];
		}
		return $table;
	}

	/**
	 * Authorisation gate for the MANAGE role, resolved through the filterable
	 * `Capabilities` map. `Command_Interpreter_Node::interpret()` catches the
	 * throw and wraps it as TM_COMMAND|TM_ERROR.
	 *
	 * @throws \RuntimeException When the current user lacks the manage role.
	 */
	protected static function require_manage_options(): void {
		Capabilities::require( Capabilities::MANAGE );
	}

	/**
	 * Read the name and the structured body of a verb carrying a blob —
	 * `save <name> <tsl…>`, `<name> <positions-json>`.
	 *
	 * The producer hands the whole body, newlines and all, as ONE token, so the
	 * name is the first token and the body the second, with no rest-of-line
	 * splitting to guess at. A lone token yields an empty body.
	 *
	 * @param list<string> $args The verb's argument tokens.
	 * @return array{0:string,1:string} The name and the body.
	 */
	protected static function split_first_token( array $args ): array {
		return [ $args[0] ?? '', $args[1] ?? '' ];
	}

	/**
	 * Build a read-only slice verb from a shape callable, so a CI's slice verbs
	 * are two or three lines sharing one memoized read instead of each
	 * repeating the JSON-encode dance.
	 *
	 * The returned handler carries the verb-handler signature
	 * ( Command_Interpreter_Node, array, array ) — for a Service CI verb the
	 * interpreter IS this node — hands that node to $shape, and JSON-encodes
	 * what comes back. A shape reads the CI's memoized snapshot (for example
	 * `$ci->items()`) and returns the one slice it owns, so slices polled
	 * separately still agree about what they saw. The handler never self-gates:
	 * `commands()` wraps it with the role its schema entry declares.
	 *
	 * @param callable $shape A `function ( Command_Interpreter_Node $ci ): mixed` returning the slice payload.
	 * @return \Closure The verb handler.
	 */
	protected static function slice_verb( callable $shape ): \Closure {
		return static function ( Command_Interpreter_Node $self, array $args = [], array $envelope = [] ) use ( $shape ): string {
			return (string) \wp_json_encode( $shape( $self ) );
		};
	}

	/**
	 * Validate a name token against $pattern and return it unchanged.
	 *
	 * The default `[a-zA-Z0-9_-]+` is the shape `Layouts_CI` and `Topologies_CI`
	 * both require: each writes a file named after the token, so the pattern is
	 * what keeps `../etc/passwd` out of the path. A caller needing a wider
	 * charset passes its own.
	 *
	 * @param string $name    Name token — the verb's first argument ($args[0]).
	 * @param string $pattern Regex with delimiters; defaults to the file-name-safe shape.
	 * @return string The validated name.
	 * @throws \RuntimeException When $name does not match $pattern.
	 */
	protected static function require_valid_name(
		string $name,
		string $pattern = '/^[a-zA-Z0-9_-]+$/'
	): string {
		if ( ! \preg_match( $pattern, $name ) ) {
			throw new \RuntimeException(
				\esc_html( "invalid name: must match $pattern" )
			);
		}
		return $name;
	}

	/**
	 * Read an operator-supplied `--key=<n>` option, throwing when it is
	 * malformed. The throw becomes a TM_COMMAND|TM_ERROR reply, so the caller
	 * hears which flag it fumbled instead of an answer for partition 0 — every
	 * `Core` coercion family resolves a bad value to a number.
	 *
	 * @param array<string,mixed> $options    The `options` half of Command_Args::parse().
	 * @param string              $key        Option name, without the leading `--`.
	 * @param int                 $fallback   Value when the option is absent.
	 * @param bool                $allow_zero Whether 0 is acceptable.
	 * @return int The option's value, or $fallback when it is absent.
	 * @throws \RuntimeException When the option is present but not a canonical decimal.
	 */
	protected static function require_option_int( array $options, string $key, int $fallback, bool $allow_zero = true ): int {
		$value = Command_Args::option_int( $options, $key, $fallback, $allow_zero );
		if ( null === $value ) {
			$bound = $allow_zero ? 'non-negative' : 'positive';
			throw new \RuntimeException(
				\esc_html( "--{$key} must be a {$bound} integer; got: " . Core::as_string( $options[ $key ] ) )
			);
		}
		return $value;
	}
}
