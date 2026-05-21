<?php
/**
 * Log_Discovery — globs `{base}/logs/*.log/` for the sorted basename list (without `.log`). Memoized per-process; cleared on Config::RESET_ACTION.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

final class Log_Discovery {

	/** @var array<string>|null Memoized basename list; null = not yet scanned. */
	private static ?array $cached = null;

	/**
	 * Sorted basenames of every `{base}/logs/*.log/` directory (without `.log`).
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

	/** Drop the memoized result; wired to Config::RESET_ACTION so workers pick up new log dirs after a config reload. */
	public static function reset(): void {
		self::$cached = null;
	}
}
