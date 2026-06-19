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
	'base_directory'   => '/tmp/newspack-nodes',

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

	// Active topologies — flat list of names resolved via
	// Topology_Registry. Substrate ships none; application plugins
	// (or per-deployment overlays) populate this list. Each entry
	// becomes one fleet of `num_partitions` workers (sized by the
	// topology's frontmatter when present).
	'topologies'       => [],

	// Vault — encrypted aggregator-server registry (managed via the Vault API).
	'vault'               => [],
	'vault_verify_ssl'    => true,
	// Refuse outbound POSTs (HTTP_Out) to a plaintext spoke when true.
	'vault_require_https' => false,
];
