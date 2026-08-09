<?php
/**
 * Log_Discovery — globs the first-level dirs under `{base}/logs` for the sorted concrete dir basename list (flat partition-in-name layout, e.g. `firehose.p0`). Memoized per-process; cleared on Config::RESET_ACTION.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

final class Log_Discovery {

	/**
	 * glob()-call seam. Lazily-defaulted to the real glob; tests reassign to force the
	 * error branch (glob returning false) without a real filesystem fault.
	 *
	 * Signature: `function ( string $pattern, int $flags ): array|false`.
	 *
	 * @var (\Closure(string, int): (array<int,string>|false))|null
	 */
	public static ?\Closure $glob = null;

	/** The browsable partition-dir roots under {base}, in catalog order. */
	public const GROUPS = [ 'logs', 'offsets', 'deadletter' ];

	/** @var array<string>|null Memoized basename list; null = not yet scanned. */
	private static ?array $cached = null;

	/** @var array<string,array<string>>|null Memoized group → basenames; null = not yet scanned. */
	private static ?array $cached_groups = null;

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
		$glob     = self::$glob ?? static fn ( string $pattern, int $flags ): array|false => \glob( $pattern, $flags );
		$matches  = $glob( "{$base_dir}/logs/*", \GLOB_ONLYDIR );
		if ( ! \is_array( $matches ) ) {
			return self::$cached = [];
		}
		\sort( $matches );
		return self::$cached = \array_map( '\basename', $matches );
	}

	/**
	 * Group → sorted concrete dir basenames for every browsable root: `logs`
	 * (the on_disk() list), `offsets` (durable reader cursors), `deadletter`
	 * (poison + write-stall quarantines). All packed partition dirs, so the
	 * Partition Viewer renders any of them.
	 *
	 * @return array<string,array<string>>
	 */
	public static function groups(): array {
		if ( null !== self::$cached_groups ) {
			return self::$cached_groups;
		}
		$base_dir = Config::get_base_directory();
		$glob     = self::$glob ?? static fn ( string $pattern, int $flags ): array|false => \glob( $pattern, $flags );
		$groups   = [];
		foreach ( self::GROUPS as $group ) {
			$matches = $glob( "{$base_dir}/{$group}/*", \GLOB_ONLYDIR );
			if ( ! \is_array( $matches ) ) {
				$groups[ $group ] = [];
				continue;
			}
			\sort( $matches );
			$groups[ $group ] = \array_map( '\basename', $matches );
		}
		return self::$cached_groups = $groups;
	}

	/** Drop the memoized results; wired to Config::RESET_ACTION so workers pick up new dirs after a config reload. */
	public static function reset(): void {
		self::$cached        = null;
		self::$cached_groups = null;
	}
}
