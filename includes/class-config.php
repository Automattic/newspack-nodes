<?php
/**
 * Newspack Nodes runtime configuration.
 *
 * Owns the substrate-level keys: base_directory, num_partitions, num_segments,
 * segment_size, max_lifespan, memcache_servers, enable_workers,
 * aggregator_servers. Reads WordPress options under the `newspack_nodes_*`
 * prefix. Application plugins (e.g. newspack-event-logger-nodes) own their own
 * application-level Config and can compose this for substrate values.
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
	 * Get core option schema - loaded on every request (autoloaded).
	 *
	 * Plugins can add their core options via the 'newspack_nodes_option_schema_core'
	 * filter. Core options are needed for request logging and hook timing.
	 *
	 * @return array Associative array of option_name => type.
	 */
	private static function get_option_schema_core(): array {
		// Substrate core options.
		$schema = [
			'base_directory' => 'path',
			'num_partitions' => 'int',
			'num_segments'   => 'int',
			'segment_size'   => 'int',
			'max_lifespan'   => 'int',
			'enable_workers' => 'bool',
		];

		// Allow plugins to add their core options.
		if ( \function_exists( 'apply_filters' ) ) {
			$schema = \apply_filters( 'newspack_nodes_option_schema_core', $schema );
		}

		return \is_array( $schema ) ? $schema : [];
	}

	/**
	 * Get extended option schema - only loaded for workers/admin (not autoloaded).
	 *
	 * Plugins can add their extended options via the
	 * 'newspack_nodes_option_schema_extended' filter. Extended options are only
	 * needed by workers and admin settings.
	 *
	 * @return array Associative array of option_name => type.
	 */
	private static function get_option_schema_extended(): array {
		// Substrate extended options.
		$schema = [
			'memcache_servers'   => 'memcache_servers',
			'aggregator_servers' => 'aggregator_servers',
		];

		// Allow plugins to add their extended options.
		if ( \function_exists( 'apply_filters' ) ) {
			$schema = \apply_filters( 'newspack_nodes_option_schema_extended', $schema );
		}

		return \is_array( $schema ) ? $schema : [];
	}

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
			foreach ( self::get_option_schema_core() as $key => $type ) {
				$value = \get_option( "newspack_nodes_{$key}" );
				if ( false !== $value && '' !== $value ) {
					$sanitized = self::sanitize_option( $value, $type );
					if ( null !== $sanitized ) {
						$config[ $key ] = $sanitized;
					}
				}
			}

			// Load extended options only for 'full' mode.
			if ( $is_full ) {
				foreach ( self::get_option_schema_extended() as $key => $type ) {
					$value = \get_option( "newspack_nodes_{$key}" );
					if ( false !== $value && '' !== $value ) {
						$sanitized = self::sanitize_option( $value, $type );
						if ( null !== $sanitized ) {
							$config[ $key ] = $sanitized;
						}
					}
				}
			}
		}

		// Cache the computed config. Late-loading plugins may add to the option
		// schema via the `newspack_nodes_option_schema_core` filter AFTER this
		// call, so the main plugin file hooks a one-shot cache reset on
		// `plugins_loaded` at priority PHP_INT_MIN — see `register_cache_invalidation`
		// below. That guarantees post-plugins_loaded reads pick up the full schema
		// without forcing every pre-plugins_loaded caller to re-run the full
		// filter chain.
		if ( $is_full ) {
			self::$config_full = $config;
		} else {
			self::$config = $config;
		}

		return $config;
	}

	/**
	 * Invalidate cached config so the next load_config() call rebuilds with
	 * the complete schema. Called once on plugins_loaded (see register_cache_invalidation).
	 */
	public static function invalidate_cache(): void {
		self::$config                      = null;
		self::$config_full                 = null;
		self::$config_defaults             = null;
		self::$validated_base_directory    = null;
		self::$validated_logs_directory    = null;
		self::$validated_locks_directory   = null;
		self::$validated_offsets_directory = null;
	}

	/**
	 * Hook a one-shot cache invalidation on plugins_loaded so that any
	 * schema additions registered by late-loading plugins are picked up by
	 * the next load_config() call. Invoked from the plugin main file.
	 */
	public static function register_cache_invalidation(): void {
		static $registered = false;
		if ( $registered ) {
			return;
		}
		$registered = true;
		if ( \function_exists( 'add_action' ) ) {
			\add_action( 'plugins_loaded', [ self::class, 'invalidate_cache' ], PHP_INT_MIN );
		}
	}

	/**
	 * Sanitize an option value based on its type.
	 *
	 * @param mixed  $value The value to sanitize.
	 * @param string $type  The type of sanitization to apply.
	 * @return mixed|null Sanitized value, or null if invalid.
	 */
	private static function sanitize_option( $value, string $type ) {
		switch ( $type ) {
			case 'bool':
				return (bool) $value;

			case 'int':
				if ( ! \is_numeric( $value ) ) {
					return null;
				}
				return (int) $value;

			case 'float':
				if ( ! \is_numeric( $value ) ) {
					return null;
				}
				return (float) $value;

			case 'path':
				// Sanitize path: no null bytes, no .., must be absolute.
				if ( ! \is_string( $value ) ) {
					return null;
				}
				$path = \trim( $value );
				// Reject null bytes and directory traversal.
				if ( false !== \strpos( $path, "\0" ) || false !== \strpos( $path, '..' ) ) {
					return null;
				}
				// Must be absolute path.
				if ( 0 !== \strpos( $path, '/' ) ) {
					return null;
				}
				return $path;

			case 'memcache_servers':
				// Newline-separated host:port list.
				if ( ! \is_string( $value ) ) {
					return null;
				}
				$servers = \array_filter( \array_map( 'trim', \explode( "\n", $value ) ) );
				if ( empty( $servers ) ) {
					return null;
				}
				$validated = [];
				foreach ( $servers as $server ) {
					// Must match host:port pattern.
					if ( \preg_match( '/^[a-zA-Z0-9.\-]+:\d{1,5}$/', $server ) ) {
						$validated[] = $server;
					}
				}
				return empty( $validated ) ? null : $validated;

			case 'array_strings':
				// Sanitize array of strings.
				if ( ! \is_array( $value ) ) {
					return null;
				}
				$result = [];
				foreach ( $value as $k => $v ) {
					if ( \is_string( $v ) ) {
						$result[ self::sanitize_string( $k ) ] = self::sanitize_string( $v );
					} elseif ( \is_bool( $v ) || \is_int( $v ) ) {
						$result[ self::sanitize_string( $k ) ] = $v;
					}
				}
				return $result;

			case 'aggregator_servers':
				// Sanitize aggregator server configs (keyed by server ID).
				if ( ! \is_array( $value ) ) {
					return null;
				}
				$result = [];
				foreach ( $value as $server_id => $config ) {
					if ( ! \is_array( $config ) ) {
						continue;
					}
					$server_id = self::sanitize_string( $server_id );
					if ( empty( $server_id ) ) {
						continue;
					}
					$url = $config['url'] ?? '';
					// URL must be https.
					if ( ! \is_string( $url ) || 0 !== \strpos( $url, 'https://' ) ) {
						continue;
					}
					$result[ $server_id ] = [
						'url'           => \esc_url_raw( $url ),
						'auth_username' => self::sanitize_string( $config['auth_username'] ?? '' ),
						'auth_password' => self::sanitize_string( $config['auth_password'] ?? '' ),
						'enabled'       => (bool) ( $config['enabled'] ?? true ),
					];
				}
				return $result;

			default:
				// Unknown type - reject.
				return null;
		}
	}

	/**
	 * Sanitize a string value.
	 *
	 * Uses WordPress sanitize_text_field if available.
	 * Throws RuntimeException if WordPress unavailable (fail-fast pattern).
	 *
	 * @param mixed $value The value to sanitize.
	 * @return string Sanitized string.
	 * @throws \RuntimeException If sanitize_text_field unavailable.
	 */
	private static function sanitize_string( $value ): string {
		$value = (string) $value;
		if ( ! \function_exists( 'sanitize_text_field' ) ) {
			throw new \RuntimeException( 'sanitize_text_field unavailable - WordPress required for sanitization' );
		}
		return \sanitize_text_field( $value );
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

		// Seed with the runtime's base_dir filter, so callers always see a
		// non-empty base_directory even before any file overlay loads.
		$config = [
			'base_directory' => \function_exists( 'apply_filters' )
				? (string) \apply_filters( 'newspack_nodes/base_dir', '/tmp/newspack-nodes' )
				: '/tmp/newspack-nodes',
		];

		// Load main config file.
		$config_path = \dirname( __DIR__ ) . '/newspack-nodes-config.php';
		if ( \file_exists( $config_path ) ) {
			$config = self::load_config_file( $config, $config_path );
		}

		// Load local override if specified (for CLI/testing).
		$local_config_file = \getenv( 'LOCAL_NEWSPACK_NODES_CONF' );
		if ( $local_config_file ) {
			$validated_path = self::validate_config_path( $local_config_file );
			if ( $validated_path && \file_exists( $validated_path ) ) {
				$config = self::load_config_file( $config, $validated_path );
			}
		}

		self::$config_defaults = $config;

		return self::$config_defaults;
	}

	/**
	 * Validate that a config file path is within allowed directories.
	 *
	 * Security: Prevents arbitrary file include via environment variable.
	 *
	 * @param string $path The path to validate.
	 * @return string|null The validated real path, or null if invalid.
	 */
	private static function validate_config_path( string $path ): ?string {
		// Reject null bytes (path injection).
		if ( false !== \strpos( $path, "\0" ) ) {
			// phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
			\error_log( 'Newspack_Nodes\\Config::validate_config_path() failed: null byte in path' );
			return null;
		}

		// Must be a .php file.
		if ( '.php' !== \substr( $path, -4 ) ) {
			// phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
			\error_log( \sprintf( 'Newspack_Nodes\\Config::validate_config_path() failed: not .php file (%s)', \preg_replace( '/[\x00-\x1f\x7f]/', '', $path ) ) );
			return null;
		}

		// Check if path is within allowed directories.
		$real_path = null;
		foreach ( self::$allowed_config_dirs as $allowed_dir ) {
			$real_path = self::is_within( $path, $allowed_dir );
			if ( $real_path ) {
				break;
			}
		}

		// Also allow plugin directory itself.
		if ( ! $real_path ) {
			$plugin_dir = \dirname( __DIR__ );
			$real_path  = self::is_within( $path, $plugin_dir );
		}

		if ( ! $real_path ) {
			// phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
			\error_log( \sprintf( 'Newspack_Nodes\\Config::validate_config_path() failed: path not found or not in allowed directories (%s)', \preg_replace( '/[\x00-\x1f\x7f]/', '', $path ) ) );
		}

		return $real_path;
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
	 * Check if a path is within a base directory.
	 *
	 * Resolves the path to its canonical form and checks containment.
	 * Returns the canonical path on success, null on failure.
	 *
	 * @param string $path Path to check.
	 * @param string $base Base directory that path must be within.
	 * @return string|null Canonical path if within base, null otherwise.
	 */
	private static function is_within( string $path, string $base ): ?string {
		$real_path = \realpath( $path );
		$real_base = \realpath( $base );

		if ( false === $real_path || false === $real_base ) {
			return null;
		}

		// Must be within base directory.
		$real_base = \rtrim( $real_base, '/' ) . '/';
		$within    = 0 === \strpos( $real_path, $real_base ) || $real_path === \rtrim( $real_base, '/' );

		return $within ? $real_path : null;
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

	/**
	 * Load a PHP config file.
	 *
	 * @param array  $config      Hash of config options.
	 * @param string $config_file Path to config file.
	 * @return array
	 */
	private static function load_config_file( array $config, string $config_file ): array {
		if ( ! \file_exists( $config_file ) ) {
			return $config;
		}

		// Load PHP config file (returns array).
		// Note: This executes PHP code. Allowed directories should be tightly controlled.
		$parsed_config = require $config_file;
		if ( \is_array( $parsed_config ) && self::validate_config_values( $parsed_config ) ) {
			$config = [ ...$config, ...$parsed_config ];
		} else {
			// phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
			\error_log( 'Newspack_Nodes\\Config::load_config_file() rejected: config must return array of scalar/array values only' );
		}

		return $config;
	}

	/**
	 * Validate that config values contain only safe types (scalars and arrays).
	 *
	 * Security: Rejects objects, closures, and resources that could execute code
	 * or leak sensitive data when the config is serialized or accessed.
	 *
	 * @param mixed $value Value to validate.
	 * @param int   $depth Current recursion depth.
	 * @return bool True if value contains only safe types.
	 */
	private static function validate_config_values( $value, int $depth = 0 ): bool {
		// Prevent excessive recursion.
		if ( $depth > 10 ) {
			return false;
		}

		// Allow scalars (string, int, float, bool) and null.
		if ( \is_scalar( $value ) || null === $value ) {
			return true;
		}

		// Allow arrays, validate contents recursively.
		if ( \is_array( $value ) ) {
			foreach ( $value as $v ) {
				if ( ! self::validate_config_values( $v, $depth + 1 ) ) {
					return false;
				}
			}
			return true;
		}

		// Reject objects, closures, resources, etc.
		return false;
	}
}
