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
	 * Worker-spawn seam for register_plugin's default handler. Lazily defaulted
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
	 * One-call registration for a plugin whose topologies live in $topologies_dir.
	 *
	 * Wires the four things a topology-running plugin otherwise hand-rolls:
	 * namespace resolution, the stock dir, a `newspack_nodes/topologies` catalog
	 * contribution per owned topology, and a `spawn_worker` handler GUARDED to the
	 * owned names (so it never collides with another plugin's handler).
	 * `$names = null` publishes every `*.tsl` in $topologies_dir.
	 *
	 * The spawn handler fires `newspack_nodes/before_worker_spawn` ($type, $partition)
	 * right before building an owned worker, so a listener can run runtime init
	 * (autoload, filter registration) before Topology_Loader::load parses the TSL.
	 * `$num_partitions = null` resolves the operator-overridable substrate option
	 * (`newspack_nodes_num_partitions`); any value (option- or arg-derived) is
	 * clamped to 1..16.
	 */
	public static function register_plugin(
		string $namespace_prefix,
		string $topologies_dir,
		?array $names = null,
		?int $num_partitions = null,
		int $stale_timeout = 60
	): void {
		// Idempotent: a repeat call (same prefix+dir) would double-wire the spawn handler → double worker spawn.
		$key = $namespace_prefix . '|' . \rtrim( $topologies_dir, '/' );
		if ( isset( self::$registered_plugins[ $key ] ) ) {
			return;
		}
		self::$registered_plugins[ $key ] = true;

		// Null → inherit the operator-overridable substrate partition count; clamp 1..16 either way.
		if ( null === $num_partitions ) {
			$cfg            = \Newspack_Nodes\Config::load_config();
			$num_partitions = (int) ( $cfg['num_partitions'] ?? 1 );
		}
		$num_partitions = \max( 1, \min( 16, $num_partitions ) );

		\Newspack_Nodes\Command_Interpreter_Node::register_namespace( $namespace_prefix );
		self::register_stock_dir( $topologies_dir );

		// Owned topology names = the explicit subset, or every *.tsl basename in THIS dir.
		$own = $names;
		if ( null === $own ) {
			$own = [];
			foreach ( \glob( \rtrim( $topologies_dir, '/' ) . '/*.tsl' ) ?: [] as $path ) {
				$own[] = \basename( $path, '.tsl' );
			}
		}

		// Publish catalog entries for owned topologies (don't clobber an existing key).
		\add_filter(
			'newspack_nodes/topologies',
			static function ( array $topologies ) use ( $own, $num_partitions, $stale_timeout ): array {
				foreach ( $own as $name ) {
					if ( isset( $topologies[ $name ] ) ) {
						continue;
					}
					$entry = self::synthesize_entry( $name, $num_partitions, $stale_timeout );
					if ( null !== $entry ) {
						$topologies[ $name ] = $entry;
					}
				}
				return $topologies;
			}
		);

		// Default spawn handler — GUARDED to owned names.
		\add_action(
			'newspack_nodes/spawn_worker',
			static function ( string $type, int $partition ) use ( $own ): void {
				if ( ! \in_array( $type, $own, true ) ) {
					return; // Not ours — let the owning plugin handle it.
				}
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
					// App runtime init (autoload, filters) before Topology_Loader::load parses the TSL — fires once, only when we actually spawn.
					\do_action( 'newspack_nodes/before_worker_spawn', $type, $partition );
					$runner( (string) $w['type'], (int) $w['partition'], (string) $w['topology'], (int) $w['stale_timeout'] );
					break;
				}
			},
			10,
			2
		);
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
