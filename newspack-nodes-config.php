<?php
/**
 * Newspack Nodes — sample substrate configuration overlay.
 *
 * This file is loaded at the bottom of `Config::load_config_defaults()` after
 * the runtime's `newspack_nodes/base_dir` filter has seeded `base_directory`,
 * and BEFORE WordPress-option overrides (`newspack_nodes_*`).
 *
 * To override locally without editing this file, point the env var
 * `LOCAL_NEWSPACK_NODES_CONF` at a `.php` file inside `/usr/src/...` or this
 * plugin's own directory and have it `return` an array of overrides. See
 * `Config::validate_config_path()` for the security envelope.
 *
 * @package Newspack_Nodes
 */

\defined( 'ABSPATH' ) || exit;

return [
	// ── Directories ────────────────────────────────────────────────────────
	// Default flows from the runtime's `newspack_nodes/base_dir` filter
	// (`/tmp/newspack-nodes` unless overridden). Set explicitly here only if
	// the substrate needs a different root.
	// 'base_directory'   => '/tmp/newspack-nodes',

	// ── Memcache (extended; loaded only in 'full' mode) ───────────────────
	// Override via WP option `newspack_nodes_memcache_servers` (newline-
	// separated `host:port`).
	'memcache_servers'   => [
		'127.0.0.1:11211',
	],

	// ── Partitioning + retention ───────────────────────────────────────────
	// `num_partitions`: parallelism factor (CRC32-keyed). Capped at 16.
	// `num_segments`:   segments retained per partition (count cap).
	// `segment_size`:   max bytes per segment before rotation (64MB default).
	// `max_lifespan`:   minimum retention in seconds. Segments are deleted
	//                   only when both over `num_segments` AND older than
	//                   `max_lifespan`. Set to 0 for pure count-based
	//                   retention.
	'num_partitions'     => 1,
	'num_segments'       => 2,
	'segment_size'       => 64 * 1024 * 1024,
	'max_lifespan'       => 86400,
];
