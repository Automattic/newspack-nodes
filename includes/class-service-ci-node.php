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
 * It carries verb-table machinery and NOTHING else. A blocking spoke HTTP
 * client used to live here too — inherited as dead surface by ten of the twelve
 * service interpreters, along with a publicly reassignable `$http_call` on the
 * base of every one of them. It is `Spoke_Client` now; probing a spoke has no
 * business being reachable from `Classes_CI_Node`.
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
	 * Install or read the verb table, wrapping EVERY handler in its capability
	 * check on the way in.
	 *
	 * The wrap used to happen only in the constructor, and `commands()` is
	 * public and mutating while `dispatch()` reads the table at call time — so
	 * a table installed afterwards replaced the gated handlers wholesale and
	 * silently disabled authorization. Nothing threw and nothing warned; the
	 * verbs just worked for everyone. Wrapping here makes the gate a property
	 * of the class instead of one code path, and catches the parent's ungated
	 * `help` injection too.
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
	 * declares, defaulting to MANAGE — fail closed for a verb that declares
	 * nothing.
	 *
	 * @param array<string,callable> $table  Verb name => handler.
	 * @param array<string,mixed>    $schema The concrete class's node_schema.
	 * @return array<string,callable>
	 */
	private static function gate_table( array $table, array $schema ): array {
		$roles = [];
		// The same key commands_from_schema() reads handlers from.
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
	 * Build the interpreter dispatch table (verb name => handler closure) from a node_schema.
	 * Only `commands[]` entries carry handlers; `requests[]` are answered by
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
	 * ( Command_Interpreter_Node, array, array ) — and self::require_manage_options()
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
			// Raw here; commands() gates every handler on the way in.
			$table[ $name ] = $verb['handler'];
		}
		return $table;
	}

	/**
	 * Authorisation gate — the manage role via the Capabilities map.
	 * CommandInterpreter::interpret() catches the throw and wraps it as
	 * TM_COMMAND|TM_ERROR.
	 */
	protected static function require_manage_options(): void {
		Capabilities::require( Capabilities::MANAGE );
	}

	/**
	 * A verb carrying a structured blob (`save <name> <tsl…>` / `<name>
	 * <positions-json>`) receives it as a discrete slot: the producer places the
	 * whole body — newlines and all — in the second token. So the name is the
	 * first token and the body is the second, unambiguously (no rest-of-line
	 * splitting to guess at). A lone token yields an empty body.
	 *
	 * @param list<string> $args
	 * @return array{0:string,1:string} [ name, body ]
	 */
	protected static function split_first_token( array $args ): array {
		return [ $args[0] ?? '', $args[1] ?? '' ];
	}

	/**
	 * Build a slice-verb handler from a shape callable, so a CI's read-only slice verbs are
	 * 2–3 lines that share one memoized read instead of each repeating the json-encode dance.
	 *
	 * The returned handler matches the verb-handler signature ( Command_Interpreter_Node, array,
	 * array ) — for a Service_CI verb the interpreter IS this node — passes that node to $shape,
	 * and JSON-encodes whatever $shape returns. The shape closure reads the CI's memoized
	 * snapshot (e.g. `$ci->items()`) and returns the one slice it owns. Authorization stays
	 * central: commands_from_schema() wraps every handler with require_manage_options(), so the
	 * slice handler never self-gates.
	 *
	 * @param callable $shape A `function ( Command_Interpreter_Node $ci ): mixed` returning the slice payload.
	 * @return \Closure The verb handler closure.
	 */
	protected static function slice_verb( callable $shape ): \Closure {
		return static function ( Command_Interpreter_Node $self, array $args = [], array $envelope = [] ) use ( $shape ): string {
			return (string) \wp_json_encode( $shape( $self ) );
		};
	}

	/**
	 * Validate a name token (the first positional argument) against $pattern.
	 * Defaults to `[a-zA-Z0-9_-]+` — the shape Layouts_CI and Topologies_CI
	 * both require. Callers needing a wider charset pass a custom pattern.
	 *
	 * @param string $name    Name token — the first argument token ($args[0]).
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

	/**
	 * Read an operator-supplied `--key=<n>` option, throwing when it is
	 * malformed. The throw becomes a TM_COMMAND|TM_ERROR reply, so the caller
	 * hears which flag it fumbled rather than an answer for partition 0.
	 *
	 * @param array<string,mixed> $options    The `options` half of Command_Args::parse().
	 * @param string              $key        Option name.
	 * @param int                 $fallback   Value when the option is absent.
	 * @param bool                $allow_zero Whether 0 is acceptable.
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
