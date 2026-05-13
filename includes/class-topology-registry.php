<?php
/**
 * Topology_Registry — name → .tsl path resolver.
 *
 * Each plugin that ships topology files registers its stock dir
 * at load time via `Topology_Registry::register_stock_dir($path)`;
 * the writable user dir holds operator customizations and
 * shadows stock by name. The substrate itself ships no stock
 * topologies — application plugins (e.g.
 * `newspack-event-logger-nodes`) contribute theirs.
 *
 * Resolution order at lookup time:
 *   1. `{user_dir}/{name}.tsl` — operator overrides win.
 *   2. Each registered stock dir, in registration order.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Topology_Registry {

	/** @var array<int,string> Plugin-registered stock dirs (first wins). */
	private static array $stock_dirs = [];

	/** @var string Writable per-deployment user dir. */
	private static string $user_dir = '';

	public static function register_stock_dir( string $path ): void {
		$path = \rtrim( $path, '/' );
		if ( '' === $path ) {
			return;
		}
		if ( ! \in_array( $path, self::$stock_dirs, true ) ) {
			self::$stock_dirs[] = $path;
		}
	}

	public static function set_user_dir( string $path ): void {
		self::$user_dir = \rtrim( $path, '/' );
	}

	/**
	 * Return the absolute path to `<name>.tsl` or null if unknown.
	 */
	public static function resolve( string $name ): ?string {
		if ( '' !== self::$user_dir ) {
			$user_path = self::$user_dir . '/' . $name . '.tsl';
			if ( \file_exists( $user_path ) ) {
				return $user_path;
			}
		}
		foreach ( self::$stock_dirs as $dir ) {
			$path = $dir . '/' . $name . '.tsl';
			if ( \file_exists( $path ) ) {
				return $path;
			}
		}
		return null;
	}

	/**
	 * Return the union of topology names across user + stock dirs.
	 *
	 * @return array<int,string>
	 */
	public static function list(): array {
		$names = [];
		if ( '' !== self::$user_dir && \is_dir( self::$user_dir ) ) {
			foreach ( \glob( self::$user_dir . '/*.tsl' ) ?: [] as $path ) {
				$names[ \basename( $path, '.tsl' ) ] = true;
			}
		}
		foreach ( self::$stock_dirs as $dir ) {
			foreach ( \glob( $dir . '/*.tsl' ) ?: [] as $path ) {
				$names[ \basename( $path, '.tsl' ) ] = true;
			}
		}
		return \array_keys( $names );
	}

	public static function reset(): void {
		self::$stock_dirs = [];
		self::$user_dir   = '';
	}
}
