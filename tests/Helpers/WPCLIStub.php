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
		public static function log( string $message ): void {
			$GLOBALS['_test_wp_cli_logs'][] = $message;
		}

		public static function warning( string $message ): void {
			$GLOBALS['_test_wp_cli_warns'][] = $message;
		}

		public static function error( string $message ): void {
			$GLOBALS['_test_wp_cli_errors'][] = $message;
			throw new \RuntimeException( "WP_CLI::error called: $message" );
		}

		public static function success( string $message ): void {
			$GLOBALS['_test_wp_cli_success'][] = $message;
		}
	}
}
