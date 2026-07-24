<?php
/**
 * Newspack Nodes (substrate) test configuration baseline.
 *
 * Loaded via LOCAL_NEWSPACK_NODES_CONF environment variable (set in
 * phpunit.xml and bootstrap.php). Tests that need a different
 * base_directory write their own per-test config file in setUp and
 * point LOCAL_NEWSPACK_NODES_CONF at it via TestCase::use_base_dir().
 *
 * @package Newspack_Nodes
 */

return [
	// realpath'd so macOS's /tmp -> /private/tmp symlink passes the path guard.
	'base_directory'   => \rtrim( (string) \realpath( \sys_get_temp_dir() ), '/' ) . '/newspack-nodes-test',
	'num_partitions'   => 1,
	'segment_size'     => 1024,
	'min_segments'     => 2,
	'num_segments'     => 2,
	'min_lifetime'     => 0,
	'lifetime'         => 0,
	'max_segments'     => 0,
	'memcache_servers' => [],
];
