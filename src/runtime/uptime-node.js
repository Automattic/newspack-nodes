/**
 * UptimeNode — the console's uptime readout. See PollerNode for the
 * ask-on-the-tick, publish-the-reply mechanism it shares with DmesgNode.
 */

import { PollerNode } from './poller-node';

/** Uptime moves faster than dmesg, so it asks more often than the default. */
const UPTIME_INTERVAL_MS = 5000;

/**
 * The `_uptime` node: poll `uptime` and publish the trimmed result
 * ( useNodeState( '_uptime', 'uptime' ) ) for the canvas footer.
 */
export class UptimeNode extends PollerNode {
	/**
	 * Poll `uptime`, faster than the default cadence.
	 */
	constructor() {
		super();
		this.verb = 'uptime';
		this.pollIntervalMs = UPTIME_INTERVAL_MS;
	}

	/**
	 * Keep the right half of `09:44:52  up 0 days, 00:01:00`. Anything else —
	 * an object reply, text with no `up …` run — publishes nothing.
	 *
	 * @param {*} payload The unwrapped reply body.
	 */
	publish( payload ) {
		const match =
			typeof payload === 'string' ? payload.match( /up\s+(.+)$/m ) : null;
		if ( match ) {
			this.setState( 'uptime', match[ 1 ].trim() );
		}
	}

	/**
	 * Console palette entry.
	 *
	 * @return {Object} The node schema.
	 */
	static nodeSchema() {
		return {
			...PollerNode.nodeSchema(),
			description:
				'Receives `uptime` poll reply; publishes for the canvas footer.',
			registrations: [ 'uptime' ],
		};
	}
}
