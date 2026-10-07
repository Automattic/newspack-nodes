<?php
/**
 * Answers "which partition directories exist on disk?" for the whole substrate.
 *
 * Three readers share the one answer: the admin storage estimate counts
 * `on_disk()`, the Raw Logs catalog lists `groups()`, and every reader of a
 * stamp splits it through `split()` and resolves a dir through `dir_of()`
 * (ADR-29). A Partition
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
	 * per root, and `dirs_matching()` once per subscription. Tests reassign it to force the error branch — `glob()` returns
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
	 * packed partition dirs, so the Log Viewer renders any of them.
	 * `dir_of()` joins a dir stamp onto one of these roots and no other.
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

	/**
	 * The longest stamp, in bytes. A reader's directory is its stamp with `/`
	 * spelled `:`, one byte for one, and a directory name holds at most 255
	 * bytes (NAME_MAX), so the `:` counts against the same limit.
	 */
	public const MAX_STAMP_BYTES = 255;

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
	 * The dir a stamp names under `$base`, or null when none is there: the
	 * stream's guard, then a direct path. A glob, a registry stamp and any
	 * name the guard refuses are refused, and a `logs` dir named like a group
	 * is refused by name, so no stamp reaches a dir the stream would not.
	 *
	 * @param string $stamp A dir stamp: `firehose.p0`, `offsets/…`, `deadletter/…`.
	 * @param string $base  The runtime base the roots sit under.
	 * @return string|null The absolute dir, or null when it does not exist.
	 * @throws \InvalidArgumentException On a stamp the guard refuses.
	 */
	public static function dir_of( string $stamp, string $base ): ?string {
		[ $group, $name, $dir ] = self::guarded( $stamp, $base, false );
		self::stamp_for( $group, $name );
		return \is_dir( $dir ) ? $dir : null;
	}

	/**
	 * Each dir a subscription glob matches under `$base`, keyed by the stamp
	 * `stamp_for()` writes for it, under the guard `dir_of()` applies; `*`
	 * matches within one path segment. A glob I/O fault answers null rather
	 * than an empty map, so a caller never mistakes it for "nothing there".
	 *
	 * @param string $sub  A subscription glob: `firehose.*`, `offsets/…*`.
	 * @param string $base The runtime base the roots sit under.
	 * @return array<string,string>|null Stamp => absolute dir, or null on a fault.
	 * @throws \InvalidArgumentException On a glob the guard refuses, or a
	 *                                   match whose dir is named like a group.
	 */
	public static function dirs_matching( string $sub, string $base ): ?array {
		[ $group, , $pattern ] = self::guarded( $sub, $base, true );
		$matches               = self::glob( $pattern );
		if ( null === $matches ) {
			return null;
		}
		$dirs = [];
		foreach ( $matches as $dir ) {
			$dirs[ self::stamp_for( $group, \basename( $dir ) ) ] = $dir;
		}
		return $dirs;
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
	 * A dir subscription through the stream's guard, and the path it names:
	 * a `GROUPS` root only, the shape `is_subscription()` admits, and a `*`
	 * only where the caller globs.
	 *
	 * @param string $sub  A dir stamp or subscription glob.
	 * @param string $base The runtime base the roots sit under.
	 * @param bool   $glob Whether `*` may appear.
	 * @return array{0:string,1:string,2:string} The group, the rest, and the path.
	 * @throws \InvalidArgumentException On a subscription the guard refuses.
	 */
	private static function guarded( string $sub, string $base, bool $glob ): array {
		[ $group, $name ] = self::split( $sub );
		if ( ( ! $glob && \str_contains( $sub, '*' ) ) || ! \in_array( $group, self::GROUPS, true ) || ! self::is_subscription( $sub ) ) {
			throw new \InvalidArgumentException( \esc_html( "invalid subscription: {$sub}" ) );
		}
		return [ $group, $name, self::path( $base, $group, $name ) ];
	}

	/**
	 * Whether a spoke's `SSE_Out_Node::open_subscription()` would read a
	 * subscription past its group and its traversal guard: a stamp's shape,
	 * once each `*` stands for a name character, with no `*` opening the
	 * name and none under `sources/`, whose registry is looked up by name. A
	 * bare group name passes, as it did the guard: `stamp_for()` refuses that
	 * dir with a message that teaches. `sources/<name>` and a worker's IPC
	 * channel are each served before the guard, and their own readers judge
	 * the name.
	 *
	 * @param string $sub A candidate subscription.
	 * @return bool True when the spoke would resolve it.
	 */
	public static function is_subscription( string $sub ): bool {
		$parts = \explode( '/', $sub );
		$last  = \end( $parts );
		return \strlen( $sub ) <= self::MAX_STAMP_BYTES
			&& ! \str_starts_with( $last, '*' )
			&& Log_Sources::is_valid_name( \str_replace( '*', 'a', $last ) )
			&& match ( \count( $parts ) ) {
				1 => true,
				2 => self::is_prefix( $parts[0] ) && ( self::SOURCES_PREFIX !== $parts[0] || ! \str_contains( $sub, '*' ) ),
				default => false,
			};
	}

	/**
	 * The one reader of a stamp: its group, then the rest. A bare stamp is a
	 * `logs` dir; one opening `{prefix}/` names that root, or for `sources`
	 * a registry entry. `logs/x` is refused rather than aliased to bare `x`,
	 * so one log has one spelling, and so is any prefix outside
	 * `STAMP_PREFIXES`, which keeps a caller's prefix out of every path
	 * built from it. The rest is returned whole; the guard judges its shape.
	 *
	 * @param string $stamp A stamp, or a subscription glob.
	 * @return array{0:string,1:string} The group, then the rest.
	 * @throws \InvalidArgumentException On an explicit `logs/` or an unknown prefix.
	 */
	public static function split( string $stamp ): array {
		$slash = \strpos( $stamp, '/' );
		if ( false === $slash ) {
			return [ 'logs', $stamp ];
		}
		$group = \substr( $stamp, 0, $slash );
		if ( ! self::is_prefix( $group ) ) {
			throw new \InvalidArgumentException( \esc_html( "invalid subscription: {$stamp}" ) );
		}
		return [ $group, \substr( $stamp, $slash + 1 ) ];
	}

	/**
	 * Whether a string is a stamp a record may carry: one name, or one of
	 * `STAMP_PREFIXES` other than `logs` and one name, each name a registry
	 * name as `Log_Sources::is_valid_name()` reads it, so it opens with a name
	 * character and holds no `..`, and the whole at most `MAX_STAMP_BYTES`.
	 * A bare prefix is no stamp, since `stamp_for()` refuses that dir, and nor
	 * is `logs/<name>`, which `stamp_for()` never writes. A stamp names
	 * directories on the hub reading it, so one from a remote is held to this
	 * before it names any.
	 *
	 * @param string $stamp A candidate stamp.
	 * @return bool True when it names one dir and nothing above it.
	 */
	public static function is_stamp( string $stamp ): bool {
		$parts = \explode( '/', $stamp );
		return \strlen( $stamp ) <= self::MAX_STAMP_BYTES && match ( \count( $parts ) ) {
			1 => ! \in_array( $stamp, self::STAMP_PREFIXES, true ) && Log_Sources::is_valid_name( $stamp ),
			2 => self::is_prefix( $parts[0] ) && Log_Sources::is_valid_name( $parts[1] ),
			default => false,
		};
	}

	/**
	 * Whether a stamp's first segment is one a stamp writes out: any of
	 * `STAMP_PREFIXES` but `logs`, whose dirs stamp bare.
	 *
	 * @param string $segment A stamp's first segment.
	 */
	private static function is_prefix( string $segment ): bool {
		return 'logs' !== $segment && \in_array( $segment, self::STAMP_PREFIXES, true );
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
		$groups   = [];
		foreach ( self::GROUPS as $group ) {
			$groups[ $group ] = \array_map( '\basename', self::glob( self::path( $base_dir, $group, '*' ) ) ?? [] );
		}
		return self::$cached_groups = $groups;
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
		$matches = self::glob( self::path( Config::get_base_directory(), 'logs', '*' ) ) ?? [];
		return self::$cached = \array_map( '\basename', $matches );
	}

	/**
	 * A path under one root: the one place `{base}/{group}/` is spelled.
	 *
	 * @param string $base  The runtime base.
	 * @param string $group A `GROUPS` root.
	 * @param string $name  A dir name or a glob.
	 */
	private static function path( string $base, string $group, string $name ): string {
		return "{$base}/{$group}/{$name}";
	}

	/**
	 * The dirs a pattern matches, sorted, through the `$glob` seam; null on
	 * an I/O fault, where `glob()` answers false and a no-match `[]`.
	 *
	 * @param string $pattern An absolute glob pattern.
	 * @return list<string>|null
	 */
	private static function glob( string $pattern ): ?array {
		$glob    = self::$glob ?? static fn ( string $pattern, int $flags ): array|false => \glob( $pattern, $flags );
		$matches = $glob( $pattern, \GLOB_ONLYDIR );
		if ( ! \is_array( $matches ) ) {
			return null;
		}
		\sort( $matches );
		return $matches;
	}

	/**
	 * Whether a subscription brings records stamped `$stamp`: its own name
	 * exactly, or a glob whose `*` matches within one path segment, as
	 * `dirs_matching()` globs it. Every other character is
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
	 * Drop both memoized scans. `newspack-nodes.php` hooks this to
	 * `Config::RESET_ACTION`, which `Config::reset()` fires.
	 */
	public static function reset(): void {
		self::$cached        = null;
		self::$cached_groups = null;
	}
}
