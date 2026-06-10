<?php
/**
 * Plugin Name: Newspack Nodes
 * Description: Node-graph runtime for composable PHP services.
 * Version: 0.15.0
 * Author: Automattic
 * License: GPL-2.0-or-later
 * Text Domain: newspack-nodes
 * Domain Path: /languages
 *
 * @package Newspack_Nodes
 */

\defined( 'ABSPATH' ) || exit;

if ( ! \defined( 'NEWSPACK_NODES_VERSION' ) ) {
	\define( 'NEWSPACK_NODES_VERSION', '0.15.0' );
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
	\Newspack_Nodes\Bootstrap::ensure_runtime_wired();
	new \Newspack_Nodes\Admin\Admin();
}

if ( \defined( 'WP_CLI' ) && \WP_CLI ) {
	\Newspack_Nodes\Bootstrap::ensure_runtime_wired();
	// `types`, `run`, `restart`, `status` are instance methods on
	// WorkerCliCommand. PHP 8+ rejects `[ClassName::class, 'instance_method']`
	// as a callable (see wp-cli/wp-cli#5472), so register a single shared
	// instance per subcommand. PHPStan's strict callable check requires this
	// form too; the old class-string-plus-method array form is no longer a
	// valid callable type. Instance reuse keeps registration cost flat.
	$nodes_worker_cli = new \Newspack_Nodes\Worker_CLI_Command();
	\WP_CLI::add_command( 'nodes',           '\\Newspack_Nodes\\CLI_Command' );
	\WP_CLI::add_command( 'nodes types',   [ $nodes_worker_cli, 'types' ]   );
	\WP_CLI::add_command( 'nodes run',     [ $nodes_worker_cli, 'run' ]     );
	\WP_CLI::add_command( 'nodes restart', [ $nodes_worker_cli, 'restart' ] );
	\WP_CLI::add_command( 'nodes status',  [ $nodes_worker_cli, 'status' ]  );
}

// The substrate runtime wiring (node-class namespaces, the `<config:…>` token
// namespace, the stock-topology dir, and the shared Core::$memd handle) is NO
// LONGER run at plugin-file scope. It moved into the idempotent
// `Bootstrap::ensure_runtime_wired()` (above's WP-CLI / is_admin blocks +
// rest_api_init + the supervisor tick) so a plain frontend page view — which
// touches none of the node graph / cache — stops paying for the Config System
// autoload + a `\Memcached` connection it never uses. See ensure_runtime_wired().

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
	// Idempotency guard. The `newspack_nodes/request_graph_ready` action
	// has been observed firing twice in the same PHP request in production —
	// without this guard the second invocation throws "node name collision:
	// workers already registered" at make_node('Workers_CI', 'workers') and
	// fatals the REST response with a 500.
	if ( null !== \Newspack_Nodes\Core::node( 'workers' ) ) {
		return;
	}

	$base_interpreter->make_node( 'Classes_CI',    'classes' );
	$base_interpreter->make_node( 'Layouts_CI',    'layouts' );
	$base_interpreter->make_node( 'Topologies_CI', 'topologies' );
	$base_interpreter->make_node( 'Raw_Logs_CI',   'raw-logs' );

	// Workers_CI needs the substrate Cli plus an optional `\Memcached`-shaped
	// cache (or null) for live-position memcache reads + SSE-slot heartbeats.
	// Substrate doesn't build a connection itself, so apply a filter for an
	// application to provide one (event-logger-nodes hands over the shared
	// `Core::$memd`). Null cache means live-position falls back to on-disk
	// offsetlog and the `heartbeat` verb throws "cache not configured".
	//
	// Construction follows the Tachikoma uniform pattern: `make_node` calls a
	// no-arg ctor + `arguments()` for scalar config; programmatic deps (Cli,
	// cache) come in via public-property assignment immediately after, since
	// `arguments()` only handles round-trippable scalar tokens.
	$cli = new \Newspack_Nodes\CLI( \Newspack_Nodes\Bootstrap::base_dir() );
	// apply_filters() returns mixed by design; the documented contract is a \Memcached or null.
	/** @var \Memcached|null $cache */
	$cache = \function_exists( 'apply_filters' )
		? \apply_filters( 'newspack_nodes/workers_cache', null )
		: null;
	$workers_ci = $base_interpreter->make_node( 'Workers_CI', 'workers' );
	if ( $workers_ci instanceof \Newspack_Nodes\Rest\Workers_CI_Node ) {
		$workers_ci->cli   = $cli;
		$workers_ci->cache = $cache;
	}
}

