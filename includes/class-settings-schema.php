<?php
/**
 * Settings_Schema: the substrate's config declaration — ONE Field per setting.
 *
 * Each substrate config key is declared once here — its default, its bounds and
 * its worker-restart class — and every other view of that key derives from the
 * Field. `Config` reads the defaults, the overlay key-list and the declared-key
 * set; `Admin` registers, renders and resets the settings page through it;
 * `Settings_CI_Node` bounds-checks the `settings` verb against the same min/max
 * the page clamps to; `Restart_Planner` reads the restart class;
 * `Settings_Event_Writer` derives the Config Audit values allowlist from the
 * rendered option names.
 *
 * A default belongs here rather than in `newspack-nodes-config.php` because a
 * deploy preserves the operator's config file: a key added later never appears
 * in it, so a default living only there reads null forever (ADR-20). Every
 * config file is an override surface and nothing else.
 *
 * Labels are `fn(): string` thunks. Any config read builds this schema — in
 * workers and CLI runs, not only admin requests — so resolving a label eagerly
 * would make every read depend on `__()`. The render and sanitize callables
 * name Admin's static methods as `[ Admin::class, '…' ]` and are never invoked
 * here, so a schema-building worker never loads the admin surface.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

use Newspack_Nodes\Admin\Admin;
use Newspack_Nodes\Config_System\Field;
use Newspack_Nodes\Config_System\Schema;

\defined( 'ABSPATH' ) || exit;

/**
 * The substrate's own Schema: its Fields and the three sections they render in.
 *
 * Fields are declared in settings-page order — the storage, remote and alerting
 * sections — followed by the `ui: false` keys, which the per-request overlay
 * loads and `Config::value()` reads but the page never renders.
 */
class Settings_Schema {

	/** @var Schema|null Memoized — the schema is pure structure (runtime values resolve inside the render callbacks). */
	private static ?Schema $schema = null;

	/**
	 * The substrate settings schema, built once per process.
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
					// The fleet scan re-expands the worker list every pass.
					restart: [],
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
					render: [ Admin::class, 'max_segments_callback' ],
				),
				new Field(
					key: 'min_lifetime',
					type: 'int',
					min: 0,
					max: 604800,
					default: 43200,
					label: static fn(): string => \__( 'Min Lifetime', 'newspack-nodes' ),
					section: $storage,
					restart: [ 'Partition', 'Topic', 'Log' ],
					render: [ Admin::class, 'min_lifetime_callback' ],
				),
				new Field(
					key: 'lifetime',
					type: 'int',
					min: 0,
					max: 604800,
					default: 86400,
					label: static fn(): string => \__( 'Lifetime', 'newspack-nodes' ),
					section: $storage,
					restart: [ 'Partition', 'Topic', 'Log' ],
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
					default: '/tmp/newspack-nodes',
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
					default: [ '127.0.0.1:11211' ],
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
					default: [],
					label: static fn(): string => \__( 'Log Sources', 'newspack-nodes' ),
					section: $storage,
					// Registry resolves per-request; no restarts.
					restart: [],
					sanitize: [ Admin::class, 'sanitize_log_sources' ],
					render: [ Admin::class, 'log_sources_callback' ],
					register_args: [ 'type' => 'array', 'default' => [], 'autoload' => false ],
				),
				// Spoke geometry the hub pushes; nothing local reads it.
				new Field(
					key: 'remote_segment_size',
					type: 'int',
					min: 1048576,
					max: 268435456,
					default: 67108864,
					label: static fn(): string => \__( 'Remote Segment Size', 'newspack-nodes' ),
					section: $remote,
					restart: [],
					render: [ Admin::class, 'remote_segment_size_callback' ],
					register_args: [ 'type' => 'integer' ],
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
					render: [ Admin::class, 'remote_min_segments_callback' ],
					register_args: [ 'type' => 'integer' ],
				),
				new Field(
					key: 'remote_num_segments',
					type: 'int',
					min: 2,
					max: 16,
					default: 8,
					label: static fn(): string => \__( 'Remote Num Segments', 'newspack-nodes' ),
					section: $remote,
					restart: [],
					render: [ Admin::class, 'remote_num_segments_callback' ],
					register_args: [ 'type' => 'integer' ],
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
					render: [ Admin::class, 'remote_max_segments_callback' ],
					register_args: [ 'type' => 'integer' ],
				),
				new Field(
					key: 'remote_min_lifetime',
					type: 'int',
					min: 0,
					max: 604800,
					default: 900,
					label: static fn(): string => \__( 'Remote Min Lifetime', 'newspack-nodes' ),
					section: $remote,
					restart: [],
					render: [ Admin::class, 'remote_min_lifetime_callback' ],
					register_args: [ 'type' => 'integer' ],
				),
				new Field(
					key: 'remote_lifetime',
					type: 'int',
					min: 0,
					max: 604800,
					default: 900,
					label: static fn(): string => \__( 'Remote Lifetime', 'newspack-nodes' ),
					section: $remote,
					restart: [],
					render: [ Admin::class, 'remote_lifetime_callback' ],
					register_args: [ 'type' => 'integer' ],
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
					render: [ Admin::class, 'alert_emit_interval_callback' ],
					register_args: [ 'type' => 'integer', 'autoload' => false ],
				),
				// Idle-close window and reopen delay, read at stream open.
				new Field(
					key: 'sse_idle_timeout',
					type: 'int',
					default: 15,
					ui: false,
				),
				new Field(
					key: 'sse_retry_ms',
					type: 'int',
					default: 5000,
					ui: false,
				),
				// The host's sustained-stream budget; see SSE_Slot_Pool.
				new Field(
					key: 'sse_max_streams',
					type: 'int',
					default: 6,
					min: 1,
					max: 64,
					ui: false,
				),
				new Field(
					key: 'sse_reserved_slots',
					type: 'int',
					default: 0,
					min: 0,
					max: 63,
					ui: false,
				),
				new Field(
					key: 'sse_max_slots',
					type: 'int',
					default: 3,
					min: 1,
					max: 64,
					ui: false,
				),
				new Field(
					key: 'sse_slot_ttl',
					type: 'int',
					default: 60,
					min: 45,
					max: 3600,
					ui: false,
				),
				// Worker analogue of sse_idle_timeout; frontmatter wins.
				new Field(
					key: 'on_demand_idle',
					type: 'int',
					default: 0,
					ui: false,
				),
				// Unregistered: a page Save would submit it empty and wipe it.
				new Field(
					key: 'topologies',
					type: 'array_strings',
					default: [],
					ui: false,
				),
				// Login allow-list narrowing admin access; empty = no filter.
				new Field(
					key: 'allowed_users',
					type: 'array_strings',
					default: [],
					ui: false,
				),
				// A deploy replaces the config file; the schema outlives it.
				new Field(
					key: 'spawn_verify_ssl',
					type: 'bool',
					default: true,
					ui: false,
				),
				// Encrypted credentials; a ui Field would log their values.
				new Field(
					key: 'vault',
					type: 'array_strings',
					default: [],
					ui: false,
				),
				// Lowered ONLY for a self-signed cert; not a checkbox.
				new Field(
					key: 'vault_verify_ssl',
					type: 'bool',
					default: true,
					ui: false,
				),
				// Refuses a plaintext spoke url outright; HTTP_Out enforces it.
				new Field(
					key: 'vault_require_ssl',
					type: 'bool',
					default: true,
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
