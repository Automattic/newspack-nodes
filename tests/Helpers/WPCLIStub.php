<?php
/**
 * Test-only WP_CLI stub. Captures log/warning/error/success calls into globals
 * so command tests can assert against the stream without a real WP-CLI runtime.
 *
 * @package Newspack_Nodes\Tests
 */

\defined( 'ABSPATH' ) || exit;

if ( ! \class_exists( 'WP_CLI', false ) ) {
	class WP_CLI {
		public static function log( string $msg ): void {
			$GLOBALS['_test_wp_cli_logs'][] = $msg;
		}

		public static function warning( string $msg ): void {
			$GLOBALS['_test_wp_cli_warns'][] = $msg;
		}

		public static function error( string $msg ): void {
			$GLOBALS['_test_wp_cli_errors'][] = $msg;
			throw new \RuntimeException( "WP_CLI::error called: $msg" );
		}

		public static function success( string $msg ): void {
			$GLOBALS['_test_wp_cli_success'][] = $msg;
		}
	}
}
