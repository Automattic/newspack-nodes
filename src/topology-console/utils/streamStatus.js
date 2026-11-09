import { __ } from '@wordpress/i18n';

/**
 * A console stream's status in sentence case, as every status word reads:
 * "Connecting", "Connected", "Disconnected" or "Closed" for the four an
 * EventSource reports, and any other status as written with its first letter
 * capitalized, never upper-cased.
 *
 * @param {string} status The stream's status.
 * @return {string} The label.
 */
export function streamStatusLabel( status ) {
	const labels = {
		connecting: __( 'Connecting', 'newspack-nodes' ),
		open: __( 'Connected', 'newspack-nodes' ),
		error: __( 'Disconnected', 'newspack-nodes' ),
		closed: __( 'Closed', 'newspack-nodes' ),
	};
	return (
		labels[ status ] ?? status.charAt( 0 ).toUpperCase() + status.slice( 1 )
	);
}
