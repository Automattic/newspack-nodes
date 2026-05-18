<?php
/**
 * Log_Discovery — readdir-based "what logs exist on disk" primitive.
 *
 * Replaces hardcoded log catalogs that drift when applications add
 * topology partitions. Globs `{base}/logs/*.log/` and returns the
 * sorted basename list (without the `.log` suffix).
 *
 * Cache policy:
 *   * Memoized per-PHP-process (admin / REST / CLI / worker).
 *   * `Config::RESET_ACTION` clears the cache so long-lived workers see
 *     new log dirs after a config reload.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

final class Log_Discovery {

	/**
	 * Memoized basename list. `null` = not yet scanned.
	 *
	 * @var array<string>|null
	 */
	private static ?array $cached = null;

	/**
	 * Sorted basenames of every `{base}/logs/*.log/` directory on disk
	 * (without the `.log` suffix).
	 *
	 * @return array<string>
	 */
	public static function on_disk(): array {
		if ( null !== self::$cached ) {
			return self::$cached;
		}
		$config   = Config::load_config();
		$base_dir = (string) ( $config['base_directory'] ?? '/tmp/newspack-nodes' );
		$matches  = \glob( "{$base_dir}/logs/*.log", \GLOB_ONLYDIR );
		if ( false === $matches ) {
			return self::$cached = [];
		}
		\sort( $matches );
		$out = [];
		foreach ( $matches as $path ) {
			$out[] = (string) \preg_replace( '/\.log$/', '', \basename( $path ) );
		}
		return self::$cached = $out;
	}

	/**
	 * Drop the memoized result. Wired to `Config::RESET_ACTION` at
	 * `Bootstrap::init()` so workers surviving a config reload pick up
	 * newly-created log directories.
	 */
	public static function reset(): void {
		self::$cached = null;
	}
}
