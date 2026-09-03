<?php
/**
 * Newspack Nodes (substrate) configuration — deployment OVERRIDES.
 *
 * Every key ships commented out beside the default `Settings_Schema` declares
 * in code: the schema is the definition, this file only overrides what it names
 * (ADR-20), and uncommenting one line is the whole edit. `ConfigSchemaTest`
 * parses these entries back into an array and holds them to
 * `Settings_Schema::defaults()`, key for key and value for value, so a default
 * changed in one file alone fails the suite.
 *
 * Four layers, weakest first: the schema default, this file, the file named by
 * `LOCAL_NEWSPACK_NODES_CONF`, and a stored `newspack_nodes_<key>` option.
 * PRESENCE decides the option layer rather than truthiness, so a stored '', []
 * or false beats both files — for every declared key, including the `vault` and
 * `topologies` ones the settings page never renders.
 *
 * Pinning is not the same as leaving a key alone: a pinned value survives a
 * later change to the schema default.
 *
 * A key the schema does not declare is reported and ignored, never thrown. The
 * deploy copies the deployment's own copy of this file over the shipped path,
 * and throwing at `plugins_loaded:-10001` would take wp-admin down with every
 * other request. A misspelled key therefore leaves the real one on its default;
 * `wp nodes doctor` and Site Health name it under `config-keys`.
 *
 * Substrate keys only. Application keys live in
 * newspack-event-logger-nodes-config.php.
 *
 * @package Newspack_Nodes
 */

\defined( 'ABSPATH' ) || exit;

return [
    // A `user_login` allowlist over the substrate admin pages, checked after
    // the MANAGE capability, so a demoted account loses access without an edit
    // here. Empty allows every user who holds that capability.
    // 'allowed_users'              => [],

    // Runtime root: the logs, locks, offsets, deadletter and IPC dirs hang off
    // it. Web, CLI and workers must all resolve the same path, and one that is
    // a symlink, traversable, or owned by another uid is refused.
    // 'base_directory'             => '/tmp/newspack-nodes',

    // Partitions each fleet spawns; a topology's frontmatter overrides it.
    // 'num_partitions'             => 1,

    // Bytes at which a partition seals a segment and rotates to the next.
    // 'segment_size'               => 64 * 1024 * 1024,

    // Floor for the AGE rule: keep this many segments however old they get.
    // 'min_segments'               => 2,

    // Target for the COUNT rule: prune the oldest back to this many segments.
    // 'num_segments'               => 8,

    // Hard cap, pruned UNCONDITIONALLY: min_lifetime does not protect it and
    // only the floor of 2 segments does. 0 = derive 2x num_segments.
    // 'max_segments'               => 0,

    // Floor for the COUNT rule: spare a segment younger than this many
    // seconds; 0 = prune purely by count.
    // 'min_lifetime'               => 43200,

    // The AGE rule itself: prune segments older than this many seconds, down
    // to min_segments; 0 = no age pruning.
    // 'lifetime'                   => 86400,

    // The one Memcached handle. Empty leaves it null rather than installing an
    // unreachable one, because each reader's fail path keys on that null:
    // command auth refuses, SSE slots fail closed, stats fail soft.
    // 'memcache_servers'           => [ '127.0.0.1:11211' ],

    // Extra /log/stream and taillog sources, one 'name=/absolute/path' each.
    // 'log_sources'                => [],

    // Fleet alerts, read live on every sweep. Consumer lag in bytes past which
    // a reader warns; the shipped 64 MiB is one segment.
    // 'alert_lag_threshold'        => 64 * 1024 * 1024,

    // Quarantined dead-letter segments past which a reader warns; 0 = warn on
    // the first one.
    // 'alert_deadletter_threshold' => 0,

    // Rate limit: at most one alert-journal batch per this many seconds.
    // 'alert_emit_interval'        => 300,

    // Seconds without DATA before an SSE stream closes clean; 0 = never.
    // 'sse_idle_timeout'           => 15,

    // Reopen delay, sent as a `retry` EVENT when the stream opens rather than
    // as the protocol `retry:` field, because the client owns reconnect.
    // 'sse_retry_ms'               => 5000,

    // Sustained SSE streams this HOST allows; each holds a php-fpm child for
    // its whole life. Raise only where the platform grants the workers to
    // spend — the arithmetic is in docs/sse-host-budget.md.
    // 'sse_max_streams'            => 6,

    // Host slots browsers may not claim, taken OUT of the total above. A spoke
    // sets 1 so the hub's aggregation pull always finds a slot.
    // 'sse_reserved_slots'         => 0,

    // One reader's share of that host total; a reader is a user id paired with
    // an IP hash. The shipped 3 leaves room for a stream reopening on the
    // sse_idle_timeout plus sse_retry_ms cycle while its dead lease stands.
    // 'sse_max_slots'              => 3,

    // Seconds a slot lease survives without a client heartbeat; only the
    // client refreshes it. A lower value is raised to the floor of 45: under
    // that, a client merely RE-AUTHENTICATING loses its stream.
    // 'sse_slot_ttl'               => 60,

    // Seconds idle before a worker exits; 0 = resident. The fleet-wide
    // default, which a topology's frontmatter overrides.
    // 'on_demand_idle'             => 0,

    // The active set, by Topology_Registry name; each spawns its own fleet.
    // 'topologies'                 => [],

    // Spokes pinned beside the code: id => url, auth_username, auth_password.
    // The Vault API writes the `newspack_nodes_vault` option instead, and that
    // wins on a shared id, so an entry pinned here is immutable through the
    // API — and its password sits in this file as plaintext, where the
    // option's is sealed under `wp_salt( 'auth' )`.
    // 'vault'                      => [],

    // Verify the TLS peer: spawn_verify_ssl on the internal loopback calls
    // (worker spawn, health cache), vault_verify_ssl on Vault spoke calls.
    // Lower ONLY for a self-signed internal certificate.
    // 'spawn_verify_ssl'           => true,
    // 'vault_verify_ssl'           => true,

    // Refuse a spoke url that is not https at all; HTTP_Out drops the batch.
    // 'vault_require_ssl'          => true,

    // Spoke geometry the settings-sync graph pushes; nothing local reads it.
    // Each lands as that spoke's own retention key, and as its own remote_*
    // copy, so the geometry propagates on to ITS spokes.
    // 'remote_segment_size'        => 64 * 1024 * 1024,
    // 'remote_min_segments'        => 2,
    // 'remote_num_segments'        => 8,
    // 'remote_max_segments'        => 0,
    // 'remote_min_lifetime'        => 900,
    // 'remote_lifetime'            => 900,
];
