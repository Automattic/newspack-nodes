<?php
/**
 * Plugin Name: Newspack AI Newsletter (Nodes example)
 * Description: Walkthrough example — a deterministic digest pipeline built from Nodes.
 * Version: 0.1.0
 *
 * Bootstrap for the walkthrough plugin that `docs/writing-a-plugin.md` and
 * `docs/writing-a-dashboard.md` build a chapter at a time. It carries wiring and nothing
 * else: the nodes live in `includes/`, the graph in `topologies/example-ai-newsletter.tsl`,
 * and the React page in `src/dashboard/`. Three registrations happen here — this plugin's
 * class namespace and topology directory with the substrate, the dashboard's service
 * interpreter into every request graph, and the admin page the bundle mounts into.
 *
 * @package Example_AI_Newsletter
 */

namespace Example_AI_Newsletter;

\defined( 'ABSPATH' ) || exit;

/**
 * The Publisher Insights page's `?page=` slug. `add_menu_page()` claims it and
 * `Admin::enqueue_react_page()` gates the bundle on it, so both read this constant rather
 * than a literal. Spell it two ways and the menu registers a page whose script never loads.
 */
const INSIGHTS_MENU_SLUG = 'example-ai-newsletter-insights';

/**
 * The id of the element React renders into. `src/dashboard/index.js` looks the element up
 * by this id, so the two halves are one contract. It holds the same string as the menu
 * slug but answers to a different consumer — the bundle rather than WordPress — so
 * changing one implies nothing about the other.
 */
const INSIGHTS_MOUNT_ID = 'example-ai-newsletter-insights';

/**
 * Register the Publisher Insights dashboard as its own top-level admin menu.
 *
 * A plugin's dashboard stands alone rather than nesting under the substrate's "Nodes"
 * menu, which belongs to the runtime's own tools — the Topology Console and the DevTools
 * hub. A dashboard that genuinely is a Nodes-internal tool registers as a `host: 'hub'`
 * DevTools tab instead of a submenu there.
 *
 * Visibility follows `Admin::current_user_allowed()` because the page reads pipeline
 * state: `manage_options` alone would show it to administrators the substrate's
 * `allowed_users` list excludes, and this page's audience should match the runtime's
 * other surfaces.
 *
 * The menu callback prints the React mount element inside the standard `.wrap` and
 * nothing more; the dashboard bundle renders everything from there.
 */
function register_insights_admin_page(): void {
	if ( ! \function_exists( 'add_menu_page' ) || ! \class_exists( '\Newspack_Nodes\Admin\Admin' ) ) {
		return;
	}
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
 *
 * `Admin::enqueue_react_page()` is the substrate's registrar and does the whole job. It
 * gates on `?page=` itself, reads `build/dashboard/index.asset.php` for the script's
 * dependencies and cache-busting version, enqueues the `index.css` sidecar plus its RTL
 * companion, and localizes `NewspackNodesData` — the `{ restUrl, nonce }` pair the
 * dashboard's JS transport authenticates its `POST /command` with. `version_fallback`
 * covers a build whose manifest carries no version.
 *
 * The stylesheet asks for `newspack-nodes-graph` rather than the registrar's default
 * `newspack-nodes-ui` because this page mounts the debug overlay; that handle brings the
 * canonical UI and theme sheets with it, so the graph CSS stays in one build asset
 * instead of a copy inside every consumer bundle.
 *
 * @param string $hook Admin page hook suffix `admin_enqueue_scripts` passes. Unread — the
 *                     registrar's own `?page=` gate decides whether this page is ours.
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
			'style_deps'       => [ 'wp-components', 'newspack-nodes-graph' ],
		]
	);
}

if ( \is_admin() ) {
	\add_action( 'admin_menu', __NAMESPACE__ . '\\register_insights_admin_page', 11 );
	\add_action( 'admin_enqueue_scripts', __NAMESPACE__ . '\\enqueue_insights_assets' );
}

/**
 * Mount the Publisher Insights service interpreter into the per-request graph, the same
 * way the substrate mounts its own CIs.
 *
 * The substrate builds `_router`, `_command_interpreter` and `_http` for a dispatch, then
 * fires `newspack_nodes/request_graph_ready`. Going through the base interpreter's
 * `make_node()` constructs, names and sinks the node in one step, and the sink is the half
 * that matters: a verb's reply is addressed TO=FROM (ADR-7) and walks back through the
 * base interpreter to the HTTP response writer, so a CI mounted without one drops every
 * reply.
 *
 * Requiring the class file spares the mount any dependence on a current composer
 * classmap, which only a hand-run `composer dump-autoload -o` refreshes.
 *
 * A second call in the same request returns early instead of colliding on the
 * `insights-demo` name, which `make_node()` throws on. Hooking a named function rather
 * than a closure is what lets the tests call the mount directly.
 *
 * @param \Newspack_Nodes\Command_Interpreter_Node $base_interpreter The request graph's
 *                                                                   base interpreter.
 */
function mount_insights_ci( \Newspack_Nodes\Command_Interpreter_Node $base_interpreter ): void {
	if ( null !== \Newspack_Nodes\Core::node( 'insights-demo' ) ) {
		return;
	}
	require_once __DIR__ . '/includes/class-insights-ci-demo-node.php';
	$base_interpreter->make_node( 'Insights_CI_Demo', 'insights-demo' );
}

// Defer to plugins_loaded: the substrate may load after this plugin.
\add_action(
	'plugins_loaded',
	static function (): void {
		if ( ! \class_exists( '\Newspack_Nodes\Topology_Registry' ) ) {
			return;
		}
		// Classmap for make_node; re-dump after adding or renaming a node.
		require_once __DIR__ . '/vendor/autoload.php';

		// One call registers the namespace prefix and the topologies dir.
		\Newspack_Nodes\Topology_Registry::register_plugin(
			'Example_AI_Newsletter\\',
			__DIR__ . '/topologies'
		);

		\add_action( 'newspack_nodes/request_graph_ready', __NAMESPACE__ . '\\mount_insights_ci' );
	},
	12
);
