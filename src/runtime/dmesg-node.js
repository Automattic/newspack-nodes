/**
 * DmesgNode — the debug-overlay's kernel-log tail. See PollerNode for the
 * ask-on-the-tick, publish-the-reply mechanism it shares with UptimeNode.
 */

import { PollerNode } from './poller-node';

/**
 * Classify ONE log line by `Core.stderr`'s convention: a line carrying
 * `WARNING:` is a warning (wins over a co-occurring `ERROR:`), else `ERROR:` is
 * an error, else it's debug. The single classifier the level counts derive from.
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

// Level → the countLevels tally key (plural for the error/warning buckets).
const COUNT_KEY = { warning: 'warnings', error: 'errors', debug: 'debug' };

/**
 * Tally a dmesg tail's non-blank lines by level (via classifyLine).
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
 * The `_dmesg` node: poll `dmesg` and publish the tail's level counts
 * ( useNodeState( '_dmesg', 'dmesg' ) → { errors, warnings, debug } ) for the
 * inspector's process-stats header. Counts come from the VIEWED process's
 * dmesg (whatever `_cwd` points at), not browser-global telemetry.
 */
export class DmesgNode extends PollerNode {
	/**
	 * Poll `dmesg` by default; the mounting view may retarget the verb.
	 */
	constructor() {
		super();
		this.verb = 'dmesg';
	}

	/**
	 * Tally a text tail by level; an object reply (a `-s` row list) publishes
	 * verbatim as `reply` instead.
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
	 * Console palette entry.
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
