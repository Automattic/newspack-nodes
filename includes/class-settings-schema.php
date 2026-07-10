<?php
/**
 * Settings_Schema: the substrate's config declaration — ONE Field per setting.
 *
 * The single source both Config (overlay key-list + autoload sweep) and Admin
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

	/** The substrate settings schema (memoized). */
	public static function get(): Schema {
		if ( null !== self::$schema ) {
			return self::$schema;
		}

		$storage = 'newspack_nodes_storage_section';
		$remote  = 'newspack_nodes_remote_section';

		// Literal prefix so a schema-building worker never autoloads Admin.
		self::$schema = new Schema(
			'newspack_nodes_',
			[
				new Field(
					key: 'num_partitions',
					type: 'int',
					label: static fn(): string => \__( 'Num Partitions', 'newspack-nodes' ),
					section: $storage,
					// Supervisor reloads config each loop; no restart needed.
					restart: 'supervisor_only',
					sanitize: [ Admin::class, 'sanitize_int_or_empty' ],
					render: [ Admin::class, 'num_partitions_callback' ],
				),
				new Field(
					key: 'num_segments',
					type: 'int',
					label: static fn(): string => \__( 'Num Segments', 'newspack-nodes' ),
					section: $storage,
					restart: [ 'Partition', 'Topic', 'Log' ],
					sanitize: [ Admin::class, 'sanitize_int_or_empty' ],
					render: [ Admin::class, 'num_segments_callback' ],
				),
				new Field(
					key: 'segment_size',
					type: 'int',
					label: static fn(): string => \__( 'Segment Size', 'newspack-nodes' ),
					section: $storage,
					restart: [ 'Partition', 'Topic', 'Log' ],
					sanitize: [ Admin::class, 'sanitize_int_or_empty' ],
					render: [ Admin::class, 'segment_size_callback' ],
				),
				new Field(
					key: 'max_lifespan',
					type: 'int',
					label: static fn(): string => \__( 'Minimum Retention', 'newspack-nodes' ),
					section: $storage,
					restart: [ 'Partition', 'Topic', 'Log' ],
					sanitize: [ Admin::class, 'sanitize_int_or_empty' ],
					render: [ Admin::class, 'max_lifespan_callback' ],
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
				// Remote storage geometry; registered + resettable.
				new Field(
					key: 'remote_num_segments',
					type: 'int',
					label: static fn(): string => \__( 'Remote Segment Count', 'newspack-nodes' ),
					section: $remote,
					restart: [],
					sanitize: [ Admin::class, 'sanitize_remote_num_segments' ],
					render: [ Admin::class, 'remote_num_segments_callback' ],
					register_args: [ 'type' => 'string' ],
				),
				new Field(
					key: 'remote_segment_size',
					type: 'int',
					label: static fn(): string => \__( 'Remote Segment Size', 'newspack-nodes' ),
					section: $remote,
					restart: [],
					sanitize: [ Admin::class, 'sanitize_remote_segment_size' ],
					render: [ Admin::class, 'remote_segment_size_callback' ],
					register_args: [ 'type' => 'string' ],
				),
				new Field(
					key: 'remote_max_lifespan',
					type: 'int',
					label: static fn(): string => \__( 'Remote Min Retention', 'newspack-nodes' ),
					section: $remote,
					restart: [],
					sanitize: [ Admin::class, 'sanitize_remote_max_lifespan' ],
					render: [ Admin::class, 'remote_max_lifespan_callback' ],
					register_args: [ 'type' => 'string' ],
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
			]
		);

		return self::$schema;
	}
}
