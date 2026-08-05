<?php
/**
 * Plugin Name: Newspack Nodes
 * Description: WordPress-internal node-graph runtime for composable services.
 * Version: 2.10.0
 * Author: Automattic
 * License: GPL-2.0-or-later
 * Requires PHP: 8.2
 * Text Domain: newspack-nodes
 * Domain Path: /languages
 *
 * @package Newspack_Nodes
 */

\defined( 'ABSPATH' ) || exit;

if ( ! \defined( 'NEWSPACK_NODES_VERSION' ) ) {
	\define( 'NEWSPACK_NODES_VERSION', '2.10.0' );
}
if ( ! \defined( 'NEWSPACK_NODES_DIR' ) ) {
	\define( 'NEWSPACK_NODES_DIR', \plugin_dir_path( __FILE__ ) );
}
if ( ! \defined( 'NEWSPACK_NODES_URL' ) && \function_exists( 'plugin_dir_url' ) ) {
	\define( 'NEWSPACK_NODES_URL', \plugin_dir_url( __FILE__ ) );
}

// Composer classmap autoload; release ships it, dev clone: composer install.
require_once NEWSPACK_NODES_DIR . 'vendor/autoload.php';

if ( \function_exists( 'is_admin' ) && \is_admin() ) {
	\Newspack_Nodes\Bootstrap::ensure_diagnostics_wired();
	new \Newspack_Nodes\Admin\Admin();
}

if ( \defined( 'WP_CLI' ) && \WP_CLI ) {
	\Newspack_Nodes\Bootstrap::ensure_diagnostics_wired();
	// PHP 8 rejects array callables here (wp-cli#5472); use shared instances.
	$nodes_worker_cli   = new \Newspack_Nodes\Worker_CLI_Command();
	$nodes_ingest_cli   = new \Newspack_Nodes\Ingest_CLI_Command();
	$nodes_scaffold_cli = new \Newspack_Nodes\Scaffold_CLI_Command();
	\WP_CLI::add_command( 'nodes',           '\\Newspack_Nodes\\CLI_Command' );
	\WP_CLI::add_command( 'nodes types',      [ $nodes_worker_cli, 'types' ]      );
	\WP_CLI::add_command( 'nodes run',        [ $nodes_worker_cli, 'run' ]        );
	\WP_CLI::add_command( 'nodes restart',    [ $nodes_worker_cli, 'restart' ]    );
	\WP_CLI::add_command( 'nodes status',     [ $nodes_worker_cli, 'status' ]     );
	\WP_CLI::add_command( 'nodes activate',   [ $nodes_worker_cli, 'activate' ]   );
	\WP_CLI::add_command( 'nodes deactivate', [ $nodes_worker_cli, 'deactivate' ] );
	\WP_CLI::add_command( 'nodes gc',         [ $nodes_worker_cli, 'gc' ]         );
	\WP_CLI::add_command( 'nodes doctor',     [ $nodes_worker_cli, 'doctor' ]     );
	\WP_CLI::add_command( 'nodes ingest',     [ $nodes_ingest_cli, 'ingest' ]     );
	\WP_CLI::add_command( 'nodes scaffold',   [ $nodes_scaffold_cli, 'scaffold' ] );
}

// Storage-backed runtime wiring stays lazy; only diagnostics wire above.

/**
 * Service-CommandInterpreter (CI) mounting.
 *
 * `HTTP_In::dispatch` lazy-builds the request-scope graph
 * (`_router` / `_command_interpreter` / `_http`) then fires
 * `newspack_nodes/request_graph_ready` so anything that wants to mount
 * a CI can do so via `$base_interpreter->make_node(...)` — which constructs,
 * names, and sinks each node in one atomic step. Without the sink, verb
 * responses (which walk back via TO=FROM) would have no path to the
 * HTTP_In response-writer and silently drop.
 *
 * The substrate uses the SAME hook the apps use (newspack-event-logger-
 * nodes does the symmetric mount via its own callback), so substrate
 * CIs can also be filter-replaced if a future app needs to override one.
 *
 * Named function (not a closure) so tests that wipe
 * `$GLOBALS['_wp_actions']` for isolation can re-attach the same
 * callback without duplicating the mount logic.
 */
