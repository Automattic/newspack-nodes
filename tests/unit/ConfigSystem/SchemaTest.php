<?php
/**
 * SchemaTest: the shared declarative config Schema — one Field per setting, the
 * SINGLE source every consumer (overlay key-list, option_names, delete-on-blank
 * set, reset list, worker-restart classification, register/render loops) derives
 * from, so no plugin's Config and Admin keep parallel hand-listed arrays.
 *
 * The WP-Settings-API stubs a Schema registers into (register_setting /
 * add_settings_section / add_settings_field) are shared from tests/bootstrap.php.
 *
 * @package Newspack_Nodes
 */

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
						key: 'max_segments',
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
						restart: [],
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

		public function test_short_of_strips_the_prefix_and_refuses_an_option_outside_it(): void {
			$this->assertSame( 'max_segments', $this->sample_schema()->short_of( 'pfx_max_segments' ) );
			$this->assertNull( $this->sample_schema()->short_of( 'other_max_segments' ) );
		}

		public function test_overlay_keys_include_every_option_even_overlay_only(): void {
			// All real options (key !== ''), incl. the ui=false allowed_users;
			// excludes the display-only total_storage (no key).
			$this->assertSame(
				[ 'max_segments', 'num_partitions', 'topologies', 'allowed_users' ],
				$this->sample_schema()->overlay_keys()
			);
		}

		public function test_setting_option_names_are_prefixed_and_exclude_ui_false_and_display(): void {
			// Rendered options only: prefixed, no allowed_users (ui=false), no total_storage (no key).
			$this->assertSame(
				[ 'pfx_max_segments', 'pfx_num_partitions', 'pfx_topologies' ],
				$this->sample_schema()->setting_option_names()
			);
		}

		public function test_delete_on_blank_options_are_the_blank_deletable_subset(): void {
			// Every non-bool setting blank-deletes (incl. array_strings topologies —
			// an empty save resets it to the file default); allowed_users is ui=false
			// so never a setting. No bool here, so all three settings qualify.
			$this->assertSame(
				[ 'pfx_max_segments', 'pfx_num_partitions', 'pfx_topologies' ],
				$this->sample_schema()->delete_on_blank_options()
			);
		}

		public function test_delete_on_blank_is_derived_from_the_bool_type(): void {
			// A bool keeps its stored value (an unchecked default-on box is a real
			// override); every other type blank-deletes to the file default.
			$this->assertFalse( ( new Field( key: 'flag', type: 'bool' ) )->delete_on_blank );
			$this->assertTrue( ( new Field( key: 'name', type: 'text' ) )->delete_on_blank );
			$this->assertTrue( ( new Field( key: 'dirs', type: 'array_strings' ) )->delete_on_blank );
			$this->assertTrue( ( new Field( key: 'ttl', type: 'int' ) )->delete_on_blank );
		}

		public function test_rendered_fields_include_display_and_keep_declaration_order(): void {
			$ids = \array_map(
				static fn ( Field $f ): string => $f->render_id(),
				$this->sample_schema()->rendered_fields()
			);
			$this->assertSame(
				[ 'max_segments', 'num_partitions', 'total_storage', 'topologies' ],
				$ids
			);
		}

		public function test_restart_for_returns_the_fields_groups(): void {
			$schema = $this->sample_schema();
			$this->assertSame( [ 'request-workers', 'job-workers' ], $schema->restart_for( 'max_segments' ) );
			$this->assertSame( [], $schema->restart_for( 'num_partitions' ) );
			// A topology save restarts nothing — the fleet re-reads its active set.
			$this->assertSame( [], $schema->restart_for( 'topologies' ) );
			// An unknown option (e.g. an internal bookkeeping key) classifies as no-restart.
			$this->assertSame( [], $schema->restart_for( 'internal_bookkeeping_7319' ) );
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

			foreach ( [ 'pfx_max_segments', 'pfx_num_partitions', 'pfx_topologies' ] as $option ) {
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
			foreach ( [ 'max_segments', 'num_partitions', 'total_storage', 'topologies' ] as $field_id ) {
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
			// Every settable field overlays the config file uniformly — there is
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

		/** A schema whose `trailing` key declares no default of its own and follows `leading`. */
		private function following_schema(): Schema {
			return new Schema(
				'pfx_',
				[
					new Field( key: 'leading', type: 'int', default: 3100 ),
					new Field( key: 'trailing', type: 'int', follows: 'leading' ),
				]
			);
		}

		/** An unset following key takes the followed key's value, whatever layer set it. */
		public function test_resolve_follows_fills_an_absent_following_key(): void {
			$this->assertSame(
				[ 'leading' => 7200, 'trailing' => 7200 ],
				$this->following_schema()->resolve_follows( [ 'leading' => 7200 ] )
			);
		}

		/** A null following key is unset too, so it follows. */
		public function test_resolve_follows_fills_a_null_following_key(): void {
			$this->assertSame(
				[ 'leading' => 5400, 'trailing' => 5400 ],
				$this->following_schema()->resolve_follows( [ 'leading' => 5400, 'trailing' => null ] )
			);
		}

		/** An explicitly set following key wins, zero included. */
		public function test_resolve_follows_keeps_an_explicit_following_value(): void {
			$schema = $this->following_schema();

			$this->assertSame( [ 'leading' => 7200, 'trailing' => 0 ], $schema->resolve_follows( [ 'leading' => 7200, 'trailing' => 0 ] ) );
			$this->assertSame( [ 'leading' => 7200, 'trailing' => 900 ], $schema->resolve_follows( [ 'leading' => 7200, 'trailing' => 900 ] ) );
		}

		/** A following key declares no literal default, so defaults() leaves it out. */
		public function test_defaults_omit_a_following_key(): void {
			$this->assertSame( [ 'leading' => 3100 ], $this->following_schema()->defaults() );
		}

		/** A Field naming both a literal default and a key to follow is two answers to one question. */
		public function test_a_field_with_both_follows_and_default_throws(): void {
			$this->expectException( \InvalidArgumentException::class );
			$this->expectExceptionMessage( 'trailing' );

			new Field( key: 'trailing', type: 'int', default: 900, follows: 'leading' );
		}

		/** A Field following a key its schema never declares fails at schema construction. */
		public function test_following_an_undeclared_key_throws(): void {
			$this->expectException( \InvalidArgumentException::class );
			$this->expectExceptionMessage( 'ghost_key' );

			new Schema(
				'pfx_',
				[
					new Field( key: 'leading', type: 'int', default: 3100 ),
					new Field( key: 'trailing', type: 'int', follows: 'ghost_key' ),
				]
			);
		}

		/** overlay() resolves after the options, so an option on the followed key alone moves the follower. */
		public function test_overlay_moves_the_follower_with_an_option_on_the_followed_key(): void {
			\update_option( 'pfx_leading', 5400 );

			try {
				$config = $this->following_schema()->overlay( [ 'leading' => 3100 ] );
			} finally {
				\delete_option( 'pfx_leading' );
			}

			$this->assertSame( [ 'leading' => 5400, 'trailing' => 5400 ], $config );
		}

		/** An option on the follower wins over the key it follows. */
		public function test_overlay_keeps_an_option_on_the_follower(): void {
			\update_option( 'pfx_leading', 5400 );
			\update_option( 'pfx_trailing', 900 );

			try {
				$config = $this->following_schema()->overlay( [ 'leading' => 3100 ] );
			} finally {
				\delete_option( 'pfx_leading' );
				\delete_option( 'pfx_trailing' );
			}

			$this->assertSame( [ 'leading' => 5400, 'trailing' => 900 ], $config );
		}

		/** followers() lists every key following the given one, and none for a key nothing follows. */
		public function test_followers_lists_the_keys_following_a_key(): void {
			$schema = $this->following_schema();

			$this->assertSame( [ 'trailing' ], $schema->followers( 'leading' ) );
			$this->assertSame( [], $schema->followers( 'trailing' ) );
		}

		/** followed() answers the Field a following Field follows. */
		public function test_followed_answers_the_followed_field(): void {
			$schema = $this->following_schema();

			$this->assertSame( 'leading', $schema->followed( $schema->field_for_short( 'trailing' ) )->key );
		}

		/** followed() of a Field that follows nothing is a caller bug, refused naming the key. */
		public function test_followed_of_a_field_that_follows_nothing_throws(): void {
			$schema = $this->following_schema();

			$this->expectException( \LogicException::class );
			$this->expectExceptionMessage( 'leading' );

			$schema->followed( $schema->field_for_short( 'leading' ) );
		}

		/** A Field following itself resolves to nothing, so the schema refuses it. */
		public function test_a_field_following_itself_throws(): void {
			$this->expectException( \InvalidArgumentException::class );
			$this->expectExceptionMessage( 'selfish follows selfish' );

			new Schema( 'pfx_', [ new Field( key: 'selfish', type: 'int', follows: 'selfish' ) ] );
		}

		/** A Field following a key that itself follows is a chain, refused naming both keys. */
		public function test_following_a_following_key_throws(): void {
			$this->expectException( \InvalidArgumentException::class );
			$this->expectExceptionMessage( 'tail follows middle' );

			new Schema(
				'pfx_',
				[
					new Field( key: 'head', type: 'int', default: 3100 ),
					new Field( key: 'middle', type: 'int', follows: 'head' ),
					new Field( key: 'tail', type: 'int', follows: 'middle' ),
				]
			);
		}
	}
}
