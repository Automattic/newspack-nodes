<?php
/**
 * Answers "which partition directories exist on disk?" for the whole substrate.
 *
 * Three readers share the one answer: the admin storage estimate counts
 * `on_disk()`, the Raw Logs catalog lists `groups()`, and `SSE_Out_Node`
 * validates a subscription's `{group}/` prefix against `GROUPS`. A Partition
 * added to a topology therefore reaches all three as soon as its directory
 * exists, with no registration step and no per-application catalog to keep in
 * step with the topologies.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * A per-process cache over one `glob()` per browsable root.
 *
 * The two entry points memoize separately, so a directory created after the
 * process booted becomes visible only once `reset()` runs, and a failed scan
 * caches its empty list like any other result and stands until then. Neither
 * is a pure read: the first scan resolves the runtime root through
 * `Config::get_base_directory()`, which creates that tree at mode 0700 when it
 * is absent.
 */
final class Log_Discovery {

	/**
	 * Seam over the `glob()` call every scan makes; `groups()` reaches it once
	 * per root. Tests reassign it to force the error branch — `glob()` returns
	 * false on an I/O fault where a no-match returns `[]` — without damaging a
	 * real directory, which leaves the sort, the basename map and the
	 * memoization under real coverage. It defaults at the call site because a
	 * closure cannot be a constant expression.
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
	 * and `deadletter` the poison quarantines and the write quarantines of
	 * batches whose segment would not open. All three hold
	 * packed partition dirs, so the Partition Viewer renders any of them.
	 * `SSE_Out_Node::parse_group()` accepts a `{group}/` subscription prefix
	 * from this list and refuses every other one, an explicit `logs/` included,
	 * because a bare name already addresses that root. That list is what keeps
	 * a caller-supplied prefix out of the glob path the node then builds.
	 */
	public const GROUPS = [ 'logs', 'offsets', Config::DEADLETTER_SUBDIR ];

	/** The stamp prefix naming a `Log_Sources` registry entry: `sources/<name>`. */
	public const SOURCES_PREFIX = 'sources';

	/**
	 * Every prefix a stamp may open with: the dir roots in `GROUPS`, and
	 * `SOURCES_PREFIX`, which names a registry entry rather than a dir. A
	 * bare stamp is never one of them.
	 */
	public const STAMP_PREFIXES = [ ...self::GROUPS, self::SOURCES_PREFIX ];

	/** @var list<string>|null Memoized `logs` basenames; null before a scan. */
	private static ?array $cached = null;

	/** @var array<string,list<string>>|null Memoized per-root basenames; null before a scan. */
	private static ?array $cached_groups = null;

	/**
	 * The name a log's record gives it, from its path relative to the runtime
	 * base: the stamp when it is a first-level dir under one of `GROUPS`, so a
	 * `logs` dir reads as its Consumers name it, and the relative path
	 * otherwise (`ipc/<worker>/output`), since a basename names many dirs.
	 * A Partition or Log declaration calls it too, so a name `stamp_for()`
	 * refuses is refused where it is declared.
	 *
	 * @param string $relative The log's path under the runtime base.
	 * @return string The record's SOURCE.
	 * @throws \InvalidArgumentException On a log dir named like a group.
	 */
	public static function source_for( string $relative ): string {
		$parts = \explode( '/', $relative );
		if ( 2 === \count( $parts ) && \in_array( $parts[0], self::GROUPS, true ) ) {
			return self::stamp_for( $parts[0], $parts[1] );
		}
		return $relative;
	}

	/**
	 * The absolute dir a catalog stamp names, the inverse of `stamp_for()`
	 * over the dirs that exist. A name no catalog dir carries is refused
	 * rather than defaulted, so a reader never opens a log it was not asked
	 * for.
	 *
	 * @param string $stamp A catalog stamp: `firehose.p0`, `offsets/…`, `deadletter/…`.
	 * @return string The absolute partition dir.
	 * @throws \InvalidArgumentException When no catalog dir carries the stamp.
	 */
	public static function dir_of( string $stamp ): string {
		foreach ( self::groups() as $group => $names ) {
			foreach ( $names as $name ) {
				if ( self::stamp_for( $group, $name ) === $stamp ) {
					return Config::get_base_directory() . "/{$group}/{$name}";
				}
			}
		}
		// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers; escape at the view, not the runtime.
		throw new \InvalidArgumentException( "unknown log: \"{$stamp}\"" );
	}

