<?php
/**
 * Formatters — substrate-side registry of named callables that
 * TSL topology files can reference by name (e.g. Partition's
 * `with_index <formatter_name>` verb resolves through here).
 *
 * Closures aren't expressible in TSL, so we register them in PHP
 * once at plugin load and reference by name from .tsl scripts.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Formatters {

	/**
	 * @var array<string,callable>
	 */
	private static array $registry = [];

	public static function register( string $name, callable $cb ): void {
		self::$registry[ $name ] = $cb;
	}

	public static function resolve( string $name ): ?callable {
		return self::$registry[ $name ] ?? null;
	}

	/**
	 * @return array<int,string> Registered formatter names.
	 */
	public static function list_names(): array {
		return \array_keys( self::$registry );
	}

	/**
	 * Test seam. Production code never calls this — formatters are
	 * registered once at plugin load and remain for the request.
	 */
	public static function reset(): void {
		self::$registry = [];
	}
}
