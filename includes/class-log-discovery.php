<?php
/**
 * Answers "which partition directories exist on disk?" for the whole substrate.
 *
 * Three readers share the one answer: the admin storage estimate counts
 * `on_disk()`, the Raw Logs catalog lists `groups()`, and every reader of a
 * stamp splits it through `split()` and resolves a dir through `dir_of()`
 * (ADR-29). A Partition added to a topology therefore reaches all three as
 * soon as its directory exists, with no registration step and no
 * per-application catalog to keep in step with the topologies.
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
	 * per root, and `dirs_matching()` once per subscription, each once more
	 * per reader root through `broker_roots()`. Tests reassign it
	 * to force the error branch — `glob()` returns false on an I/O fault where
	 * a no-match returns `[]` — without damaging a real directory, which
	 * leaves the sort, the basename map and the memoization under real
	 * coverage. It defaults at the call site because a closure cannot be a
	 * constant expression.
	 *
	 * Signature: `function ( string $pattern, int $flags ): array|false`.
	 *
	 * @var (\Closure(string, int): (list<string>|false))|null
	 */
	public static ?\Closure $glob = null;

	/**
	 * The roots a durable reader's sidecars sit under: its cursor in `offsets`
	 * and its quarantine in `deadletter`. A broker nests one dir per reader
	 * kind under a root of its own there, `<root>/<kind>`, which stamps as one
	 * segment, `<group>:<root>:<kind>`, so a FROM trail never cuts it (ADR-29).
	 */
	public const READER_GROUPS = [ 'offsets', Config::DEADLETTER_SUBDIR ];

	/**
	 * The browsable partition-dir roots under `{base}`, in catalog order.
	 *
	 * `logs` holds the data partitions, `offsets` the durable reader cursors,
	 * and `deadletter` the poison quarantines and the write quarantines of
	 * batches whose segment would not open. All three hold
	 * packed partition dirs, so the Log Viewer renders any of them.
	 * `dir_of()` joins a dir stamp onto one of these roots and no other.
	 */
	public const GROUPS = [ 'logs', ...self::READER_GROUPS ];

	/** The stamp prefix naming a `Log_Sources` registry entry: `sources/<name>`. */
	public const SOURCES_PREFIX = 'sources';

	/**
	 * The prefix naming a spoke's log in this site's own probe channel,
	 * `remote/<vault_id>:<kind>`, which `remote_for()` writes and `remote_of()`
	 * alone reads. It is no stamp prefix: a remote name is a probe record's
	 * SOURCE, never a FROM, a subscription or a dir.
	 */
	public const REMOTE_PREFIX = 'remote';

	/**
	 * Every prefix a stamp may open with: the dir roots in `GROUPS`, and
	 * `SOURCES_PREFIX`, which names a registry entry rather than a dir.
	 */
	public const STAMP_PREFIXES = [ ...self::GROUPS, self::SOURCES_PREFIX ];

	/**
	 * The longest stamp, in bytes. A reader's directory is its stamp with `/`
	 * spelled `:`, one byte for one, and a directory name holds at most 255
	 * bytes (NAME_MAX), so the `:` counts against the same limit. A broker
	 * reader's stamp is bounded part by part instead: its root and its kind
	 * are each one directory name, so each holds at most this, and the length
	 * refuses no reader dir; a root `ROOT_PATTERN` refuses, or a kind no
	 * stamp folds to, leaves its dir with no stamp.
	 */
	public const MAX_STAMP_BYTES = 255;

	/**
	 * A broker root's name: a Vault id's letters, digits, `_` and `-`, in
	 * either case, and the `.` a topology joins it with, opening with no `.`.
	 * It holds neither `/` nor `:`, so a reader stamp names a dir under its
	 * root and cuts at its first two colons; `..` is refused apart.
	 */
	private const ROOT_PATTERN = '/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/D';

	/** @var list<string>|null Memoized `logs` basenames; null before a scan. */
	private static ?array $cached = null;

	/** @var array<string,list<string>>|null Memoized per-root basenames; null before a scan. */
	private static ?array $cached_groups = null;

	/** @var array<string,list<string>> Per root, the dirs the memoized scan could not read. */
	private static array $cached_unreadable = [];

	/**
	 * The name a log's record gives it, from its path relative to the runtime
	 * base: the stamp when it is a first-level dir under one of `GROUPS`, so a
	 * `logs` dir reads as its Consumers name it, or a broker reader's sidecar
	 * under one of `READER_GROUPS`, so it reads as the catalog lists it; the
	 * relative path otherwise (`ipc/<worker>/output`), since a basename names
	 * many dirs, and for a reader dir `is_stamp()` names no stamp for, so a
	 * SOURCE never names a stamp the catalog refuses. A Partition or Log
	 * declaration calls it too, so a name `stamp_for()` refuses is refused
	 * where it is declared.
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
		if ( 3 === \count( $parts ) && \in_array( $parts[0], self::READER_GROUPS, true ) ) {
			$stamp = self::reader_stamp( $parts[0], $parts[1], $parts[2] );
			return null !== $stamp && self::is_stamp( $stamp ) ? $stamp : $relative;
		}
		return $relative;
	}

	/**
	 * The dir a stamp names under `$base`, or null when none is there: the
	 * stream's guard, then a direct path. A glob, a registry stamp and any
	 * name the guard refuses are refused, and a `logs` dir named like a group
	 * is refused by name, so no stamp reaches a dir the stream would not.
	 *
	 * @param string $stamp A dir stamp: `firehose.p0`, `offsets/…`, `deadletter/…`, `offsets:<root>:<kind>`.
	 * @param string $base  The runtime base the roots sit under.
	 * @return string|null The absolute dir, or null when it does not exist.
	 * @throws \InvalidArgumentException On a stamp the guard refuses.
	 */
	public static function dir_of( string $stamp, string $base ): ?string {
		[ , $dir ] = self::guarded( $stamp, $base, false );
		return \is_dir( $dir ) ? $dir : null;
	}

	/**
	 * Each dir a subscription glob matches under `$base`, keyed by the stamp
	 * `stamp_for()` writes for its path under the root, under the guard
	 * `dir_of()` applies; `*` matches within one path segment, and an exact
	 * reader stamp matches its own dir. A broker's root is no match, as the
	 * catalog lists none, and a glob reaches none of its readers, since no
	 * glob carries a reader stamp. A match whose stamp `is_stamp()`
	 * refuses is left out, so a glob opens no dir `dir_of()` would refuse. A
	 * glob I/O fault answers null rather than an empty map, so a caller never
	 * mistakes it for "nothing there".
	 *
	 * @param string $sub  A subscription glob: `firehose.*`, `offsets/…*`.
	 * @param string $base The runtime base the roots sit under.
	 * @return array<string,string>|null Stamp => absolute dir, or null on a fault, a dir under a matched root that will not read included.
	 * @throws \InvalidArgumentException On a glob the guard refuses, or a
	 *                                   match whose dir is named like a group.
	 */
	public static function dirs_matching( string $sub, string $base ): ?array {
		[ $group, $pattern ] = self::guarded( $sub, $base, true );
		$matches             = self::glob( $pattern, \GLOB_ONLYDIR );
		$roots               = [] !== ( $matches ?? [] ) && \in_array( $group, self::READER_GROUPS, true ) ? self::broker_roots( $pattern ) : [];
		if ( null === $matches || null === $roots ) {
			return null;
		}
		$skip = \strlen( self::root( $base, $group ) ) + 1;
		$dirs = [];
		foreach ( \array_diff( $matches, \array_keys( $roots ) ) as $dir ) {
			$stamp = self::stamp_for( $group, \substr( $dir, $skip ) );
			if ( self::is_stamp( $stamp ) ) {
				$dirs[ $stamp ] = $dir;
			}
		}
		return $dirs;
	}

	/**
	 * A dir subscription through the stream's guard, and the path it names:
	 * a `GROUPS` root only, and a glob of the shape `is_subscription()` admits
	 * or an exact stamp `stamp_for()` writes and `is_stamp()` reads, so a log
	 * dir named like a group is refused by name. `split()` hands a reader
	 * stamp's `<root>/<kind>` back as the rest, which `stamp_for()` writes
	 * back only in the colon form, so a reader dir has one spelling.
	 *
	 * @param string $sub  A dir stamp or subscription glob.
	 * @param string $base The runtime base the roots sit under.
	 * @param bool   $glob Whether `*` may appear.
	 * @return array{0:string,1:string} The group, then the path.
	 * @throws \InvalidArgumentException On a subscription the guard refuses.
	 */
	private static function guarded( string $sub, string $base, bool $glob ): array {
		[ $group, $name ] = self::split( $sub );
		$shaped           = $glob ? self::is_subscription( $sub ) : ( $sub === self::stamp_for( $group, $name ) && self::is_stamp( $sub ) );
		if ( ! $shaped || ! \in_array( $group, self::GROUPS, true ) ) {
			throw new \InvalidArgumentException( \esc_html( "invalid subscription: {$sub}" ) );
		}
		return [ $group, self::path( $base, $group, $name ) ];
	}

	/**
	 * The stamp naming a dir under one of `GROUPS`: a `logs` dir stays bare
	 * and a grouped one keeps its prefix, so one directory has one spelling
	 * wherever it is named — an SSE frame's FROM and a Partition record's
	 * SOURCE alike. A broker reader's `<root>/<kind>` dir under one of
	 * `READER_GROUPS` stamps as one segment, `<group>:<root>:<kind>`, its
	 * kind as it sits on disk. A bare stamp that is a group name would read
	 * back as that group's prefix, so a log dir named like a group is refused
	 * by name, and so is a broker root holding a `:`, which would read back
	 * as another root and kind.
	 *
	 * @param string $group    The root group the dir sits under.
	 * @param string $basename The dir's basename, or a reader's `<root>/<kind>`.
	 * @return string The stamp.
	 * @throws \InvalidArgumentException On a log dir named like a group, or a
	 *                                   broker root holding a `:`.
	 */
	public static function stamp_for( string $group, string $basename ): string {
		$reader = \explode( '/', $basename, 2 );
		if ( isset( $reader[1] ) && \in_array( $group, self::READER_GROUPS, true ) ) {
			return self::reader_stamp( $group, $reader[0], $reader[1] )
				?? throw new \InvalidArgumentException( \esc_html( "broker root {$reader[0]} holds a colon, so no stamp names its readers; rename it" ) );
		}
		if ( 'logs' !== $group ) {
			return "{$group}/{$basename}";
		}
		if ( \in_array( $basename, self::STAMP_PREFIXES, true ) ) {
			throw new \InvalidArgumentException( \esc_html( "log dir {$basename} is named like a group; rename it" ) );
		}
		return $basename;
	}

	/**
	 * A reader dir's stamp, `<group>:<root>:<kind>`, or null when the root
	 * holds a `:`, where `reader_parts()` would cut it.
	 *
	 * @param string $group A `READER_GROUPS` root.
	 * @param string $root  The broker root's name.
	 * @param string $kind  The reader dir's basename.
	 */
	private static function reader_stamp( string $group, string $root, string $kind ): ?string {
		return \str_contains( $root, ':' ) ? null : "{$group}:{$root}:{$kind}";
	}

	/**
	 * Whether a spoke's `SSE_Out_Node::open_subscription()` would read a
	 * subscription past its group and its traversal guard: a stamp's shape,
	 * once each `*` stands for a name character, with no `*` opening the
	 * name and none under `sources/`, whose registry is looked up by name. A
	 * bare group name passes, as it did the guard: `stamp_for()` refuses that
	 * dir with a message that teaches. `sources/<name>` and a worker's IPC
	 * channel are each served before the guard, and their own readers judge
	 * the name. A reader stamp takes no glob, so it passes exactly when
	 * `is_stamp()` does.
	 *
	 * @param string $sub A candidate subscription.
	 * @return bool True when the spoke would resolve it.
	 */
	public static function is_subscription( string $sub ): bool {
		if ( self::is_reader_stamp( $sub ) ) {
			return ! self::is_glob( $sub ) && self::is_stamp( $sub );
		}
		$parts = \explode( '/', $sub );
		$last  = \end( $parts );
		return \strlen( $sub ) <= self::MAX_STAMP_BYTES
			&& ! \str_starts_with( $last, '*' )
			&& Log_Sources::is_valid_name( \str_replace( '*', 'a', $last ) )
			&& match ( \count( $parts ) ) {
				1 => true,
				2 => self::is_prefix( $parts[0] ) && ( self::SOURCES_PREFIX !== $parts[0] || ! self::is_glob( $sub ) ),
				default => false,
			};
	}

	/**
	 * Per root in `GROUPS`, the first-level dirs `groups()` could not read and
	 * so left out, by basename; the catalog reports each as unavailable.
	 *
	 * @return array<string,list<string>>
	 * @throws \RuntimeException Through `groups()`.
	 */
	public static function unreadable(): array {
		self::groups();
		return self::$cached_unreadable;
	}

	/**
	 * Every partition dir under each root in `GROUPS`, keyed by root, in
	 * sorted order: its basename, or under one of `READER_GROUPS` a broker
	 * reader's `<root>/<kind>`, which `stamp_for()` reads either way, in the
	 * place of the root `broker_roots()` finds. The `logs` entry repeats
	 * `on_disk()`, which a caller wanting that root alone reads instead.
	 *
	 * A root with no directory and a root whose first-level scan fails both
	 * yield an empty list rather than a missing key, so a caller may index all
	 * three without checking first. A first-level dir under one of
	 * `READER_GROUPS` that will not read lists in `unreadable()` instead, so
	 * one root-owned dir costs only its own place.
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
			$pattern = self::path( $base_dir, $group, '*' );
			$dirs    = self::glob( $pattern, \GLOB_ONLYDIR ) ?? [];
			[ $roots, $unreadable ] = [] !== $dirs && \in_array( $group, self::READER_GROUPS, true )
				? self::readable_roots( $pattern, $dirs )
				: [ [], [] ];
			$names = [];
			self::$cached_unreadable[ $group ] = \array_map( '\basename', $unreadable );
			foreach ( \array_diff( $dirs, $unreadable ) as $dir ) {
				$name = \basename( $dir );
				if ( ! isset( $roots[ $dir ] ) ) {
					$names[] = $name;
					continue;
				}
				foreach ( $roots[ $dir ] as $kind ) {
					$names[] = "{$name}/{$kind}";
				}
			}
			$groups[ $group ] = $names;
		}
		return self::$cached_groups = $groups;
	}

	/**
	 * `broker_roots()` over one group's first-level dirs, and the dirs that
	 * would not read: one glob over them all, and only when it fails one per
	 * dir, so a dir that will not read is named and costs no other its place.
	 *
	 * @param string       $pattern The group's first-level glob.
	 * @param list<string> $dirs    The dirs it matched.
	 * @return array{0:array<string,list<string>>,1:list<string>} Root dir => kinds, then the dirs that would not read.
	 */
	private static function readable_roots( string $pattern, array $dirs ): array {
		$roots = self::broker_roots( $pattern );
		if ( null !== $roots ) {
			return [ $roots, [] ];
		}
		$roots      = [];
		$unreadable = [];
		foreach ( $dirs as $dir ) {
			$found = self::broker_roots( $dir );
			if ( null === $found ) {
				$unreadable[] = $dir;
				continue;
			}
			$roots += $found;
		}
		return [ $roots, $unreadable ];
	}

	/**
	 * The broker roots among the dirs `$pattern` matches, each with its
	 * readers' kinds, sorted: a dir holding no segment whose subdirs do. A
	 * subdir holding none is no reader yet, and a root nested a level deeper
	 * is none at all. One glob reads every match and its subdirs, and a
	 * segment check runs on each candidate root alone. `GLOB_ERR` stops a
	 * glob on a dir that will not read rather than skipping it, so that
	 * answers null.
	 *
	 * @param string $pattern An absolute first-level glob under one of `READER_GROUPS`.
	 * @return array<string,list<string>>|null Root dir => its kinds, or null on a read fault.
	 */
	private static function broker_roots( string $pattern ): ?array {
		$files = self::glob( "{$pattern}/*/*.log", \GLOB_ERR );
		if ( null === $files ) {
			return null;
		}
		$kinds = [];
		foreach ( self::segments( $files ) as $file ) {
			$kinds[ \dirname( $file, 2 ) ][ \basename( \dirname( $file ) ) ] = true;
		}
		$roots = [];
		foreach ( $kinds as $root => $readers ) {
			$own = self::glob( "{$root}/*.log", \GLOB_ERR );
			if ( null === $own ) {
				return null;
			}
			if ( [] === self::segments( $own ) ) {
				$names = \array_map( '\strval', \array_keys( $readers ) );
				\sort( $names );
				$roots[ $root ] = $names;
			}
		}
		return $roots;
	}

	/**
	 * The files among `$files` a Partition writes as segments.
	 *
	 * @param list<string> $files Paths.
	 * @return list<string>
	 */
	private static function segments( array $files ): array {
		return \array_values( \array_filter( $files, static fn ( string $file ): bool => 1 === \preg_match( Partition_Node::SEGMENT_PATTERN, \basename( $file ) ) ) );
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
		$matches = self::glob( self::path( Config::get_base_directory(), 'logs', '*' ), \GLOB_ONLYDIR ) ?? [];
		return self::$cached = \array_map( '\basename', $matches );
	}

	/**
	 * A path under one root.
	 *
	 * @param string $base  The runtime base.
	 * @param string $group A `GROUPS` root.
	 * @param string $name  A dir name or a glob.
	 */
	private static function path( string $base, string $group, string $name ): string {
		return self::root( $base, $group ) . "/{$name}";
	}

	/**
	 * One root's dir: the one place `{base}/{group}` is spelled, so a reader
	 * outside this class names a root it cannot misspell.
	 *
	 * @param string $base  The runtime base.
	 * @param string $group A `GROUPS` root.
	 * @throws \InvalidArgumentException On a name `GROUPS` lacks.
	 */
	public static function root( string $base, string $group ): string {
		if ( ! \in_array( $group, self::GROUPS, true ) ) {
			throw new \InvalidArgumentException( \esc_html( "no log root named '{$group}'" ) );
		}
		return "{$base}/{$group}";
	}

	/**
	 * The paths a pattern matches, sorted, through the `$glob` seam; null on
	 * an I/O fault, where `glob()` answers false and a no-match `[]`.
	 *
	 * @param string $pattern An absolute glob pattern.
	 * @param int    $flags   `GLOB_ONLYDIR` for dirs, `GLOB_ERR` to stop on an unreadable one.
	 * @return list<string>|null
	 */
	private static function glob( string $pattern, int $flags ): ?array {
		$glob    = self::$glob ?? static fn ( string $pattern, int $flags ): array|false => \glob( $pattern, $flags );
		$matches = $glob( $pattern, $flags );
		if ( ! \is_array( $matches ) ) {
			return null;
		}
		\sort( $matches );
		return $matches;
	}

	/**
	 * The name this site gives one spoke's log in its own probe channel:
	 * `remote/<vault_id>:<kind>`, the spoke's Vault id and the stamp's kind.
	 * A spoke's `firehose.p0` and this site's own are two logs, so they carry
	 * two names (ADR-29). Neither a Vault id nor a stamp carries `:`, so the
	 * first `:` parts the two.
	 *
	 * @param string $vault_id The spoke's Vault id.
	 * @param string $stamp    The stamp the spoke gives the log.
	 * @return string The remote log's name.
	 * @throws \InvalidArgumentException On a Vault id the Vault refuses.
	 */
	public static function remote_for( string $vault_id, string $stamp ): string {
		if ( ! Vault::is_valid_id( $vault_id ) ) {
			throw new \InvalidArgumentException( \esc_html( "remote log of an invalid vault id: {$vault_id}" ) );
		}
		return self::REMOTE_PREFIX . "/{$vault_id}:" . self::kind_of( $stamp );
	}

	/**
	 * The kind a stamp's reader takes: the sibling slot a broker publishes it
	 * under, its name's suffix and its sidecars' directory. The stamp's `/`
	 * is spelled `:`, because the Router splits a TO on `/` and a step reply
	 * returns addressed to that reader's name. `stamp_of()` reads it back,
	 * and `tests/fixtures/log-kinds.json` holds the two to one case list. A
	 * broker reader's stamp names a dir no stream carries, and its kind would
	 * fold back into three dirs, so it is refused.
	 *
	 * @param string $stamp A partition dir or `sources/<name>`.
	 * @return string The kind.
	 * @throws \InvalidArgumentException On a broker reader's stamp.
	 */
	public static function kind_of( string $stamp ): string {
		if ( self::is_reader_stamp( $stamp ) ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers; escape at the view, not the runtime.
			throw new \InvalidArgumentException( "a broker reader's stamp names a dir, not a kind: {$stamp}" );
		}
		return \str_replace( '/', ':', $stamp );
	}

	/**
	 * The registry name a `sources/<name>` stamp carries, or null for anything
	 * else, a string no stamp names included. It reads through `is_stamp()`
	 * and `split()`, so it never throws, and a caller holding a path or a
	 * stamp can ask which it has.
	 *
	 * @param string $stamp A path or a stamp.
	 * @return string|null The name after the prefix, or null.
	 */
	public static function source_name( string $stamp ): ?string {
		if ( ! self::is_stamp( $stamp ) ) {
			return null;
		}
		[ $group, $name ] = self::split( $stamp );
		return self::SOURCES_PREFIX === $group ? $name : null;
	}

	/**
	 * The one reader of a subscription: its group, then the rest; a FROM
	 * trail reads through `dir_from_stamp()` instead. A bare stamp is a
	 * `logs` dir; one opening `{prefix}/` names that root, or for `sources`
	 * a registry entry; a broker reader's stamp names its group, and its
	 * `<root>/<kind>` as the rest. `logs/x` is refused rather than aliased to bare `x`,
	 * so one log has one spelling, and so is any prefix outside
	 * `STAMP_PREFIXES`, which keeps a caller's prefix out of every path
	 * built from it. The rest is returned whole; the guard judges its shape.
	 *
	 * @param string $stamp A stamp, or a subscription glob.
	 * @return array{0:string,1:string} The group, then the rest.
	 * @throws \InvalidArgumentException On an explicit `logs/` or an unknown prefix.
	 */
	public static function split( string $stamp ): array {
		$reader = self::reader_parts( $stamp );
		if ( null !== $reader ) {
			return [ $reader[0], "{$reader[1]}/{$reader[2]}" ];
		}
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
	 * Whether a subscription brings records stamped `$stamp`: its own name
	 * exactly, or a glob whose `*` matches within one path segment, as
	 * `dirs_matching()` globs it, and never a broker reader's stamp, which
	 * is one segment no glob names. Every other character is
	 * literal, `?` and `[` included, which is why this is not `fnmatch()`.
	 *
	 * @param string $sub   A subscription, as `subscribe` lists it.
	 * @param string $stamp A record's stamp, as `dir_from_stamp()` reads it.
	 * @return bool True when the subscription carries the stamp.
	 */
	public static function carries( string $sub, string $stamp ): bool {
		if ( ! self::is_glob( $sub ) ) {
			return $sub === $stamp;
		}
		if ( self::is_reader_stamp( $stamp ) ) {
			return false;
		}
		$pattern = \implode( '[^/]*', \array_map( static fn ( string $part ): string => \preg_quote( $part, '#' ), \explode( '*', $sub ) ) );
		return 1 === \preg_match( "#^{$pattern}$#D", $stamp );
	}

	/**
	 * Whether a subscription is a glob, whose stamps only what the spoke
	 * finds names: a `*` anywhere in it.
	 *
	 * @param string $sub A subscription, a pair's source as written.
	 */
	public static function is_glob( string $sub ): bool {
		return \str_contains( $sub, '*' );
	}

	/**
	 * The stamp a FROM breadcrumb opens with, and the inverse of
	 * `stamp_for()`: a stamp opening with one of `STAMP_PREFIXES` keeps its
	 * second segment, any other is the first path segment alone, a broker
	 * reader's stamp included, which holds no `/`. No bare stamp is a prefix,
	 * because `stamp_for()` refuses that dir. Reading the leading segments
	 * rather than the whole string is what lets a full routing path resolve
	 * too. `tests/fixtures/log-stamps.json` holds it to
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
	 * The spoke and the kind a remote log's name carries, the inverse of
	 * `remote_for()`; null for any name it did not write, a local stamp
	 * included. `tests/fixtures/log-remotes.json` holds it to the browser's
	 * `remoteOf()`.
	 *
	 * @param string $name A probe record's SOURCE.
	 * @return array{vault_id:string,kind:string}|null
	 */
	public static function remote_of( string $name ): ?array {
		$prefix = self::REMOTE_PREFIX . '/';
		if ( ! \str_starts_with( $name, $prefix ) || \str_contains( \substr( $name, \strlen( $prefix ) ), '/' ) ) {
			return null;
		}
		$parts = \explode( ':', \substr( $name, \strlen( $prefix ) ), 2 );
		if ( 2 !== \count( $parts ) || '' === $parts[0] || '' === $parts[1] ) {
			return null;
		}
		return [
			'vault_id' => $parts[0],
			'kind'     => $parts[1],
		];
	}

	/**
	 * Drop both memoized scans. `newspack-nodes.php` hooks this to
	 * `Config::RESET_ACTION`, which `Config::reset()` fires.
	 */
	public static function reset(): void {
		self::$cached            = null;
		self::$cached_groups     = null;
		self::$cached_unreadable = [];
	}

	/**
	 * The one reader of a broker reader's stamp: its group, its root and its
	 * kind, cut at its first two colons, when the group is one of
	 * `READER_GROUPS` and the root holds no `/`; null for any other string. It
	 * judges no name, which `is_stamp()` does, and
	 * `tests/fixtures/reader-stamps.json` holds it to `src/runtime/log-stamp.js`.
	 *
	 * @param string $candidate A string that may be a reader stamp.
	 * @return array{0:string,1:string,2:string}|null
	 */
	private static function reader_parts( string $candidate ): ?array {
		$parts = \explode( ':', $candidate, 3 );
		if ( ! isset( $parts[2] ) || ! \in_array( $parts[0], self::READER_GROUPS, true ) || \str_contains( $parts[1], '/' ) ) {
			return null;
		}
		return [ $parts[0], $parts[1], $parts[2] ];
	}

	/**
	 * The stamp a kind names, the inverse of `kind_of()`: a stamp never
	 * carries `:`, so every `:` in a kind spells a `/`. A reader stamp is a
	 * kind of no stamp, and folding one would split it into three dirs, so
	 * it is refused.
	 *
	 * @param string $kind A reader's kind, or its directory's basename.
	 * @return string The stamp.
	 * @throws \InvalidArgumentException On a broker reader's stamp.
	 */
	public static function stamp_of( string $kind ): string {
		if ( self::is_reader_stamp( $kind ) ) {
			// phpcs:ignore WordPress.Security.EscapeOutput.ExceptionNotEscaped -- plain-text message for log/CLI consumers; escape at the view, not the runtime.
			throw new \InvalidArgumentException( "a broker reader's stamp names a dir, not a kind: {$kind}" );
		}
		return \str_replace( ':', '/', $kind );
	}

	/**
	 * Whether a string has a broker reader's stamp's shape, as
	 * `reader_parts()` reads it, before `is_stamp()` judges its names. No kind
	 * folds out of one and no glob carries one, and a broker pair, which cuts
	 * at its first `:`, refuses one as its source.
	 *
	 * @param string $candidate A stamp, a kind or a pair token.
	 */
	public static function is_reader_stamp( string $candidate ): bool {
		return null !== self::reader_parts( $candidate );
	}

	/**
	 * Whether a string is a stamp a record may carry: one name, or one of
	 * `STAMP_PREFIXES` other than `logs` and one name, each name a registry
	 * name as `Log_Sources::is_valid_name()` reads it, so it opens with a name
	 * character and holds no `..`, and the whole at most `MAX_STAMP_BYTES`.
	 * A bare prefix is no stamp, since `stamp_for()` refuses that dir, and nor
	 * is `logs/<name>`, which `stamp_for()` never writes. A broker reader's
	 * stamp, `<group>:<root>:<kind>`, takes a root `ROOT_PATTERN` admits and
	 * a kind `kind_of()` writes for some stamp, each at most
	 * `MAX_STAMP_BYTES`. A stamp names directories on the hub reading it, so
	 * one from a remote is held to this before it names any.
	 *
	 * @param string $stamp A candidate stamp.
	 * @return bool True when it names one dir and nothing above it.
	 */
	public static function is_stamp( string $stamp ): bool {
		$reader = self::reader_parts( $stamp );
		if ( null !== $reader ) {
			return self::is_root( $reader[1] ) && self::is_kind( $reader[2] );
		}
		$parts = \explode( '/', $stamp );
		return \strlen( $stamp ) <= self::MAX_STAMP_BYTES && match ( \count( $parts ) ) {
			1 => ! \in_array( $stamp, self::STAMP_PREFIXES, true ) && Log_Sources::is_valid_name( $stamp ),
			2 => self::is_prefix( $parts[0] ) && Log_Sources::is_valid_name( $parts[1] ),
			default => false,
		};
	}

	/**
	 * Whether a broker root's name is one `ROOT_PATTERN` admits, holding no
	 * `..`, within one directory name.
	 *
	 * @param string $root A reader stamp's root.
	 */
	private static function is_root( string $root ): bool {
		return \strlen( $root ) <= self::MAX_STAMP_BYTES && ! \str_contains( $root, '..' ) && 1 === \preg_match( self::ROOT_PATTERN, $root );
	}

	/**
	 * Whether a reader dir's basename is a kind: `kind_of()` of a stamp, which
	 * a reader stamp never is, since a broker reads no reader's dir.
	 *
	 * @param string $kind A reader stamp's kind.
	 */
	private static function is_kind( string $kind ): bool {
		return ! \str_contains( $kind, '/' ) && ! self::is_reader_stamp( $kind ) && self::is_stamp( self::stamp_of( $kind ) );
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
}
