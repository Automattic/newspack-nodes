<?php
/**
 * One-time activation rename of the two retention-geometry options to the
 * split dual-rule scheme. The old single count/lifespan pair became two
 * ranges: num_segments → max_segments (count rule) and max_lifespan →
 * min_lifetime (the count rule's age floor). The two brand-new options
 * (min_segments, max_lifetime) are seeded to their defaults only when the
 * corresponding old option existed, so an upgraded install keeps its prior
 * retention behavior while gaining the new axes.
 *
 * Each SET old value is copied to its new name (without clobbering an existing
 * new value) and the old row is deleted. Presence of the old option is the
 * idempotency guard: after the first run the old rows are gone, so a
 * re-activation is a no-op.
 *
 * The hub-side remote-spoke geometry pushes (remote_num_segments,
 * remote_max_lifespan) get the same rename under the same mapping, but have no
 * new sibling axis to seed — their seed-option is null.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Retention_Settings_Migration {

	/** [ old-option => [ new-option, seed-option|null, seed-default ] ] for the renamed settings. */
	private const MIGRATIONS = [
		'newspack_nodes_num_segments'        => [ 'newspack_nodes_max_segments', 'newspack_nodes_min_segments', 2 ],
		'newspack_nodes_max_lifespan'        => [ 'newspack_nodes_min_lifetime', 'newspack_nodes_max_lifetime', 0 ],
		'newspack_nodes_remote_num_segments' => [ 'newspack_nodes_remote_max_segments', null, 0 ],
		'newspack_nodes_remote_max_lifespan' => [ 'newspack_nodes_remote_min_lifetime', null, 0 ],
	];

	/**
	 * Rename each set old option to its new name, seed the new sibling option,
	 * and drop the old row. Idempotent via the old-option presence check.
	 *
	 * @api Called from the activation hook.
	 */
	public static function migrate(): void {
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
	}
}
