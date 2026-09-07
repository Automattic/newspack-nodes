<?php
/**
 * The registry TSL formatter names resolve through.
 *
 * TSL has no closure syntax, so a topology file names a formatter and a plugin
 * registers the callable under that name in PHP. Registrations are per-process
 * static state, which is why they belong at plugin load: every process that
 * parses a topology or dispatches a verb — worker, REST, CLI — has to make them
 * for itself.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Formatter callables addressed by name.
 *
 * Three surfaces read it: `Partition_Node::with_index_named()`, the `with_index`
 * verb on Partition and Topic, and `Classes_CI`, which publishes `list_names()`
 * as the topology console's picker for a `formatter_name` argument, a type only
 * `with_index` declares. The registry constrains nothing beyond `callable` —
 * the signature a name must satisfy belongs to whoever calls it, which for the
 * companion-index formatters is `fn(array $message, array $position): ?string`.
 */
class Formatters {

	/**
	 * Registered callables, keyed by the name a verb argument or a PHP caller
	 * addresses.
	 *
	 * @var array<string,callable>
	 */
	private static array $registry = [];

	/**
	 * Register a callable under a name, replacing whatever held that name.
	 *
	 * @api Called from consumer plugins; the substrate has no production caller.
	 *
	 * @param string   $name Name the registry keys this callable under.
	 * @param callable $cb   The callable. Nothing checks its signature here; the
	 *                       caller that resolves the name defines what it takes.
	 */
	public static function register( string $name, callable $cb ): void {
		self::$registry[ $name ] = $cb;
	}

	/**
	 * Look up a registered callable, answering null when the name is unknown.
	 *
	 * Null rather than a throw, because the caller words the refusal: the
	 * `with_index` verbs raise `unknown formatter: <name>`, while
	 * `Partition_Node::with_index_named()` returns false to its programmatic
	 * caller.
	 *
	 * @param string $name Registered formatter name.
	 * @return callable|null The callable, or null when nothing is registered under $name.
	 */
	public static function resolve( string $name ): ?callable {
		return self::$registry[ $name ] ?? null;
	}

	/**
	 * List every registered name, in registration order.
	 *
	 * `Classes_CI` sorts the result before publishing it; nothing here does.
	 *
	 * @return array<int,string> Registered formatter names.
	 */
	public static function list_names(): array {
		return \array_keys( self::$registry );
	}

	/**
	 * Empty the registry.
	 *
	 * The registry is static, so tests sharing a process inherit each other's
	 * registrations — one that asserts on an unknown name needs the slate clear
	 * first. Production never calls this.
	 *
	 * @api Support for unit tests.
	 */
	public static function reset(): void {
		self::$registry = [];
	}
}
