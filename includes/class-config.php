<?php
/**
 * Newspack Nodes runtime configuration.
 *
 * Owns the substrate-level keys: base_directory, num_partitions, num_segments,
 * segment_size, max_lifespan, memcache_servers. Reads WordPress options
 * under the `newspack_nodes_*` prefix. Application plugins (e.g.
 * newspack-event-logger-nodes) own their own application-level Config
 * and can compose this for substrate values; aggregator-related keys
 * (`aggregator_servers`) and the hub designation (`enable_workers`) are
 * application-owned and live in the event-logger plugin's Config.
 *
 * Mirrors the application Config layout so callers see a familiar API
 * (`load_config`, `get_base_directory`, etc.).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

if ( ! \defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Substrate configuration management class.
 */
class Config {
	/**
	 * Cached config (file defaults + WordPress options).
	 *
	 * @var array|null
	 */
	private static $config = null;

	/**
	 * Cached full config (includes extended options).
	 *
	 * @var array|null
	 */
	private static $config_full = null;

	/**
	 * Cached config defaults from files.
	 *
	 * @var array|null
	 */
	private static $config_defaults = null;

	/**
	 * Cached validated base directory.
	 *
	 * @var string|null
	 */
	private static ?string $validated_base_directory = null;

	/**
	 * Cached validated logs directory.
	 *
	 * @var string|null
	 */
	private static ?string $validated_logs_directory = null;

	/**
	 * Cached validated locks directory.
	 *
	 * @var string|null
	 */
	private static ?string $validated_locks_directory = null;

	/**
	 * Cached validated offsets directory.
	 *
	 * @var string|null
	 */
	private static ?string $validated_offsets_directory = null;

	/**
	 * Core options are needed for request logging and hook timing.
	 */
	private static $option_schema_core = [
		'base_directory' => 'path',
		'num_partitions' => 'int',
		'num_segments'   => 'int',
		'segment_size'   => 'int',
		'max_lifespan'   => 'int',
		// Flat list of active topology names. Each entry must
		// resolve via Topology_Registry. The supervisor spawns
		// one worker fleet per entry, named after the topology.
		// Substrate ships an empty default; application plugins
		// (or per-deployment config files) populate it.
		'topologies'     => 'array_strings',
	];

	/**
	 * Extended options are only needed by workers and admin settings.
	 */
	private static $option_schema_extended = [
		'memcache_servers' => 'memcache_servers',
	];

	/**
	 * Allowed directories for local config override files.
	 *
	 * Only config files within these directories (or subdirectories) are allowed.
	 */
	private static $allowed_config_dirs = [
		'/usr/src',
	];

	/**
	 * Load configuration from disk + WordPress options.
	 *
	 * @param string $mode 'core' (default) loads only options needed for request logging.
	 *                     'full' loads all options including worker/admin settings.
	 * @return array Configuration array.
	 */
	public static function load_config( string $mode = 'core' ): array {
		$is_full = 'full' === $mode;

		// Return cached config if available.
		if ( $is_full && null !== self::$config_full ) {
			return self::$config_full;
		}
		if ( ! $is_full && null !== self::$config ) {
			return self::$config;
		}

		// Load from disk.
		$config = self::load_config_defaults();

		// Override with WordPress options (with sanitization).
		if ( \defined( 'ABSPATH' ) && \function_exists( 'get_option' ) ) {
			// Always load core options.
			foreach ( self::$option_schema_core as $key => $type ) {
				$value = \get_option( "newspack_nodes_{$key}" );
				if ( false !== $value && '' !== $value ) {
					$sanitized = Config_Utils::sanitize_option( $value, $type );
					if ( null !== $sanitized ) {
						$config[ $key ] = $sanitized;
					}
				}
			}

			// Load extended options only for 'full' mode.
			if ( $is_full ) {
				foreach ( self::$option_schema_extended as $key => $type ) {
					$value = \get_option( "newspack_nodes_{$key}" );
					if ( false !== $value && '' !== $value ) {
						$sanitized = Config_Utils::sanitize_option( $value, $type );
						if ( null !== $sanitized ) {
							$config[ $key ] = $sanitized;
						}
					}
				}
			}
		}

		if ( $is_full ) {
			self::$config_full = $config;
		} else {
			self::$config = $config;
		}

		return $config;
	}

