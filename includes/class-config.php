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

	/** One-time marker so `correct_option_autoload()` sweeps once per install. */
	public const AUTOLOAD_FIXED_OPTION = 'newspack_nodes_autoload_fixed';

	/** Action fired from reset() so dependent Configs can invalidate their caches. */
	public const RESET_ACTION = 'newspack_nodes/config_reset';

	/**
	 * Allowed directories (or subdirectories) for local config override files.
	 *
	 * @var array<int, string>
	 */
	private static $allowed_config_dirs = [
		'/usr/src',
	];

	/** @var array<string, mixed>|null Cached config (file defaults + WordPress options). */
	private static $config = null;

	/** @var array<string, mixed>|null Cached config defaults from files. */
	private static $config_defaults = null;

	/** @var string|null */
	private static ?string $validated_base_directory = null;

	/** @var array<string,string> Memoized base-relative subdirs (logs/locks/offsets); cleared by reset(). */
	private static array $validated_subdirs = [];

	/**
	 * Get the logs directory path ({base}/logs).
	 *
	 * @api
	 * @return string
	 * @throws \RuntimeException If base or logs directory cannot be created or realpath doesn't match.
	 */
	public static function get_logs_directory(): string {
		return self::validated_subdir( 'logs' );
	}

	/**
	 * Memoized `{base}/{sub}` path (created + realpath-checked via ensure_path).
	 *
	 * @throws \RuntimeException If base or the subdir cannot be created or realpath doesn't match.
	 */
	private static function validated_subdir( string $sub ): string {
		return self::$validated_subdirs[ $sub ] ??= self::ensure_path( self::get_base_directory() . '/' . $sub );
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

		$config   = self::load_config();
		$base_dir = $config['base_directory'] ?? null;
		if ( empty( $base_dir ) || ! \is_scalar( $base_dir ) ) {
			throw new \RuntimeException( 'base_directory not configured' );
		}

		self::$validated_base_directory = self::ensure_path( (string) $base_dir );
		return self::$validated_base_directory;
	}

	/**
	 * Load configuration from disk + WordPress options.
	 *
	 * @return array<string, mixed>
	 */
	public static function load_config(): array {
		if ( null !== self::$config ) {
			return self::$config;
		}

		// Presence-based overlay: any stored option wins; only absent falls back.
		$schema = Settings_Schema::get();
		$config = Config_System\Options_Overlay::apply(
			self::load_config_defaults(),
			$schema->overlay_keys(),
			$schema->prefix()
		);

		self::$config = $config;
		return $config;
	}

	/**
	 * Load configuration defaults from file only (no WordPress options).
	 *
	 * @return array<string, mixed>
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
		// Local override (CLI/testing) via env var to an allowed-dir config file.
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

	/**
	 * Get the locks directory path ({base}/locks).
	 *
	 * @return string
	 * @throws \RuntimeException If base or locks directory cannot be created or realpath doesn't match.
	 */
	public static function get_locks_directory(): string {
		return self::validated_subdir( 'locks' );
	}

	/**
	 * Get the offsets directory path ({base}/offsets).
	 *
	 * @return string
	 * @throws \RuntimeException If base or offsets directory cannot be created or realpath doesn't match.
	 */
	public static function get_offsets_directory(): string {
		return self::validated_subdir( 'offsets' );
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
				// Directories derived from the base dir; every other key reads config.
				$derived = [
					'logs_dir'       => 'logs',
					'offsets_dir'    => 'offsets',
					'deadletter_dir' => 'deadletter',
				];
				if ( isset( $derived[ $key ] ) ) {
					return \rtrim( self::get_base_directory(), '/' ) . '/' . $derived[ $key ];
				}
				$cfg = self::load_config();
				return $cfg[ $key ] ?? null;
			}
		);
	}

	/** One-time sweep flipping every schema key to autoloaded (admin_init; no-op on WP < 6.6). */
	public static function correct_option_autoload(): void {
		if ( ! \function_exists( 'wp_set_option_autoload' ) ) {
			return;
		}
		if ( ! empty( \get_option( self::AUTOLOAD_FIXED_OPTION ) ) ) {
			return;
		}
		$schema = Settings_Schema::get();
		foreach ( $schema->overlay_keys() as $key ) {
			\wp_set_option_autoload( $schema->prefix() . $key, true );
		}
		\update_option( self::AUTOLOAD_FIXED_OPTION, '1', false );
	}

	/** Reset cached config; fires `newspack_nodes/config_reset` so dependent Configs invalidate too. */
	public static function reset(): void {
		self::$config                   = null;
		self::$config_defaults          = null;
		self::$validated_base_directory = null;
		self::$validated_subdirs        = [];
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
}