// Wire WordPress integration: REST routes, cron-driven supervisor tick, activation/deactivation.
// Skipped in test environments where add_action is a stub but rest_api_init never fires.
if ( \function_exists( 'add_action' ) ) {
	// Wire the runtime before any REST callback runs (priority 1, ahead of
	// register_rest_routes at 10). Covers all REST: command, SSE, spawn, the
	// service CIs, and spawned workers (which boot inside the /spawn request).
	\add_action( 'rest_api_init', [ '\\Newspack_Nodes\\Bootstrap', 'ensure_runtime_wired' ], 1 );
	\add_action( 'rest_api_init', [ '\\Newspack_Nodes\\Bootstrap', 'register_rest_routes' ] );
	\add_action( 'newspack_nodes/supervisor', [ '\\Newspack_Nodes\\Bootstrap', 'run_supervisor_tick' ] );
	\add_action( 'newspack_nodes/restart_fleet', [ '\\Newspack_Nodes\\Worker_CLI_Command', 'restart_fleet_by_name' ] );
	\add_action( 'newspack_nodes/request_graph_ready', 'newspack_nodes_mount_substrate_cis' );
	// Veto-time supervisor-cron diagnostics: these filters run inside
	// wp_schedule_event/wp_reschedule_event under ANY cron runner, unlike the
	// cron_*_event_error actions only wp-cron.php fires.
	\add_filter( 'pre_schedule_event', [ '\\Newspack_Nodes\\Bootstrap', 'log_supervisor_schedule_veto' ], PHP_INT_MAX - 2, 2 );
	\add_filter( 'pre_reschedule_event', [ '\\Newspack_Nodes\\Bootstrap', 'log_supervisor_schedule_veto' ], PHP_INT_MAX - 2, 2 );
	// Substrate-owned default spawn handler: spawns any worker in the active set
	// (expand_workers), ungated by plugin ownership — topologies aren't owned.
	\add_action( 'newspack_nodes/spawn_worker', [ '\\Newspack_Nodes\\Topology_Registry', 'spawn_worker' ], 10, 2 );
	// Long-lived workers that survive a config reload need their on-disk
	// log view invalidated so newly-created log dirs become visible AND
	// their per-topology basename cache cleared so newly-edited TSLs are
	// re-read. Narrow reset_basename_cache() keeps `Topology_Registry`'s
	// stock_dirs + user_dir intact (the full `reset()` is test-only).
	\add_action( \Newspack_Nodes\Config::RESET_ACTION, [ '\\Newspack_Nodes\\Log_Discovery', 'reset' ] );
	\add_action( \Newspack_Nodes\Config::RESET_ACTION, [ '\\Newspack_Nodes\\Topology_Registry', 'reset_basename_cache' ] );
	// Self-heal: if logging is on and a topology is selected but the
	// supervisor cron got cleared (DB rebuild, manual wp cron delete, etc.),
	// re-arm it on the next admin page view rather than waiting for the
	// operator to deactivate + reactivate the plugin.
	\add_action( 'admin_init', [ '\\Newspack_Nodes\\Bootstrap', 'self_heal_supervisor_cron' ] );
	// One-time autoload-correction sweep for existing installs (guarded;
	// off the frontend path). See Config::correct_option_autoload().
	\add_action( 'admin_init', [ '\\Newspack_Nodes\\Config', 'correct_option_autoload' ] );
}
if ( \function_exists( 'add_filter' ) ) {
	// phpcs:ignore WordPress.WP.CronInterval.ChangeDetected -- The 60s interval registered by the callback is intentional (substrate supervisor tick); rule can't see into array-callable targets.
	\add_filter( 'cron_schedules', [ '\\Newspack_Nodes\\Bootstrap', 'register_cron_schedules' ] );
	// Substrate-owned topology catalog: every .tsl in list() (user dir + all
	// stock dirs), not a per-plugin allowlist.
	\add_filter( 'newspack_nodes/topologies', [ '\\Newspack_Nodes\\Topology_Registry', 'publish_catalog' ] );
}
if ( \function_exists( 'register_activation_hook' ) ) {
	\register_activation_hook( NEWSPACK_NODES_FILE, [ '\\Newspack_Nodes\\Bootstrap', 'activate' ] );
}
if ( \function_exists( 'register_deactivation_hook' ) ) {
	\register_deactivation_hook( NEWSPACK_NODES_FILE, [ '\\Newspack_Nodes\\Bootstrap', 'deactivate' ] );
}
