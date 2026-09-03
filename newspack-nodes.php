<?php
/**
 * Plugin Name: Newspack Nodes
 * Description: WordPress-internal node-graph runtime for composable services.
 * Version: 2.49.1
 * Author: Automattic
 * Author URI: https://newspack.com/
 * License: GPL-2.0-or-later
 * License URI: https://www.gnu.org/licenses/gpl-2.0.html
 * Requires at least: 6.5
 * Requires PHP: 8.2
 * Text Domain: newspack-nodes
 * Domain Path: /languages
 *
 * Plugin entry point: the registrations that make the substrate reachable from
 * WordPress. No logic lives here — each hook names a handler elsewhere, and the
 * one function defined below mounts the substrate's service CIs.
 *
 * Runtime wiring deliberately does not happen at load. Admin and WP-CLI
 * requests wire `Bootstrap::ensure_diagnostics_wired()` only, which resolves no
 * base directory, so Site Health and `wp nodes doctor` keep reporting on a
 * misconfigured runtime. The storage-backed tier — the namespaces `make_node`
 * resolves against, the `<config:key>` TSL tokens, the user topology directory,
 * the `newspack_nodes/periodic` subscribers — waits for
 * `Bootstrap::ensure_runtime_wired()`, which each command, REST route and admin
 * screen calls when it needs it. A frontend page view reaches neither tier.
 *
 * @package Newspack_Nodes
 */

\defined( 'ABSPATH' ) || exit;

/** Substrate version: the consumer handshake, and the admin bundles' cache buster. */
if ( ! \defined( 'NEWSPACK_NODES_VERSION' ) ) {
	\define( 'NEWSPACK_NODES_VERSION', '2.49.1' );
}
/** Filesystem root: the autoloader, the bundled topologies and the built assets. */
if ( ! \defined( 'NEWSPACK_NODES_DIR' ) ) {
	\define( 'NEWSPACK_NODES_DIR', \plugin_dir_path( __FILE__ ) );
}
/** Browser base for the `build/` bundles; undefined where `plugin_dir_url()` is absent. */
if ( ! \defined( 'NEWSPACK_NODES_URL' ) && \function_exists( 'plugin_dir_url' ) ) {
	\define( 'NEWSPACK_NODES_URL', \plugin_dir_url( __FILE__ ) );
}

// The release zip ships vendor/; a dev clone needs `composer install`.
require_once NEWSPACK_NODES_DIR . 'vendor/autoload.php';

// Load-time, like consumers': TSL includes resolve without runtime wiring.
\Newspack_Nodes\Topology_Registry::register_builtin();

if ( \function_exists( 'is_admin' ) && \is_admin() ) {
	\Newspack_Nodes\Bootstrap::ensure_diagnostics_wired();
	new \Newspack_Nodes\Admin\Admin();
}

if ( \defined( 'WP_CLI' ) && \WP_CLI ) {
	\Newspack_Nodes\Bootstrap::ensure_diagnostics_wired();
	// Instances: the verb methods are not static (wp-cli#5472).
	$nodes_worker_cli   = new \Newspack_Nodes\Worker_CLI_Command();
	$nodes_ingest_cli   = new \Newspack_Nodes\Ingest_CLI_Command();
	$nodes_scaffold_cli = new \Newspack_Nodes\Scaffold_CLI_Command();
	$nodes_memcache_cli = new \Newspack_Nodes\Memcache_CLI_Command();
	$nodes_caps_cli     = new \Newspack_Nodes\Caps_CLI_Command();
	\WP_CLI::add_command( 'nodes',           '\\Newspack_Nodes\\CLI_Command' );
	\WP_CLI::add_command( 'nodes types',      [ $nodes_worker_cli, 'types' ]      );
	\WP_CLI::add_command( 'nodes run',        [ $nodes_worker_cli, 'run' ]        );
	\WP_CLI::add_command( 'nodes restart',    [ $nodes_worker_cli, 'restart' ]    );
	\WP_CLI::add_command( 'nodes stop',       [ $nodes_worker_cli, 'stop' ]       );
	\WP_CLI::add_command( 'nodes start',      [ $nodes_worker_cli, 'start' ]      );
	\WP_CLI::add_command( 'nodes status',     [ $nodes_worker_cli, 'status' ]     );
	\WP_CLI::add_command( 'nodes activate',   [ $nodes_worker_cli, 'activate' ]   );
	\WP_CLI::add_command( 'nodes deactivate', [ $nodes_worker_cli, 'deactivate' ] );
	\WP_CLI::add_command( 'nodes gc',         [ $nodes_worker_cli, 'gc' ]         );
	\WP_CLI::add_command( 'nodes doctor',     [ $nodes_worker_cli, 'doctor' ]     );
	\WP_CLI::add_command( 'nodes ingest',     [ $nodes_ingest_cli, 'ingest' ]     );
	\WP_CLI::add_command( 'nodes scaffold',   [ $nodes_scaffold_cli, 'scaffold' ] );
	\WP_CLI::add_command( 'nodes memcache get', [ $nodes_memcache_cli, 'get' ] );
	\WP_CLI::add_command( 'nodes memcache flush', [ $nodes_memcache_cli, 'flush' ] );
	\WP_CLI::add_command( 'nodes caps',       [ $nodes_caps_cli, 'caps' ]         );
	\WP_CLI::add_command( 'nodes hub-user',   [ $nodes_caps_cli, 'hub_user' ]     );
}

