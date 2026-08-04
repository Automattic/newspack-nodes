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
 * Self-timed verb poller. It rides the `_router` TIMER, emits its configured
 * verb as a command to `target`, and publishes the reply as node state: a text
 * reply becomes `dmesg` level counts, an object or row-list reply becomes
 * `reply` verbatim. `verb`, `pollArgs`, and `target` are all settable by the
 * mounting view, so the same class serves `dmesg`, `list_timers`, and
 * `list_handles`.
 */
export class DmesgNode extends TimerNode {
	/**
	 * Seed the published states and the default poll (`dmesg`, no arguments).
	 */
	constructor() {
		super();
		this.registrations.dmesg = {};
		// A `-s` row list and other object replies publish to `reply`.
		this.registrations.reply = {};
		// Poll verb + args; mounting views (e.g. RuntimeView) retarget these.
		this.verb = 'dmesg';
		this.pollArgs = [];
	}

	/**
	 * Publish the poll reply. An object payload (an `-s` row list included)
	 * publishes raw as `reply`; a string payload is tallied by level and
	 * published as `dmesg`.
	 *
	 * @param {Array} message The 7-field positional message.
	 */
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

	/**
	 * Router TIMER subscriber: emit the configured poll to `this.target`. Does
	 * nothing without a sink.
	 */
	fire() {
		if ( ! this.sink ) {
			return;
		}
		this.counter++;
		const m = this._pollMessage( this.verb, this.pollArgs );
		if ( m ) {
			this.sink.fill( m ); // else unauthenticated; next tick carries it
		}
	}

	/**
	 * Build the poll TM_COMMAND for `this.target`; FROM=name is the reply path
	 * and LOCAL authorizes it.
	 *
	 * @param {string}   verb   Command verb to poll (e.g. `dmesg`).
	 * @param {string[]} [args] Positional argument tokens for the verb.
	 * @return {?Array} A signed, LOCAL-marked Message, or null if unauthenticated.
	 */
	_pollMessage( verb, args = [] ) {
		return this.command( verb, args );
	}

	/**
	 * Hitchhike the Router TIMER, letting the base `fireCb()` throttle the
	 * per-second tick down to this node's 10s cadence.
	 */
	setTimer() {
		super.setTimer( POLL_INTERVAL_MS );
	}

	/**
	 * Console palette entry — hidden, takes no arguments, and accepts no
	 * user-routed fill (its only input is its own poll reply).
	 */
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
