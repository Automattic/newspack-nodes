<?php
/**
 * Erase what a deleted plugin would otherwise leave behind: the runtime's
 * on-disk state tree, and every option row carrying the plugin's prefix.
 *
 * Plain functions rather than a class. The classmap autoloader maps classes
 * only, so nothing loads this file on a normal request — `uninstall.php`
 * requires it by path.
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
 * Takes the handle rather than reading `$wpdb` itself, so a test can pass a
 * double.
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
 * Resolve the base directory this install EXPLICITLY configured, in the
 * precedence `Config` applies: the option overlay, else the
 * LOCAL_NEWSPACK_NODES_CONF file, else the shipped `newspack-nodes-config.php`.
 * '' when none of them names one.
 *
 * `Config::get_base_directory()` would do two things uninstall must not: it
 * creates the directory it resolves, and it falls back to the schema default.
 * That default is the path every unconfigured install on a host SHARES, so
 * resolving to it would make uninstalling one site delete another's live logs,
 * locks and offsets. Leaving a tree behind for an operator to remove is the
 * cheaper mistake.
 *
 * @return string Configured base directory, or '' when nothing configures one.
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
 * user topologies, SQLite's temporary files under `tmp/`, and this install's
 * command-session store. Scoped to the KNOWN runtime subtrees (a base dir
 * shared with operator files loses only ours), symlink-safe and
 * containment-checked via
 * `Spawn_Coordinator::delete_directory_recursive`. The base dir itself goes
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
	foreach ( [ 'logs', 'locks', 'offsets', 'ipc', Config::DEADLETTER_SUBDIR, 'topologies', 'tmp' ] as $subdir ) {
		Spawn_Coordinator::delete_directory_recursive( "{$base_dir}/{$subdir}", $base_dir );
	}
	delete_session_store( $base_dir );
	// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_rmdir -- one-time uninstall of the runtime's own reserved dir.
	@\rmdir( $base_dir );
}

/**
 * Delete this install's session store, wherever its base is, and the runtime
 * disk tree, then all prefixed options (every site on multisite). Tree first
 * — its location is read from an option this deletes.
 *
 * @param string $prefix Option-name prefix.
 */
function uninstall_cleanup( string $prefix ): void {
	global $wpdb;
	/** @var \wpdb $wpdb */

	// The fleet is network-global; one tree regardless of multisite.
	delete_session_store( session_store_base() );
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

/**
 * Delete this install's command-session store under `$base_dir`, its `-wal`
 * and `-shm` before the database, then `tables/` when nothing else is left
 * in it. The file holds every live session key, recoverable; its name is
 * this install's alone, so a base other installs share loses nothing of
 * theirs, and every other Table's file belongs to its declaring plugin.
 *
 * @param string $base_dir The runtime base directory.
 */
function delete_session_store( string $base_dir ): void {
	$tables = \rtrim( $base_dir, '/' ) . '/tables';
	// A symlinked base or tables dir would aim the unlinks at its target.
	if ( \is_link( $base_dir ) || \is_link( $tables ) || ! \is_dir( $tables ) ) {
		return;
	}
	$store = "{$tables}/" . Table_Node::stem( Command_Auth::session_store(), 0 ) . '.sqlite';
	foreach ( [ "{$store}-wal", "{$store}-shm", $store ] as $file ) {
		// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.file_ops_unlink -- one-time uninstall of this install's own session store.
		@\unlink( $file );
	}
	// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_rmdir -- removed only when empty.
	@\rmdir( $tables );
}

/**
 * Where this install's session store lives: the configured base directory,
 * else the schema default, which `runtime_base_directory()` refuses because
 * other installs share it, and where the store's name is still this
 * install's alone.
 *
 * @return string The base directory.
 */
function session_store_base(): string {
	$base = runtime_base_directory();
	return '' !== $base ? $base : Core::as_string( Settings_Schema::get()->field_for_short( 'base_directory' )?->default );
}
