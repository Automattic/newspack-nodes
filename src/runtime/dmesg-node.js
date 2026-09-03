/**
 * DmesgNode — the topology console's stderr-tail readout. The `dmesg` verb
 * returns an interpreter's bounded stderr tail as text; this node turns that
 * text into the per-level counts the inspector's process-stats header shows.
 * See PollerNode for the ask-on-the-tick, publish-the-reply mechanism it
 * shares with UptimeNode.
 */

import { PollerNode } from './poller-node';

/**
 * Classify ONE log line by the prefix substrate stderr callers write: a
 * `WARNING:` line is a warning even when it also carries `ERROR:`, a line with
 * only `ERROR:` is an error, and everything else is debug. `Core._stderr`
 * tests the same two patterns in the same order for its own telemetry, so a
 * line counted here lands in the bucket that classified it on the way out.
 *
 * @param {string} line One log line.
 * @return {'warning'|'error'|'debug'} The line's level.
 */
function classifyLine( line ) {
	if ( /\bWARNING:/.test( line ) ) {
		return 'warning';
	}
	if ( /\bERROR:/.test( line ) ) {
		return 'error';
	}
	return 'debug';
}

/** Maps a level to its `countLevels` tally key, which pluralizes two of three. */
const COUNT_KEY = { warning: 'warnings', error: 'errors', debug: 'debug' };

/**
 * Tally a dmesg tail's lines by level, through classifyLine. Blank lines are
 * skipped, so the trailing newline every tail ends on counts as nothing.
 *
 * @param {string} text The dmesg output.
 * @return {{errors:number, warnings:number, debug:number}} Per-level line counts.
 */
function countLevels( text ) {
	const counts = { errors: 0, warnings: 0, debug: 0 };
	for ( const line of String( text || '' ).split( '\n' ) ) {
		if ( '' === line.trim() ) {
			continue;
		}
		counts[ COUNT_KEY[ classifyLine( line ) ] ]++;
	}
	return counts;
}

/**
 * The `_dmesg` node: poll `dmesg` and publish the tail's level counts, which
 * the inspector's process-stats header reads as
 * `useNodeState( '_dmesg', 'dmesg' )`. The console points the poll at `_cwd`,
 * so the counts describe the process being VIEWED — a worker's PHP stderr tail
 * when cwd is a worker — rather than the browser's own telemetry.
 */
export class DmesgNode extends PollerNode {
	/**
	 * Poll `dmesg`, keeping PollerNode's slow cadence: every reply carries the
	 * whole 100-line tail rather than a delta, so asking often buys nothing.
	 */
	constructor() {
		super();
		this.verb = 'dmesg';
	}

	/**
	 * Tally a text tail and publish it as `dmesg`. A structured reply keeps the
	 * base's verbatim `reply` publication instead, because the tally reads text
	 * and a view that retargets this node's verb at `list_timers` still wants
	 * its rows. A reply carrying no payload publishes zeros, which is what an
	 * empty tail means.
	 *
	 * @param {*} payload The unwrapped reply body.
	 */
	publish( payload ) {
		if ( payload && typeof payload === 'object' ) {
			super.publish( payload );
			return;
		}
		this.setState(
			'dmesg',
			countLevels( typeof payload === 'string' ? payload : '' )
		);
	}

	/**
	 * Console palette entry — PollerNode's schema, with both state names this
	 * node publishes under.
	 *
	 * @return {Object} The node schema.
	 */
	static nodeSchema() {
		return {
			...PollerNode.nodeSchema(),
			description:
				'Polls `dmesg` and publishes error/warning/debug line counts.',
			registrations: [ 'dmesg', 'reply' ],
		};
	}
}
