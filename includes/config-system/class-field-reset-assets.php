<?php
/**
 * Enqueue the shared per-field reset toggle module and the sheet that paints it.
 *
 * The toggle is built once, here in newspack-nodes, and every settings admin
 * offering per-field reset — nodes, event-logger-nodes, pyrobase — enqueues
 * that same bundle by URL, so the reset UI has one definition instead of
 * three that drift.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Config_System;

\defined( 'ABSPATH' ) || exit;

/**
 * The one call a settings page makes to get working reset toggles, from its
 * `admin_enqueue_scripts` handler.
 *
 * `enqueue()` supplies the behaviour and the UI sheet that paints a marked
 * toggle; the markup is each admin's own, written to the module's contract of
 * a `data-nn-reset="<mark name>"` wrapper around a `data-nn-reset-toggle`
 * button (`Settings_Renderer` emits it here, pyrobase inline in its settings
 * admin) inside a `.newspack-nodes-ui` page wrapper, which is what scopes the
 * sheet: without that class the toggle clears and posts but never turns red.
 *
 * Nothing here calls a substrate class: pyrobase's hermetic suite requires this
 * file on its own, without the autoloader, so a `Core::` call would fatal a
 * sibling's tests. WordPress functions and the two `NEWSPACK_NODES_*` constants
 * only.
 */
class Field_Reset_Assets {

	/**
	 * Enqueue the nodes-built field-reset toggle module into the footer, and
	 * the `newspack-nodes-ui` sheet whose `.button.is-danger` role paints a
	 * marked toggle.
	 *
	 * `NEWSPACK_NODES_DIR` locates the build's `index.asset.php`, which supplies
	 * the dependencies and the version; an unreadable or malformed manifest
	 * yields no dependencies and an empty version rather than a fatal, so the
	 * module still loads. `NEWSPACK_NODES_URL` is the script src, and the plugin
	 * defines it only where `plugin_dir_url()` exists, so a guarded no-op beats
	 * enqueuing a src that 404s. The sheet goes by handle: nodes' admin registers
	 * it on every admin page, and a page that already enqueued it is unchanged.
	 * Call this from `admin_enqueue_scripts` after priority 2, where nodes'
	 * admin registers the handle: the sheet then prints in `<head>` rather than
	 * as a late style after the form it paints, and an enqueue ahead of the
	 * registration would print nothing and drop every sheet depending on it.
	 */
	public static function enqueue(): void {
		if (
			! \function_exists( 'wp_enqueue_script' )
			|| ! \function_exists( 'wp_enqueue_style' )
			|| ! \defined( 'NEWSPACK_NODES_DIR' )
			|| ! \defined( 'NEWSPACK_NODES_URL' )
		) {
			return;
		}
		$url      = \NEWSPACK_NODES_URL . 'build/admin-field-reset/index.js';
		$asset    = \NEWSPACK_NODES_DIR . 'build/admin-field-reset/index.asset.php';
		$config   = \is_readable( $asset ) ? require $asset : [];
		$deps_raw = ( \is_array( $config ) && \is_array( $config['dependencies'] ?? null ) ) ? $config['dependencies'] : [];
		$deps     = \array_values( \array_filter( $deps_raw, '\is_string' ) );
		$ver      = ( \is_array( $config ) && \is_string( $config['version'] ?? null ) ) ? $config['version'] : '';
		\wp_enqueue_script( 'newspack-nodes-field-reset', $url, $deps, $ver, true );
		\wp_enqueue_style( 'newspack-nodes-ui' );
	}
}
