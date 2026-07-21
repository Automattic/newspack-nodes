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
	 * Load a PHP config file (validated scalar/array tree) and merge it into $config.
	 *
	 * @param array<string, mixed> $config           Existing config to merge into.
	 * @param string                $config_file      Absolute path to a PHP file returning array.
	 * @param string                $error_log_prefix Disambiguates failure messages across callers.
	 * @return array<string, mixed>
	 * @throws \RuntimeException If the config file returns an invalid value tree.
	 */
	public static function load_config_file(
		array $config,
		string $config_file,
		string $error_log_prefix = 'Config_Utils'
	): array {
		if ( ! \file_exists( $config_file ) ) {
			return $config;
		}
		// Executes PHP; callers must pass a trusted path.
		$parsed_config = require $config_file;
		if ( \is_array( $parsed_config ) && self::validate_config_values( $parsed_config ) ) {
			// require'd config: dynamic array; validated above as scalar/array.
			/** @var array<string,mixed> $parsed_config */
			return [ ...$config, ...$parsed_config ];
		}
		throw new \RuntimeException(
			\sprintf(
				'%s::load_config_file() rejected: config must return array of scalar/array values only',
				\esc_html( $error_log_prefix )
			)
		);
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
	 * Resolve a config path to a canonical, readable PHP file; null otherwise.
	 *
	 * @param string $path             Path to validate.
	 * @param string $error_log_prefix Disambiguates error_log lines across callers.
	 */
	public static function validate_config_path(
		string $path,
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
		$real_path = \realpath( $path );
		if (
			false === $real_path
			|| ! \is_file( $real_path )
			|| ! \is_readable( $real_path )
			|| '.php' !== \substr( $real_path, -4 )
		) {
			$safe = \preg_replace( '/[\x00-\x1f\x7f]/', '', $path );
			Core::stderr( "{$error_log_prefix}::validate_config_path() failed: path is not a canonical readable PHP file ({$safe})" );
			return null;
		}

		return $real_path;
	}
}
