<?php
/**
 * Newspack Nodes uninstall cleanup.
 *
 * Runs ONLY on plugin delete (WordPress defines WP_UNINSTALL_PLUGIN), never on
 * deactivate. Removes every `newspack_nodes_` option this plugin created.
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
