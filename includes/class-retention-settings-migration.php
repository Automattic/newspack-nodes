<?php
/**
 * XXX: One-time activation rename of the retention-geometry options across three
 * schema generations, gated by a VERSIONED run-once marker.
 *
 * Generation 1 (shipped) split the old single count/lifespan pair into two
 * ranges: num_segments → max_segments (count rule) and max_lifespan →
 * min_lifetime (the count rule's age floor), seeding the two brand-new options
 * (min_segments, max_lifetime) to their defaults when the old option existed.
 *
 * Generation 2 (shipped) renamed the LOCAL axes and freed max_segments for a
 * true hard cap: max_segments → num_segments (the TARGET count) and
 * max_lifetime → lifetime. Gens 1 + 2 run in one pass (gen-1 first) so a
 * version-skipping install round-trips the target count back onto num_segments.
 *
 * Generation 3 (this change) mirrors gen-2 onto the REMOTE axes so each
 * remote_<axis> names the exact spoke axis it sets: remote_max_segments →
 * remote_num_segments (the target count) and remote_max_lifetime →
 * remote_lifetime. The freed remote_max_segments NAME becomes the new remote
 * hard-cap knob — so the old remote_max_segments VALUE (a count) MUST land on
 * remote_num_segments, never stay under remote_max_segments.
 *
 * The marker stores the HIGHEST applied generation, not a boolean, and each
 * generation is gated independently: gen-1 runs at marker < 1, gen-2 at < 2,
 * gen-3 at < 3. This matters because the legacy marker value '1' is AMBIGUOUS:
 * released 0.39.0 stamped '1' after gen-1 ONLY (gen-2 did not exist yet), while
 * the unreleased build stamped '1' after gens 1 + 2. A single `< 1` gate over a
 * bundled gen-1+gen-2 would skip gen-2 for the released population, silently
 * reinterpreting their stored max_segments (a count) as the new hard cap and
 * blanking their real setting. Re-running gen-2 for the unreleased-build '1'
 * population is safe: gen-2 is pure source-row renames and its old rows are
 * already gone, so it no-ops — the ONLY cannibalization window is an install
 * that ran the unreleased build AND set an explicit hard-cap option before
 * upgrading, a single dev box we control. gen-3 fires for any marker < 3, then
 * the marker advances to the current version so every rename fires at most once
 * and a later admin-set remote hard cap is protected.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Retention_Settings_Migration {

	/** Run-once guard storing the highest applied schema generation (legacy value '1' = gens 1+2 done). */
	private const MARKER = 'newspack_nodes_retention_settings_migrated';

	/** Highest schema generation this migration applies. */
	private const SCHEMA_VERSION = 3;

	/**
	 * Gen-1 — split the single count/lifespan pair into dual-rule ranges. Gated marker < 1.
	 *
	 * [ old-option => [ new-option, seed-option|null, seed-default ] ].
	 */
	private const GEN1_MIGRATIONS = [
		'newspack_nodes_num_segments'        => [ 'newspack_nodes_max_segments', 'newspack_nodes_min_segments', 2 ],
		'newspack_nodes_max_lifespan'        => [ 'newspack_nodes_min_lifetime', 'newspack_nodes_max_lifetime', 0 ],
		'newspack_nodes_remote_num_segments' => [ 'newspack_nodes_remote_max_segments', null, 0 ],
		'newspack_nodes_remote_max_lifespan' => [ 'newspack_nodes_remote_min_lifetime', null, 0 ],
	];

	/**
	 * Gen-2 — rename the LOCAL axes, freeing the max_segments name for the hard cap. Gated marker < 2.
	 * Re-runs for the ambiguous marker '1' (see class docblock); safe because these are pure source-row renames.
	 */
	private const GEN2_MIGRATIONS = [
		'newspack_nodes_max_segments' => [ 'newspack_nodes_num_segments', null, 0 ],
		'newspack_nodes_max_lifetime' => [ 'newspack_nodes_lifetime', null, 0 ],
	];

	/**
	 * Gen-3 — mirror gen-2 onto the REMOTE axes, freeing remote_max_segments for the hard cap. Gated marker < 3.
	 */
	private const GEN3_MIGRATIONS = [
		'newspack_nodes_remote_max_segments' => [ 'newspack_nodes_remote_num_segments', null, 0 ],
		'newspack_nodes_remote_max_lifetime' => [ 'newspack_nodes_remote_lifetime', null, 0 ],
	];

	/**
	 * Advance the retention options to the current schema version, once.
	 *
	 * @api Called from the activation hook.
	 */
	public static function migrate(): void {
		$marker  = \get_option( self::MARKER, 0 );
		$applied = \is_numeric( $marker ) ? (int) $marker : 0;
		if ( $applied >= self::SCHEMA_VERSION ) {
			return;
		}
		if ( $applied < 1 ) {
			self::apply( self::GEN1_MIGRATIONS );
		}
		if ( $applied < 2 ) {
			self::apply( self::GEN2_MIGRATIONS );
		}
		self::apply( self::GEN3_MIGRATIONS );
		\update_option( self::MARKER, (string) self::SCHEMA_VERSION, false );
	}

	/**
	 * Rename each set old option to its new name (without clobbering an existing
	 * new value), seed the companion option, and drop the old row.
	 *
	 * @param array<string,array{0:string,1:?string,2:int}> $migrations Old → [ new, seed|null, seed-default ] map.
	 */
	private static function apply( array $migrations ): void {
		foreach ( $migrations as $old => [ $new, $seed, $seed_default ] ) {
			$value = \get_option( $old, null );
			if ( null === $value ) {
				continue;
			}
			if ( false === \get_option( $new, false ) ) {
				\update_option( $new, $value, false );
			}
			if ( null !== $seed && false === \get_option( $seed, false ) ) {
				\update_option( $seed, $seed_default, false );
			}
			\delete_option( $old );
		}
	}
}
