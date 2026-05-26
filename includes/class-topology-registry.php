<?php
/**
 * Topology_Registry — name → .tsl path resolver.
 *
 * Plugins register stock dirs; the writable user dir shadows stock by name.
 * Resolution: user dir first, then each stock dir in registration order.
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

	/** @var array<string,array<string>> Per-topology basename cache; cleared by reset(). */
	private static array $basename_cache = [];

	/** @var array<string,array<string,int>> Memoized per-Partition segment_size overrides by topology name. */
	private static array $segment_size_overrides_cache = [];

	/** @var array<string,bool> Guards register_plugin against double-wiring (a second call would double-spawn). */
	private static array $registered_plugins = [];

	/**
	 * Worker-spawn seam for spawn_worker's default handler. Lazily defaulted
	 * to a closure that builds + executes the real Worker_Base. Tests reassign in
	 * setUp to capture the spawn intent without forking a worker process — that
	 * leaves the guard + expand_workers lookup running as real production code.
	 * Signature: `function ( string $type, int $partition, string $topology_name, int $stale_timeout ): void`.
	 *
	 * @var \Closure|null
	 */
	public static ?\Closure $spawn_runner = null;

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

	/** Read-only view of the user-dir path. */
	public static function user_dir(): string {
		return self::$user_dir;
	}

	/**
	 * Per-name source breakdown across user + stock dirs (powers the REST list `source` field).
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
	 * Return the absolute path to `<name>.tsl` or null if unknown (is_file, not file_exists).
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
	 * Lightweight `var name = value` extractor for supervisor metadata reads (no topology execution).
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
	 * Build a `[topology, num_partitions, stale_timeout]` entry from a TSL's frontmatter; null if unknown.
	 */
	public static function synthesize_entry(
		string $name,
		int $default_num_partitions = 1,
		int $default_stale_timeout = Lock_Node::STALE_TIMEOUT
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
	 * Log basenames declared by `$name`'s Partition nodes (sorted, deduped, `.log` stripped). Memoized.
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

	/**
	 * Per-Partition literal segment_size overrides from `$name`'s TSL (`{basename => int}`). Memoized.
	 *
	 * Token-substituted values are omitted; the caller falls back to the global default.
	 *
	 * @return array<string,int>
	 */
	public static function segment_size_overrides_for( string $name ): array {
		if ( isset( self::$segment_size_overrides_cache[ $name ] ) ) {
			return self::$segment_size_overrides_cache[ $name ];
		}
		$path = self::resolve( $name );
		if ( null === $path ) {
			return self::$segment_size_overrides_cache[ $name ] = [];
		}
		// phpcs:ignore WordPressVIPMinimum.Performance.FetchingRemoteData.FileGetContentsUnknown
		$contents  = (string) \file_get_contents( $path );
		$overrides = [];
		foreach ( \explode( "\n", $contents ) as $raw ) {
			$line = \trim( $raw );
			if ( '' === $line || '#' === $line[0] ) {
				continue;
			}
			// Capture basename ($m[1]) + segment_size arg ($m[2]); filter on int after the match.
			if ( ! \preg_match(
				'/^make_node\s+Partition\s+\S+\s+\S*\/([A-Za-z0-9_-]+)\.log\s+\S+\s+(\S+)/',
				$line,
				$m
			) ) {
				continue;
			}
			if ( \ctype_digit( $m[2] ) ) {
				$overrides[ $m[1] ] = (int) $m[2];
			}
		}
		return self::$segment_size_overrides_cache[ $name ] = $overrides;
	}

	/**
	 * Register a plugin's topologies: a node-namespace prefix + a stock dir.
	 *
	 * Topologies are NOT owned by the registering plugin. The catalog is built
	 * from `list()` (user dir ∪ every stock dir) by `publish_catalog`, and any
	 * active topology is spawned by `spawn_worker` regardless of which plugin — if
	 * any — shipped it. This call only makes a plugin's `*_Node` classes resolvable
	 * (`register_namespace`) and its `.tsl` files discoverable (`register_stock_dir`).
	 */
	public static function register_plugin( string $namespace_prefix, string $topologies_dir ): void {
		// Idempotent: repeated plugins_loaded passes must not re-register.
		$key = $namespace_prefix . '|' . \rtrim( $topologies_dir, '/' );
		if ( isset( self::$registered_plugins[ $key ] ) ) {
			return;
		}
		self::$registered_plugins[ $key ] = true;

		\Newspack_Nodes\Command_Interpreter_Node::register_namespace( $namespace_prefix );
		self::register_stock_dir( $topologies_dir );
	}

	/**
	 * `newspack_nodes/topologies` catalog filter: synthesize an entry for every
	 * `.tsl` in `list()` (user-authored + every registered stock dir), so the
	 * catalog reflects what exists on disk, not a per-plugin allowlist. Registered
	 * once by the substrate (newspack-nodes.php). num_partitions defaults to the
	 * operator-overridable substrate option (clamped 1..16); a topology's own
	 * `var num_partitions` frontmatter overrides via synthesize_entry.
	 *
	 * @param array<string,array> $topologies Existing catalog (a prior contributor wins on key collision).
	 * @return array<string,array>
	 */
	public static function publish_catalog( array $topologies ): array {
		$cfg        = \Newspack_Nodes\Config::load_config();
		$default_np = \max( 1, \min( 16, (int) ( $cfg['num_partitions'] ?? 1 ) ) );
		foreach ( self::list() as $name ) {
			if ( isset( $topologies[ $name ] ) ) {
				continue;
			}
			$entry = self::synthesize_entry( $name, $default_np, Lock_Node::STALE_TIMEOUT );
			if ( null !== $entry ) {
				$topologies[ $name ] = $entry;
			}
		}
		return $topologies;
	}

	/**
	 * `newspack_nodes/spawn_worker` handler: spawn the {type, partition} worker iff
	 * it is in the active set (`Bootstrap::expand_workers()`) — ungated by plugin
	 * ownership. Fires `newspack_nodes/before_worker_spawn` (app runtime init)
	 * right before building the worker, then runs the `$spawn_runner` seam (which
	 * defaults to a real Worker_Base execution). A type with no active descriptor
	 * is a no-op. Registered once by the substrate (newspack-nodes.php).
	 */
	public static function spawn_worker( string $type, int $partition ): void {
		foreach ( \Newspack_Nodes\Bootstrap::expand_workers() as $w ) {
			if ( $w['type'] !== $type || (int) $w['partition'] !== $partition ) {
				continue;
			}
			$runner = self::$spawn_runner ?? static function ( string $t, int $p, string $topology_name, int $stale ): void {
				$base_dir   = \Newspack_Nodes\Bootstrap::base_dir();
				$nonce_salt = \defined( 'NONCE_SALT' ) ? \NONCE_SALT : '';
				$supervisor = new \Newspack_Nodes\Supervisor( $base_dir, $nonce_salt );
				$wb         = new \Newspack_Nodes\Worker_Base( $base_dir, $t, $p, stale_timeout: $stale );
				$topology   = static function ( \Newspack_Nodes\Command_Interpreter_Node $ci, int $partition_arg ) use ( $topology_name ): void {
					\Newspack_Nodes\Topology_Loader::load( $topology_name, $partition_arg, $ci );
				};
				$wb->execute( $topology, \rest_url( 'newspack-nodes/v1/workers/spawn' ), $supervisor->generate_spawn_token( \time() ) );
			};
			// App runtime init (autoload, filters) before Topology_Loader::load parses the TSL — only when we actually spawn.
			\do_action( 'newspack_nodes/before_worker_spawn', $type, $partition );
			$runner( (string) $w['type'], (int) $w['partition'], (string) $w['topology'], (int) $w['stale_timeout'] );
			break;
		}
	}

	/** Drop only the parsed caches, keeping the dir registrations (wired to Config::RESET_ACTION). */
	public static function reset_basename_cache(): void {
		self::$basename_cache               = [];
		self::$segment_size_overrides_cache = [];
	}

	public static function reset(): void {
		self::$stock_dirs         = [];
		self::$user_dir           = '';
		self::$registered_plugins = [];
		self::reset_basename_cache();
	}
}