function newspack_nodes_mount_substrate_cis( \Newspack_Nodes\Command_Interpreter_Node $base_interpreter ): void {
	// Idempotency guard: request_graph_ready can fire twice, colliding names.
	if ( null !== \Newspack_Nodes\Core::node( 'workers' ) ) {
		return;
	}

	$base_interpreter->make_node( 'Classes_CI',    'classes' );
	$base_interpreter->make_node( 'Layouts_CI',    'layouts' );
	$base_interpreter->make_node( 'Topologies_CI', 'topologies' );
	$base_interpreter->make_node( 'Raw_Logs_CI',   'raw-logs' );
	$base_interpreter->make_node( 'Vault_CI',      'vault' );
	$base_interpreter->make_node( 'Aggregator_CI', 'aggregator' );
	$base_interpreter->make_node( 'Settings_CI',   'settings' );
	$base_interpreter->make_node( 'Status_CI',     'status' );

	// Workers_CI needs the Cli: assign it as a public property after make_node.
	$cli        = new \Newspack_Nodes\CLI( \Newspack_Nodes\Bootstrap::base_dir() );
	$workers_ci = $base_interpreter->make_node( 'Workers_CI', 'workers' );
	if ( $workers_ci instanceof \Newspack_Nodes\Rest\Workers_CI_Node ) {
		$workers_ci->cli = $cli;
	}
}

// Wire WP integration (REST, supervisor cron, activation); skipped in tests.
if ( \function_exists( 'add_action' ) ) {
	\add_action( 'rest_api_init', [ '\\Newspack_Nodes\\Bootstrap', 'register_rest_routes' ] );
	\add_action( 'newspack_nodes/supervisor', [ '\\Newspack_Nodes\\Bootstrap', 'run_supervisor_tick' ] );
	\add_action( 'newspack_nodes/restart_fleet', [ '\\Newspack_Nodes\\Worker_CLI_Command', 'restart_fleet_by_name' ] );
	\add_action( 'newspack_nodes/request_graph_ready', 'newspack_nodes_mount_substrate_cis' );
	// Settings-sync: register option-change hooks once (init idempotent).
	\Newspack_Nodes\Settings_Event_Writer::init();
	// Supervisor-cron veto filters: run under ANY cron runner, not wp-cron.
	\add_filter( 'pre_schedule_event', [ '\\Newspack_Nodes\\Bootstrap', 'log_supervisor_schedule_veto' ], PHP_INT_MAX - 2, 2 );
	\add_filter( 'pre_reschedule_event', [ '\\Newspack_Nodes\\Bootstrap', 'log_supervisor_schedule_veto' ], PHP_INT_MAX - 2, 2 );
	\add_filter( 'schedule_event', [ '\\Newspack_Nodes\\Bootstrap', 'remember_schedule_event_context' ], PHP_INT_MIN + 2, 1 );
	\add_filter( 'schedule_event', [ '\\Newspack_Nodes\\Bootstrap', 'log_supervisor_schedule_event_veto' ], PHP_INT_MAX - 2, 1 );
	// Default spawn handler: spawns any active-set worker, ungated by owner.
	\add_action( 'newspack_nodes/spawn_worker', [ '\\Newspack_Nodes\\Topology_Registry', 'spawn_worker' ], 10, 2 );
	// On config reload: reset log view + basename cache (narrow, keeps dirs).
	\add_action( \Newspack_Nodes\Config::RESET_ACTION, [ '\\Newspack_Nodes\\Log_Discovery', 'reset' ] );
	\add_action( \Newspack_Nodes\Config::RESET_ACTION, [ '\\Newspack_Nodes\\Topology_Registry', 'reset_basename_cache' ] );
	// Self-heal: re-arm the supervisor cron on admin view if it got cleared.
	\add_action( 'admin_init', [ '\\Newspack_Nodes\\Bootstrap', 'self_heal_supervisor_cron' ] );
}

if ( \function_exists( 'add_filter' ) ) {
	// phpcs:ignore WordPress.WP.CronInterval.ChangeDetected -- The 60s interval registered by the callback is intentional (substrate supervisor tick); rule can't see into array-callable targets.
	\add_filter( 'cron_schedules', [ '\\Newspack_Nodes\\Bootstrap', 'register_cron_schedules' ] );
	// Topology catalog: every .tsl (user + stock dirs), not an allowlist.
	\add_filter( 'newspack_nodes/topologies', [ '\\Newspack_Nodes\\Topology_Registry', 'publish_catalog' ] );
}

if ( \function_exists( 'register_activation_hook' ) ) {
	\register_activation_hook( __FILE__, [ '\\Newspack_Nodes\\Bootstrap', 'activate' ] );
}

if ( \function_exists( 'register_deactivation_hook' ) ) {
	\register_deactivation_hook( __FILE__, [ '\\Newspack_Nodes\\Bootstrap', 'deactivate' ] );
}
