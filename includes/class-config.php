<?php
/**
 * Newspack Nodes runtime configuration.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

if ( ! \defined( 'ABSPATH' ) ) {
	exit;
}

class Config {
	/** Action fired from reset() so dependent Configs can invalidate their caches. */
	public const RESET_ACTION = 'newspack_nodes/config_reset';

	/** One-time marker so `correct_option_autoload()` sweeps once per install. */
	public const AUTOLOAD_FIXED_OPTION = 'newspack_nodes_autoload_fixed';

	/** One-time sweep flipping every schema key to autoloaded (admin_init; no-op on WP < 6.6). */
	public static function correct_option_autoload(): void {
		if ( ! \function_exists( 'wp_set_option_autoload' ) ) {
			return;
		}
		if ( ! empty( \get_option( self::AUTOLOAD_FIXED_OPTION ) ) ) {
			return;
		}
		foreach ( \array_keys( self::$option_schema ) as $key ) {
			\wp_set_option_autoload( "newspack_nodes_{$key}", true );
		}
		\update_option( self::AUTOLOAD_FIXED_OPTION, '1', false );
	}

	/**
	 * Register the substrate's `config` topology-token namespace.
	 *
	 * Resolves `<config:logs_dir>` / `<config:offsets_dir>` (derived from the
	 * base directory) and every other key straight off load_config(). Called
	 * once at boot; the app registers its own namespaces for its own keys.
	 */
	public static function register_token_namespace(): void {
		Core::register_config_namespace(
			'config',
			static function ( string $key ) {
				if ( 'logs_dir' === $key ) {
					return \rtrim( self::get_base_directory(), '/' ) . '/logs';
				}
				if ( 'offsets_dir' === $key ) {
					return \rtrim( self::get_base_directory(), '/' ) . '/offsets';
				}
				$cfg = self::load_config();
				return $cfg[ $key ] ?? null;
			}
		);
	}

	/** @var array|null Cached config (file defaults + WordPress options). */
	private static $config = null;

	/** @var array|null Cached config defaults from files. */
	private static $config_defaults = null;

	/** @var string|null */
	private static ?string $validated_base_directory = null;

	/** @var string|null */
	private static ?string $validated_logs_directory = null;

	/** @var string|null */
	private static ?string $validated_locks_directory = null;

	/** @var string|null */
	private static ?string $validated_offsets_directory = null;

	/** Option schema — every key loaded on every load_config() call (sanitizers in Config_Utils). */
	private static $option_schema = [
		'base_directory'   => 'path',
		'num_partitions'   => 'int',
		'num_segments'     => 'int',
		'segment_size'     => 'int',
		'max_lifespan'     => 'int',
		'memcache_servers' => 'memcache_servers',
		// Flat list of active topology names; one worker fleet per entry.
		'topologies'       => 'array_strings',
	];

	/** Allowed directories (or subdirectories) for local config override files. */
	private static $allowed_config_dirs = [
		'/usr/src',
	];

	/**
	 * Load configuration from disk + WordPress options.
	 *
	 * @return array
	 */
	public static function load_config(): array {
		if ( null !== self::$config ) {
			return self::$config;
		}

		$config = self::load_config_defaults();

		if ( \defined( 'ABSPATH' ) && \function_exists( 'get_option' ) ) {
			foreach ( self::$option_schema as $key => $type ) {
				$value = \get_option( "newspack_nodes_{$key}" );
				if ( false === $value || '' === $value ) {
					continue;
				}
				$value = self::coerce_option_value( $value, $type );
				if ( null !== $value ) {
					$config[ $key ] = $value;
				}
			}
		}

		self::$config = $config;
		return $config;
	}

	/**
	 * XXX cheap type coercion for the WP-option overlay. The write-time
	 * sanitize callbacks store these in their typed shape, but a site that
	 * saved them under older code (or via a raw `update_option`) hands back a
	 * newline string / numeric string. Coerce just enough that consumers see
	 * the schema type — NO `sanitize_text_field` (that per-element cost moved
	 * to write time; this runs on every request). Returns null to fall back to
	 * the file default on non-numeric ints. Remove once stored option data has
	 * been re-saved everywhere.
	 *
	 * @param mixed  $value Raw option value (already past the false/'' skip).
	 * @param string $type  Schema-declared type tag.
	 * @return mixed|null Coerced value, or null to keep the file default.
	 */
	private static function coerce_option_value( $value, string $type ) {
		if ( 'int' === $type ) {
			if ( ! \is_numeric( $value ) ) {
				return null;
			}
			return (int) $value;
		}
		if ( \in_array( $type, [ 'memcache_servers', 'array_strings' ], true ) && \is_string( $value ) ) {
			return \array_values( \array_filter( \array_map( 'trim', \explode( "\n", $value ) ) ) );
		}
		return $value;
	}

	/**
	 * Load configuration defaults from file only (no WordPress options).
	 *
	 * @return array
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
		// Local override (CLI/testing) via env var pointing at an allowed-dir config file.
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

	/** Validate a config-override path against the allowed directories (plus the plugin dir). */
	private static function validate_config_path( string $path ): ?string {
		$dirs = [ ...self::$allowed_config_dirs, \dirname( __DIR__ ) ];
		return Config_Utils::validate_config_path( $path, $dirs, 'Newspack_Nodes\\Config' );
	}

	/** Reset cached config; fires `newspack_nodes/config_reset` so dependent Configs invalidate too. */
	public static function reset(): void {
		self::$config                      = null;
		self::$config_defaults             = null;
		self::$validated_base_directory    = null;
		self::$validated_logs_directory    = null;
		self::$validated_locks_directory   = null;
		self::$validated_offsets_directory = null;
		if ( \function_exists( 'do_action' ) ) {
			\do_action( self::RESET_ACTION );
		}
	}

	/** Drop WP's per-process option snapshots so workers see fresh writes. Pair with (and run before) Config::reset(), which reads through get_option. */
	public static function invalidate_options_cache(): void {
		if ( \function_exists( 'wp_cache_delete' ) ) {
			\wp_cache_delete( 'alloptions', 'options' );
			\wp_cache_delete( 'notoptions', 'options' );
		}
	}

	/**
	 * Ensure a directory path exists and is canonical (realpath must match input — detects symlink attacks).
	 *
	 * @param string $path Directory path to ensure.
	 * @return string Validated canonical path.
	 * @throws \RuntimeException If path cannot be created or is not canonical.
	 */
	public static function ensure_path( string $path ): string {
		if ( false !== \strpos( $path, "\0" ) ) {
			throw new \RuntimeException( 'Path contains null byte' );
		}

		$path = \rtrim( $path, '/' );

		if ( ! \is_dir( $path ) ) {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
			@\mkdir( $path, 0755, true );
		}

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
	 * Get the validated base directory path (created + realpath-checked).
	 *
	 * @return string
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
	 * @return string
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
	 * @return string
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
	 * @return string
	 */
	public static function get_offsets_directory(): string {
		if ( null !== self::$validated_offsets_directory ) {
			return self::$validated_offsets_directory;
		}
		self::$validated_offsets_directory = self::ensure_path( self::get_base_directory() . '/offsets' );
		return self::$validated_offsets_directory;
	}

	/**
	 * Drop a restart flag on worker locks matching the given group prefixes (best-effort).
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
			if ( '.lock.d' !== \substr( $entry, -7 ) ) {
				continue;
			}
			$path = "{$locks_dir}/{$entry}";
			if ( ! \is_dir( $path ) ) {
				continue;
			}

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
				( new Lock_Node( $path ) )->request_restart();
			} catch ( \Throwable $e ) {
				continue;
			}
		}
	}

}
