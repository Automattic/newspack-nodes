<?php
/**
 * Plugin Name: Newspack Nodes
 * Description: Node-graph runtime for composable PHP services.
 * Version: 0.1.0
 * Author: Automattic
 * License: GPL-2.0-or-later
 *
 * @package Newspack_Nodes
 */

\defined( 'ABSPATH' ) || exit;

if ( ! \defined( 'NEWSPACK_NODES_VERSION' ) ) {
	\define( 'NEWSPACK_NODES_VERSION', '0.1.0' );
}
if ( ! \defined( 'NEWSPACK_NODES_FILE' ) ) {
	\define( 'NEWSPACK_NODES_FILE', __FILE__ );
}
if ( ! \defined( 'NEWSPACK_NODES_DIR' ) ) {
	\define( 'NEWSPACK_NODES_DIR', \plugin_dir_path( __FILE__ ) );
}

// Load classes (added one per task — kept require_once for parity with event-logger conventions; no composer for A1).
// Order matters: Router extends Timer (Task 7), so Timer (and EventFramework it depends on) must load before Router.
require_once NEWSPACK_NODES_DIR . 'includes/class-core.php';
require_once NEWSPACK_NODES_DIR . 'includes/class-message.php';
require_once NEWSPACK_NODES_DIR . 'includes/class-node.php';
require_once NEWSPACK_NODES_DIR . 'includes/class-event-framework.php';
require_once NEWSPACK_NODES_DIR . 'includes/class-timer.php';
require_once NEWSPACK_NODES_DIR . 'includes/class-router.php';
require_once NEWSPACK_NODES_DIR . 'includes/class-responder.php';
require_once NEWSPACK_NODES_DIR . 'includes/class-command-interpreter.php';
require_once NEWSPACK_NODES_DIR . 'includes/class-lock.php';
require_once NEWSPACK_NODES_DIR . 'includes/class-partition.php';
require_once NEWSPACK_NODES_DIR . 'includes/class-topic.php';
require_once NEWSPACK_NODES_DIR . 'includes/class-consumer.php';
require_once NEWSPACK_NODES_DIR . 'includes/class-callback.php';
require_once NEWSPACK_NODES_DIR . 'includes/class-shell.php';
require_once NEWSPACK_NODES_DIR . 'includes/class-dumper.php';
require_once NEWSPACK_NODES_DIR . 'includes/class-tee.php';
require_once NEWSPACK_NODES_DIR . 'includes/class-hook.php';
require_once NEWSPACK_NODES_DIR . 'includes/class-tail.php';
require_once NEWSPACK_NODES_DIR . 'includes/class-worker-base.php';
require_once NEWSPACK_NODES_DIR . 'includes/class-supervisor-base.php';
require_once NEWSPACK_NODES_DIR . 'includes/class-supervisor.php';
require_once NEWSPACK_NODES_DIR . 'includes/rest/class-spawn-controller.php';
require_once NEWSPACK_NODES_DIR . 'includes/class-bootstrap.php';
require_once NEWSPACK_NODES_DIR . 'includes/class-cli.php';

if ( \defined( 'WP_CLI' ) && \WP_CLI ) {
	require_once NEWSPACK_NODES_DIR . 'includes/class-cli-command.php';
	require_once NEWSPACK_NODES_DIR . 'includes/cli/class-worker-cli-command.php';
	\WP_CLI::add_command( 'nodes', '\\Newspack_Nodes\\Cli_Command' );
	\WP_CLI::add_command( 'nodes types',   [ '\\Newspack_Nodes\\WorkerCliCommand', 'types'   ] );
	\WP_CLI::add_command( 'nodes run',     [ '\\Newspack_Nodes\\WorkerCliCommand', 'run'     ] );
	\WP_CLI::add_command( 'nodes restart', [ '\\Newspack_Nodes\\WorkerCliCommand', 'restart' ] );
	\WP_CLI::add_command( 'nodes status',  [ '\\Newspack_Nodes\\WorkerCliCommand', 'status'  ] );
}

// Wire WordPress integration: REST routes, cron-driven supervisor tick, activation/deactivation.
// Skipped in test environments where add_action is a stub but rest_api_init never fires.
if ( \function_exists( 'add_action' ) ) {
	\add_action( 'rest_api_init', [ '\\Newspack_Nodes\\Bootstrap', 'register_rest_routes' ] );
	\add_action( 'newspack_nodes/supervisor', [ '\\Newspack_Nodes\\Bootstrap', 'run_supervisor_tick' ] );
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
