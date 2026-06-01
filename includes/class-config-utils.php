<?php
/**
 * Config_Utils — static sanitize / validate / path-guard helpers shared by every Config class.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Config_Utils {
	/**
	 * Sanitize an option value by type (bool/int/float/path/memcache_servers/array_strings).
	 *
	 * @param mixed  $value Raw option value.
	 * @param string $type  Schema-declared type tag.
	 * @return mixed|null Sanitized value, or null if invalid / unknown type.
	 */
	public static function sanitize_option( $value, string $type ) {
		switch ( $type ) {
			case 'bool':
				return (bool) $value;

			case 'int':
				return \is_numeric( $value ) ? (int) $value : null;

			case 'float':
				return \is_numeric( $value ) ? (float) $value : null;

			case 'path':
				if ( ! \is_string( $value ) ) {
					return null;
				}
				$path = \trim( $value );
				// Reject null bytes, directory traversal, relative paths.
				if ( false !== \strpos( $path, "\0" )
					|| false !== \strpos( $path, '..' )
					|| 0 !== \strpos( $path, '/' )
				) {
					return null;
				}
				return $path;

			case 'memcache_servers':
				if ( ! \is_string( $value ) ) {
					return null;
				}
				$servers = \array_filter( \array_map( 'trim', \explode( "\n", $value ) ) );
				if ( empty( $servers ) ) {
					return null;
				}
				$validated = [];
				foreach ( $servers as $server ) {
					if ( \preg_match( '/^[a-zA-Z0-9.\-]+:\d{1,5}$/', $server ) ) {
						$validated[] = $server;
					}
				}
				return empty( $validated ) ? null : $validated;

			case 'array_strings':
				if ( ! \is_array( $value ) ) {
					return null;
				}
				$result = [];
				foreach ( $value as $k => $v ) {
					if ( \is_string( $v ) ) {
						$result[ self::sanitize_string( $k ) ] = self::sanitize_string( $v );
					} elseif ( \is_bool( $v ) || \is_int( $v ) ) {
						// e.g. custom_events stores `event_name => true`.
						$result[ self::sanitize_string( $k ) ] = $v;
					}
				}
				return $result;

			default:
				return null;
		}
	}

	/**
	 * sanitize_text_field wrapper that throws outside WordPress instead of passing through.
	 *
	 * @param mixed $value Raw value, cast to string before sanitizing.
	 * @throws \RuntimeException If WordPress is not loaded.
	 */
	public static function sanitize_string( $value ): string {
		$value = (string) $value;
		if ( ! \function_exists( 'sanitize_text_field' ) ) {
			throw new \RuntimeException( 'sanitize_text_field unavailable - WordPress required for sanitization' );
		}
		return \sanitize_text_field( $value );
	}

	/**
	 * Validate a config file path is a `.php` within an allowed dir; null otherwise.
	 *
	 * @param string   $path             Path to validate.
	 * @param string[] $allowed_dirs     Roots the path must live under.
	 * @param string   $error_log_prefix Disambiguates error_log lines across callers.
	 */
	public static function validate_config_path(
		string $path,
		array $allowed_dirs,
		string $error_log_prefix = 'Config_Utils'
	): ?string {
		if ( false !== \strpos( $path, "\0" ) ) {
			Core::stderr( "{$error_log_prefix}::validate_config_path() failed: null byte in path" );
			return null;
		}
		if ( '.php' !== \substr( $path, -4 ) ) {
			$safe = \preg_replace( '/[\x00-\x1f\x7f]/', '', $path );
			Core::stderr( "{$error_log_prefix}::validate_config_path() failed: not .php file ({$safe})" );
			return null;
		}
		foreach ( $allowed_dirs as $allowed_dir ) {
			$real_path = self::is_within( $path, $allowed_dir );
			if ( $real_path ) {
				return $real_path;
			}
		}
		$safe = \preg_replace( '/[\x00-\x1f\x7f]/', '', $path );
		Core::stderr( "{$error_log_prefix}::validate_config_path() failed: path not found or not in allowed directories ({$safe})" );
		return null;
	}

	/** Path containment check; returns the canonical real path, or null on failure. */
	public static function is_within( string $path, string $base ): ?string {
		$real_path = \realpath( $path );
		$real_base = \realpath( $base );
		if ( false === $real_path || false === $real_base ) {
			return null;
		}
		$real_base = \rtrim( $real_base, '/' ) . '/';
		$within    = 0 === \strpos( $real_path, $real_base )
			|| $real_path === \rtrim( $real_base, '/' );
		return $within ? $real_path : null;
	}

	/**
	 * True if $value is only scalars/arrays (depth-bounded); rejects objects/closures/resources.
	 *
	 * @param mixed $value Value tree to validate.
	 */
	public static function validate_config_values( $value, int $depth = 0 ): bool {
		if ( $depth > 10 ) {
			return false;
		}
		if ( \is_scalar( $value ) || null === $value ) {
			return true;
		}
		if ( \is_array( $value ) ) {
			foreach ( $value as $v ) {
				if ( ! self::validate_config_values( $v, $depth + 1 ) ) {
					return false;
				}
			}
			return true;
		}
		return false;
	}

	/**
	 * Load a PHP config file (validated scalar/array tree) and merge it into $config.
	 *
	 * @param array<string, mixed> $config           Existing config to merge into.
	 * @param string                $config_file      Absolute path to a PHP file returning array.
	 * @param string                $error_log_prefix Disambiguates error_log lines.
	 * @return array<string, mixed>
	 */
	public static function load_config_file(
		array $config,
		string $config_file,
		string $error_log_prefix = 'Config_Utils'
	): array {
		if ( ! \file_exists( $config_file ) ) {
			return $config;
		}
		// Note: this executes PHP. Allowed directories must be tightly controlled.
		$parsed_config = require $config_file;
		if ( \is_array( $parsed_config ) && self::validate_config_values( $parsed_config ) ) {
			return [ ...$config, ...$parsed_config ];
		}
		Core::stderr( "{$error_log_prefix}::load_config_file() rejected: config must return array of scalar/array values only" );
		return $config;
	}
}
