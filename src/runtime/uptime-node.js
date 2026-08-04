/**
 * Uptime — the `_uptime` node. `_router` delivers the `uptime` poll reply here;
 * it publishes the trimmed uptime string ( useNodeState( '_uptime', 'uptime' ) ).
 */

import { TimerNode } from './timer-node';
import { VALUE } from './message';

// Poll cadence (ms) — the base Timer throttle paces it (interval_ms > 1000).
const POLL_INTERVAL_MS = 5000;

/**
 * The `_uptime` node: poll `uptime` on the Router TIMER, publish the trimmed
 * result. Its own reply is its only input — nothing is forwarded onward, and
 * subscribers read the value through the published `uptime` state.
 */
export class UptimeNode extends TimerNode {
	/**
	 * Seed the `uptime` state slot subscribers register on.
	 */
	constructor() {
		super();
		this.registrations.uptime = {};
	}

	/**
	 * Publish the poll reply. The payload arrives either as a reply envelope
	 * (`{ name, arguments, payload }`) or as a bare string; anything else, and
	 * any text without an `up ...` run, publishes nothing.
	 *
	 * @param {Array} message The 7-field positional message.
	 */
	fill( message ) {
		this.counter++;
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
		// `09:44:52  up 0 days, 00:01:00` → keep the right half.
		const match = text.match( /up\s+(.+)$/m );
		if ( match ) {
			this.setState( 'uptime', match[ 1 ].trim() );
		}
	}

	/**
	 * Router TIMER subscriber: emit the `uptime` poll. Does nothing without a
	 * sink.
	 */
	fire() {
		if ( ! this.sink ) {
			return;
		}
		this.counter++;
		const m = this._pollMessage( 'uptime' );
		if ( m ) {
			this.sink.fill( m ); // else unauthenticated; next tick carries it
		}
	}

	/**
	 * Build the poll TM_COMMAND for `this.target` (`_cwd`); FROM=name is the
	 * reply path and LOCAL authorizes it.
	 *
	 * @param {string} verb Command verb to poll (`uptime`).
	 * @return {?Array} A LOCAL-marked Message, or null if unauthenticated.
	 */
	_pollMessage( verb ) {
		return this.command( verb );
	}

	/**
	 * Hitchhike the Router TIMER, letting the base `fireCb()` throttle the
	 * per-second tick down to this node's 5s cadence.
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
				'Receives `uptime` poll reply; publishes for the canvas footer.',
			accepts_fill: false,
			arguments: [],
			commands: [],
		};
	}
}
