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

	/**
	 * Overlay stored WP options onto a copy of the file-config defaults.
	 *
	 * @param array<string,mixed> $defaults    File-config defaults.
	 * @param array<int,string>   $schema_keys Schema keys to overlay (without the prefix).
	 * @param string              $prefix      WP-option name prefix (e.g. 'newspack_nodes_').
	 * @return array<string,mixed>
	 */
	public static function apply( array $defaults, array $schema_keys, string $prefix ): array {
		if ( ! \function_exists( 'get_option' ) ) {
			return $defaults;
		}
		$missing = "\0__config_system_absent__\0";
		foreach ( $schema_keys as $key ) {
			$value = \get_option( $prefix . $key, $missing );
			if ( $missing === $value ) {
				continue;
			}
			$defaults[ $key ] = $value;
		}
		return $defaults;
	}
}
