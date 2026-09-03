/**
 * UptimeNode — the console header's uptime readout. The `uptime` verb returns
 * an interpreter's wall clock and its elapsed run as one line of text, and
 * this node keeps the elapsed half. See PollerNode for the ask-on-the-tick,
 * publish-the-reply mechanism it shares with DmesgNode.
 */

import { PollerNode } from './poller-node';

/**
 * Cadence in milliseconds. The reading is a running clock, so the base
 * poller's 10s leaves it visibly behind. 5s is a harmonic of the same grid
 * (ADR-17) — every second 5s boundary is a 10s one — so the faster poll still
 * meets the slower ones on a tick and leaves in their POST, where an
 * off-harmonic cadence would buy a request of its own.
 */
const UPTIME_INTERVAL_MS = 5000;

/**
 * The `_uptime` node: poll `uptime` and publish the elapsed run
 * ( useNodeState( '_uptime', 'uptime' ) ) for the console header's LIVE
 * button. The console points the poll at `_cwd`, so the reading describes the
 * process being VIEWED — a worker, when cwd is a worker — rather than the
 * browser's own interpreter.
 */
export class UptimeNode extends PollerNode {
	/**
	 * Poll `uptime`, on this node's own faster cadence.
	 */
	constructor() {
		super();
		this.verb = 'uptime';
		this.pollIntervalMs = UPTIME_INTERVAL_MS;
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
