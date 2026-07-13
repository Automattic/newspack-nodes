<?php
/**
 * XXX: One-time rename of the three remote-spoke geometry options from the ELN
 * `newspack_event_logger_nodes_remote_*` names to the substrate
 * `newspack_nodes_remote_*` names (these settings configure substrate storage
 * geometry pushed to spokes and now live on the Nodes Runtime settings page).
 *
 * The two count/lifespan options land directly on their post-split names
 * (remote_max_segments / remote_min_lifetime) so an install that runs this for
 * the first time skips the now-deleted intermediate names; an install that
 * already ran it against the intermediate names is carried the rest of the way
 * by Retention_Settings_Migration on activation.
 *
 * Each SET old value is copied to its new name (without clobbering an existing
 * new value) and the old row is deleted. Guarded by a marker option so it runs
 * at most once.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Remote_Settings_Migration {

	private const MARKER = 'newspack_nodes_remote_settings_migrated';

	/** [ old-option-name => new-option-name ] for the three renamed settings. */
	private const RENAMES = [
		'newspack_event_logger_nodes_remote_num_segments' => 'newspack_nodes_remote_max_segments',
		'newspack_event_logger_nodes_remote_segment_size' => 'newspack_nodes_remote_segment_size',
		'newspack_event_logger_nodes_remote_max_lifespan' => 'newspack_nodes_remote_min_lifetime',
	];

	/**
	 * Copy each set old option to its new name and drop the old row, once.
	 *
	 * @api
	 */
	public static function maybe_migrate(): void {
		if ( ! empty( \get_option( self::MARKER ) ) ) {
			return;
		}
		foreach ( self::RENAMES as $old => $new ) {
			$value = \get_option( $old, null );
			if ( null === $value ) {
				continue;
			}
			if ( false === \get_option( $new, false ) ) {
				\update_option( $new, $value, false );
			}
			\delete_option( $old );
		}
		\update_option( self::MARKER, '1', false );
	}
}