	/**
	 * The stamp naming a dir under one of `GROUPS`: a `logs` dir stays bare
	 * and a grouped one keeps its prefix, so one directory has one spelling
	 * wherever it is named — an SSE frame's FROM and a Partition record's
	 * SOURCE alike. A bare stamp that is a group name would read back as that
	 * group's prefix, so a log dir named like a group is refused by name.
	 *
	 * @param string $group    The root group the dir sits under.
	 * @param string $basename The dir's basename.
	 * @return string The stamp.
	 * @throws \InvalidArgumentException On a log dir named like a group.
	 */
	public static function stamp_for( string $group, string $basename ): string {
		if ( 'logs' !== $group ) {
			return "{$group}/{$basename}";
		}
		if ( \in_array( $basename, self::STAMP_PREFIXES, true ) ) {
			throw new \InvalidArgumentException( \esc_html( "log dir {$basename} is named like a group; rename it" ) );
		}
		return $basename;
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
	 * @throws \RuntimeException Through `Config::get_base_directory()`, on the
	 *                          same conditions as `on_disk()`.
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
	 * Whether a subscription brings records stamped `$stamp`: its own name
	 * exactly, or a glob whose `*` matches within one path segment, as
	 * `SSE_Out_Node::matched_dirs()` globs it. Every other character is
	 * literal, `?` and `[` included, which is why this is not `fnmatch()`.
	 * `tests/fixtures/subscription-carries.json` holds it to the browser's
	 * `carries()`.
	 *
	 * @param string $sub   A subscription, as `subscribe` lists it.
	 * @param string $stamp A record's stamp, as `dir_from_stamp()` reads it.
	 * @return bool True when the subscription carries the stamp.
	 */
	public static function carries( string $sub, string $stamp ): bool {
		if ( ! \str_contains( $sub, '*' ) ) {
			return $sub === $stamp;
		}
		$pattern = \implode( '[^/]*', \array_map( static fn ( string $part ): string => \preg_quote( $part, '#' ), \explode( '*', $sub ) ) );
		return 1 === \preg_match( "#^{$pattern}$#D", $stamp );
	}

	/**
	 * The stamp a FROM breadcrumb opens with, and the inverse of
	 * `stamp_for()`: a stamp opening with one of `STAMP_PREFIXES` keeps its
	 * second segment, any other is the first path segment alone. No bare
	 * stamp is a prefix, because `stamp_for()` refuses that dir. Reading the
	 * leading segments rather than the whole string is what lets a full
	 * routing path resolve too. `tests/fixtures/log-stamps.json` holds it to
	 * `src/runtime/log-stamp.js`.
	 *
	 * @param string $from A stamp, or a FROM path beginning with one.
	 * @return string The stamp it opens with.
	 */
	public static function dir_from_stamp( string $from ): string {
		$parts = \explode( '/', $from );
		if ( isset( $parts[1] ) && '' !== $parts[1] && \in_array( $parts[0], self::STAMP_PREFIXES, true ) ) {
			return "{$parts[0]}/{$parts[1]}";
		}
		return $parts[0];
	}

	/**
	 * Sorted basenames of every first-level directory under `{base}/logs`,
	 * returned verbatim. The flat layout carries the partition in the name, so
	 * `firehose.p0` is one entry and nothing strips a suffix; `GLOB_ONLYDIR`
	 * keeps a `Log` file-sink's segment files out of the list.
	 *
	 * @return list<string>
	 * @throws \RuntimeException Through `Config::get_base_directory()`: a
	 *                          malformed config file, an empty or non-scalar
	 *                          `base_directory`, or a runtime root that will
	 *                          not resolve or that another uid owns. Nothing
	 *                          here catches it: a substituted path would
	 *                          report "no logs" while the writer fills the
	 *                          real tree.
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
	 * Drop both memoized scans. `newspack-nodes.php` hooks this to
	 * `Config::RESET_ACTION`, which `Config::reset()` fires.
	 */
	public static function reset(): void {
		self::$cached        = null;
		self::$cached_groups = null;
	}
}
