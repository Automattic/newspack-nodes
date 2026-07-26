/**
 * Dmesg — the `_dmesg` node. `_router` delivers the `dmesg` poll reply here; it
 * classifies the recent stderr tail by level and publishes the counts
 * ( useNodeState( '_dmesg', 'dmesg' ) → { errors, warnings, debug } ) for the
 * inspector's process-stats header. Counts come from the VIEWED process's dmesg
 * (whatever `_cwd` points at), not browser-global telemetry.
 */

import { TimerNode } from './timer-node';
import { VALUE } from './message';

// Poll cadence (ms) — slow; counts shift slowly, reply is a ~100-line tail.
const POLL_INTERVAL_MS = 10000;

/**
 * Classify ONE log line by `Core.stderr`'s convention: a line carrying
 * `WARNING:` is a warning (wins over a co-occurring `ERROR:`), else `ERROR:` is
 * an error, else it's debug. The single classifier the level counts derive from.
 *
 * @param {string} line One log line.
 * @return {'warning'|'error'|'debug'} The line's level.
 */
export function classifyLine( line ) {
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
export function countLevels( text ) {
	const counts = { errors: 0, warnings: 0, debug: 0 };
	for ( const line of String( text || '' ).split( '\n' ) ) {
		if ( '' === line.trim() ) {
			continue;
		}
		counts[ COUNT_KEY[ classifyLine( line ) ] ]++;
	}
	return counts;
}

export class DmesgNode extends TimerNode {
	constructor() {
		super();
		this.registrations.dmesg = {};
		// runtime_stats and other object replies publish to `reply`.
		this.registrations.reply = {};
		// Poll verb + args; mounting views (e.g. RuntimeView) retarget these.
		this.verb = 'dmesg';
		this.pollArgs = [];
	}

	fill( message ) {
		this.counter++;
		const value = message[ VALUE ];
		// Reply envelope is { name, arguments, payload }; else raw VALUE.
		const payload =
			value && typeof value === 'object' ? value.payload : value;
		// Object payload publishes raw; a string payload tails as text.
		if ( payload && typeof payload === 'object' ) {
			this.setState( 'reply', payload );
			return;
		}
		const text = typeof payload === 'string' ? payload : '';
		this.setState( 'dmesg', countLevels( text ) );
	}

	// Router TIMER subscriber: emit the configured poll to `this.target`.
	fire() {
		if ( ! this.sink ) {
			return;
		}
		this.counter++;
		this.sink.fill( this._pollMessage( this.verb, this.pollArgs ) );
	}

	// Poll TM_COMMAND to this.target; FROM=name reply path, LOCAL authorizes.
	_pollMessage( verb, args = [] ) {
		return this.mint( verb, args );
	}

	// Hitchhike the Router TIMER and let the base fireCb() throttle to 10s.
	setTimer() {
		super.setTimer( POLL_INTERVAL_MS );
	}

	static nodeSchema() {
		return {
			category: 'Hidden',
			description:
				'Self-timed verb poller (default `dmesg`; configurable verb/args/target). Publishes level counts, and an object payload as `reply`.',
			accepts_fill: false,
			arguments: [],
			commands: [],
		};
	}
}
