<?php
/**
 * SchemaTest: the shared declarative config Schema — one Field per setting, the
 * SINGLE source every consumer (overlay key-list, option_names, delete-on-blank
 * set, reset list, worker-restart classification, register/render loops) derives
 * from. Replaces the parallel hand-listed arrays each plugin's Config + Admin
 * used to keep in lockstep.
 *
 * Owns its own WP-Settings-API stubs (global namespace) so a Schema can register
 * settings/sections/fields without the runtime bootstrap.
 *
 * @package Newspack_Nodes
 */

namespace {
	if ( ! \function_exists( 'register_setting' ) ) {
		function register_setting( string $group, string $option, array $args = [] ): void {
			$GLOBALS['_registered_settings'][ $option ] = [ 'group' => $group, 'args' => $args ];
		}
	}
	if ( ! \function_exists( 'add_settings_section' ) ) {
		function add_settings_section( string $id, string $title, callable $cb, string $page ): void {
			$GLOBALS['_registered_sections'][ $id ] = [ 'title' => $title, 'callback' => $cb, 'page' => $page ];
		}
	}
	if ( ! \function_exists( 'add_settings_field' ) ) {
		function add_settings_field( string $id, string $title, callable $cb, string $page, string $section ): void {
			$GLOBALS['_registered_fields'][ $id ] = [ 'title' => $title, 'callback' => $cb, 'page' => $page, 'section' => $section ];
		}
	}
}

namespace Newspack_Nodes\Tests\Unit\ConfigSystem {

	use Newspack_Nodes\Config_System\Field;
	use Newspack_Nodes\Config_System\Schema;
	use Newspack_Nodes\Tests\TestCase;
	use PHPUnit\Framework\Attributes\CoversClass;

	#[CoversClass( Schema::class )]
	#[CoversClass( Field::class )]
	class SchemaTest extends TestCase {

		/**
		 * A representative schema: a rendered option, a non-blank-deletable
		 * selection option, an overlay-only (ui=false) option, and a display-only
		 * (no key) field — exercising every Field predicate.
		 */
		private function sample_schema(): Schema {
			return new Schema(
				'pfx_',
				[
					new Field(
						key: 'num_segments',
						type: 'int',
						label: 'Num Segments',
						section: 'storage',
						restart: [ 'request-workers', 'job-workers' ],
						sanitize: static fn ( $v ) => $v,
						render: static function (): void {},
					),
					new Field(
						key: 'num_partitions',
						type: 'int',
						label: 'Num Partitions',
						section: 'storage',
						restart: 'supervisor_only',
						sanitize: static fn ( $v ) => $v,
						render: static function (): void {},
					),
					new Field(
						id: 'total_storage',
						label: 'Total Storage',
						section: 'storage',
						render: static function (): void {},
					),
					new Field(
						key: 'topologies',
						type: 'array_strings',
						label: 'Active Topologies',
						section: 'topologies',
						delete_on_blank: false,
						sanitize: static fn ( $v ) => $v,
						render: static function (): void {},
					),
					new Field(
						key: 'allowed_users',
						type: 'array_strings',
						ui: false,
					),
				],
				[
					'storage'    => [ 'title' => 'Storage', 'callback' => static function (): void {} ],
					'topologies' => [ 'title' => 'Topologies', 'callback' => static function (): void {} ],
				]
			);
		}

		public function test_overlay_keys_include_every_option_even_overlay_only(): void {
			// All real options (key !== ''), incl. the ui=false allowed_users;
			// excludes the display-only total_storage (no key).
			$this->assertSame(
				[ 'num_segments', 'num_partitions', 'topologies', 'allowed_users' ],
				$this->sample_schema()->overlay_keys()
			);
		}

		public function test_setting_option_names_are_prefixed_and_exclude_ui_false_and_display(): void {
			// Rendered options only: prefixed, no allowed_users (ui=false), no total_storage (no key).
			$this->assertSame(
				[ 'pfx_num_segments', 'pfx_num_partitions', 'pfx_topologies' ],
				$this->sample_schema()->setting_option_names()
			);
		}

		public function test_delete_on_blank_options_are_the_blank_deletable_subset(): void {
			// topologies opts out (empty selection is a real override); allowed_users
			// is ui=false so never a setting.
			$this->assertSame(
				[ 'pfx_num_segments', 'pfx_num_partitions' ],
				$this->sample_schema()->delete_on_blank_options()
			);
		}

		public function test_rendered_fields_include_display_and_keep_declaration_order(): void {
			$ids = \array_map(
				static fn ( Field $f ): string => $f->render_id(),
				$this->sample_schema()->rendered_fields()
			);
			$this->assertSame(
				[ 'num_segments', 'num_partitions', 'total_storage', 'topologies' ],
				$ids
			);
		}

