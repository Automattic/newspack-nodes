<?php
/**
 * The stored-option layer of the substrate's config resolution.
 *
 * Every plugin on the substrate resolves its runtime config through `apply()`,
 * passing its own option prefix and schema keys, so what counts as an override
 * is decided here once instead of in each plugin's `Config`. It is the last of
 * three layers: the schema declares each key's default in code, the config
 * files override what they name (ADR-20), and a stored option outranks both.
 *
 * One of the five `Config_System` files a sibling's hermetic test harness loads
 * on its own, so it calls nothing outside this namespace.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Config_System;

\defined( 'ABSPATH' ) || exit;

/**
 * PRESENCE decides an override, never truthiness: a stored option — even '',
 * [], false or 0 — beats the file default, and only an absent row falls back.
 *
 * A stored blank is a real setting — an empty `memcache_servers` means no
 * servers, not the configured pool — so a caller expresses "use the default"
 * by DELETING the option row. `Reset_Gate` is what does that for the settings
 * pages, on a per-field reset and on a blank text field.
 */
class Options_Overlay {

	/**
	 * The absent-option sentinel `stored_value()` returns when no row exists.
	 *
	 * Handing it to `get_option()` as the default is what makes absence
	 * detectable. WordPress returns the CALLER's default when one is passed and
	 * the `register_setting()` default only when none is, so a bare read reports
	 * a registered default as though an operator had stored it. The NUL
	 * delimiters keep the sentinel distinct from any value a settings form or a
	 * sanitizer can produce.
	 */
	public const ABSENT = "\0__config_system_absent__\0";

	/**
	 * Overlay the stored WP options named by $schema_keys onto the defaults.
	 *
	 * $defaults arrives by value, so the caller's array is untouched, and a key
	 * the schema does not name passes through unread. The prime is guarded
	 * because it is an optimization only: an install whose WordPress predates
	 * `wp_prime_option_caches()` resolves the same values, one query per key.
	 *
	 * @param array<string,mixed> $defaults    File-config defaults, keyed unprefixed.
	 * @param array<int,string>   $schema_keys Schema keys to overlay (without the prefix).
	 * @param string              $prefix      WP-option name prefix (e.g. 'newspack_nodes_').
	 * @return array<string,mixed> The defaults with every stored option overlaid.
	 */
	public static function apply( array $defaults, array $schema_keys, string $prefix ): array {
		// Batch-prime the schema in ONE query; else a DB round-trip per key.
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
	 * Read one prefixed option, returning {@see self::ABSENT} when the row is
	 * absent.
	 *
	 * The one place the presence test lives, so the overlay and every surface
	 * reporting it — the settings page's Effective Configuration panel — agree
	 * on which settings are stored and which are defaults. Where WordPress is
	 * not loaded there are no rows to read, so every key reads ABSENT and the
	 * defaults stand alone.
	 *
	 * @param string $prefix WP-option name prefix (e.g. 'newspack_nodes_').
	 * @param string $key    Schema key (without the prefix).
	 * @return mixed The stored value, or {@see self::ABSENT} when no row exists.
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
