/**
 * Uptime — the `_uptime` node. `_router` delivers the `uptime` poll reply here;
 * it publishes the trimmed uptime string ( useNodeState( '_uptime', 'uptime' ) ).
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

// Poll cadence (ms) — the base Timer throttle paces it (interval_ms > 1000).
const POLL_INTERVAL_MS = 5000;

export class UptimeNode extends TimerNode {
	constructor() {
		super();
		this.registrations.uptime = {};
	}

	// Hitchhike the Router TIMER and let the base fireCb() throttle to 5s.
	setTimer() {
		super.setTimer( POLL_INTERVAL_MS );
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
		// `09:44:52  up 0 days, 00:01:00` → keep the right half.
		const match = text.match( /up\s+(.+)$/m );
		if ( match ) {
			this.setState( 'uptime', match[ 1 ].trim() );
		}
	}

	// Router TIMER subscriber: the base fireCb() throttles to 5s, so fire() just
	// emits an uptime poll. `_cwd` handles every scope, so there's no per-scope
	// gate — emit whenever a sink exists.
	fire() {
		if ( ! this.sink ) {
			return;
		}
		this.counter += 1;
		this.sink.fill( this._pollMessage( 'uptime' ) );
	}

	// Build a poll TM_COMMAND addressed to this.target (the `_cwd` node, which
	// re-stamps the live cwd). FROM = own name is the reply pivot (the reply comes
	// back here); LOCAL taints it so the browser interpreter authorizes a local poll.
	_pollMessage( verb ) {
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND;
		m[ FROM ] = this.name;
		m[ TO ] = this.target;
		m[ VALUE ] = { name: verb, arguments: '' };
		m[ LOCAL ] = true;
		return m;
	}

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
