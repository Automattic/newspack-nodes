<?php
/**
 * XXX: One-time activation rename of the retention-geometry options across two
 * schema generations.
 *
 * Generation 1 (already shipped) split the old single count/lifespan pair into
 * two ranges: num_segments → max_segments (count rule) and max_lifespan →
 * min_lifetime (the count rule's age floor), seeding the two brand-new options
 * (min_segments, max_lifetime) to their defaults when the old option existed.
 *
 * Generation 2 (this change) renames the axes again and adds a true hard cap:
 * max_segments → num_segments (the TARGET count) and max_lifetime → lifetime.
 * The freed-up `max_segments` NAME now means the hard cap — so the old
 * max_segments VALUE, which was the target count, MUST land on num_segments,
 * never stay under max_segments. Both generations run in one pass, gen-1 first,
 * so a version-skipping install round-trips the target count back onto
 * num_segments correctly.
 *
 * Guarded by a run-once MARKER — NOT presence-of-old-option — because gen-2
 * reuses the `newspack_nodes_max_segments` name for a different setting. A
 * presence guard would re-migrate (and delete) an admin-set hard cap on every
 * later activation; the marker makes the whole rename fire exactly once.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Retention_Settings_Migration {

	/** Run-once guard: gen-2 reuses an old option name, so presence alone can't gate. */
	private const MARKER = 'newspack_nodes_retention_settings_migrated';

	/** [ old-option => [ new-option, seed-option|null, seed-default ] ], processed in order (gen-1 before gen-2). */
	private const MIGRATIONS = [
		// Generation 1: single pair → dual-rule ranges.
		'newspack_nodes_num_segments'        => [ 'newspack_nodes_max_segments', 'newspack_nodes_min_segments', 2 ],
		'newspack_nodes_max_lifespan'        => [ 'newspack_nodes_min_lifetime', 'newspack_nodes_max_lifetime', 0 ],
		'newspack_nodes_remote_num_segments' => [ 'newspack_nodes_remote_max_segments', null, 0 ],
		'newspack_nodes_remote_max_lifespan' => [ 'newspack_nodes_remote_min_lifetime', null, 0 ],
		// Gen-2: rename the axes; free the max_segments name for the hard cap.
		'newspack_nodes_max_segments'        => [ 'newspack_nodes_num_segments', null, 0 ],
		'newspack_nodes_max_lifetime'        => [ 'newspack_nodes_lifetime', null, 0 ],
	];

	/**
	 * Rename each set old option to its new name, seed the new sibling option,
	 * and drop the old row — once, guarded by the MARKER.
	 *
	 * @api Called from the activation hook.
	 */
	public static function migrate(): void {
		if ( ! empty( \get_option( self::MARKER ) ) ) {
			return;
		}
		foreach ( self::MIGRATIONS as $old => [ $new, $seed, $seed_default ] ) {
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
		\update_option( self::MARKER, '1', false );
	}
}
