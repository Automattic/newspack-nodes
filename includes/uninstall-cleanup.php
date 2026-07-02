<?php
/**
 * Uninstall option-cleanup helpers.
 *
 * Loaded only from uninstall.php (plugin delete). Kept out of the autoloader so
 * it costs nothing at runtime.
 *
 * @package Newspack_Nodes
 */

declare( strict_types = 1 );

namespace Newspack_Nodes;

/**
 * Delete every option row for a prefix, plus its transient variants (all are
 * option rows, so this stays options-only). Prefix-based so it stays complete
 * as options come and go and catches autoload=off rows a hardcoded list misses.
 *
 * @param \wpdb  $wpdb   WordPress database handle.
 * @param string $prefix Option-name prefix, e.g. `newspack_nodes_`.
 * @return int Number of option rows deleted.
 */
function delete_prefixed_options( $wpdb, string $prefix ): int {
	$deleted = 0;
	// phpcs:disable WordPress.DB.PreparedSQL.NotPrepared, WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching -- one-time uninstall cleanup; the LIKE prefix is esc_like-escaped and contains no user input.
	foreach ( [ $prefix, '_transient_' . $prefix, '_transient_timeout_' . $prefix ] as $stub ) {
		$sql = "SELECT option_name FROM {$wpdb->options} WHERE option_name LIKE '" . $wpdb->esc_like( $stub ) . "%'";
		foreach ( $wpdb->get_col( $sql ) as $name ) {
			if ( \is_string( $name ) ) {
				\delete_option( $name );
				++$deleted;
			}
		}
	}
	// phpcs:enable
	return $deleted;
}

/**
 * Delete all prefixed options, iterating every site on multisite.
 *
 * @param string $prefix Option-name prefix.
 * @return void
 */
function uninstall_cleanup( string $prefix ): void {
	global $wpdb;
	/** @var \wpdb $wpdb */

	if ( \is_multisite() ) {
		foreach ( \get_sites( [ 'fields' => 'ids', 'number' => 0 ] ) as $site_id ) {
			\switch_to_blog( $site_id );
			delete_prefixed_options( $wpdb, $prefix );
			\restore_current_blog();
		}
		return;
	}
	delete_prefixed_options( $wpdb, $prefix );
}
