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
	// Deployment override: restrict admin UI to these usernames.
	'allowed_users'       => [],

	// Filesystem root for logs / locks / offsets / IPC dirs.
	'base_directory'      => '/tmp/newspack-nodes',

	// Retention: dual-rule; count-prune eligible after 1 hour, age-prune past 24 h.
	'num_partitions'      => 1,
	'segment_size'        => 64 * 1024 * 1024,
	'min_segments'        => 2,
	'max_segments'        => 2,
	'min_lifetime'        => 3600,
	'max_lifetime'        => 86400,

	// Memcache. Stats live here only, never on disk; per-partition prefix.
	'memcache_servers'    => [
		'127.0.0.1:11211',
	],

	// Topologies (Topology_Registry names); each = a num_partitions fleet.
	'topologies'          => [],

	// Vault: encrypted aggregator-server registry (managed via Vault API).
	'vault'               => [],

	// Aggregator spoke list (hubs only; spokes leave empty).
	'vault_verify_ssl'    => true,
	'vault_require_ssl'   => true,
	'remote_max_segments' => 2,
	'remote_segment_size' => 10 * 1024 * 1024,
	'remote_min_lifetime' => 3600,
];
