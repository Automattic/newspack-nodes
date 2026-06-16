<?php
/**
 * Plugin Name: Newspack AI Newsletter (Nodes example)
 * Description: Walkthrough example — a deterministic digest pipeline built from Nodes.
 * Version: 0.1.0
 *
 * @package Example_AI_Newsletter
 */

namespace Example_AI_Newsletter;

\defined( 'ABSPATH' ) || exit;

const INSIGHTS_MENU_SLUG = 'example-ai-newsletter-insights';
const INSIGHTS_MOUNT_ID  = 'example-ai-newsletter-insights';

/**
 * Register the Publisher Insights dashboard as its OWN top-level admin menu —
 * it's this plugin's page, not a Nodes-substrate tool, so it stands alone rather
 * than nesting under the "Nodes" menu. The callback renders only the React mount
 * point inside the standard `.wrap`; the dashboard bundle takes over from there.
 */
function register_insights_admin_page(): void {
	if ( ! \function_exists( 'add_menu_page' ) || ! \class_exists( '\Newspack_Nodes\Admin\Admin' ) ) {
		return;
	}
	// Honor the substrate's access gate (manage_options + allowed_users whitelist),
	// since the dashboard reads substrate-managed pipeline state.
	if ( ! \Newspack_Nodes\Admin\Admin::current_user_allowed() ) {
		return;
	}
	\add_menu_page(
		\__( 'Publisher Insights', 'example-ai-newsletter' ),
		\__( 'Publisher Insights', 'example-ai-newsletter' ),
		'manage_options',
		INSIGHTS_MENU_SLUG,
		static fn () => print( '<div class="wrap"><div id="' . \esc_attr( INSIGHTS_MOUNT_ID ) . '" class="example-ai-newsletter-insights"></div></div>' ),
		'dashicons-chart-bar',
		58.7
	);
}

/**
 * Enqueue the Publisher Insights dashboard bundle on its own admin page.
 */
function enqueue_insights_assets( string $hook = '' ): void {
	if ( ! \function_exists( 'wp_enqueue_script' ) || ! \class_exists( '\Newspack_Nodes\Admin\Admin' ) ) {
		return;
	}
	if ( ! \Newspack_Nodes\Admin\Admin::current_user_allowed() ) {
		return;
	}

	\Newspack_Nodes\Admin\Admin::enqueue_react_page(
		[
			'handle'           => 'example-ai-newsletter-insights',
			'page'             => INSIGHTS_MENU_SLUG,
			'dir'              => __DIR__ . '/build/dashboard',
			'url'              => \plugins_url( 'build/dashboard', __FILE__ ),
			'version_fallback' => '0.1.0',
			'style_deps'       => [],
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
 * (same request) no-ops rather than colliding on the 'insights-demo' node name.
 */
function mount_insights_ci( \Newspack_Nodes\Command_Interpreter_Node $base_interpreter ): void {
	if ( null !== \Newspack_Nodes\Core::node( 'insights-demo' ) ) {
		return;
	}
	require_once __DIR__ . '/includes/class-insights-ci-demo-node.php';
	$base_interpreter->make_node( 'Insights_CI_Demo', 'insights-demo' );
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

		// One call wires it all: the Example_AI_Newsletter\ namespace (so
		// make_node resolves *_Node classes), the topologies/ stock dir, a
		// catalog entry for every *.tsl in it (just example-ai-newsletter.tsl here), and a
		// guarded spawn handler. That's the whole "register a Nodes plugin" story.
		\Newspack_Nodes\Topology_Registry::register_plugin(
			'Example_AI_Newsletter\\',
			__DIR__ . '/topologies'
		);

		// Mount the Insights service CI into each request graph so the dashboard can poll it.
		\add_action( 'newspack_nodes/request_graph_ready', __NAMESPACE__ . '\\mount_insights_ci' );
	},
	12
);
