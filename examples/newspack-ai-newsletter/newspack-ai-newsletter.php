<?php
/**
 * Plugin Name: Newspack AI Newsletter (Nodes example)
 * Description: Walkthrough example — a deterministic digest pipeline built from Nodes.
 * Version: 0.1.0
 *
 * @package Newspack_AI_Newsletter
 */

namespace Newspack_AI_Newsletter;

\defined( 'ABSPATH' ) || exit;

const INSIGHTS_MENU_SLUG = 'newspack-ai-newsletter-insights';
const INSIGHTS_MOUNT_ID  = 'newspack-ai-newsletter-insights';

/**
 * Register the Publisher Insights admin page as a submenu under the substrate's
 * "Nodes" menu. Renders only the React mount point — the dashboard bundle takes over.
 */
function register_insights_admin_page(): void {
	if ( ! \function_exists( 'add_submenu_page' ) || ! \class_exists( '\Newspack_Nodes\Admin\Admin' ) ) {
		return;
	}
	// Honor the substrate's access gate (manage_options + allowed_users whitelist), so this
	// page's visibility matches the sibling Workers / Raw Logs pages under the same menu.
	if ( ! \Newspack_Nodes\Admin\Admin::current_user_allowed() ) {
		return;
	}
	\add_submenu_page(
		\Newspack_Nodes\Admin\Admin::TOPOLOGY_MENU_SLUG,
		\__( 'Publisher Insights', 'newspack-ai-newsletter' ),
		\__( 'Publisher Insights', 'newspack-ai-newsletter' ),
		'manage_options',
		INSIGHTS_MENU_SLUG,
		static fn () => print( '<div id="' . \esc_attr( INSIGHTS_MOUNT_ID ) . '" class="newspack-ai-newsletter-insights"></div>' )
	);
}

/**
 * Enqueue the Publisher Insights dashboard bundle on its own admin page.
 */
function enqueue_insights_assets( string $hook = '' ): void {
	if ( ! \function_exists( 'wp_enqueue_script' ) ) {
		return;
	}
	// phpcs:ignore WordPress.Security.NonceVerification.Recommended
	$page = isset( $_GET['page'] ) && \is_string( $_GET['page'] ) ? \sanitize_text_field( \wp_unslash( $_GET['page'] ) ) : '';
	if ( INSIGHTS_MENU_SLUG !== $page ) {
		return;
	}
	if ( \class_exists( '\Newspack_Nodes\Admin\Admin' ) && ! \Newspack_Nodes\Admin\Admin::current_user_allowed() ) {
		return;
	}

	$asset_file = __DIR__ . '/build/dashboard/index.asset.php';
	$script_url = \plugins_url( 'build/dashboard/index.js', __FILE__ );
	if ( ! \file_exists( $asset_file ) ) {
		return;
	}
	$asset = require $asset_file;
	if ( ! \is_array( $asset ) ) {
		return;
	}
	$handle   = 'newspack-ai-newsletter-insights';
	$dep_list = \is_array( $asset['dependencies'] ?? null ) ? $asset['dependencies'] : [];
	$deps     = \array_values( \array_filter( $dep_list, '\is_string' ) );
	$version  = \is_string( $asset['version'] ?? null ) ? $asset['version'] : '0.1.0';
	\wp_enqueue_script( $handle, $script_url, $deps, $version, true );

	$css_file = __DIR__ . '/build/dashboard/index.css';
	if ( \file_exists( $css_file ) ) {
		\wp_enqueue_style( $handle, \plugins_url( 'build/dashboard/index.css', __FILE__ ), [], $version );
	}

	// REST root + nonce for the shared CommandClient (used by a later milestone).
	$rest_url = \function_exists( 'rest_url' ) ? \rest_url() : '/wp-json/';
	$nonce    = \function_exists( 'wp_create_nonce' ) ? \wp_create_nonce( 'wp_rest' ) : '';
	\wp_localize_script(
		$handle,
		'NewspackNodesData',
		[
			'restUrl' => \esc_url_raw( $rest_url ),
			'nonce'   => $nonce,
		]
	);
}

if ( \is_admin() ) {
	\add_action( 'admin_menu', __NAMESPACE__ . '\\register_insights_admin_page', 11 );
	\add_action( 'admin_enqueue_scripts', __NAMESPACE__ . '\\enqueue_insights_assets' );
}

/**
 * Mount the Publisher Insights service interpreter into the per-request graph,
 * the same way the substrate mounts its own CIs. Idempotent: a second call
 * (same request) no-ops rather than colliding on the 'insights' node name.
 */
function mount_insights_ci( \Newspack_Nodes\Command_Interpreter_Node $base_interpreter ): void {
	if ( null !== \Newspack_Nodes\Core::node( 'insights' ) ) {
		return;
	}
	require_once __DIR__ . '/includes/class-insights-ci.php';
	$base_interpreter->make_node( 'Insights_CI', 'insights' );
}

// Load after newspack-nodes (its own deferred loader runs at plugins_loaded:11).
\add_action(
	'plugins_loaded',
	static function (): void {
		if ( ! \class_exists( '\Newspack_Nodes\Topology_Registry' ) ) {
			return;
		}
		// Composer classmap autoload (run `composer dump-autoload -o` after
		// adding/renaming a node). This is also what puts the node classes in
		// the classmap that Classes_CI scans, so their node_schema() verbs show
		// up in the topology-console palette + per-node Inspector.
		require_once __DIR__ . '/vendor/autoload.php';

		// One call wires it all: the Newspack_AI_Newsletter\ namespace (so
		// make_node resolves *_Node classes), the topologies/ stock dir, a
		// catalog entry for every *.tsl in it (just digest.tsl here), and a
		// guarded spawn handler. That's the whole "register a Nodes plugin" story.
		\Newspack_Nodes\Topology_Registry::register_plugin(
			'Newspack_AI_Newsletter\\',
			__DIR__ . '/topologies'
		);

		// Mount the Insights service CI into each request graph so the dashboard can poll it.
		\add_action( 'newspack_nodes/request_graph_ready', __NAMESPACE__ . '\\mount_insights_ci' );
	},
	12
);
