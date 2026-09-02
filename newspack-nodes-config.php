<?php
/**
 * Newspack Nodes (substrate) configuration — deployment OVERRIDES.
 *
 * Every key below is commented out, and the value shown is the default
 * `Settings_Schema` declares in code. Uncomment a line to override it on this
 * deployment; a WordPress option, where a key has a settings field, beats
 * both. Pinning is not the same as leaving a key alone — a pinned value
 * survives a later change to the schema default.
 *
 * Substrate keys only. Application keys live in
 * newspack-event-logger-nodes-config.php.
 *
 * @package Newspack_Nodes
 */

\defined( 'ABSPATH' ) || exit;

return [
    // Access control; empty = every manage_options admin is allowed.
    // 'allowed_users'              => [],

    // Filesystem root for logs / locks / offsets / IPC dirs.
    // 'base_directory'             => '/tmp/newspack-nodes',

    // Retention; max_segments 0 = derive 2x num_segments (the hard ceiling).
    // 'num_partitions'             => 1,
    // 'segment_size'               => 64 * 1024 * 1024,
    // 'min_segments'               => 2,
    // 'num_segments'               => 8,
    // 'max_segments'               => 0,
    // 'min_lifetime'               => 43200,
    // 'lifetime'                   => 86400,

    // Memcache. Stats live here only, never on disk; per-partition prefix.
    // 'memcache_servers'           => [ '127.0.0.1:11211' ],

    // Extra /log/stream + taillog sources ('name=/absolute/path' entries).
    // 'log_sources'                => [],

    // Fleet alerts, read live each tick: lag bytes (64 MiB = one segment).
    // 'alert_lag_threshold'        => 64 * 1024 * 1024,

    // Dead-letter: warn past this many quarantined segments (0 = the first).
    // 'alert_deadletter_threshold' => 0,

    // Rate limit: minimum seconds between alert-emission bursts.
    // 'alert_emit_interval'        => 300,

    // SSE close-at-EOF: seconds of no DATA before a stream closes (0 = never).
    // 'sse_idle_timeout'           => 15,

    // The reopen delay that close advertises as `retry:`; match the pair.
    // 'sse_retry_ms'               => 5000,

    // Sustained SSE streams this HOST allows; each holds a php-fpm
    // child for its whole life. Raise only where the platform grants
    // the workers to spend.
    // 'sse_max_streams'            => 6,

    // Host slots browsers may not claim, taken OUT of the total above. A spoke
    // sets 1 so the hub's aggregation pull always finds a slot.
    // 'sse_reserved_slots'         => 0,

    // One reader's share of that host total; the per-user/IP concurrency cap.
    // 'sse_max_slots'              => 3,

    // Seconds a slot lease survives without a client heartbeat. The floor is 45
    // — below it a client merely RE-AUTHENTICATING loses its stream.
    // 'sse_slot_ttl'               => 60,

    // Seconds idle before a worker exits; 0 = resident. TSL frontmatter wins.
    // 'on_demand_idle'             => 0,

    // Topologies (Topology_Registry names); each = a num_partitions fleet.
    // 'topologies'                 => [],

    // Vault: encrypted aggregator-server registry (managed via Vault API).
    // 'vault'                      => [],

    // Lower ONLY for a self-signed internal certificate.
    // 'spawn_verify_ssl'           => true,
    // 'vault_verify_ssl'           => true,
    // 'vault_require_ssl'          => true,

    // Remote-spoke retention, pushed to spokes by the settings-sync graph.
    // 'remote_segment_size'        => 64 * 1024 * 1024,
    // 'remote_min_segments'        => 2,
    // 'remote_num_segments'        => 8,
    // 'remote_max_segments'        => 0,
    // 'remote_min_lifetime'        => 900,
    // 'remote_lifetime'            => 900,
];
