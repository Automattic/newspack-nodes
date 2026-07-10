<?php
/**
 * Log_Discovery — globs the first-level dirs under `{base}/logs` for the sorted concrete dir basename list (flat partition-in-name layout, e.g. `firehose.p0`). Memoized per-process; cleared on Config::RESET_ACTION.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

final class Log_Discovery {

	/** @var array<string>|null Memoized basename list; null = not yet scanned. */
	private static ?array $cached = null;

	/**
	 * Sorted concrete dir basenames of every first-level directory under
	 * `{base}/logs` (flat partition-in-name layout, e.g. `firehose.p0`),
	 * returned verbatim. GLOB_ONLYDIR skips Log file-sink segment files.
	 *
	 * @return array<string>
	 */
	public static function on_disk(): array {
		if ( null !== self::$cached ) {
			return self::$cached;
		}
		$base_dir = Config::get_base_directory();
		$matches  = \glob( "{$base_dir}/logs/*", \GLOB_ONLYDIR );
		if ( false === $matches ) {
			return self::$cached = [];
		}
		\sort( $matches );
		return self::$cached = \array_map( '\basename', $matches );
	}

	/** Drop the memoized result; wired to Config::RESET_ACTION so workers pick up new log dirs after a config reload. */
	public static function reset(): void {
		self::$cached = null;
	}
}
