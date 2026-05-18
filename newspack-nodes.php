<?php
/**
 * Plugin Name: Newspack Nodes
 * Description: Node-graph runtime for composable PHP services.
 * Version: 0.1.31
 * Author: Automattic
 * License: GPL-2.0-or-later
 *
 * @package Newspack_Nodes
 */

\defined( 'ABSPATH' ) || exit;

if ( ! \defined( 'NEWSPACK_NODES_VERSION' ) ) {
	\define( 'NEWSPACK_NODES_VERSION', '0.1.31' );
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
	// `types`, `run`, `restart`, `status` are instance methods on
	// WorkerCliCommand. PHP 8+ rejects `[ClassName::class, 'instance_method']`
	// as a callable (see wp-cli/wp-cli#5472), so register a single shared
	// instance per subcommand. PHPStan's strict callable check requires this
	// form too; the old class-string-plus-method array form is no longer a
	// valid callable type. Instance reuse keeps registration cost flat.
	$nodes_worker_cli = new \Newspack_Nodes\WorkerCliCommand();
	\WP_CLI::add_command( 'nodes',           '\\Newspack_Nodes\\Cli_Command' );
	\WP_CLI::add_command( 'nodes types',   [ $nodes_worker_cli, 'types' ]   );
	\WP_CLI::add_command( 'nodes run',     [ $nodes_worker_cli, 'run' ]     );
	\WP_CLI::add_command( 'nodes restart', [ $nodes_worker_cli, 'restart' ] );
	\WP_CLI::add_command( 'nodes status',  [ $nodes_worker_cli, 'status' ]  );
}

// Register substrate node types with CommandInterpreter::$class_map so the
// shell `make_node` verb and the topology-side `$interpreter->make_node()`
// instance API can construct them by short name. Plugins extending the
// runtime add their own subclasses via additional `register_class()` calls.
\Newspack_Nodes\CommandInterpreter::register_class( 'Callback',           \Newspack_Nodes\Callback::class );
\Newspack_Nodes\CommandInterpreter::register_class( 'CommandInterpreter', \Newspack_Nodes\CommandInterpreter::class );
\Newspack_Nodes\CommandInterpreter::register_class( 'Consumer',           \Newspack_Nodes\Consumer::class );
\Newspack_Nodes\CommandInterpreter::register_class( 'Dumper',             \Newspack_Nodes\Dumper::class );
\Newspack_Nodes\CommandInterpreter::register_class( 'Echo',               \Newspack_Nodes\Echo_Node::class );
\Newspack_Nodes\CommandInterpreter::register_class( 'Hook',               \Newspack_Nodes\Hook::class );
\Newspack_Nodes\CommandInterpreter::register_class( 'Lock',               \Newspack_Nodes\Lock::class );
\Newspack_Nodes\CommandInterpreter::register_class( 'Log',                \Newspack_Nodes\Log::class );
\Newspack_Nodes\CommandInterpreter::register_class( 'Partition',          \Newspack_Nodes\Partition::class );
\Newspack_Nodes\CommandInterpreter::register_class( 'Router',             \Newspack_Nodes\Router::class );
\Newspack_Nodes\CommandInterpreter::register_class( 'Shell',              \Newspack_Nodes\Shell::class );
\Newspack_Nodes\CommandInterpreter::register_class( 'Tail',               \Newspack_Nodes\Tail::class );
\Newspack_Nodes\CommandInterpreter::register_class( 'Tee',                \Newspack_Nodes\Tee::class );
\Newspack_Nodes\CommandInterpreter::register_class( 'Timer',              \Newspack_Nodes\Timer::class );
\Newspack_Nodes\CommandInterpreter::register_class( 'Topic',              \Newspack_Nodes\Topic::class );

