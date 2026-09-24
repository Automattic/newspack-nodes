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
    // A `user_login` allowlist narrowing every capability role, so it governs
    // the REST control plane — `/command`, `/auth`, both SSE streams, the spawn
    // endpoint's external path — as well as the admin pages. Checked after the
    // capability, so a demoted account loses access without an edit here, and
    // only for a logged-in user, so CLI, cron and workers are never narrowed.
    // Empty allows every user who holds the role; a login named here must
    // include any service account, such as the log aggregator's hub user.
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
    // 'sse_idle_timeout'           => 5,

    // Wall-clock seconds an SSE stream stays open, busy or not, before it
    // closes clean and the client reopens; 0 = no limit.
    // 'sse_max_lifetime'           => 30,

    // Reopen delay, sent as a `retry` EVENT when the stream opens rather
    // than as the protocol `retry:` field, because the client owns reconnect.
    // A stream that delivered records sends 0 at its lifetime close: reopen
    // at once. 0 here sends nothing at open, so an idle close falls back to
    // the client's own backoff.
    // 'sse_retry_ms'               => 5000,

    // Sustained SSE streams this HOST allows; each holds a php-fpm child for
    // its whole life. Raise only where the platform grants the workers to
    // spend — the arithmetic is in docs/sse-host-budget.md.
    // 'sse_max_streams'            => 6,

    // Host slots browsers may not claim, taken OUT of the total above. A spoke
    // sets 1 so the hub's aggregation pull always finds a slot.
    // 'sse_reserved_slots'         => 0,

    // One reader's share of that host total; a reader is a user id paired with
    // an IP hash. The shipped 3 leaves room for a lease a dead process never
    // released, standing for the whole TTL while the client's real reconnect
    // already wants a slot of its own.
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
