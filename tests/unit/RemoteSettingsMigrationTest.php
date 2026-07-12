<?php
/**
 * RemoteSettingsMigrationTest: the one-time rename of the three remote-spoke
 * geometry options from the ELN `newspack_event_logger_nodes_remote_*` names to
 * the substrate `newspack_nodes_remote_*` names.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Remote_Settings_Migration;
use Newspack_Nodes\Tests\TestCase;

final class RemoteSettingsMigrationTest extends TestCase {

	private const MARKER = 'newspack_nodes_remote_settings_migrated';

	/** [ old-name => new-name ] for the three renamed options (targets are the post-split names). */
	private const RENAMES = [
		'newspack_event_logger_nodes_remote_num_segments' => 'newspack_nodes_remote_max_segments',
		'newspack_event_logger_nodes_remote_segment_size' => 'newspack_nodes_remote_segment_size',
		'newspack_event_logger_nodes_remote_max_lifespan' => 'newspack_nodes_remote_min_lifetime',
	];

	protected function setUp(): void {
		parent::setUp();
		foreach ( self::RENAMES as $old => $new ) {
			\delete_option( $old );
			\delete_option( $new );
		}
		\delete_option( self::MARKER );
	}

	public function test_copies_set_old_values_to_new_names_and_deletes_old(): void {
		\update_option( 'newspack_event_logger_nodes_remote_num_segments', 8 );
		\update_option( 'newspack_event_logger_nodes_remote_segment_size', 5 * 1024 * 1024 );
		\update_option( 'newspack_event_logger_nodes_remote_max_lifespan', 1200 );

		Remote_Settings_Migration::maybe_migrate();

		$this->assertSame( 8, \get_option( 'newspack_nodes_remote_max_segments' ) );
		$this->assertSame( 5 * 1024 * 1024, \get_option( 'newspack_nodes_remote_segment_size' ) );
		$this->assertSame( 1200, \get_option( 'newspack_nodes_remote_min_lifetime' ) );

		foreach ( \array_keys( self::RENAMES ) as $old ) {
			$this->assertFalse( \get_option( $old ), "old option {$old} must be deleted" );
		}
	}

	public function test_leaves_unset_options_alone(): void {
		// Only one of the three is set; the others must not be created.
		\update_option( 'newspack_event_logger_nodes_remote_num_segments', 4 );

		Remote_Settings_Migration::maybe_migrate();

		$this->assertSame( 4, \get_option( 'newspack_nodes_remote_max_segments' ) );
		$this->assertFalse( \get_option( 'newspack_nodes_remote_segment_size' ) );
		$this->assertFalse( \get_option( 'newspack_nodes_remote_min_lifetime' ) );
	}

	public function test_is_idempotent_and_does_not_clobber_existing_new_values(): void {
		\update_option( 'newspack_event_logger_nodes_remote_num_segments', 8 );
		Remote_Settings_Migration::maybe_migrate();

		// A later write to the new name plus a re-run must not resurrect the rename.
		\update_option( 'newspack_nodes_remote_max_segments', 12 );
		\update_option( 'newspack_event_logger_nodes_remote_num_segments', 8 );
		Remote_Settings_Migration::maybe_migrate();

		$this->assertSame( 12, \get_option( 'newspack_nodes_remote_max_segments' ) );
		$this->assertSame( 8, \get_option( 'newspack_event_logger_nodes_remote_num_segments' ), 'second run is a no-op' );
	}

	public function test_noop_when_nothing_to_migrate(): void {
		Remote_Settings_Migration::maybe_migrate();

		$this->assertFalse( \get_option( 'newspack_nodes_remote_max_segments' ) );
		$this->assertNotEmpty( \get_option( self::MARKER ), 'marker is set even on a clean install' );
	}
}
