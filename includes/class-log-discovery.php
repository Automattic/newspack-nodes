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
	 * under a root of its own there, `<root>/<stamp>`, which stamps as
	 * `<group>:<root>:<stamp>` (ADR-29).
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

	/** The stamp prefix naming a `Log_Sources` registry entry: `sources:<name>`. */
	public const SOURCES_PREFIX = 'sources';

	/**
	 * The prefix naming a spoke's log in this site's own probe channel,
	 * `remote:<vault_id>:<stamp>`, which `remote_for()` writes and
	 * `remote_of()` alone reads. It is not a stamp prefix: a remote name is a
	 * probe record's SOURCE, never a FROM, a subscription or a dir.
	 */
	public const REMOTE_PREFIX = 'remote';

	/**
	 * Every prefix a stamp may open with, before its first `:`: the reader
	 * roots, and `SOURCES_PREFIX`, which names a registry entry rather than a
	 * dir. A `logs` dir stamps bare.
	 */
	public const STAMP_PREFIXES = [ ...self::READER_GROUPS, self::SOURCES_PREFIX ];

	/**
	 * The longest dir name a stamp's part may spell, in bytes: NAME_MAX. A
	 * log's stamp is held to it whole, and a broker reader's
	 * `<group>:<root>:<stamp>` part by part, because its dir is
	 * `<root>/<stamp>`: the root and the stamp it reads each name one dir and
	 * the whole names none. A broker takes a stamp as its reader's dir name,
	 * so it reads only a stamp `fits_a_dir_name()` admits.
	 */
	public const MAX_STAMP_BYTES = 255;

	/**
	 * A broker root's name: a Vault id's letters, digits, `_` and `-`, in
	 * either case, and the `.` a topology joins it with, opening with no `.`.
	 * It holds neither `/` nor `:`, so a reader stamp's first `:` after its
	 * group ends the root; `..` is refused apart.
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
	 * base: the stamp `is_stamp()` admits for a first-level dir under one of
	 * `GROUPS`, so a `logs` dir reads as its Consumers name it, or for a
	 * broker reader's dir under one of `READER_GROUPS`, so it reads as the
	 * catalog lists it; the relative path for any other dir, a dir no stamp
	 * names included (`ipc/<worker>/output`, a quarantine named for a dir
	 * holding a `:`), since a basename names many dirs. It never throws.
	 *
	 * @param string $relative The log's path under the runtime base.
	 * @return string The record's SOURCE.
	 */
	public static function source_for( string $relative ): string {
		$parts = \explode( '/', $relative, 2 );
		$depth = \substr_count( $relative, '/' );
		$under = [ 1 => self::GROUPS, 2 => self::READER_GROUPS ][ $depth ] ?? [];
		if ( ! isset( $parts[1] ) || ! \in_array( $parts[0], $under, true ) || self::holds_colon_name( $parts[1] ) ) {
			return $relative;
		}
		$stamp = self::stamp_for( $parts[0], $parts[1] );
		return self::is_stamp( $stamp ) ? $stamp : $relative;
	}

	/**
	 * The dir a stamp names under `$base`, or null when none is there: the
	 * stream's guard, then a direct path. A glob, a registry stamp and any
	 * name the guard refuses are refused, so no stamp reaches a dir the
	 * stream would not. It reads no listing: a broker's root and a Consumer's
	 * cursor are both one flat name, which no shape tells apart, so a root
	 * resolves to its dir, which holds no segments.
	 *
	 * @param string $stamp A dir stamp: `firehose.p0`, `offsets:…`, `deadletter:…`, `offsets:<root>:<stamp>`.
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
	 * `dir_of()` applies; `*` matches within one stamp part, so a dir whose
	 * name holds a `:` is not a match, as `carries()` reads it, and an exact
	 * reader stamp matches its own dir. A broker's root is not a match, as the
	 * catalog lists none, and a glob reaches none of its readers, since no
	 * glob names a root. A match whose stamp `is_stamp()` refuses is left out,
	 * so a glob opens no dir `dir_of()` would refuse. A glob I/O fault
	 * answers null rather than an empty map, so a caller never mistakes it
	 * for "nothing there".
	 *
	 * @param string $sub  A subscription glob: `firehose.*`, `offsets:…*`.
	 * @param string $base The runtime base the roots sit under.
	 * @return array<string,string>|null Stamp => absolute dir, or null on a fault, a dir under a matched root that will not read included.
	 * @throws \InvalidArgumentException On a glob the guard refuses.
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
			$name = \substr( $dir, $skip );
			if ( self::holds_colon_name( $name ) ) {
				continue;
			}
			$stamp = self::stamp_for( $group, $name );
			if ( self::is_stamp( $stamp ) ) {
				$dirs[ $stamp ] = $dir;
			}
		}
		return $dirs;
	}

	/**
	 * The stamp naming a dir under one of `GROUPS`: a `logs` dir stays bare
	 * and a grouped one takes `<group>:`, so one directory has one spelling
	 * wherever it is named — an SSE frame's FROM and a Partition record's
	 * SOURCE alike. A broker reader's `<root>/<stamp>` dir under one of
	 * `READER_GROUPS` stamps as `<group>:<root>:<stamp>`, its stamp as it sits
	 * on disk. Every stamp is one FROM segment, so a log may take a group's
	 * name; a first-level dir holding a `:` would read back as another, so it
	 * is refused by name.
	 *
	 * @param string $group The root group the dir sits under.
	 * @param string $path  The dir's basename, or a reader's `<root>/<stamp>`.
	 * @return string The stamp.
	 * @throws \InvalidArgumentException On a first-level dir holding a `:`.
	 */
	public static function stamp_for( string $group, string $path ): string {
		if ( self::holds_colon_name( $path ) ) {
			throw new \InvalidArgumentException( \esc_html( "log dir {$path} holds a colon, which a stamp reads as a separator; rename it" ) );
		}
		$rest = \implode( ':', \explode( '/', $path, 2 ) );
		return 'logs' === $group ? $rest : "{$group}:{$rest}";
	}

	/**
	 * Whether a path under a root names a first-level dir holding a `:`, which
	 * a stamp would read back as a group, a root or a broker reader: such a
	 * dir has no stamp. `stamp_for()` refuses it, `source_for()` names it by
	 * its path, and `dirs_matching()` skips it.
	 *
	 * @param string $path A dir's name, or a reader's `<root>/<stamp>`.
	 */
	private static function holds_colon_name( string $path ): bool {
		return \str_contains( \explode( '/', $path, 2 )[0], ':' );
	}

	/**
	 * A dir subscription through the stream's guard, and the path it names: a
	 * `GROUPS` root only, and a glob `is_subscription()` admits or a stamp
	 * `is_stamp()` reads. The rest's first `:`, which only a broker reader's
	 * `<root>:<stamp>` holds, is the `/` between its root and its stamp.
	 *
	 * @param string $sub  A dir stamp or subscription glob.
	 * @param string $base The runtime base the roots sit under.
	 * @param bool   $glob Whether `*` may appear.
	 * @return array{0:string,1:string} The group, then the path.
	 * @throws \InvalidArgumentException On a subscription the guard refuses.
	 */
	private static function guarded( string $sub, string $base, bool $glob ): array {
		[ $group, $rest ] = self::split( $sub );
		$shaped           = $glob ? self::is_subscription( $sub ) : self::is_stamp( $sub );
		if ( ! $shaped || ! \in_array( $group, self::GROUPS, true ) ) {
			throw new \InvalidArgumentException( \esc_html( "invalid subscription: {$sub}" ) );
		}
		return [ $group, self::path( $base, $group, \implode( '/', \explode( ':', $rest, 2 ) ) ) ];
	}

	/**
	 * Whether a spoke's `SSE_Out_Node::open_subscription()` would read a
	 * subscription past its group and its traversal guard: a stamp, or a glob
	 * whose rest is one name once each `*` stands for a name character, with
	 * no `*` opening it and none under `sources:`, whose registry is looked up
	 * by name. A glob's `*` matches within one stamp part, so no glob names a
	 * broker reader. `sources:<name>` and a worker's IPC channel are each
	 * served before the guard, and their own readers judge the name.
	 *
	 * @param string $sub A candidate subscription.
	 * @return bool True when the spoke would resolve it.
	 */
	public static function is_subscription( string $sub ): bool {
		if ( ! self::is_glob( $sub ) ) {
			return self::is_stamp( $sub );
		}
		[ $group, $rest ] = self::split( $sub );
		return \strlen( $sub ) <= self::MAX_STAMP_BYTES
			&& self::SOURCES_PREFIX !== $group
			&& ! \str_starts_with( $rest, '*' )
			&& Log_Sources::is_valid_name( \str_replace( '*', 'a', $rest ) );
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
	 * reader's `<root>/<stamp>`, which `stamp_for()` reads either way, in the
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
				foreach ( $roots[ $dir ] as $stamp ) {
					$names[] = "{$name}/{$stamp}";
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
	 * @return array{0:array<string,list<string>>,1:list<string>} Root dir => reader stamps, then the dirs that would not read.
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
	 * readers' stamps, sorted: a dir holding no segment whose subdirs do. A
	 * subdir holding none is not a reader yet, and a root nested a level deeper
	 * is not one at all. One glob reads every match and its subdirs, and a
	 * segment check runs on each candidate root alone. `GLOB_ERR` stops a
	 * glob on a dir that will not read rather than skipping it, so that
	 * answers null.
	 *
	 * @param string $pattern An absolute first-level glob under one of `READER_GROUPS`.
	 * @return array<string,list<string>>|null Root dir => its readers' stamps, or null on a read fault.
	 */
	private static function broker_roots( string $pattern ): ?array {
		$files = self::glob( "{$pattern}/*/*.log", \GLOB_ERR );
		if ( null === $files ) {
			return null;
		}
		$stamps = [];
		foreach ( self::segments( $files ) as $file ) {
			$stamps[ \dirname( $file, 2 ) ][ \basename( \dirname( $file ) ) ] = true;
		}
		$roots = [];
		foreach ( $stamps as $root => $readers ) {
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
	 * The registry name a `sources:<name>` stamp carries, or null for anything
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
	 * Whether a subscription brings records stamped `$stamp`: its own name
	 * exactly, or a glob whose `*` matches within one stamp part, as
	 * `dirs_matching()` globs it, so no glob carries a broker reader's stamp.
	 * Every other character is literal, `?` and `[` included, which is why
	 * this is not `fnmatch()`.
	 *
	 * @param string $sub   A subscription, as `subscribe` lists it.
	 * @param string $stamp A record's stamp, as `dir_from_stamp()` reads it.
	 * @return bool True when the subscription carries the stamp.
	 */
	public static function carries( string $sub, string $stamp ): bool {
		if ( ! self::is_glob( $sub ) ) {
			return $sub === $stamp;
		}
		$pattern = \implode( '[^/:]*', \array_map( static fn ( string $part ): string => \preg_quote( $part, '#' ), \explode( '*', $sub ) ) );
		return 1 === \preg_match( "#^{$pattern}$#D", $stamp );
	}

	/**
	 * Whether a subscription is a glob, whose stamps only what the spoke
	 * finds names: a `*` anywhere in it.
	 *
	 * @param string $sub A subscription, a broker's source as written.
	 */
	public static function is_glob( string $sub ): bool {
		return \str_contains( $sub, '*' );
	}

	/**
	 * The name this site gives one spoke's log in its own probe channel:
	 * `remote:<vault_id>:<stamp>`, the spoke's Vault id and its stamp. A
	 * spoke's `firehose.p0` and this site's own are two logs, so they carry
	 * two names (ADR-29). A Vault id carries no `:`, so the first `:` after
	 * the prefix parts the two.
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
		return self::REMOTE_PREFIX . ":{$vault_id}:{$stamp}";
	}

	/**
	 * The stamp a streamed record's FROM opens with: its first `/` segment,
	 * by position alone, because every stamp is one segment and every segment
	 * after it is a node name, many of which hold `:` (`requests:consumer`,
	 * `_cli:4471`). Nothing reads a trail's shape to find a stamp.
	 * `tests/fixtures/log-stamps.json` holds it to `src/runtime/log-stamp.js`.
	 *
	 * @param string $from A FROM path beginning with a stamp.
	 * @return string The stamp it opens with.
	 */
	public static function dir_from_stamp( string $from ): string {
		return \explode( '/', $from, 2 )[0];
	}

	/**
	 * The spoke and the stamp a remote log's name carries, the inverse of
	 * `remote_for()`; null for any name it did not write, a local stamp
	 * included. `tests/fixtures/log-remotes.json` holds it to the browser's
	 * `remoteOf()`.
	 *
	 * @param string $name A probe record's SOURCE.
	 * @return array{vault_id:string,stamp:string}|null
	 */
	public static function remote_of( string $name ): ?array {
		$parts = \explode( ':', $name, 3 );
		if ( 3 !== \count( $parts ) || self::REMOTE_PREFIX !== $parts[0] || '' === $parts[1] || '' === $parts[2] || \str_contains( $name, '/' ) ) {
			return null;
		}
		return [
			'vault_id' => $parts[1],
			'stamp'    => $parts[2],
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
	 * Whether a string is a stamp a record may carry: a `logs` or `sources:`
	 * name as `Log_Sources::is_valid_name()` reads it, so it opens with a name
	 * character and holds no `:`, `/` or `..`, the whole within
	 * `MAX_STAMP_BYTES`; or under one of `READER_GROUPS`, such a name, or a
	 * broker reader's `<root>:<stamp>`, its root one `ROOT_PATTERN` admits and
	 * the stamp it reads one `fits_a_dir_name()` admits, each within
	 * `MAX_STAMP_BYTES`. The rest's own `:` tells the two apart, since no name
	 * holds one, so the shape reads no disk. A stamp names directories on the
	 * hub reading it, so one from a remote is held to this before it names any.
	 *
	 * @param string $stamp A candidate stamp.
	 * @return bool True when it names one dir and nothing above it.
	 */
	public static function is_stamp( string $stamp ): bool {
		[ $group, $rest ] = self::split( $stamp );
		$reader           = \in_array( $group, self::READER_GROUPS, true ) ? \explode( ':', $rest, 2 ) : [ $rest ];
		return isset( $reader[1] )
			? \strlen( $reader[0] ) <= self::MAX_STAMP_BYTES && self::is_root( $reader[0] ) && self::fits_a_dir_name( $reader[1] )
			: \strlen( $stamp ) <= self::MAX_STAMP_BYTES && Log_Sources::is_valid_name( $rest );
	}

	/**
	 * Whether a stamp may name a dir of its own: one `is_stamp()` admits and
	 * holds within `MAX_STAMP_BYTES` whole, as a broker reader's dir, named the
	 * stamp it reads, must.
	 *
	 * @param string $stamp A candidate stamp.
	 */
	public static function fits_a_dir_name( string $stamp ): bool {
		return \strlen( $stamp ) <= self::MAX_STAMP_BYTES && self::is_stamp( $stamp );
	}

	/**
	 * Whether a broker root's name is one `ROOT_PATTERN` admits, holding no
	 * `..`.
	 *
	 * @param string $root A reader stamp's root.
	 */
	private static function is_root( string $root ): bool {
		return ! \str_contains( $root, '..' ) && 1 === \preg_match( self::ROOT_PATTERN, $root );
	}

	/**
	 * The one reader of a stamp's parts: its group, then the rest, cut at its
	 * first `:` when what precedes it is one of `STAMP_PREFIXES`; any other
	 * stamp is a `logs` dir's name, whole. It judges nothing, so `logs:x`,
	 * `remote:…` and `offsets/x` read as names `is_stamp()` then refuses, and
	 * a caller's prefix never reaches a path. Only a stamp context reads
	 * through it — a subscription, a broker's source, a catalog key — never a
	 * FROM trail, whose segments after the stamp are node names.
	 *
	 * @param string $stamp A stamp, or a subscription glob.
	 * @return array{0:string,1:string} The group, then the rest.
	 */
	public static function split( string $stamp ): array {
		$parts = \explode( ':', $stamp, 2 );
		return isset( $parts[1] ) && \in_array( $parts[0], self::STAMP_PREFIXES, true ) ? [ $parts[0], $parts[1] ] : [ 'logs', $stamp ];
	}
}
