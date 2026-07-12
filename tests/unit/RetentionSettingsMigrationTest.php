<?php
/**
 * RetentionSettingsMigrationTest: the one-time activation rename of the two
 * retention-geometry options to the split dual-rule scheme
 * (num_segments → max_segments, max_lifespan → min_lifetime) plus seeding the
 * two brand-new options (min_segments, max_lifetime) when the old ones existed.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Retention_Settings_Migration;
use Newspack_Nodes\Tests\TestCase;

final class RetentionSettingsMigrationTest extends TestCase {

	/** Every option the migration reads / writes / deletes. */
	private const OPTIONS = [
		'newspack_nodes_num_segments',
		'newspack_nodes_max_segments',
		'newspack_nodes_min_segments',
		'newspack_nodes_max_lifespan',
		'newspack_nodes_min_lifetime',
		'newspack_nodes_max_lifetime',
		'newspack_nodes_remote_num_segments',
		'newspack_nodes_remote_max_segments',
		'newspack_nodes_remote_max_lifespan',
		'newspack_nodes_remote_min_lifetime',
	];

	protected function setUp(): void {
		parent::setUp();
		foreach ( self::OPTIONS as $option ) {
			\delete_option( $option );
		}
	}

	public function test_renames_num_segments_to_max_segments_and_seeds_min_segments(): void {
		\update_option( 'newspack_nodes_num_segments', 8 );

		Retention_Settings_Migration::migrate();

		$this->assertSame( 8, \get_option( 'newspack_nodes_max_segments' ) );
		$this->assertSame( 2, \get_option( 'newspack_nodes_min_segments' ) );
		$this->assertFalse( \get_option( 'newspack_nodes_num_segments' ), 'old option must be deleted' );
	}

	public function test_renames_max_lifespan_to_min_lifetime_and_seeds_max_lifetime(): void {
		\update_option( 'newspack_nodes_max_lifespan', 86400 );

		Retention_Settings_Migration::migrate();

		$this->assertSame( 86400, \get_option( 'newspack_nodes_min_lifetime' ) );
		$this->assertSame( 0, \get_option( 'newspack_nodes_max_lifetime' ) );
		$this->assertFalse( \get_option( 'newspack_nodes_max_lifespan' ), 'old option must be deleted' );
	}

	public function test_does_not_seed_new_options_when_old_ones_absent(): void {
		Retention_Settings_Migration::migrate();

		$this->assertFalse( \get_option( 'newspack_nodes_min_segments' ) );
		$this->assertFalse( \get_option( 'newspack_nodes_max_segments' ) );
		$this->assertFalse( \get_option( 'newspack_nodes_min_lifetime' ) );
		$this->assertFalse( \get_option( 'newspack_nodes_max_lifetime' ) );
	}

	public function test_does_not_clobber_existing_new_values(): void {
		\update_option( 'newspack_nodes_num_segments', 8 );
		\update_option( 'newspack_nodes_max_segments', 12 );
		\update_option( 'newspack_nodes_min_segments', 3 );

		Retention_Settings_Migration::migrate();

		$this->assertSame( 12, \get_option( 'newspack_nodes_max_segments' ), 'existing new value preserved' );
		$this->assertSame( 3, \get_option( 'newspack_nodes_min_segments' ), 'existing seed preserved' );
		$this->assertFalse( \get_option( 'newspack_nodes_num_segments' ), 'old option still deleted' );
	}

	public function test_is_idempotent_on_re_run(): void {
		\update_option( 'newspack_nodes_max_lifespan', 3600 );
		Retention_Settings_Migration::migrate();

		// A later edit to the new name plus a re-run must not resurrect the rename.
		\update_option( 'newspack_nodes_min_lifetime', 120 );
		Retention_Settings_Migration::migrate();

		$this->assertSame( 120, \get_option( 'newspack_nodes_min_lifetime' ) );
		$this->assertFalse( \get_option( 'newspack_nodes_max_lifespan' ) );
	}

	public function test_renames_remote_geometry_options_without_seeding_a_companion(): void {
		\update_option( 'newspack_nodes_remote_num_segments', 8 );
		\update_option( 'newspack_nodes_remote_max_lifespan', 3600 );

		Retention_Settings_Migration::migrate();

		$this->assertSame( 8, \get_option( 'newspack_nodes_remote_max_segments' ) );
		$this->assertSame( 3600, \get_option( 'newspack_nodes_remote_min_lifetime' ) );
		$this->assertFalse( \get_option( 'newspack_nodes_remote_num_segments' ), 'old remote option must be deleted' );
		$this->assertFalse( \get_option( 'newspack_nodes_remote_max_lifespan' ), 'old remote option must be deleted' );
	}

	public function test_remote_rename_does_not_clobber_existing_new_value(): void {
		\update_option( 'newspack_nodes_remote_num_segments', 8 );
		\update_option( 'newspack_nodes_remote_max_segments', 12 );

		Retention_Settings_Migration::migrate();

		$this->assertSame( 12, \get_option( 'newspack_nodes_remote_max_segments' ), 'existing new remote value preserved' );
		$this->assertFalse( \get_option( 'newspack_nodes_remote_num_segments' ), 'old remote option still deleted' );
	}

	public function test_remote_rename_is_a_noop_when_old_remote_options_absent(): void {
		Retention_Settings_Migration::migrate();

		$this->assertFalse( \get_option( 'newspack_nodes_remote_max_segments' ) );
		$this->assertFalse( \get_option( 'newspack_nodes_remote_min_lifetime' ) );
	}
}
