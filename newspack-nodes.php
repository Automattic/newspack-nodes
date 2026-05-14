<?php
/**
 * Plugin Name: Newspack Nodes
 * Description: Node-graph runtime for composable PHP services.
 * Version: 0.1.22
 * Author: Automattic
 * License: GPL-2.0-or-later
 *
 * @package Newspack_Nodes
 */

\defined( 'ABSPATH' ) || exit;

if ( ! \defined( 'NEWSPACK_NODES_VERSION' ) ) {
	\define( 'NEWSPACK_NODES_VERSION', '0.1.22' );
}
if ( ! \defined( 'NEWSPACK_NODES_FILE' ) ) {
	\define( 'NEWSPACK_NODES_FILE', __FILE__ );
}
if ( ! \defined( 'NEWSPACK_NODES_DIR' ) ) {
	\define( 'NEWSPACK_NODES_DIR', \plugin_dir_path( __FILE__ ) );
}
if ( ! \defined( 'NEWSPACK_NODES_URL' ) && \function_exists( 'plugin_dir_url' ) ) {
	\define( 'NEWSPACK_NODES_URL', \plugin_dir_url( __FILE__ ) );
}

// Composer classmap autoloader. Class files inside includes/ are scanned at
// `composer install` / `composer dump-autoload` time and registered with a
// FQCN-to-path map; classes load on first reference so request scope doesn't
// pay for code it never touches. Generated vendor/autoload.php ships with the
// release zip via build-release.sh (which runs composer install --no-dev
// --optimize-autoloader pre-stage). Dev environments need a `composer install`
// after cloning; the build:autoloaders npm script wraps this for parity with
// the other plugins.
require_once NEWSPACK_NODES_DIR . 'vendor/autoload.php';

if ( \function_exists( 'is_admin' ) && \is_admin() ) {
	new \Newspack_Nodes\Admin\Admin();
}

if ( \defined( 'WP_CLI' ) && \WP_CLI ) {
	\WP_CLI::add_command( 'nodes', '\\Newspack_Nodes\\Cli_Command' );
	\WP_CLI::add_command( 'nodes types',   [ '\\Newspack_Nodes\\WorkerCliCommand', 'types'   ] );
	\WP_CLI::add_command( 'nodes run',     [ '\\Newspack_Nodes\\WorkerCliCommand', 'run'     ] );
	\WP_CLI::add_command( 'nodes restart', [ '\\Newspack_Nodes\\WorkerCliCommand', 'restart' ] );
	\WP_CLI::add_command( 'nodes status',  [ '\\Newspack_Nodes\\WorkerCliCommand', 'status'  ] );
}

// Register substrate node types with CommandInterpreter::$class_map so the
// shell `make_node` verb and the topology-side `$interpreter->make_node()`
// instance API can construct them by short name. Plugins extending the
// runtime add their own subclasses via additional `register_class()` calls.
\Newspack_Nodes\CommandInterpreter::register_class( 'Callback',          \Newspack_Nodes\Callback::class );
\Newspack_Nodes\CommandInterpreter::register_class( 'CommandInterpreter', \Newspack_Nodes\CommandInterpreter::class );
\Newspack_Nodes\CommandInterpreter::register_class( 'Consumer',          \Newspack_Nodes\Consumer::class );
\Newspack_Nodes\CommandInterpreter::register_class( 'Dumper',            \Newspack_Nodes\Dumper::class );
\Newspack_Nodes\CommandInterpreter::register_class( 'Echo',              \Newspack_Nodes\Echo_Node::class );
\Newspack_Nodes\CommandInterpreter::register_class( 'Hook',              \Newspack_Nodes\Hook::class );
\Newspack_Nodes\CommandInterpreter::register_class( 'Lock',              \Newspack_Nodes\Lock::class );
\Newspack_Nodes\CommandInterpreter::register_class( 'Log',               \Newspack_Nodes\Log::class );
\Newspack_Nodes\CommandInterpreter::register_class( 'Partition',         \Newspack_Nodes\Partition::class );
\Newspack_Nodes\CommandInterpreter::register_class( 'Router',            \Newspack_Nodes\Router::class );
\Newspack_Nodes\CommandInterpreter::register_class( 'Shell',             \Newspack_Nodes\Shell::class );
\Newspack_Nodes\CommandInterpreter::register_class( 'Tail',              \Newspack_Nodes\Tail::class );
\Newspack_Nodes\CommandInterpreter::register_class( 'Tee',               \Newspack_Nodes\Tee::class );
\Newspack_Nodes\CommandInterpreter::register_class( 'Timer',             \Newspack_Nodes\Timer::class );
\Newspack_Nodes\CommandInterpreter::register_class( 'Topic',             \Newspack_Nodes\Topic::class );

// One-shot cache invalidation on plugins_loaded so late-loading plugins that
// register substrate option-schema additions are picked up by the next
// load_config() call.
\Newspack_Nodes\Config::register_cache_invalidation();

// Wire WordPress integration: REST routes, cron-driven supervisor tick, activation/deactivation.
// Skipped in test environments where add_action is a stub but rest_api_init never fires.
if ( \function_exists( 'add_action' ) ) {
	\add_action( 'rest_api_init', [ '\\Newspack_Nodes\\Bootstrap', 'register_rest_routes' ] );
	\add_action( 'newspack_nodes/supervisor', [ '\\Newspack_Nodes\\Bootstrap', 'run_supervisor_tick' ] );
	\add_action( 'newspack_nodes/restart_fleet', [ '\\Newspack_Nodes\\WorkerCliCommand', 'restart_fleet_by_name' ] );
}
if ( \function_exists( 'add_filter' ) ) {
	\add_filter( 'cron_schedules', [ '\\Newspack_Nodes\\Bootstrap', 'register_cron_schedules' ] );
}
if ( \function_exists( 'register_activation_hook' ) ) {
	\register_activation_hook( NEWSPACK_NODES_FILE, [ '\\Newspack_Nodes\\Bootstrap', 'activate' ] );
}
if ( \function_exists( 'register_deactivation_hook' ) ) {
	\register_deactivation_hook( NEWSPACK_NODES_FILE, [ '\\Newspack_Nodes\\Bootstrap', 'deactivate' ] );
}
