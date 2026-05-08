<?php
/**
 * PHPUnit bootstrap for Newspack Nodes A1 tests.
 *
 * No WordPress; just enough function stubs that the plugin file loads.
 *
 * @package Newspack_Nodes
 */

\define( 'ABSPATH', '/' );

// Minimal WP stubs needed for the plugin file.
function plugin_dir_path( string $file ): string {
	return \dirname( $file ) . '/';
}

// Load the plugin (which require_once's the class files).
require_once \dirname( __DIR__ ) . '/newspack-nodes.php';

// Load test helpers.
require_once __DIR__ . '/Helpers/TestCase.php';
require_once __DIR__ . '/Helpers/CaptureSink.php';
