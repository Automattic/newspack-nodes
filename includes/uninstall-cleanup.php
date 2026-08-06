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

\defined( 'ABSPATH' ) || exit;

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
 * Resolve the runtime base directory WITHOUT loading the Config machinery:
 * the option overlay, else the LOCAL_NEWSPACK_NODES_CONF file, else the
 * shipped `newspack-nodes-config.php` — the same three-layer precedence
 * `Config::get_base_directory()` reads. '' when nothing resolves.
 */
function runtime_base_directory(): string {
	$opt = \function_exists( 'get_option' ) ? \get_option( 'newspack_nodes_base_directory' ) : false;
	if ( \is_string( $opt ) && '' !== $opt ) {
		return $opt;
	}
	$local      = \getenv( 'LOCAL_NEWSPACK_NODES_CONF' );
	$candidates = \is_string( $local ) && '' !== $local ? [ $local ] : [];
	$candidates[] = \dirname( __DIR__ ) . '/newspack-nodes-config.php';
	foreach ( $candidates as $file ) {
		if ( ! \is_file( $file ) ) {
			continue;
		}
		$cfg = require $file;
		$dir = \is_array( $cfg ) ? ( $cfg['base_directory'] ?? null ) : null;
		if ( \is_string( $dir ) && '' !== $dir ) {
			return $dir;
		}
	}
	return '';
}

/**
 * Remove the runtime's on-disk state — logs, locks, offsets, IPC, deadletters,
 * user topologies. Scoped to the KNOWN runtime subtrees (a base dir shared
 * with operator files loses only ours), symlink-safe and containment-checked
 * via `Spawn_Coordinator::delete_directory_recursive`. The base dir itself goes
 * only when the runtime owned everything in it (rmdir refuses non-empty).
 *
 * @param string $base_dir Configured runtime base directory.
 */
function delete_runtime_tree( string $base_dir ): void {
	$base_dir = \rtrim( $base_dir, '/' );
	if ( '' === $base_dir || ! \is_dir( $base_dir ) ) {
		return;
	}
	// A symlinked base makes uninstall a delete primitive at the target.
	if ( \is_link( $base_dir ) ) {
		return;
	}
	require_once __DIR__ . '/class-spawn-coordinator.php';
	foreach ( [ 'logs', 'locks', 'offsets', 'ipc', 'deadletter', 'topologies' ] as $subdir ) {
		Spawn_Coordinator::delete_directory_recursive( "{$base_dir}/{$subdir}", $base_dir );
	}
	// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_rmdir -- one-time uninstall of the runtime's own reserved dir.
	@\rmdir( $base_dir );
}

/**
 * Delete the runtime disk tree, then all prefixed options (every site on
 * multisite). Tree first — its location is read from an option this deletes.
 *
 * @param string $prefix Option-name prefix.
 * @return void
 */
function uninstall_cleanup( string $prefix ): void {
	global $wpdb;
	/** @var \wpdb $wpdb */

	// The fleet is network-global; one tree regardless of multisite.
	delete_runtime_tree( runtime_base_directory() );

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
