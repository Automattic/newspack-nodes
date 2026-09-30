<?php
/**
 * Test-only WP_CLI stub. Captures log/warning/error/success/confirm calls into globals
 * so command tests can assert against the stream without a real WP-CLI runtime,
 * and records each `add_command()` under `_test_wp_cli_commands`, name =>
 * callable, for the usage-overview rule to read.
 *
 * @package Newspack_Nodes\Tests
 */

\defined( 'ABSPATH' ) || exit;

if ( ! \class_exists( 'WP_CLI', false ) ) {
	class WP_CLI {
		public static function add_command( string $name, mixed $callable ): void {
			$GLOBALS['_test_wp_cli_commands'][ $name ] = $callable;
		}

		public static function log( string $message ): void {
			$GLOBALS['_test_wp_cli_logs'][] = $message;
		}

		public static function line( string $message = '' ): void {
			$GLOBALS['_test_wp_cli_lines'][] = $message;
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

		/**
		 * As WP-CLI's: `--yes` skips the question. Otherwise the question is
		 * recorded and answered from `_test_wp_cli_confirm`, a no by default,
		 * which throws where WP-CLI would exit.
		 */
		public static function confirm( string $question, array $assoc_args = [] ): void {
			if ( isset( $assoc_args['yes'] ) ) {
				return;
			}
			$GLOBALS['_test_wp_cli_confirms'][] = $question;
			if ( true !== ( $GLOBALS['_test_wp_cli_confirm'] ?? false ) ) {
				throw new \RuntimeException( "WP_CLI::confirm declined: {$question}" );
			}
		}
	}
}
