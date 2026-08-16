<?php
/**
 * Test-only `WP_CLI\Utils\format_items`. A command prints its rows through it,
 * so a test reads `$GLOBALS['_test_wp_cli_tables']` to see what was tabulated
 * — a separate file because a namespaced declaration cannot sit beside the
 * global-scope class in WPCLIStub.php.
 *
 * @package Newspack_Nodes\Tests
 */

namespace WP_CLI\Utils;

\defined( 'ABSPATH' ) || exit;

if ( ! \function_exists( 'WP_CLI\Utils\format_items' ) ) {
	function format_items( string $format, array $items, array $fields ): void {
		$GLOBALS['_test_wp_cli_tables'][] = [
			'format' => $format,
			'items'  => $items,
			'fields' => $fields,
		];
		// @longform Also emit the rows as LINES. Defining this function at all
		// flips every command that branches on `function_exists()` onto its
		// WP-CLI path, and the tests written against the plain-text fallback
		// read `_test_wp_cli_lines` or `_test_wp_cli_logs` — so a stub that
		// only records structure silently empties their output.
		$emit = static function ( string $line ): void {
			$GLOBALS['_test_wp_cli_lines'][] = $line;
			$GLOBALS['_test_wp_cli_logs'][]  = $line;
		};
		$emit( \implode( '  ', $fields ) );
		foreach ( $items as $item ) {
			$row = [];
			foreach ( $fields as $field ) {
				$row[] = (string) ( \is_array( $item ) ? ( $item[ $field ] ?? '' ) : '' );
			}
			$emit( \implode( '  ', $row ) );
		}
	}
}
