<?php
/**
 * Global-namespace `wp_cache_delete()` stub, deliberately NOT required by
 * bootstrap.php (see the "intentionally NOT stubbed" note there — other
 * suites rely on `function_exists('wp_cache_delete')` being false). Only
 * `#[RunInSeparateProcess]` tests that need to assert on individual
 * `wp_cache_delete()` calls should `require_once` this file.
 *
 * @package Newspack_Nodes
 */

if ( ! \function_exists( 'wp_cache_delete' ) ) {
	function wp_cache_delete( string $key, string $group = '' ): bool {
		$GLOBALS['_wp_cache_delete_calls'][] = [ $key, $group ];
		return true;
	}
}
