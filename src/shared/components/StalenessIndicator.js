/**
 * StalenessIndicator — the ONE shared "Ns ago" chrome every streaming dashboard
 * (Partition Viewer, Log Viewer, Request Log, Error Log) renders, so the decision
 * lives once instead of forking four ways.
 *
 * While PAUSED the stream is intentionally closed (pause frees the server SSE
 * slot), so the last-frame clock has no live meaning — show a steady "Paused"
 * label rather than a counter climbing forever. Otherwise show "Ns ago" since the
 * last frame (amber past STALE_WARN_SEC), or nothing when no frame has arrived
 * yet (`staleSec` null — a closed stream reports null lastEventTime).
 *
 * @param {Object}  props
 * @param {boolean} props.paused   Whether the stream is user-paused (closed).
 * @param {?number} props.staleSec Seconds since the last frame, or null.
 * @return {import('react').ReactElement|null} The indicator, or null.
 */

import { __, sprintf } from '@wordpress/i18n';
import './StalenessIndicator.scss';

// Seconds of silence past which the "Ns ago" clock turns amber.
const STALE_WARN_SEC = 10;

export default function StalenessIndicator( { paused, staleSec } ) {
	if ( paused ) {
		return (
			<span className="newspack-nodes-staleness">
				{ __( 'Paused', 'newspack-nodes' ) }
			</span>
		);
	}
	if ( null === staleSec || undefined === staleSec ) {
		return null;
	}
	const className =
		staleSec > STALE_WARN_SEC
			? 'newspack-nodes-staleness newspack-nodes-staleness--warn'
			: 'newspack-nodes-staleness';
	return (
		<span className={ className }>
			{ sprintf(
				// translators: %d: seconds since the last streamed frame.
				__( '%ds ago', 'newspack-nodes' ),
				staleSec
			) }
		</span>
	);
}
