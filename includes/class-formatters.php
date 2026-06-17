<?php
/**
 * Formatters — substrate-side registry of named callables that TSL topology files reference by name.
 *
 * Closures aren't expressible in TSL, so register them in PHP once at plugin load.
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

	/** @api Used by external plugins */
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

	/** @api Support for unit tests. */
	public static function reset(): void {
		self::$registry = [];
	}
}
