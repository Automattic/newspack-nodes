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
	// Per test process; tests/bootstrap.php names it, realpath'd for macOS.
	'base_directory'   => \getenv( 'NEWSPACK_TEST_BASE_DIR' ) ?: throw new \RuntimeException( 'NEWSPACK_TEST_BASE_DIR is unset: load tests/bootstrap.php' ),
	'num_partitions'   => 1,
	'segment_size'     => 1024,
	'min_segments'     => 2,
	'num_segments'     => 2,
	'min_lifetime'     => 0,
	'lifetime'         => 0,
	'max_segments'     => 0,
	'memcache_servers' => [],
];
