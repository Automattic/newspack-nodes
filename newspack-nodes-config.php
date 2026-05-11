<?php
/**
 * Newspack Nodes (substrate) configuration.
 *
 * Substrate keys only. Application keys live in
 * newspack-event-logger-nodes-config.php.
 *
 * @package Newspack_Nodes
 */

\defined( 'ABSPATH' ) || exit;

return [
	// Filesystem root for logs / locks / offsets / IPC dirs.
	// 'base_directory' (commented) — filter-driven; `newspack_nodes/base_dir`
	// resolves the default to /tmp/newspack-nodes. Per-env overlays set this
	// explicitly to a persistent volume path.

	// Partitioning + segment retention.
	//   num_partitions: parallelism factor (CRC32-keyed; capped at 16).
	//   num_segments:   retained per partition (count cap).
	//   segment_size:   max bytes before rotation.
	//   max_lifespan:   minimum retention seconds; deletion requires BOTH
	//                   over num_segments AND older than max_lifespan.
	'num_partitions'   => 1,
	'num_segments'     => 2,
	'segment_size'     => 64 * 1024 * 1024,
	'max_lifespan'     => 86400,

	// Memcache pool. Stats live here only — never on disk. Per-partition
	// prefix namespaces the keys.
	'memcache_servers' => [
		'127.0.0.1:11211',
	],
];
