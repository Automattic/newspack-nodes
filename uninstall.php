<?php
/**
 * Newspack Nodes uninstall entry point: erase what a deleted plugin would
 * otherwise orphan — the capability grants and the hub role, the runtime's
 * on-disk state tree, and every `newspack_nodes_` option row.
 *
 * WordPress defines WP_UNINSTALL_PLUGIN and runs this on plugin DELETE only,
 * never on deactivate, so deactivating and reactivating keeps every setting.
 *
 * The plugin's own entry point never ran here and no autoloader is
 * registered, so this file requires the classmap that resolves `Roles`, and
 * the cleanup helpers by path — plain functions a classmap cannot map.
 *
 * @package Newspack_Nodes
 */

if ( ! \defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

require __DIR__ . '/vendor/autoload.php';
require __DIR__ . '/includes/uninstall-cleanup.php';

// Caps live in WP's roles option; a newspack_nodes_ sweep never reaches it.
\Newspack_Nodes\Roles::uninstall();
\Newspack_Nodes\uninstall_cleanup( 'newspack_nodes_' );
