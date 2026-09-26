<?php
/**
 * Switches the `get_option()` shim in wp-shims.php onto a model of WP core's
 * `options` cache group. The switch cannot be undone, so only
 * `#[RunInSeparateProcess]` tests `require_once` this file.
 *
 * `$GLOBALS['_wp_options']` is the database and `_wp_option_autoload` each
 * row's flag. Core fills the group with autoloaded rows under `alloptions`,
 * any other row under its own key, and a missing row's absence under
 * `notoptions`. Two tiers hold those entries: `_wp_option_cache` is THIS
 * process's runtime copy and `_wp_option_shared` the persistent cache every
 * process sees. A read hits the runtime copy, then the shared tier, copying
 * what it finds down, then the database. A write from this process lands in
 * both tiers; `wp_test_write_elsewhere()` and `wp_test_delete_elsewhere()`
 * reach the database and the shared tier only, leaving this copy stale.
 *
 * `wp_cache_flush_runtime()` empties the runtime copy. `wp_cache_flush_group(
 * 'options' )` empties both tiers, because a site with no external cache has
 * no shared tier. Each flush appends `runtime` or the group's name to
 * `$GLOBALS['_wp_cache_flushes']`. `wp_using_ext_object_cache()` answers
 * `$GLOBALS['_wp_using_ext_object_cache']`, true unless a test sets it false.
 *
 * @package Newspack_Nodes
 */

$GLOBALS['_wp_option_cache']  ??= [];
$GLOBALS['_wp_option_shared'] ??= [];