	/**
	 * Load configuration defaults from file only (no WordPress options).
	 *
	 * @return array Configuration defaults from file.
	 */
	public static function load_config_defaults(): array {
		if ( null !== self::$config_defaults ) {
			return self::$config_defaults;
		}


		$config = Config_Utils::load_config_file(
			[],
			\dirname( __DIR__ ) . '/newspack-nodes-config.php',
			'Newspack_Nodes\\Config'
		);
		// Local override (for CLI/testing) — env var points at an
		// alternate config file inside the allowed directories.
		$local_config_file = \getenv( 'LOCAL_NEWSPACK_NODES_CONF' );
		if ( $local_config_file ) {
			$validated_path = self::validate_config_path( $local_config_file );
			if ( $validated_path ) {
				$config = Config_Utils::load_config_file(
					$config,
					$validated_path,
					'Newspack_Nodes\\Config'
				);
			}
		}

		self::$config_defaults = $config;

		return self::$config_defaults;
	}

	/**
	 * Validate a config-override path against the substrate's allowed
	 * directories (plus the plugin dir itself as a fallback). Wraps
	 * Config_Utils::validate_config_path with the substrate's list.
	 */
	private static function validate_config_path( string $path ): ?string {
		$dirs = [ ...self::$allowed_config_dirs, \dirname( __DIR__ ) ];
		return Config_Utils::validate_config_path( $path, $dirs, 'Newspack_Nodes\\Config' );
	}

	/**
	 * Reset cached config - call before load_config() to get fresh values.
	 */
	public static function reset(): void {
		self::$config                      = null;
		self::$config_full                 = null;
		self::$config_defaults             = null;
		self::$validated_base_directory    = null;
		self::$validated_logs_directory    = null;
		self::$validated_locks_directory   = null;
		self::$validated_offsets_directory = null;
	}

	/**
	 * Drop WordPress's per-process `alloptions` / `notoptions` snapshots.
	 *
	 * `wp_load_alloptions()` caches into a static var on first call and
	 * never re-reads, so any `get_option()` for an autoloaded option
	 * returns whatever was cached at the start of the PHP process.
	 * Long-lived workers (Supervisor, Job/Request workers) need to
	 * invalidate this between work cycles to see admin / cross-worker
	 * option writes.
	 *
	 * Pair with `Config::reset()` when the caller also reads merged
	 * config — `reset()` only invalidates the in-memory `Config` cache
	 * but its rebuild still reads through `get_option`, so without
	 * invalidating `alloptions` first the rebuild gets stale values too.
	 */
	public static function invalidate_options_cache(): void {
		if ( \function_exists( 'wp_cache_delete' ) ) {
			\wp_cache_delete( 'alloptions', 'options' );
			\wp_cache_delete( 'notoptions', 'options' );
		}
	}

	/**
	 * Ensure a directory path exists and is canonical.
	 *
	 * Creates the directory if it doesn't exist, then validates that
	 * realpath() matches the input (detects symlink attacks).
	 *
	 * @param string $path Directory path to ensure.
	 * @return string Validated canonical path.
	 * @throws \RuntimeException If path cannot be created or is not canonical.
	 */
	public static function ensure_path( string $path ): string {
		// Reject null bytes before any filesystem operations.
		if ( false !== \strpos( $path, "\0" ) ) {
			throw new \RuntimeException( 'Path contains null byte' );
		}

		$path = \rtrim( $path, '/' );

		if ( ! \is_dir( $path ) ) {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
			@\mkdir( $path, 0755, true );
		}

		// realpath() returns false if path doesn't exist or isn't accessible.
		$real = \realpath( $path );
		if ( false === $real ) {
			throw new \RuntimeException(
				\sprintf( 'Failed to create directory: %s', \esc_html( $path ) )
			);
		}

		// Canonical path must match input (prevents symlink attacks).
		if ( $real !== $path ) {
			throw new \RuntimeException(
				\sprintf(
					'Path %s resolves to %s - symlink or path traversal detected',
					\esc_html( $path ),
					\esc_html( $real )
				)
			);
		}

		return $real;
	}

