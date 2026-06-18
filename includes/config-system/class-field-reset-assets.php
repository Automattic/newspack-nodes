<?php
/**
 * Field_Reset_Assets: enqueue the shared per-field reset toggle JS + its style.
 *
 * The toggle module is built ONCE in newspack-nodes; every plugin's settings
 * admin (nodes, ELN, pyrobase) enqueues that same nodes-built bundle by URL and
 * prints the same marked-state highlight, so the per-field reset UI is defined
 * in exactly one place. Consumers all hard-depend on newspack-nodes, so its
 * build dir + URL constant are always present.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Config_System;

\defined( 'ABSPATH' ) || exit;

class Field_Reset_Assets {

	/** Enqueue the nodes-built field-reset toggle module (DOM-only, no deps). */
	public static function enqueue(): void {
		// Need both constants: DIR to read the asset manifest, URL to build a
		// loadable script src (a bare relative path would 404).
		if ( ! \function_exists( 'wp_enqueue_script' ) || ! \defined( 'NEWSPACK_NODES_DIR' ) || ! \defined( 'NEWSPACK_NODES_URL' ) ) {
			return;
		}
		$rel    = 'build/admin-field-reset/index.js';
		$url    = \NEWSPACK_NODES_URL . $rel;
		$asset  = \NEWSPACK_NODES_DIR . 'build/admin-field-reset/index.asset.php';
		$config    = \is_readable( $asset ) ? require $asset : [];
		$deps_raw  = ( \is_array( $config ) && \is_array( $config['dependencies'] ?? null ) ) ? $config['dependencies'] : [];
		$deps      = \array_values( \array_filter( $deps_raw, '\is_string' ) );
		$ver       = ( \is_array( $config ) && \is_string( $config['version'] ?? null ) ) ? $config['version'] : '';
		\wp_enqueue_script( 'newspack-nodes-field-reset', $url, $deps, $ver, true );
	}

	/** Marked-state highlight CSS — print once near the settings form. */
	public static function highlight_style(): string {
		// The :hover/:focus rule re-asserts the red at (0,3,0) so WP core's
		// `.wp-core-ui .button:focus` can't repaint the marked toggle grey the
		// moment it's clicked; box-shadow is left alone, so WP's blue focus ring
		// still renders over the (now visible) red state.
		return '<style>.is-marked [data-nn-reset-toggle]{background:#d63638;border-color:#d63638;color:#fff;}'
			. '.is-marked [data-nn-reset-toggle]:hover,.is-marked [data-nn-reset-toggle]:focus{background:#b32d2e;border-color:#b32d2e;color:#fff;}</style>';
	}
}
