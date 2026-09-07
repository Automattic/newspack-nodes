<?php
/**
 * Shared config-file handling for the `Config` classes built on the substrate.
 *
 * Every plugin that has a `Config` class reads configuration the same way
 * (ADR-20): the schema declares each key and its default in code, and a PHP
 * file the deployment owns overrides the values it names. This class is the
 * file half of that — resolve the path, execute the file, and prove that what
 * came back is data rather than behaviour.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Static helpers called by `Newspack_Nodes\Config` and
 * `Newspack_Event_Logger_Nodes\Config`. The class carries no state.
 *
 * `docs/stability.md` counts all three methods among the frozen surfaces: a
 * consumer plugin's `Config` may read its configuration through them, so a
 * signature here cannot move under it.
 */
class Config_Utils {

	/**
	 * Layer a PHP config file over $config and return the merged array.
	 *
	 * The file is an override surface, never the base: it wins for the keys
	 * it names and leaves the rest of $config alone (ADR-20). The merge is one
	 * level deep, so a key holding an array is replaced wholesale rather than
	 * blended into the base. A missing file is not an error, and $config comes
	 * back untouched. The file is EXECUTED, so a caller passes a path it
	 * trusts; an operator-supplied one goes through `validate_config_path()`
	 * first.
	 *
	 * A file returning anything but an array of scalars, nulls and arrays
	 * throws. ADR-20's "report, never throw" governs an unrecognized KEY,
	 * which the calling `Config` handles in `note_unrecognized_keys()`; it
	 * does not cover a file that yielded no usable tree at all.
	 *
	 * @param array<string,mixed> $config           Base config to merge into.
	 * @param string              $config_file      Absolute path to a PHP file returning an array.
	 * @param string              $error_log_prefix Names the calling Config class in the exception.
	 * @return array<string,mixed> $config with the file's keys layered over it.
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
		// @longform The closure is load-bearing: `require` runs in the
		// INCLUDING scope, so a bare one here lets an operator config that
		// writes `$config` overwrite this method's own parameter and silently
		// drop every default it was handed.
		$parsed_config = ( static fn ( string $file ) => require $file )( $config_file );
		if ( \is_array( $parsed_config ) && self::validate_config_values( $parsed_config ) ) {
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
	 * True when $value is a tree of scalars, nulls and arrays and nothing else.
	 *
	 * Configuration is data. An object, closure or resource reaching the tree
	 * would carry behaviour or a live handle into every reader of
	 * `Config::value()`, so the walk refuses one wherever it sits. The depth
	 * bound ends the recursion on a self-referential array, which a `require`d
	 * file can build.
	 *
	 * @param mixed $value Value tree to validate.
	 * @param int   $depth Recursion depth of $value; above 10 the value is refused unread.
	 * @return bool True when every leaf is a scalar or null and arrays nest at most ten deep.
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
	 * The path arrives from the environment (`LOCAL_NEWSPACK_NODES_CONF`) and
	 * whatever it names is about to be executed, so the `.php` suffix is
	 * retested after `realpath()`, beside the file and readability checks: a
	 * symlink called `config.php` can point at anything. A null byte is
	 * refused first — `realpath()` raises an uncaught `ValueError` on one.
	 * Failure logs and returns null instead of throwing, leaving the caller to
	 * decide whether a bad path is fatal. Control characters are stripped from
	 * the logged path so a crafted name cannot forge log lines or emit
	 * terminal escapes.
	 *
	 * @param string $path             Path to validate.
	 * @param string $error_log_prefix Names the calling Config class in the stderr line.
	 * @return string|null The canonical path, or null when it fails any check.
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
