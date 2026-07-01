<?php
/**
 * Options_Overlay: presence-based WP-option overlay onto file-config defaults.
 *
 * The single home for the runtime's config-override rule, used verbatim by every
 * plugin built on the substrate (each passes its own option prefix + schema
 * keys). PRESENCE decides override: a STORED option — even '', [], false, 0 —
 * wins over the file default; only a truly ABSENT option falls back. The sentinel
 * makes absence detectable even when register_setting() declares a `default`
 * (which would otherwise make get_option return that default, not the sentinel,
 * on a missing row — the bug this rule fixes).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Config_System;

\defined( 'ABSPATH' ) || exit;

class Options_Overlay {

	/** Absent-option sentinel: `stored_value()` returns this when no option row exists, so presence is detectable even when register_setting() declares a `default`. */
	public const ABSENT = "\0__config_system_absent__\0";

	/**
	 * Overlay stored WP options onto a copy of the file-config defaults.
	 *
	 * @param array<string,mixed> $defaults    File-config defaults.
	 * @param array<int,string>   $schema_keys Schema keys to overlay (without the prefix).
	 * @param string              $prefix      WP-option name prefix (e.g. 'newspack_nodes_').
	 * @return array<string,mixed>
	 */
	public static function apply( array $defaults, array $schema_keys, string $prefix ): array {
		// Batch-prime the whole schema in ONE query so the per-key get_option() loop is
		// cache hits — a schema key with no option row (config on its file default) is not
		// autoloaded, so it otherwise costs one uncached DB round-trip each on a cold request.
		if ( \function_exists( 'wp_prime_option_caches' ) && [] !== $schema_keys ) {
			\wp_prime_option_caches( \array_map( static fn ( string $key ): string => $prefix . $key, $schema_keys ) );
		}
		foreach ( $schema_keys as $key ) {
			$value = self::stored_value( $prefix, $key );
			if ( self::ABSENT === $value ) {
				continue;
			}
			$defaults[ $key ] = $value;
		}
		return $defaults;
	}

	/**
	 * Read a single prefixed option, returning {@see self::ABSENT} when the row is
	 * absent. The one place the presence test lives, so the overlay and any UI of
	 * it (e.g. the Effective Configuration panel) can't drift on the sentinel.
	 *
	 * @param string $prefix WP-option name prefix (e.g. 'newspack_nodes_').
	 * @param string $key    Schema key (without the prefix).
	 */
	public static function stored_value( string $prefix, string $key ): mixed {
		if ( ! \function_exists( 'get_option' ) ) {
			// @codeCoverageIgnoreStart
			return self::ABSENT;
			// @codeCoverageIgnoreEnd
		}
		return \get_option( $prefix . $key, self::ABSENT );
	}
}
