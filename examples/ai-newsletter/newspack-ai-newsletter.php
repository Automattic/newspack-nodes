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
		if ( ! \class_exists( '\Newspack_Nodes\Command_Interpreter_Node' ) ) {
			return;
		}
		require_once __DIR__ . '/includes/class-releases-source.php';
		require_once __DIR__ . '/includes/class-community-source.php';
		require_once __DIR__ . '/includes/class-summarizer.php';
		require_once __DIR__ . '/includes/class-digest-builder.php';
		\Newspack_Nodes\Command_Interpreter_Node::register_namespace( 'Newspack_AI_Newsletter\\' );
	},
	12
);
