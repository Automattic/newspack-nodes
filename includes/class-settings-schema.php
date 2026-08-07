<?php
/**
 * Settings_Schema: the substrate's config declaration — ONE Field per setting.
 *
 * The single source both Config (overlay key-list) and Admin
 * (register_setting + add_settings_field loops, option_names, delete-on-blank
 * set, reset list, worker-restart classification) derive from.
 *
 * The Field render/sanitize callables point at Admin's static methods; building
 * the Schema only references them as `[Admin::class, '…']` callables (never
 * invokes them), so a worker that loads Config for overlay_keys() never pulls
 * in the admin surface.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

use Newspack_Nodes\Admin\Admin;
use Newspack_Nodes\Config_System\Field;
use Newspack_Nodes\Config_System\Schema;

\defined( 'ABSPATH' ) || exit;

class Settings_Schema {

	/** @var Schema|null Memoized — the schema is pure structure (runtime values resolve inside the render callbacks). */
	private static ?Schema $schema = null;

	/**
	 * The substrate settings schema (memoized).
	 *
	 * Footgun: every ui-visible Field's option auto-joins the Config Audit
	 * VALUES allowlist (Settings_Event_Writer logs old/new excerpts to the
	 * durable settings.p0). Never add a credential-bearing Field here —
	 * secrets belong in the Vault, which the writer hard-excludes.
	 */
	public static function get(): Schema {
		if ( null !== self::$schema ) {
			return self::$schema;
		}

		$storage  = 'newspack_nodes_storage_section';
		$remote   = 'newspack_nodes_remote_section';
		$alerting = 'newspack_nodes_alerting_section';

		// Literal prefix so a schema-building worker never autoloads Admin.
		self::$schema = new Schema(
			'newspack_nodes_',
			[
				new Field(
					key: 'num_partitions',
					type: 'int',
					min: 1,
					max: 16,
					default: 1,
					label: static fn(): string => \__( 'Num Partitions', 'newspack-nodes' ),
					section: $storage,
					// Fleet_Node re-reads each window.
					restart: [],
					sanitize: [ Admin::class, 'sanitize_int_or_empty' ],
					render: [ Admin::class, 'num_partitions_callback' ],
				),
				new Field(
					key: 'segment_size',
					type: 'int',
					min: 1048576,
					max: 536870912,
					default: 67108864,
					label: static fn(): string => \__( 'Segment Size', 'newspack-nodes' ),
					section: $storage,
					restart: [ 'Partition', 'Topic', 'Log' ],
					sanitize: [ Admin::class, 'sanitize_int_or_empty' ],
					render: [ Admin::class, 'segment_size_callback' ],
				),
				new Field(
					key: 'min_segments',
					type: 'int',
					min: 2,
					max: 32,
					default: 2,
					label: static fn(): string => \__( 'Min Segments', 'newspack-nodes' ),
					section: $storage,
					restart: [ 'Partition', 'Topic', 'Log' ],
					sanitize: [ Admin::class, 'sanitize_int_or_empty' ],
					render: [ Admin::class, 'min_segments_callback' ],
				),
				new Field(
					key: 'num_segments',
					type: 'int',
					min: 2,
					max: 32,
					default: 8,
					label: static fn(): string => \__( 'Num Segments', 'newspack-nodes' ),
					section: $storage,
					restart: [ 'Partition', 'Topic', 'Log' ],
					sanitize: [ Admin::class, 'sanitize_int_or_empty' ],
					render: [ Admin::class, 'num_segments_callback' ],
				),
				// True hard cap; 0 = auto (2x num_segments).
				new Field(
					key: 'max_segments',
					type: 'int',
					min: 0,
					max: 64,
					default: 0,
					label: static fn(): string => \__( 'Max Segments (hard cap)', 'newspack-nodes' ),
					section: $storage,
					restart: [ 'Partition', 'Topic', 'Log' ],
					sanitize: [ Admin::class, 'sanitize_int_or_empty' ],
					render: [ Admin::class, 'max_segments_callback' ],
				),
				new Field(
					key: 'min_lifetime',
					type: 'int',
					min: 0,
					max: 604800,
					default: 0,
					label: static fn(): string => \__( 'Min Lifetime', 'newspack-nodes' ),
					section: $storage,
					restart: [ 'Partition', 'Topic', 'Log' ],
					sanitize: [ Admin::class, 'sanitize_int_or_empty' ],
					render: [ Admin::class, 'min_lifetime_callback' ],
				),
				new Field(
					key: 'lifetime',
					type: 'int',
					min: 0,
					max: 604800,
					default: 0,
					label: static fn(): string => \__( 'Lifetime', 'newspack-nodes' ),
					section: $storage,
					restart: [ 'Partition', 'Topic', 'Log' ],
					sanitize: [ Admin::class, 'sanitize_int_or_empty' ],
					render: [ Admin::class, 'lifetime_callback' ],
				),
				// Display-only readout (no option, no reset).
				new Field(
					id: 'total_storage',
					label: static fn(): string => \__( 'Total Log Storage', 'newspack-nodes' ),
					section: $storage,
					render: [ Admin::class, 'total_storage_callback' ],
				),
				new Field(
					key: 'base_directory',
					type: 'path',
					label: static fn(): string => \__( 'Base Directory', 'newspack-nodes' ),
					section: $storage,
					// Long-lived workers resolve paths from base_directory.
					restart: 'all',
					sanitize: [ Admin::class, 'sanitize_base_directory' ],
					render: [ Admin::class, 'base_directory_callback' ],
				),
				new Field(
					key: 'memcache_servers',
					type: 'memcache_servers',
					label: static fn(): string => \__( 'Memcache Servers', 'newspack-nodes' ),
					section: $storage,
					// The Memcached handle lives in every long-lived worker.
					restart: 'all',
					sanitize: [ Admin::class, 'sanitize_memcache_servers' ],
					render: [ Admin::class, 'memcache_servers_callback' ],
					register_args: [ 'type' => 'array', 'default' => [], 'autoload' => false ],
				),
				new Field(
					key: 'log_sources',
					type: 'array_strings',
					label: static fn(): string => \__( 'Log Sources', 'newspack-nodes' ),
					section: $storage,
					// Registry resolves per-request; no restarts.
					restart: [],
					sanitize: [ Admin::class, 'sanitize_log_sources' ],
					render: [ Admin::class, 'log_sources_callback' ],
					register_args: [ 'type' => 'array', 'default' => [], 'autoload' => false ],
				),
				// Remote storage geometry; registered + resettable.
				new Field(
					key: 'remote_segment_size',
					type: 'int',
					min: 1048576,
					max: 268435456,
					default: 33554432,
					label: static fn(): string => \__( 'Remote Segment Size', 'newspack-nodes' ),
					section: $remote,
					restart: [],
					sanitize: [ Admin::class, 'sanitize_remote_segment_size' ],
					render: [ Admin::class, 'remote_segment_size_callback' ],
					register_args: [ 'type' => 'string' ],
				),
				new Field(
					key: 'remote_min_segments',
					type: 'int',
					min: 2,
					max: 16,
					default: 2,
					label: static fn(): string => \__( 'Remote Min Segments', 'newspack-nodes' ),
					section: $remote,
					restart: [],
					sanitize: [ Admin::class, 'sanitize_remote_min_segments' ],
					render: [ Admin::class, 'remote_min_segments_callback' ],
					register_args: [ 'type' => 'string' ],
				),
				new Field(
					key: 'remote_num_segments',
					type: 'int',
					min: 2,
					max: 16,
					default: 2,
					label: static fn(): string => \__( 'Remote Num Segments', 'newspack-nodes' ),
					section: $remote,
					restart: [],
					sanitize: [ Admin::class, 'sanitize_remote_num_segments' ],
					render: [ Admin::class, 'remote_num_segments_callback' ],
					register_args: [ 'type' => 'string' ],
				),
				// Remote hard cap for spokes; 0 = spoke derives 2x its count.
				new Field(
					key: 'remote_max_segments',
					type: 'int',
					min: 0,
					max: 64,
					default: 0,
					label: static fn(): string => \__( 'Remote Max Segments (hard cap)', 'newspack-nodes' ),
					section: $remote,
					restart: [],
					sanitize: [ Admin::class, 'sanitize_remote_max_segments' ],
					render: [ Admin::class, 'remote_max_segments_callback' ],
					register_args: [ 'type' => 'string' ],
				),
				new Field(
					key: 'remote_min_lifetime',
					type: 'int',
					min: 0,
					max: 604800,
					default: 3600,
					label: static fn(): string => \__( 'Remote Min Lifetime', 'newspack-nodes' ),
					section: $remote,
					restart: [],
					sanitize: [ Admin::class, 'sanitize_remote_min_lifetime' ],
					render: [ Admin::class, 'remote_min_lifetime_callback' ],
					register_args: [ 'type' => 'string' ],
				),
				new Field(
					key: 'remote_lifetime',
					type: 'int',
					min: 0,
					max: 604800,
					default: 0,
					label: static fn(): string => \__( 'Remote Lifetime', 'newspack-nodes' ),
					section: $remote,
					restart: [],
					sanitize: [ Admin::class, 'sanitize_remote_lifetime' ],
					render: [ Admin::class, 'remote_lifetime_callback' ],
					register_args: [ 'type' => 'string' ],
				),
				// Fleet-alert thresholds; read live by Alerts, no restart.
				new Field(
					key: 'alert_lag_threshold',
					type: 'int',
					min: 0,
					max: 10737418240,
					default: 67108864,
					label: static fn(): string => \__( 'Consumer Lag Threshold', 'newspack-nodes' ),
					section: $alerting,
					restart: [],
					sanitize: [ Admin::class, 'sanitize_int_or_empty' ],
					render: [ Admin::class, 'alert_lag_threshold_callback' ],
					register_args: [ 'type' => 'integer', 'autoload' => false ],
				),
				new Field(
					key: 'alert_deadletter_threshold',
					type: 'int',
					min: 0,
					max: 4096,
					default: 0,
					label: static fn(): string => \__( 'Dead-letter Threshold', 'newspack-nodes' ),
					section: $alerting,
					restart: [],
					sanitize: [ Admin::class, 'sanitize_int_or_empty' ],
					render: [ Admin::class, 'alert_deadletter_threshold_callback' ],
					register_args: [ 'type' => 'integer', 'autoload' => false ],
				),
				new Field(
					key: 'alert_emit_interval',
					type: 'int',
					min: 1,
					max: 86400,
					default: 300,
					label: static fn(): string => \__( 'Alert Emit Interval', 'newspack-nodes' ),
					section: $alerting,
					restart: [],
					sanitize: [ Admin::class, 'sanitize_int_or_empty' ],
					render: [ Admin::class, 'alert_emit_interval_callback' ],
					register_args: [ 'type' => 'integer', 'autoload' => false ],
				),
				// Overlay-only SSE close-at-EOF pair; read once per stream.
				new Field(
					key: 'sse_idle_timeout',
					type: 'int',
					default: 5,
					ui: false,
				),
				new Field(
					key: 'sse_retry_ms',
					type: 'int',
					default: 5000,
					ui: false,
				),
				// Worker analogue of sse_idle_timeout; frontmatter wins.
				new Field(
					key: 'on_demand_idle',
					type: 'int',
					default: 0,
					ui: false,
				),
				// ui:false overlay; registering lets Save wipe the active set.
				new Field(
					key: 'topologies',
					type: 'array_strings',
					ui: false,
				),
				// Overlay-only access whitelist; no settings field.
				new Field(
					key: 'allowed_users',
					type: 'array_strings',
					ui: false,
				),
				// Deploy replaces the config file; only this survives.
				new Field(
					key: 'spawn_verify_ssl',
					type: 'bool',
					ui: false,
				),
			],
			[
				$storage => [
					'title'    => static fn(): string => \__( 'Storage Settings', 'newspack-nodes' ),
					'callback' => [ Admin::class, 'storage_section_callback' ],
				],
				$remote  => [
					'title'    => static fn(): string => \__( 'Remote Servers', 'newspack-nodes' ),
					'callback' => [ Admin::class, 'remote_settings_section_callback' ],
				],
				$alerting => [
					'title'    => static fn(): string => \__( 'Fleet Alerts', 'newspack-nodes' ),
					'callback' => [ Admin::class, 'alerting_section_callback' ],
				],
			]
		);

		return self::$schema;
	}
}
