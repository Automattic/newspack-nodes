<?php
/**
 * Service_CI: base class for substrate + application service interpreters.
 *
 * Hoists the two verb-helper seams that every interpreter built on the M3 +
 * M2 dispatch path duplicates verbatim — `require_manage_options` and
 * `require_valid_name`. Subclasses extend Service_CI instead of
 * CommandInterpreter and reach for the helpers via `self::` inside
 * their verb closures.
 *
 * The helpers are `protected static`. The legitimate callers are
 * subclass verb-table closures using `self::method()` — `self::` resolves
 * at compile time inside the closure's containing method, so static
 * closures (which can't `use ($this)`) still find them. No instance method
 * exists; the helpers don't need one.
 *
 * Lives at `includes/class-service-ci.php` rather than `includes/rest/`
 * because it's substrate infrastructure — both REST-facing interpreters and
 * non-REST callers can inherit. Mirrors `class-command-interpreter.php`'s
 * location.
 *
 * Service_CI is inheritance-only. It has no verbs of its own; as an abstract
 * base it is never make_node'd, and its inherited Hidden category keeps it out
 * of the editor's class palette.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

abstract class Service_CI_Node extends Command_Interpreter_Node {

	/**
	 * Derive the dispatch table from the concrete subclass's node_schema() so each
	 * verb is declared ONCE. Late static binding reads the subclass schema; the base
	 * Command_Interpreter_Node has no ctor, so there's nothing to chain.
	 */
	public function __construct() {
		parent::__construct();
		$this->commands( self::commands_from_schema( static::node_schema() ) );
	}

	/**
	 * Build the interpreter dispatch table (verb name => handler closure) from a node_schema.
	 * Only `verbs[]` entries carry handlers (commands); `requests[]` are answered by
	 * the node's own fill(), so they contribute no dispatch entry.
	 *
	 * A named verb without a callable handler is a schema bug: it would show in the
	 * catalog yet dispatch to nothing ("unknown command" at runtime). We emit ONE
	 * rate-limited warning naming the verb + concrete class, then skip it — keeping
	 * the table to verbs that are actually dispatchable. `is_callable` (not Closure)
	 * is intentional: string/array callables are legitimately dispatchable.
	 *
	 * EVERY derived handler is wrapped to call require_manage_options() before the
	 * original handler runs. Gate-by-default: there are no public Service CI verbs,
	 * so authorization lives here once instead of per-verb. The wrapper is
	 * variadic-transparent — it preserves the handler's exact call signature
	 * ( Command_Interpreter_Node, string, array ) — and self::require_manage_options()
	 * resolves through late static binding inside the closure.
	 *
	 * @param array<string,mixed> $schema
	 * @return array<string,callable>
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
			$name      = \is_scalar( $verb_name ) ? (string) $verb_name : '';
			if ( '' === $name ) {
				continue;
			}
			if ( ! isset( $verb['handler'] ) || ! \is_callable( $verb['handler'] ) ) {
				Core::print_less_often(
					'Service_CI: verb "' . $name . '" on ' . static::class . ' has no callable handler; skipping'
				);
				continue;
			}
			$handler        = $verb['handler'];
			$table[ $name ] = static function ( ...$args ) use ( $handler ) {
				self::require_manage_options();
				return $handler( ...$args );
			};
		}
		// Gate the auto-`help` too: the base commands() accessor injects an
		// UNgated default help into any interpreter that lacks one. Pre-seed a
		// wrapped help here so it passes the same cap check as every other verb
		// (gate-by-default — no ungated bypass).
		if ( ! isset( $table['help'] ) ) {
			$table['help'] = static function ( Command_Interpreter_Node $self, string $args = '', array $envelope = [] ): string {
				self::require_manage_options();
				return $self->default_help();
			};
		}
		return $table;
	}

	/**
	 * Authorisation gate. Throws a RuntimeException when the current user
	 * lacks the `manage_options` capability; CommandInterpreter::interpret()
	 * catches and wraps as TM_COMMAND|TM_ERROR.
	 *
	 * The `function_exists` guard keeps the helper usable in request-scope
	 * unit tests where the cap stub may not be loaded — same shape as the
	 * legacy per-interpreter copies it replaces.
	 */
	protected static function require_manage_options(): void {
		if ( \function_exists( 'current_user_can' ) && ! \current_user_can( 'manage_options' ) ) {
			throw new \RuntimeException( 'permission denied: manage_options required' );
		}
	}

	/**
	 * Split an arguments string into its first whitespace-delimited token and the
	 * VERBATIM remainder (everything after the first run of whitespace). The
	 * remainder keeps its internal and trailing whitespace, so a verb carrying a
	 * structured blob (`save <name> <tsl…>` / `<name> <positions-json>`) gets the
	 * body intact — newlines and all. Leading whitespace is skipped; a lone token
	 * with no body yields `''`.
	 *
	 * @return array{0:string,1:string} [ first_token, remainder ]
	 */
	protected static function split_first_token( string $args ): array {
		if ( \preg_match( '/\A\s*(\S+)\s+(.*)\z/s', $args, $m ) ) {
			return [ $m[1], $m[2] ];
		}
		return [ \trim( $args ), '' ];
	}

	/**
	 * Validate a name token (the first positional argument) against $pattern.
	 * Defaults to `[a-zA-Z0-9_-]+` — the shape Layouts_CI and Topologies_CI
	 * both require. Callers needing a wider charset pass a custom pattern.
	 *
	 * @param string $name    Name token, already split off the arguments string.
	 * @param string $pattern Regex with delimiters; default is the common file-name-safe pattern.
	 * @return string The validated name.
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
}
