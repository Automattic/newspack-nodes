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