	/**
	 * Get the validated base directory path.
	 *
	 * Returns the configured base_directory after validating that realpath() matches.
	 * Creates the directory if it doesn't exist. If realpath differs from the
	 * configured path, a symlink attack may be in progress.
	 *
	 * @return string Validated absolute path to base directory.
	 * @throws \RuntimeException If directory cannot be created or realpath doesn't match.
	 */
	public static function get_base_directory(): string {
		if ( null !== self::$validated_base_directory ) {
			return self::$validated_base_directory;
		}

		$config = self::load_config();
		if ( empty( $config['base_directory'] ) ) {
			throw new \RuntimeException( 'base_directory not configured' );
		}

		self::$validated_base_directory = self::ensure_path( $config['base_directory'] );
		return self::$validated_base_directory;
	}

	/**
	 * Get the logs directory path ({base}/logs).
	 *
	 * @return string Validated absolute path to logs directory.
	 */
	public static function get_logs_directory(): string {
		if ( null !== self::$validated_logs_directory ) {
			return self::$validated_logs_directory;
		}
		self::$validated_logs_directory = self::ensure_path( self::get_base_directory() . '/logs' );
		return self::$validated_logs_directory;
	}

	/**
	 * Get the locks directory path ({base}/locks).
	 *
	 * @return string Validated absolute path to locks directory.
	 */
	public static function get_locks_directory(): string {
		if ( null !== self::$validated_locks_directory ) {
			return self::$validated_locks_directory;
		}
		self::$validated_locks_directory = self::ensure_path( self::get_base_directory() . '/locks' );
		return self::$validated_locks_directory;
	}

	/**
	 * Get the offsets directory path ({base}/offsets).
	 *
	 * @return string Validated absolute path to offsets directory.
	 */
	public static function get_offsets_directory(): string {
		if ( null !== self::$validated_offsets_directory ) {
			return self::$validated_offsets_directory;
		}
		self::$validated_offsets_directory = self::ensure_path( self::get_base_directory() . '/offsets' );
		return self::$validated_offsets_directory;
	}

	/**
	 * Force-restart any worker locks whose names start with one of the given
	 * group prefixes.
	 *
	 * Called on plugin deactivation. Walks `{base_dir}/locks/*.lock.d/`,
	 * matches each directory name against the supplied group names, and
	 * fires `Lock::request_restart()` per match. The current lock holder
	 * polls `should_restart()` from its drain loop and exits cleanly the
	 * next tick — no SIGTERM, no force-kill, no race with active writes.
	 *
	 * Lock dir naming convention: `{group}.p{N}.lock.d` (per-partition) or
	 * `{group}.lock.d` (singleton). Both forms are handled by the prefix
	 * match.
	 *
	 * Failures (missing locks dir, unreadable entries, Lock instantiation
	 * problems) are swallowed: deactivation is best-effort, never fatal.
	 *
	 * @param string[] $groups Group-name prefixes to match against lock-dir basenames.
	 */
	public static function kill_readers( array $groups ): void {
		if ( empty( $groups ) ) {
			return;
		}

		try {
			$locks_dir = self::get_locks_directory();
		} catch ( \Throwable $e ) {
			return;
		}

		$entries = @\scandir( $locks_dir );
		if ( false === $entries ) {
			return;
		}

		foreach ( $entries as $entry ) {
			if ( '.' === $entry || '..' === $entry ) {
				continue;
			}
			// Only act on lock dirs.
			if ( '.lock.d' !== \substr( $entry, -7 ) ) {
				continue;
			}
			$path = "{$locks_dir}/{$entry}";
			if ( ! \is_dir( $path ) ) {
				continue;
			}

			// Match by group prefix.
			$matched = false;
			foreach ( $groups as $group ) {
				$group = (string) $group;
				if ( '' === $group ) {
					continue;
				}
				if ( $entry === "{$group}.lock.d"
					|| 0 === \strpos( $entry, "{$group}.p" )
				) {
					$matched = true;
					break;
				}
			}
			if ( ! $matched ) {
				continue;
			}

			try {
				( new Lock( $path ) )->request_restart();
			} catch ( \Throwable $e ) {
				// Best-effort; carry on with the next dir.
				continue;
			}
		}
	}

}
