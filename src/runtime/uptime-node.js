/**
 * UptimeNode — the console header's uptime readout. The `uptime` verb returns
 * an interpreter's wall clock and its elapsed run as one line of text, and
 * this node keeps the elapsed half. See PollerNode for the ask-on-the-tick,
 * publish-the-reply mechanism it shares with DmesgNode.
 */

import { LIVE_POLL_INTERVAL_MS, PollerNode } from './poller-node';

/**
 * The `_uptime` node: poll `uptime` and publish the elapsed run
 * ( useNodeState( '_uptime', 'uptime' ) ) for the console header's LIVE
 * button. The console points the poll at `_cwd`, so the reading describes the
 * process being VIEWED — a worker, when cwd is a worker — rather than the
 * browser's own interpreter.
 */
export class UptimeNode extends PollerNode {
	/**
	 * Poll `uptime` at the live cadence: the reading is a running clock.
	 */
	constructor() {
		super();
		this.verb = 'uptime';
		this.pollIntervalMs = LIVE_POLL_INTERVAL_MS;
	}

	/**
	 * Keep the right half of `09:44:52  up 2h 09m` — the elapsed run the
	 * button shows, the clock belonging to the polled process rather than to
	 * the reader. Text carrying no `up …` run publishes nothing, so the last
	 * reading stands. A structured reply publishes nothing either, without
	 * DmesgNode's fall-through to the base's verbatim `reply`, which is why
	 * the schema below declares `uptime` alone.
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
	 * Console palette entry — PollerNode's schema, with the one state name
	 * this node publishes under.
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
