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

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Config_System\Field;
use Newspack_Nodes\Settings_Schema;
use Newspack_Nodes\Tests\TestCase;

#[CoversClass( Settings_Schema::class )]
class SettingsSchemaTest extends TestCase {

	private const OVERLAY_KEYS = [
		'num_partitions',
		'segment_size',
		'min_segments',
		'num_segments',
		'max_segments',
		'min_lifetime',
		'lifetime',
		'base_directory',
		'memcache_servers',
		'log_sources',
		'remote_segment_size',
		'remote_min_segments',
		'remote_num_segments',
		'remote_max_segments',
		'remote_min_lifetime',
		'remote_lifetime',
		'alert_lag_threshold',
		'alert_deadletter_threshold',
		'alert_emit_interval',
		'sse_idle_timeout',
		'sse_max_slots',
		'sse_max_streams',
		'sse_reserved_slots',
		'sse_retry_ms',
		'sse_slot_ttl',
		'on_demand_idle',
		'topologies',
		'allowed_users',
		'spawn_verify_ssl',
		'vault',
		'vault_verify_ssl',
		'vault_require_ssl',
	];

	private const OPTION_NAMES = [
		'newspack_nodes_num_partitions',
		'newspack_nodes_segment_size',
		'newspack_nodes_min_segments',
		'newspack_nodes_num_segments',
		'newspack_nodes_max_segments',
		'newspack_nodes_min_lifetime',
		'newspack_nodes_lifetime',
		'newspack_nodes_base_directory',
		'newspack_nodes_memcache_servers',
		'newspack_nodes_log_sources',
		'newspack_nodes_remote_segment_size',
		'newspack_nodes_remote_min_segments',
		'newspack_nodes_remote_num_segments',
		'newspack_nodes_remote_max_segments',
		'newspack_nodes_remote_min_lifetime',
		'newspack_nodes_remote_lifetime',
		'newspack_nodes_alert_lag_threshold',
		'newspack_nodes_alert_deadletter_threshold',
		'newspack_nodes_alert_emit_interval',
	];

	private const RENDERED_IDS = [
		'num_partitions',
		'segment_size',
		'min_segments',
		'num_segments',
		'max_segments',
		'min_lifetime',
		'lifetime',
		'total_storage',
		'base_directory',
		'memcache_servers',
		'log_sources',
		'remote_segment_size',
		'remote_min_segments',
		'remote_num_segments',
		'remote_max_segments',
		'remote_min_lifetime',
		'remote_lifetime',
		'alert_lag_threshold',
		'alert_deadletter_threshold',
		'alert_emit_interval',
	];

	protected function setUp(): void {
		parent::setUp();

		$schema = new \ReflectionProperty( Settings_Schema::class, 'schema' );
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

		$this->assertSame( [], $schema->restart_for( 'num_partitions' ) );
		$this->assertSame( [ 'Partition', 'Topic', 'Log' ], $schema->restart_for( 'segment_size' ) );
		$this->assertSame( 'all', $schema->restart_for( 'memcache_servers' ) );
		$this->assertSame( 'all', $schema->restart_for( 'base_directory' ) );
		// Streams resolve the registry per-request; no worker holds it.
		$this->assertSame( [], $schema->restart_for( 'log_sources' ) );
		$this->assertSame( [], $schema->restart_for( 'topologies' ) );
		$this->assertSame( [], $schema->restart_for( 'missing_option' ) );
	}

	/** The fleet-alert thresholds restart nothing — Alerts reads them live per invocation (fleet tick / admin / Site Health). */
	public function test_alert_thresholds_restart_nothing(): void {
		$schema = Settings_Schema::get();

		$this->assertSame( [], $schema->restart_for( 'alert_lag_threshold' ) );
		$this->assertSame( [], $schema->restart_for( 'alert_deadletter_threshold' ) );
		$this->assertSame( [], $schema->restart_for( 'alert_emit_interval' ) );
	}

	/** The three alert thresholds are registered + resettable options in the alerting section. */
	public function test_alert_thresholds_are_overlaid_in_the_alerting_section(): void {
		$schema = Settings_Schema::get();

		foreach ( [ 'alert_lag_threshold', 'alert_deadletter_threshold', 'alert_emit_interval' ] as $key ) {
			$field = $schema->field_for_short( $key );
			$this->assertNotNull( $field, "alert field {$key} must exist" );
			$this->assertSame( 'newspack_nodes_alerting_section', $field->section );
			$this->assertContains( $key, $schema->overlay_keys() );
		}
	}

	/** The remote-spoke geometry settings restart nothing — they push to spokes via the settings-sync graph. */
	public function test_remote_settings_restart_nothing(): void {
		$schema = Settings_Schema::get();

		$this->assertSame( [], $schema->restart_for( 'remote_num_segments' ) );
		$this->assertSame( [], $schema->restart_for( 'remote_segment_size' ) );
		$this->assertSame( [], $schema->restart_for( 'remote_min_lifetime' ) );
		$this->assertSame( [], $schema->restart_for( 'remote_max_segments' ) );
	}

	/**
	 * The four remote-spoke settings are registered + resettable options and now
	 * overlay the config file uniformly like every other setting (the per-field
	 * overlay opt-out is gone).
	 */
	public function test_remote_settings_are_overlaid_like_every_setting(): void {
		$schema = Settings_Schema::get();

		foreach ( [ 'remote_num_segments', 'remote_segment_size', 'remote_min_lifetime', 'remote_max_segments' ] as $key ) {
			$field = $schema->field_for_short( $key );
			$this->assertNotNull( $field, "remote field {$key} must exist" );
			$this->assertSame( 'newspack_nodes_remote_section', $field->section );
		}

		$this->assertContains( 'remote_num_segments', $schema->overlay_keys() );
		$this->assertContains( 'remote_segment_size', $schema->overlay_keys() );
		$this->assertContains( 'remote_min_lifetime', $schema->overlay_keys() );
		$this->assertContains( 'remote_max_segments', $schema->overlay_keys() );
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
	public function test_the_sse_stream_knobs_declare_their_defaults_on_the_field(): void {
		// @longform A default that lives only in the shipped
		// newspack-nodes-config.php is null on every EXISTING deployment,
		// permanently: a deploy preserves the operator's config file, so a key
		// added later never appears in it. SSE_Out reads `$idle_timeout > 0`,
		// so null read as "disabled" and the idle close shipped inert. The
		// Field is now the only home for the value; the file only documents it.
		$fields = [];
		foreach ( Settings_Schema::get()->fields() as $field ) {
			$fields[ $field->key ] = $field;
		}

		$this->assertSame( 15, $fields['sse_idle_timeout']->default ?? null );
		$this->assertSame( 5000, $fields['sse_retry_ms']->default ?? null );
		$this->assertSame(
			0,
			$fields['on_demand_idle']->default ?? null,
			'0 = resident; a non-zero default would opt every topology in'
		);
	}
	/**
	 * `register_args['type']` is what register_setting() tells WordPress the
	 * option is. Six remote_* bounded ints declared `string` while three sibling
	 * ints declared `integer` — same kind of field, two answers. Harmless while
	 * nothing sets show_in_rest, and wrong the moment something does.
	 */
	public function test_every_int_field_registers_as_an_integer(): void {
		$wrong = [];
		foreach ( Settings_Schema::get()->fields() as $field ) {
			$declared = $field->register_args['type'] ?? null;
			if ( 'int' === $field->type && null !== $declared && 'integer' !== $declared ) {
				$wrong[ $field->key ] = $declared;
			}
		}
		$this->assertSame( [], $wrong, 'int fields declaring a non-integer register type' );
	}
}
