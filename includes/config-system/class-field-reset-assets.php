<?php
/**
 * Enqueue the shared per-field reset toggle module and its marked-state style.
 *
 * The toggle is built once, here in newspack-nodes, and every settings admin
 * offering per-field reset — nodes, event-logger-nodes, pyrobase — enqueues
 * that same bundle by URL and prints that same highlight, so the reset UI has
 * one definition instead of three that drift.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Config_System;

\defined( 'ABSPATH' ) || exit;

/**
 * The two calls a settings page makes to get working reset toggles.
 *
 * `enqueue()` supplies the behaviour and `highlight_style()` the marked-state
 * paint; the markup is each admin's own, written to the module's contract of a
 * `data-nn-reset="<mark name>"` wrapper around a `data-nn-reset-toggle` button
 * (`Settings_Renderer` emits it here, pyrobase inline in its settings admin).
 *
 * Nothing here calls a substrate class: pyrobase's hermetic suite requires this
 * file on its own, without the autoloader, so a `Core::` call would fatal a
 * sibling's tests. WordPress functions and the two `NEWSPACK_NODES_*` constants
 * only.
 */
class Field_Reset_Assets {

	/**
	 * Enqueue the nodes-built field-reset toggle module into the footer.
	 *
	 * `NEWSPACK_NODES_DIR` locates the build's `index.asset.php`, which supplies
	 * the dependencies and the version; an unreadable or malformed manifest
	 * yields no dependencies and an empty version rather than a fatal, so the
	 * module still loads. `NEWSPACK_NODES_URL` is the script src, and the plugin
	 * defines it only where `plugin_dir_url()` exists, so a guarded no-op beats
	 * enqueuing a src that 404s.
	 */
	public static function enqueue(): void {
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

	/**
	 * The marked-state highlight, as a `<style>` element to print by the form.
	 *
	 * Red marks a field whose option Save will delete. The `:hover`/`:focus`
	 * rule repeats that red at specificity (0,3,0) to match WP core's
	 * `.wp-core-ui .button:focus`, which otherwise repaints the toggle in the
	 * default button colors the moment it is clicked — exactly when the operator
	 * needs to see the mark. Callers echo this unescaped, so it stays a literal
	 * with nothing interpolated into it.
	 */
	public static function highlight_style(): string {
		return '<style>.is-marked [data-nn-reset-toggle]{background:#d63638;border-color:#d63638;color:#fff;}'
			. '.is-marked [data-nn-reset-toggle]:hover,.is-marked [data-nn-reset-toggle]:focus{background:#b32d2e;border-color:#b32d2e;color:#fff;}</style>';
	}
}