		public function test_restart_for_returns_the_fields_groups(): void {
			$schema = $this->sample_schema();
			$this->assertSame( [ 'request-workers', 'job-workers' ], $schema->restart_for( 'num_segments' ) );
			$this->assertSame( 'supervisor_only', $schema->restart_for( 'num_partitions' ) );
			// A topology save restarts nothing (supervisor pulls it).
			$this->assertSame( [], $schema->restart_for( 'topologies' ) );
			// An unknown option (e.g. an internal bookkeeping key) classifies as no-restart.
			$this->assertSame( [], $schema->restart_for( 'autoload_fixed' ) );
		}

		public function test_restart_for_returns_node_type_list_and_all_verbatim(): void {
			$schema = new Schema(
				'p_',
				[
					new Field( key: 'geom', restart: [ 'Partition', 'Topic' ] ),
					new Field( key: 'wide', restart: 'all' ),
				]
			);
			$this->assertSame( [ 'Partition', 'Topic' ], $schema->restart_for( 'geom' ) );
			$this->assertSame( 'all', $schema->restart_for( 'wide' ) );
		}

		public function test_register_options_registers_each_setting_with_its_sanitizer(): void {
			$GLOBALS['_registered_settings'] = [];
			$this->sample_schema()->register_options( 'pfx_group' );

			foreach ( [ 'pfx_num_segments', 'pfx_num_partitions', 'pfx_topologies' ] as $option ) {
				$this->assertArrayHasKey( $option, $GLOBALS['_registered_settings'] );
				$this->assertSame( 'pfx_group', $GLOBALS['_registered_settings'][ $option ]['group'] );
				$this->assertIsCallable( $GLOBALS['_registered_settings'][ $option ]['args']['sanitize_callback'] );
			}
			// Overlay-only + display fields never register a setting.
			$this->assertArrayNotHasKey( 'pfx_allowed_users', $GLOBALS['_registered_settings'] );
			$this->assertArrayNotHasKey( 'pfx_total_storage', $GLOBALS['_registered_settings'] );
		}

		public function test_register_options_merges_per_field_register_args(): void {
			$GLOBALS['_registered_settings'] = [];
			$schema = new Schema(
				'pfx_',
				[
					new Field(
						key: 'memcache_servers',
						type: 'memcache_servers',
						label: 'Memcache',
						section: 'storage',
						sanitize: static fn ( $v ) => [],
						register_args: [ 'type' => 'array', 'default' => [], 'autoload' => false ],
					),
				]
			);
			$schema->register_options( 'g' );
			$args = $GLOBALS['_registered_settings']['pfx_memcache_servers']['args'];
			$this->assertFalse( $args['autoload'] );
			$this->assertSame( 'array', $args['type'] );
		}

		public function test_register_sections_and_fields_registers_sections_then_fields(): void {
			$GLOBALS['_registered_sections'] = [];
			$GLOBALS['_registered_fields']   = [];
			$this->sample_schema()->register_sections_and_fields( 'pfx_page' );

			$this->assertArrayHasKey( 'storage', $GLOBALS['_registered_sections'] );
			$this->assertArrayHasKey( 'topologies', $GLOBALS['_registered_sections'] );
			foreach ( [ 'num_segments', 'num_partitions', 'total_storage', 'topologies' ] as $field_id ) {
				$this->assertArrayHasKey( $field_id, $GLOBALS['_registered_fields'] );
				$this->assertSame( 'pfx_page', $GLOBALS['_registered_fields'][ $field_id ]['page'] );
			}
			$this->assertSame( 'storage', $GLOBALS['_registered_fields']['total_storage']['section'] );
			$this->assertSame( 'topologies', $GLOBALS['_registered_fields']['topologies']['section'] );
		}

		public function test_field_for_short_finds_by_key(): void {
			$schema = $this->sample_schema();
			$this->assertSame( 'num_partitions', $schema->field_for_short( 'num_partitions' )->key );
			$this->assertNull( $schema->field_for_short( 'nope' ) );
		}

		public function test_overlay_keys_includes_every_non_empty_key_field(): void {
			// Every settable field now overlays the config file uniformly — there is
			// no per-field opt-out. overlay_keys() returns every field with a non-empty
			// key (rendered options AND overlay-only ui=false keys), excluding only the
			// keyless display-only fields.
			$schema = new Schema(
				'pfx_',
				[
					new Field(
						key: 'rendered',
						type: 'int',
						label: 'Rendered',
						section: 'storage',
						sanitize: static fn ( $v ) => $v,
						render: static function (): void {},
					),
					new Field(
						key: 'overlay_only',
						type: 'array_strings',
						ui: false,
					),
					new Field(
						id: 'display_only',
						label: 'Display',
						section: 'storage',
						render: static function (): void {},
					),
				]
			);
			$this->assertSame( [ 'rendered', 'overlay_only' ], $schema->overlay_keys() );
		}
	}
}
