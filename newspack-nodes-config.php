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

	// Retention; max_segments 0 = derive 2x num_segments (the hard ceiling).
	'num_partitions'      => 1,
	'segment_size'        => 64 * 1024 * 1024,
	'min_segments'        => 2,
	'num_segments'        => 8,
	'min_lifetime'        => 3600,
	'lifetime'            => 86400,
	'max_segments'        => 0,

	// Memcache. Stats live here only, never on disk; per-partition prefix.
	'memcache_servers'    => [
		'127.0.0.1:11211',
	],

	// Extra /log/stream + taillog sources ('name=/absolute/path' entries).
	'log_sources'         => [],

	// Fleet alerts, read live each tick: lag bytes (64 MiB = one segment).
	'alert_lag_threshold' => 64 * 1024 * 1024,
	// Dead-letter: warn past this many quarantined segments (0 = the first).
	'alert_deadletter_threshold' => 0,
	// Rate limit: minimum seconds between alert-emission bursts.
	'alert_emit_interval' => 300,

	// Topologies (Topology_Registry names); each = a num_partitions fleet.
	'topologies'          => [],

	// Vault: encrypted aggregator-server registry (managed via Vault API).
	'vault'               => [],

	// Aggregator spoke list (hubs only; spokes leave empty).

	// Lower ONLY for a self-signed internal certificate.
	'spawn_verify_ssl'    => true,

	'vault_verify_ssl'    => true,
	'vault_require_ssl'   => true,
	'remote_min_segments' => 2,
	'remote_num_segments' => 8,
	'remote_segment_size' => 64 * 1024 * 1024,
	'remote_min_lifetime' => 900,
	'remote_lifetime'     => 900,
	// Remote hard cap; 0 = spoke derives 2x remote num segments.
	'remote_max_segments' => 0,
];
