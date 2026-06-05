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
	},
	12
);
