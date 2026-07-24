<?php
/**
 * XXX: RetentionSettingsMigrationTest: the run-once activation rename of the
 * retention-geometry options across two schema generations — gen-1 split the
 * single count/lifespan pair, gen-2 renamed the axes (max_segments →
 * num_segments, max_lifetime → lifetime) and freed the max_segments NAME for the
 * new hard cap. Both generations run in one guarded pass; these assert the FINAL
 * end-state plus the marker guard that keeps an admin-set hard cap safe on
 * re-activation.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Retention_Settings_Migration;
use Newspack_Nodes\Tests\TestCase;

final class RetentionSettingsMigrationTest extends TestCase {

	/** Every option the migration reads / writes / deletes, plus the run-once marker. */
	private const OPTIONS = [
		'newspack_nodes_retention_settings_migrated',
		'newspack_nodes_num_segments',
		'newspack_nodes_max_segments',
		'newspack_nodes_min_segments',
		'newspack_nodes_max_lifespan',
		'newspack_nodes_min_lifetime',
		'newspack_nodes_max_lifetime',
		'newspack_nodes_lifetime',
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

	public function test_gen2_renames_max_segments_to_num_segments(): void {
		// The current (post-gen-1) install stores the target count under max_segments.
		\update_option( 'newspack_nodes_max_segments', 12 );

		Retention_Settings_Migration::migrate();

		$this->assertSame( 12, \get_option( 'newspack_nodes_num_segments' ), 'the target count moves to num_segments, NOT the hard cap' );
		$this->assertFalse( \get_option( 'newspack_nodes_max_segments' ), 'the max_segments name is freed for the hard cap' );
	}

	public function test_gen2_renames_max_lifetime_to_lifetime(): void {
		\update_option( 'newspack_nodes_max_lifetime', 43200 );

		Retention_Settings_Migration::migrate();

		$this->assertSame( 43200, \get_option( 'newspack_nodes_lifetime' ) );
		$this->assertFalse( \get_option( 'newspack_nodes_max_lifetime' ), 'old option must be deleted' );
	}

	public function test_gen1_num_segments_round_trips_back_to_the_count_target(): void {
		// A skip-gen-1 install still names the count target num_segments; gen-1
		// moves it to max_segments and gen-2 moves it back — net-net it stays put.
		\update_option( 'newspack_nodes_num_segments', 9 );

		Retention_Settings_Migration::migrate();

		$this->assertSame( 9, \get_option( 'newspack_nodes_num_segments' ), 'count target survives the two-generation round trip' );
		$this->assertSame( 2, \get_option( 'newspack_nodes_min_segments' ), 'gen-1 seeds the min_segments floor' );
		$this->assertFalse( \get_option( 'newspack_nodes_max_segments' ), 'no leftover intermediate' );
	}

	public function test_gen1_max_lifespan_becomes_min_lifetime(): void {
		\update_option( 'newspack_nodes_max_lifespan', 86400 );

		Retention_Settings_Migration::migrate();

		$this->assertSame( 86400, \get_option( 'newspack_nodes_min_lifetime' ) );
		$this->assertFalse( \get_option( 'newspack_nodes_max_lifespan' ), 'old option must be deleted' );
	}

	public function test_hard_cap_survives_reactivation(): void {
		// First activation renames the old target-count value onto num_segments.
		\update_option( 'newspack_nodes_max_segments', 7 );
		Retention_Settings_Migration::migrate();
		$this->assertSame( 7, \get_option( 'newspack_nodes_num_segments' ) );

		// Admin then sets a REAL hard cap under the freed max_segments name.
		\update_option( 'newspack_nodes_max_segments', 20 );

		// A later activation must NOT cannibalize it back into num_segments.
		Retention_Settings_Migration::migrate();

		$this->assertSame( 20, \get_option( 'newspack_nodes_max_segments' ), 'the marker guard protects an admin-set hard cap' );
		$this->assertSame( 7, \get_option( 'newspack_nodes_num_segments' ), 'the count target is untouched by the no-op re-run' );
	}

	public function test_does_not_seed_anything_when_no_old_options_present(): void {
		Retention_Settings_Migration::migrate();

		$this->assertFalse( \get_option( 'newspack_nodes_num_segments' ) );
		$this->assertFalse( \get_option( 'newspack_nodes_min_segments' ) );
		$this->assertFalse( \get_option( 'newspack_nodes_lifetime' ) );
	}

	public function test_rename_does_not_clobber_an_existing_new_value(): void {
		// A single-generation rename (the remote geometry, which gen-2 doesn't
		// touch) must not overwrite a value already stored under the new name.
		\update_option( 'newspack_nodes_remote_num_segments', 8 );
		\update_option( 'newspack_nodes_remote_max_segments', 12 );

		Retention_Settings_Migration::migrate();

		$this->assertSame( 12, \get_option( 'newspack_nodes_remote_max_segments' ), 'existing new value preserved' );
		$this->assertFalse( \get_option( 'newspack_nodes_remote_num_segments' ), 'old option still deleted' );
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
}
