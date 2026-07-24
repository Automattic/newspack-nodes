<?php
/**
 * XXX: RetentionSettingsMigrationTest: the versioned run-once activation rename
 * of the retention-geometry options across THREE schema generations — gen-1
 * split the single count/lifespan pair, gen-2 renamed the LOCAL axes
 * (max_segments → num_segments, max_lifetime → lifetime), gen-3 mirrored that
 * onto the REMOTE axes; each freed the max_segments NAME for a hard cap. Each
 * generation is gated independently (marker < 1 / < 2 / < 3) because the legacy
 * marker '1' is ambiguous (gen-1-only on released 0.39.0, gens 1+2 on the
 * unreleased build). These assert the FINAL end-state per gen plus the marker
 * guard that keeps an admin-set hard cap safe on re-activation.
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
		'newspack_nodes_remote_max_lifetime',
		'newspack_nodes_remote_lifetime',
	];

	/** Run-once marker option name. */
	private const MARKER = 'newspack_nodes_retention_settings_migrated';

	/** The ambiguous legacy marker '1': gen-1-only on released 0.39.0, gens 1+2 on the unreleased build. */
	private const MARKER_V1 = '1';

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

	public function test_gen1_only_install_at_marker_v1_still_gets_gen2(): void {
		// A RELEASED 0.39.0 install stamped marker '1' after gen-1 ONLY — gen-2
		// did not exist yet — so its max_segments is still a COUNT. The gate must
		// run gen-2 for it; reinterpreting that count as the hard cap would lose
		// the operator's real setting and blank num_segments.
		\update_option( self::MARKER, self::MARKER_V1 );
		\update_option( 'newspack_nodes_max_segments', 20 );
		\update_option( 'newspack_nodes_max_lifetime', 43201 );

		Retention_Settings_Migration::migrate();

		$this->assertSame( 20, \get_option( 'newspack_nodes_num_segments' ), 'the count moves to num_segments' );
		$this->assertSame( 43201, \get_option( 'newspack_nodes_lifetime' ) );
		$this->assertFalse( \get_option( 'newspack_nodes_max_segments' ), 'the hard-cap name is freed, not left holding the stale count' );
		$this->assertSame( '3', \get_option( self::MARKER ) );
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

	public function test_gen3_renames_remote_max_segments_to_remote_num_segments(): void {
		// A gen-2-migrated install (marker '1') stores the remote target count
		// under remote_max_segments; gen-3 must move it to remote_num_segments and
		// free the remote_max_segments name for the new remote hard cap.
		\update_option( self::MARKER, self::MARKER_V1 );
		\update_option( 'newspack_nodes_remote_max_segments', 7 );

		Retention_Settings_Migration::migrate();

		$this->assertSame( 7, \get_option( 'newspack_nodes_remote_num_segments' ), 'the remote count moves to remote_num_segments' );
		$this->assertFalse( \get_option( 'newspack_nodes_remote_max_segments' ), 'the remote_max_segments name is freed for the hard cap' );
	}

	public function test_gen3_renames_remote_max_lifetime_to_remote_lifetime(): void {
		\update_option( self::MARKER, self::MARKER_V1 );
		\update_option( 'newspack_nodes_remote_max_lifetime', 43200 );

		Retention_Settings_Migration::migrate();

		$this->assertSame( 43200, \get_option( 'newspack_nodes_remote_lifetime' ) );
		$this->assertFalse( \get_option( 'newspack_nodes_remote_max_lifetime' ), 'old remote option must be deleted' );
	}

	public function test_gen2_migrated_install_still_gets_gen3(): void {
		// requirement (b): the shipped marker '1' means gens 1+2 already ran; gen-3
		// must still fire despite the presence of the run-once marker.
		\update_option( self::MARKER, self::MARKER_V1 );
		\update_option( 'newspack_nodes_remote_max_segments', 5 );
		\update_option( 'newspack_nodes_remote_max_lifetime', 1800 );

		Retention_Settings_Migration::migrate();

		$this->assertSame( 5, \get_option( 'newspack_nodes_remote_num_segments' ) );
		$this->assertSame( 1800, \get_option( 'newspack_nodes_remote_lifetime' ) );
		$this->assertSame( '3', \get_option( self::MARKER ), 'marker advances to the current schema version' );
	}

	public function test_fresh_install_runs_all_gens(): void {
		// requirement (a): no marker → every generation runs. Seed the oldest
		// pre-split names so the value round-trips through gens 1, 2 and 3.
		\update_option( 'newspack_nodes_num_segments', 9 );
		\update_option( 'newspack_nodes_remote_num_segments', 6 );

		Retention_Settings_Migration::migrate();

		$this->assertSame( 9, \get_option( 'newspack_nodes_num_segments' ), 'local count survives gen-1→gen-2' );
		$this->assertSame( 6, \get_option( 'newspack_nodes_remote_num_segments' ), 'remote count survives gen-1→gen-3' );
		$this->assertFalse( \get_option( 'newspack_nodes_remote_max_segments' ), 'remote_max_segments left free for the hard cap' );
		$this->assertSame( '3', \get_option( self::MARKER ) );
	}

	public function test_remote_hard_cap_survives_reactivation(): void {
		// scope requirement: gen-3 frees remote_max_segments for the hard cap; a
		// later re-run must NOT cannibalize an admin-set value back into the count.
		\update_option( self::MARKER, self::MARKER_V1 );
		\update_option( 'newspack_nodes_remote_max_segments', 7 );
		Retention_Settings_Migration::migrate();
		$this->assertSame( 7, \get_option( 'newspack_nodes_remote_num_segments' ) );

		// Admin then sets a REAL remote hard cap under the freed name.
		\update_option( 'newspack_nodes_remote_max_segments', 21 );

		Retention_Settings_Migration::migrate();

		$this->assertSame( 21, \get_option( 'newspack_nodes_remote_max_segments' ), 'the marker guard protects an admin-set remote hard cap' );
		$this->assertSame( 7, \get_option( 'newspack_nodes_remote_num_segments' ), 'the remote count is untouched by the no-op re-run' );
	}

	public function test_gen3_run_once_holds_after_completion(): void {
		// requirement (c): once the marker reaches the current version, re-running
		// is a pure no-op even with a fresh old-named option present.
		\update_option( self::MARKER, (string) 3 );
		\update_option( 'newspack_nodes_remote_max_lifetime', 999 );

		Retention_Settings_Migration::migrate();

		$this->assertSame( 999, \get_option( 'newspack_nodes_remote_max_lifetime' ), 'a completed marker blocks all further migration' );
		$this->assertFalse( \get_option( 'newspack_nodes_remote_lifetime' ) );
	}

	public function test_gen3_does_not_clobber_an_existing_new_remote_value(): void {
		\update_option( self::MARKER, self::MARKER_V1 );
		\update_option( 'newspack_nodes_remote_num_segments', 15 );
		\update_option( 'newspack_nodes_remote_max_segments', 7 );

		Retention_Settings_Migration::migrate();

		$this->assertSame( 15, \get_option( 'newspack_nodes_remote_num_segments' ), 'existing new value preserved' );
		$this->assertFalse( \get_option( 'newspack_nodes_remote_max_segments' ), 'old remote option still deleted' );
	}
}