/**
 * Mount the substrate's service command interpreters onto a request graph.
 *
 * `Bootstrap::mount_request_graph()` builds `_router` and
 * `_command_interpreter`, then fires `newspack_nodes/request_graph_ready` —
 * the same action applications mount their own CIs on, so no door ends up with
 * a different verb surface behind it. Each CI arrives through `make_node()`,
 * which constructs, names and sinks it in one step; without that sink a verb
 * reply, addressed TO=FROM, has no path back to the `_output` response writer
 * and drops silently.
 *
 * A named function rather than a closure, so the callback can be re-attached
 * or unhooked by name: tests that wipe `$GLOBALS['_wp_actions']` for isolation
 * re-register this one.
 *
 * @param \Newspack_Nodes\Command_Interpreter_Node $base_interpreter The request-scope `_command_interpreter`.
 */
function newspack_nodes_mount_substrate_cis( \Newspack_Nodes\Command_Interpreter_Node $base_interpreter ): void {
	// request_graph_ready can fire twice in one request; skip the remount.
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
	$base_interpreter->make_node( 'Sessions_CI',   'sessions' );

	// make_node drops non-scalar args, so object deps are assigned after it.
	$cli        = new \Newspack_Nodes\CLI( \Newspack_Nodes\Bootstrap::base_dir() );
	$workers_ci = $base_interpreter->make_node( 'Workers_CI', 'workers' );
	if ( $workers_ci instanceof \Newspack_Nodes\Rest\Workers_CI_Node ) {
		$workers_ci->cli = $cli;
	}
}

if ( \function_exists( 'add_action' ) ) {
	\add_action( 'rest_api_init', [ '\\Newspack_Nodes\\Bootstrap', 'register_rest_routes' ] );
	\add_action( 'newspack_nodes/reconcile', [ '\\Newspack_Nodes\\Bootstrap', 'reconcile_fleet' ] );
	\add_action( 'newspack_nodes/restart_fleet', [ '\\Newspack_Nodes\\Worker_CLI_Command', 'restart_fleet_by_name' ] );
	\add_action( 'newspack_nodes/request_graph_ready', 'newspack_nodes_mount_substrate_cis' );
	// Settings-sync: init() registers the option-change hooks once.
	\Newspack_Nodes\Settings_Event_Writer::init();
	// Veto diagnostics: every cron runner calls these, not only wp-cron.php.
	\add_filter( 'pre_schedule_event', [ '\\Newspack_Nodes\\Bootstrap', 'log_reconcile_schedule_veto' ], PHP_INT_MAX - 2, 2 );
	\add_filter( 'pre_reschedule_event', [ '\\Newspack_Nodes\\Bootstrap', 'log_reconcile_schedule_veto' ], PHP_INT_MAX - 2, 2 );
	// A late veto erases the hook name; MIN + 2 captures it, MAX - 2 reports.
	\add_filter( 'schedule_event', [ '\\Newspack_Nodes\\Bootstrap', 'remember_schedule_event_context' ], PHP_INT_MIN + 2, 1 );
	\add_filter( 'schedule_event', [ '\\Newspack_Nodes\\Bootstrap', 'log_reconcile_schedule_event_veto' ], PHP_INT_MAX - 2, 1 );
	// Default spawn handler: spawns any active-set worker, ungated by owner.
	\add_action( 'newspack_nodes/spawn_worker', [ '\\Newspack_Nodes\\Topology_Registry', 'spawn_worker' ], 10, 2 );
	// Config reload: drop memoized scans, parsed TSL and vault credentials.
	\add_action( \Newspack_Nodes\Config::RESET_ACTION, [ '\\Newspack_Nodes\\Log_Discovery', 'reset' ] );
	\add_action( \Newspack_Nodes\Config::RESET_ACTION, [ '\\Newspack_Nodes\\Topology_Registry', 'reset_basename_cache' ] );
	\add_action( \Newspack_Nodes\Config::RESET_ACTION, [ '\\Newspack_Nodes\\Vault', 'reset' ] );
	// Self-heal: re-arm the reconcile cron on admin view if it got cleared.
	\add_action( 'admin_init', [ '\\Newspack_Nodes\\Bootstrap', 'self_heal_reconcile_cron' ] );
}

if ( \function_exists( 'add_filter' ) ) {
	// phpcs:ignore WordPress.WP.CronInterval.ChangeDetected -- The 60s interval registered by the callback is intentional (the substrate reconcile pass); rule can't see into array-callable targets.
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
