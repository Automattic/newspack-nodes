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

if ( ! function_exists( 'do_action' ) ) {
	$GLOBALS['_wp_actions'] = [];
	function do_action( string $hook, ...$args ): void {
		foreach ( $GLOBALS['_wp_actions'][ $hook ] ?? [] as $cb ) {
			$cb( ...$args );
		}
	}
	function add_action( string $hook, callable $cb ): void {
		$GLOBALS['_wp_actions'][ $hook ][] = $cb;
	}
	function apply_filters( string $hook, mixed $value, ...$args ): mixed {
		foreach ( $GLOBALS['_wp_actions'][ $hook ] ?? [] as $cb ) {
			$value = $cb( $value, ...$args );
		}
		return $value;
	}
	function add_filter( string $hook, callable $cb ): void {
		$GLOBALS['_wp_actions'][ $hook ][] = $cb;
	}
}

// Load the plugin (which require_once's the class files).
require_once \dirname( __DIR__ ) . '/newspack-nodes.php';

// Load test helpers.
require_once __DIR__ . '/Helpers/TestCase.php';
require_once __DIR__ . '/Helpers/CaptureSink.php';
require_once __DIR__ . '/Helpers/BoundedTicks.php';
