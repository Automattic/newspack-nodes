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

	/**
	 * Per-topology basename cache. Populated lazily by `basenames_for()`;
	 * cleared by `reset()` (also fires on Config::RESET_ACTION via
	 * `Bootstrap::reset_caches`).
	 *
	 * @var array<string,array<string>>
	 */
	private static array $basename_cache = [];

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
	 * Read-only view of the user-dir path. The REST list endpoint
	 * surfaces this so the UI can show the on-disk location.
	 */
	public static function user_dir(): string {
		return self::$user_dir;
	}

	/**
	 * Per-name source breakdown across user + stock dirs. Powers the
	 * REST list endpoint's `source` field. Returns:
	 *   [ name => [ 'user' => ?absolute-path, 'stock' => [ absolute-paths ] ] ]
	 *
	 * `user` is null when no user copy exists; `stock` is empty when
	 * the name isn't in any registered stock dir. A name appears in
	 * the result if it has at least one of either.
	 *
	 * @return array<string,array{user:?string,stock:array<int,string>}>
	 */
	public static function describe(): array {
		$out = [];
		if ( '' !== self::$user_dir && \is_dir( self::$user_dir ) ) {
			foreach ( \glob( self::$user_dir . '/*.tsl' ) ?: [] as $path ) {
				if ( ! \is_file( $path ) ) {
					continue;
				}
				$name                    = \basename( $path, '.tsl' );
				$out[ $name ]['user']    = $path;
				$out[ $name ]['stock'] ??= [];
			}
		}
		foreach ( self::$stock_dirs as $dir ) {
			foreach ( \glob( $dir . '/*.tsl' ) ?: [] as $path ) {
				if ( ! \is_file( $path ) ) {
					continue;
				}
				$name                      = \basename( $path, '.tsl' );
				$out[ $name ]['user']    ??= null;
				$out[ $name ]['stock']   ??= [];
				$out[ $name ]['stock'][]   = $path;
			}
		}
		return $out;
	}

	/**
	 * Return the absolute path to `<name>.tsl` or null if unknown.
	 *
	 * `is_file()` (not `file_exists()`) so callers can trust they got a
	 * readable file path. A directory at `{dir}/{name}.tsl/` would
	 * `file_exists` → true, but `file_get_contents` on a directory returns
	 * `""` (PHP 8.0+) — yielding a 200-OK with an empty body for the
	 * `get_topology` controller. `is_file()` filters that at the source,
	 * pushing the caller down the `null → not_found` branch.
	 */
	public static function resolve( string $name ): ?string {
		if ( '' !== self::$user_dir ) {
			$user_path = self::$user_dir . '/' . $name . '.tsl';
			if ( \is_file( $user_path ) ) {
				return $user_path;
			}
		}
		foreach ( self::$stock_dirs as $dir ) {
			$path = $dir . '/' . $name . '.tsl';
			if ( \is_file( $path ) ) {
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
				if ( ! \is_file( $path ) ) {
					continue;
				}
				$names[ \basename( $path, '.tsl' ) ] = true;
			}
		}
		foreach ( self::$stock_dirs as $dir ) {
			foreach ( \glob( $dir . '/*.tsl' ) ?: [] as $path ) {
				if ( ! \is_file( $path ) ) {
					continue;
				}
				$names[ \basename( $path, '.tsl' ) ] = true;
			}
		}
		return \array_keys( $names );
	}

	/**
	 * Lightweight `var name = value` extractor for supervisor-side
	 * metadata reads (num_partitions, stale_timeout, …) without
	 * executing the topology. Mirrors the `var` builtin's parse rule:
	 * three-token form `var <name> = <value>`, optional trailing `;`,
	 * comments and blank lines skipped, names with `:` rejected.
	 *
	 * Reads the WHOLE file (vars can appear anywhere); supervisor
	 * lookups don't care about ordering relative to make_node lines.
	 *
	 * @return array<string,string>
	 */
	public static function frontmatter( string $name ): array {
		$path = self::resolve( $name );
		if ( null === $path ) {
			return [];
		}
		// phpcs:ignore WordPressVIPMinimum.Performance.FetchingRemoteData.FileGetContentsUnknown
		$contents = (string) \file_get_contents( $path );
		$out      = [];
		foreach ( \explode( "\n", $contents ) as $raw ) {
			// Statements can also be `;`-separated on one line.
			foreach ( \explode( ';', $raw ) as $stmt ) {
				$stmt = \trim( $stmt );
				if ( '' === $stmt || '#' === $stmt[0] ) {
					continue;
				}
				if ( \preg_match( '/^var\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+)$/', $stmt, $m ) ) {
					$out[ $m[1] ] = \trim( $m[2] );
				}
			}
		}
		return $out;
	}

	/**
	 * Build a topology config entry — `[topology, num_partitions, stale_timeout]`
	 * — for a TSL file by reading its frontmatter. Returns null if `$name`
	 * doesn't resolve to a TSL file, so callers can drop typos / stale
	 * option values without crashing the supervisor.
	 *
	 * Shared by the substrate's `Bootstrap::get_topologies()` (synthesizes
	 * entries for admin-UI selections the app didn't publish in its
	 * catalog) and applications' own `newspack_nodes/topologies` filter
	 * callbacks (build the catalog from a `topologies` config list). Each
	 * caller passes the defaults appropriate to its context.
	 */
	public static function synthesize_entry(
		string $name,
		int $default_num_partitions = 1,
		int $default_stale_timeout = Lock::STALE_TIMEOUT
	): ?array {
		if ( null === self::resolve( $name ) ) {
			return null;
		}
		$front = self::frontmatter( $name );
		return [
			'topology'       => $name,
			'num_partitions' => isset( $front['num_partitions'] ) ? (int) $front['num_partitions'] : $default_num_partitions,
			'stale_timeout'  => isset( $front['stale_timeout'] ) ? (int) $front['stale_timeout'] : $default_stale_timeout,
		];
	}

	/**
	 * Basenames declared by `$name`'s topology TSL — every
	 * `make_node Partition <node>:partition <config:logs_dir>/<basename>.log ...`
	 * line contributes one basename. Returns sorted, deduplicated, with the
	 * `.log` suffix stripped. Empty array for unknown topologies and for
	 * topologies that declare no Partition nodes.
	 *
	 * Memoized per-name; cleared by `reset()`.
	 *
	 * @return array<string>
	 */
	public static function basenames_for( string $name ): array {
		if ( isset( self::$basename_cache[ $name ] ) ) {
			return self::$basename_cache[ $name ];
		}
		$path = self::resolve( $name );
		if ( null === $path ) {
			return self::$basename_cache[ $name ] = [];
		}
		// phpcs:ignore WordPressVIPMinimum.Performance.FetchingRemoteData.FileGetContentsUnknown
		$contents = (string) \file_get_contents( $path );
		$seen     = [];
		foreach ( \explode( "\n", $contents ) as $raw ) {
			$line = \trim( $raw );
			if ( '' === $line || '#' === $line[0] ) {
				continue;
			}
			if ( ! \preg_match(
				'/^make_node\s+Partition\s+\S+\s+\S*\/([A-Za-z0-9_-]+)\.log\b/',
				$line,
				$m
			) ) {
				continue;
			}
			$seen[ $m[1] ] = true;
		}
		$out = \array_keys( $seen );
		\sort( $out );
		return self::$basename_cache[ $name ] = $out;
	}

	public static function reset(): void {
		self::$stock_dirs     = [];
		self::$user_dir       = '';
		self::$basename_cache = [];
	}
}
