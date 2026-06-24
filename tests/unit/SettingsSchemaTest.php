<?php
/**
 * SettingsSchemaTest: the substrate settings declaration parity net.
 *
 * Pins the derived key sets that Config and Admin consume so a change to the
 * declarative schema cannot silently move an option between overlay, settings,
 * reset, render, or worker-restart behavior.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Config_System\Field;
use Newspack_Nodes\Settings_Schema;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Settings_Schema::class )]
class SettingsSchemaTest extends TestCase {

	private const OVERLAY_KEYS = [
		'num_partitions',
		'num_segments',
		'segment_size',
		'max_lifespan',
		'base_directory',
		'memcache_servers',
		'remote_num_segments',
		'remote_segment_size',
		'remote_max_lifespan',
		'topologies',
		'allowed_users',
	];

	private const OPTION_NAMES = [
		'newspack_nodes_num_partitions',
		'newspack_nodes_num_segments',
		'newspack_nodes_segment_size',
		'newspack_nodes_max_lifespan',
		'newspack_nodes_base_directory',
		'newspack_nodes_memcache_servers',
		'newspack_nodes_remote_num_segments',
		'newspack_nodes_remote_segment_size',
		'newspack_nodes_remote_max_lifespan',
	];

	private const RENDERED_IDS = [
		'num_partitions',
		'num_segments',
		'segment_size',
		'max_lifespan',
		'total_storage',
		'base_directory',
		'memcache_servers',
		'remote_num_segments',
		'remote_segment_size',
		'remote_max_lifespan',
	];

	protected function setUp(): void {
		parent::setUp();

		$schema = new \ReflectionProperty( Settings_Schema::class, 'schema' );
		$schema->setAccessible( true );
		$schema->setValue( null, null );
	}

	public function test_overlay_keys_match_the_substrate_config_overlay(): void {
		$this->assertSameSet( self::OVERLAY_KEYS, Settings_Schema::get()->overlay_keys() );
	}

	public function test_setting_option_names_match_the_admin_settings_form(): void {
		$this->assertSameSet( self::OPTION_NAMES, Settings_Schema::get()->setting_option_names() );
	}

	public function test_delete_on_blank_options_match_the_resettable_settings(): void {
		$this->assertSameSet( self::OPTION_NAMES, Settings_Schema::get()->delete_on_blank_options() );
	}

	public function test_rendered_fields_include_the_display_only_total_storage_readout(): void {
		$rendered_ids = \array_map(
			static fn ( Field $field ): string => $field->render_id(),
			Settings_Schema::get()->rendered_fields()
		);

		$this->assertSame( self::RENDERED_IDS, $rendered_ids );
	}

	public function test_restart_classification_matches_runtime_boundaries(): void {
		$schema = Settings_Schema::get();

		$this->assertSame( 'supervisor_only', $schema->restart_for( 'num_partitions' ) );
		$this->assertSame( [ 'Partition', 'Topic', 'Log' ], $schema->restart_for( 'segment_size' ) );
		$this->assertSame( 'all', $schema->restart_for( 'memcache_servers' ) );
		$this->assertSame( 'all', $schema->restart_for( 'base_directory' ) );
		$this->assertSame( [], $schema->restart_for( 'topologies' ) );
		$this->assertSame( [], $schema->restart_for( 'missing_option' ) );
	}

	/** The remote-spoke geometry settings restart nothing — they push to spokes via the settings-sync graph. */
	public function test_remote_settings_restart_nothing(): void {
		$schema = Settings_Schema::get();

		$this->assertSame( [], $schema->restart_for( 'remote_num_segments' ) );
		$this->assertSame( [], $schema->restart_for( 'remote_segment_size' ) );
		$this->assertSame( [], $schema->restart_for( 'remote_max_lifespan' ) );
	}

	/**
	 * The three remote-spoke settings are registered + resettable options and now
	 * overlay the config file uniformly like every other setting (the per-field
	 * overlay opt-out is gone).
	 */
	public function test_remote_settings_are_overlaid_like_every_setting(): void {
		$schema = Settings_Schema::get();

		foreach ( [ 'remote_num_segments', 'remote_segment_size', 'remote_max_lifespan' ] as $key ) {
			$field = $schema->field_for_short( $key );
			$this->assertNotNull( $field, "remote field {$key} must exist" );
			$this->assertSame( 'newspack_nodes_remote_section', $field->section );
		}

		$this->assertContains( 'remote_num_segments', $schema->overlay_keys() );
		$this->assertContains( 'remote_segment_size', $schema->overlay_keys() );
		$this->assertContains( 'remote_max_lifespan', $schema->overlay_keys() );
	}

	public function test_prefix_is_the_substrate_prefix_and_get_is_memoized(): void {
		$schema = Settings_Schema::get();

		$this->assertSame( 'newspack_nodes_', $schema->prefix() );
		$this->assertSame( $schema, Settings_Schema::get() );
	}

	/** Order-independent set equality; config consumers treat these lists as sets. */
	private function assertSameSet( array $expected, array $actual ): void {
		\sort( $expected );
		\sort( $actual );
		$this->assertSame( $expected, $actual );
	}
}