// Substrate service CIs — discoverable to `$base_ci->make_node(...)`,
// which constructs + names + sinks each in one step from the
// `newspack_nodes/request_graph_ready` hook mounted below. Matches the
// app-side `_CI`-suffix convention (newspack-event-logger-nodes.php)
// so `Classes_CI.list` returns a consistent shell-name catalog across
// substrate + application CIs.
\Newspack_Nodes\CommandInterpreter::register_class( 'Classes_CI',    \Newspack_Nodes\Rest\Classes_CI::class );
\Newspack_Nodes\CommandInterpreter::register_class( 'Layouts_CI',    \Newspack_Nodes\Rest\Layouts_CI::class );
\Newspack_Nodes\CommandInterpreter::register_class( 'Topologies_CI', \Newspack_Nodes\Rest\Topologies_CI::class );

/**
 * Service-CommandInterpreter (CI) mounting.
 *
 * `Command_Controller::dispatch` lazy-builds the request-scope graph
 * (`_router` / `_command_interpreter` / `_http`) then fires
 * `newspack_nodes/request_graph_ready` so anything that wants to mount
 * a CI can do so via `$base_ci->make_node(...)` — which constructs,
 * names, and sinks each node in one atomic step. Without the sink, verb
 * responses (which walk back via TO=FROM) would have no path to the
 * HTTP_Out and silently drop.
 *
 * The substrate uses the SAME hook the apps use (newspack-event-logger-
 * nodes does the symmetric mount via its own callback), so substrate
 * CIs can also be filter-replaced if a future app needs to override one.
 *
 * Named function (not a closure) so tests that wipe
 * `$GLOBALS['_wp_actions']` for isolation can re-attach the same
 * callback without duplicating the mount logic.
 */
function newspack_nodes_mount_substrate_cis( \Newspack_Nodes\CommandInterpreter $base_ci ): void {
	$base_ci->make_node( 'Classes_CI',    'classes' );
	$base_ci->make_node( 'Layouts_CI',    'layouts' );
	$base_ci->make_node( 'Topologies_CI', 'topologies' );
}

// Wire WordPress integration: REST routes, cron-driven supervisor tick, activation/deactivation.
// Skipped in test environments where add_action is a stub but rest_api_init never fires.
if ( \function_exists( 'add_action' ) ) {
	\add_action( 'rest_api_init', [ '\\Newspack_Nodes\\Bootstrap', 'register_rest_routes' ] );
	\add_action( 'newspack_nodes/supervisor', [ '\\Newspack_Nodes\\Bootstrap', 'run_supervisor_tick' ] );
	\add_action( 'newspack_nodes/restart_fleet', [ '\\Newspack_Nodes\\WorkerCliCommand', 'restart_fleet_by_name' ] );
	\add_action( 'newspack_nodes/request_graph_ready', 'newspack_nodes_mount_substrate_cis' );
	// Long-lived workers that survive a config reload need their on-disk
	// log view invalidated so newly-created log dirs become visible.
	\add_action( \Newspack_Nodes\Config::RESET_ACTION, [ '\\Newspack_Nodes\\Log_Discovery', 'reset' ] );
	// Self-heal: if logging is on and a topology is selected but the
	// supervisor cron got cleared (DB rebuild, manual wp cron delete, etc.),
	// re-arm it on the next admin page view rather than waiting for the
	// operator to deactivate + reactivate the plugin.
	\add_action( 'admin_init', [ '\\Newspack_Nodes\\Bootstrap', 'self_heal_supervisor_cron' ] );
}
if ( \function_exists( 'add_filter' ) ) {
	// phpcs:ignore WordPress.WP.CronInterval.ChangeDetected -- The 60s interval registered by the callback is intentional (substrate supervisor tick); rule can't see into array-callable targets.
	\add_filter( 'cron_schedules', [ '\\Newspack_Nodes\\Bootstrap', 'register_cron_schedules' ] );
}
if ( \function_exists( 'register_activation_hook' ) ) {
	\register_activation_hook( NEWSPACK_NODES_FILE, [ '\\Newspack_Nodes\\Bootstrap', 'activate' ] );
}
if ( \function_exists( 'register_deactivation_hook' ) ) {
	\register_deactivation_hook( NEWSPACK_NODES_FILE, [ '\\Newspack_Nodes\\Bootstrap', 'deactivate' ] );
}
