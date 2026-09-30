<?php
/**
 * Service_CI_Node: the base every substrate and application service interpreter
 * extends.
 *
 * A service interpreter declares each verb ONCE, in `node_schema()`, and this
 * base turns that declaration into a working command surface: a dispatch table
 * derived from the schema, and the helpers the verbs share
 * (`require_valid_name`, `slice_verb`). `Command_Interpreter_Node::dispatch()`
 * refuses each verb against the role its schema names (ADR-26) and binds its
 * declared `args` before the handler runs, so a handler neither checks a role
 * nor parses. A hand-built verb table beside the schema names every verb
 * twice, and the two drift.
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
 * Schema-derived verb dispatch for service interpreters.
 */
abstract class Service_CI_Node extends Command_Interpreter_Node {

	/**
	 * Derive the dispatch table from the concrete subclass's `node_schema()`, so
	 * each verb is declared ONCE. Late static binding reads the SUBCLASS schema;
	 * `parent::__construct()` reaches `Node`, which seeds the registrations.
	 */
	public function __construct() {
		parent::__construct();
		$this->commands( self::commands_from_schema() );
	}

	/**
	 * Build the dispatch table (verb name => handler) from the concrete class's
	 * declared verbs. Only `commands[]` entries carry handlers; `requests[]` are
	 * answered by the addressed node's own `fill()`, so they contribute no
	 * dispatch entry.
	 *
	 * A named verb without a callable handler is a schema bug: it lists in the
	 * catalog and in `help`, then dispatches to nothing ("unknown command") at
	 * runtime. Emit one rate-limited warning naming the verb and the concrete
	 * class, then skip it, so the table holds only verbs that dispatch.
	 * `is_callable` rather than an `instanceof Closure` test is deliberate:
	 * string and array callables dispatch as well as closures do.
	 *
	 * Handlers come out RAW: `dispatch()` gates each by the role its entry
	 * declares.
	 *
	 * @return array<string,callable> Verb name => ungated handler.
	 */
	private static function commands_from_schema(): array {
		$table = [];
		foreach ( self::declared_verbs( static::class ) as $name => $verb ) {
			$handler = $verb['handler'] ?? null;
			if ( ! \is_callable( $handler ) ) {
				Core::print_less_often(
					'Service_CI: verb "',
					$name,
					'" on ' . static::class . ' has no callable handler; skipping'
				);
				continue;
			}
			$table[ $name ] = $handler;
		}
		return $table;
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
	 * `dispatch()` refuses a caller below the role its schema entry declares.
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
	 * @param string $name    Name — a verb's bound `name` argument.
	 * @param string $pattern Regex with delimiters; defaults to the file-name-safe shape.
	 * @return string The validated name.
	 * @throws \RuntimeException When $name does not match $pattern.
	 */
	protected static function require_valid_name(
		string $name,
		string $pattern = '/^[a-zA-Z0-9_-]+$/D'
	): string {
		if ( ! \preg_match( $pattern, $name ) ) {
			throw new \RuntimeException(
				\esc_html( "invalid name: must match $pattern" )
			);
		}
		return $name;
	}
}
