<?php
/**
 * Answers "which partition directories exist on disk?" for the whole substrate.
 *
 * Three readers share the one answer: the admin storage estimate counts
 * `on_disk()`, the Raw Logs catalog lists `groups()`, and the SSE subscription
 * parser validates a `{group}/` prefix against `GROUPS`. A Partition added to a
 * topology therefore reaches all three with no registration step and no
 * per-application catalog to keep in step with the topologies.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * A per-process cache over one `glob()` per browsable root.
 *
 * Both entry points memoize, so a directory created after the process booted
 * becomes visible only once `reset()` runs. A failed scan caches its empty list
 * like any other result and stands until then.
 */
final class Log_Discovery {

	/**
	 * Seam over the single `glob()` call each scan makes. Tests reassign it to
	 * force the error branch — `glob()` returns false on an I/O fault, where a
	 * no-match returns `[]` — without damaging a real directory, leaving the
	 * sort, the basename map and the memoization under real coverage. It
	 * defaults at the call site because a closure cannot be a constant
	 * expression.
	 *
	 * Signature: `function ( string $pattern, int $flags ): array|false`.
	 *
	 * @var (\Closure(string, int): (list<string>|false))|null
	 */
	public static ?\Closure $glob = null;

	/**
	 * The browsable partition-dir roots under `{base}`, in catalog order.
	 *
	 * `logs` holds the data partitions, `offsets` the durable reader cursors,
	 * and `deadletter` the poison and write-stall quarantines. All three hold
	 * packed partition dirs, so the Partition Viewer renders any of them.
	 * `SSE_Out_Node` accepts a `{group}/` subscription prefix from this list
	 * alone and refuses every other one, which is what keeps a caller-supplied
	 * prefix from reaching a path.
	 */
	public const GROUPS = [ 'logs', 'offsets', 'deadletter' ];

	/** @var list<string>|null Memoized `logs` basenames; null before a scan. */
	private static ?array $cached = null;

	/** @var array<string,list<string>>|null Memoized per-root basenames. */
	private static ?array $cached_groups = null;

	/**
	 * Sorted basenames of every first-level directory under `{base}/logs`,
	 * returned verbatim. The flat layout carries the partition in the name, so
	 * `firehose.p0` is one entry and nothing strips a suffix; `GLOB_ONLYDIR`
	 * keeps a `Log` file-sink's segment files out of the list.
	 *
	 * @return list<string>
	 * @throws \RuntimeException When `base_directory` is unconfigured. There is
	 *                          no silent `/tmp` default: a phantom tree reports
	 *                          "no logs" while the writer fills the real one.
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
	 * Sorted basenames under every root in `GROUPS`, keyed by root. The `logs`
	 * entry repeats `on_disk()`, which a caller wanting that root alone reads
	 * instead.
	 *
	 * A root with no directory and a root whose scan fails both yield an empty
	 * list rather than a missing key, so a caller may index all three without
	 * checking first.
	 *
	 * @return array<string,list<string>>
	 * @throws \RuntimeException When `base_directory` is unconfigured.
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

	/**
	 * Drop both memoized scans. `newspack-nodes.php` wires this to
	 * `Config::RESET_ACTION`, the signal a config reload fires.
	 */
	public static function reset(): void {
		self::$cached        = null;
		self::$cached_groups = null;
	}
}
