/**
 * Dmesg — the `_dmesg` node. `_router` delivers the `dmesg` poll reply here; it
 * classifies the recent stderr tail by level and publishes the counts
 * ( useNodeState( '_dmesg', 'dmesg' ) → { errors, warnings, debug } ) for the
 * inspector's process-stats header. Counts come from the VIEWED process's dmesg
 * (whatever `_cwd` points at), not browser-global telemetry.
 */

import { TimerNode } from './timer-node';
import {
	newMessage,
	TYPE,
	FROM,
	TO,
	VALUE,
	LOCAL,
	TM_COMMAND,
} from './message';

// Poll cadence (ms) — slow: counts shift slowly and each reply is a ~100-line
// tail, so there's no need to re-pull it every tick. The base Timer throttle
// paces it (interval_ms > 1000).
const POLL_INTERVAL_MS = 10000;

/**
 * Classify a dmesg tail by level, matching `Core.stderr`'s convention: a line
 * carrying `WARNING:` is a warning (wins over a co-occurring `ERROR:`), else
 * `ERROR:` is an error, else it's debug. Blank lines don't count.
 *
 * @param {string} text The dmesg output.
 * @return {{errors:number, warnings:number, debug:number}} Per-level line counts.
 */
export function countLevels( text ) {
	const counts = { errors: 0, warnings: 0, debug: 0 };
	for ( const line of String( text || '' ).split( '\n' ) ) {
		if ( '' === line.trim() ) {
			continue;
		}
		if ( /\bWARNING:/.test( line ) ) {
			counts.warnings += 1;
		} else if ( /\bERROR:/.test( line ) ) {
			counts.errors += 1;
		} else {
			counts.debug += 1;
		}
	}
	return counts;
}

export class DmesgNode extends TimerNode {
	constructor() {
		super();
		this.registrations.dmesg = {};
	}

	fill( message ) {
		this.counter += 1;
		const value = message[ VALUE ];
		let text = '';
		if (
			value &&
			typeof value === 'object' &&
			typeof value.payload === 'string'
		) {
			text = value.payload;
		} else if ( typeof value === 'string' ) {
			text = value;
		}
		this.setState( 'dmesg', countLevels( text ) );
	}

	// Router TIMER subscriber: the base fireCb() throttles, so fire() just emits a
	// dmesg poll to `_cwd` (which re-stamps the live cwd, so the counts track the
	// scope being viewed).
	fire() {
		if ( ! this.sink ) {
			return;
		}
		this.counter += 1;
		this.sink.fill( this._pollMessage( 'dmesg' ) );
	}

	// Build a poll TM_COMMAND addressed to this.target. FROM = own name is the
	// reply pivot; LOCAL taints it so the browser interpreter authorizes a local poll.
	_pollMessage( verb ) {
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND;
		m[ FROM ] = this.name;
		m[ TO ] = this.target;
		m[ VALUE ] = { name: verb, arguments: '' };
		m[ LOCAL ] = true;
		return m;
	}

	// Hitchhike the Router TIMER and let the base fireCb() throttle to 10s.
	setTimer() {
		super.setTimer( POLL_INTERVAL_MS );
	}

	static nodeSchema() {
		return {
			category: 'Hidden',
			description:
				'Polls `dmesg`; publishes error/warning/debug line counts for the inspector header.',
			accepts_fill: false,
			arguments: [],
			commands: [],
		};
	}
}
