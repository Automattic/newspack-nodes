/**
 * Uptime — the `_uptime` node. `_router` delivers the `uptime` poll reply here;
 * it publishes the trimmed uptime string ( useNodeState( '_uptime', 'uptime' ) ).
 */

import { TimerNode } from './timer-node';
import { VALUE } from './message';

// Poll cadence (ms) — the base Timer throttle paces it (interval_ms > 1000).
const POLL_INTERVAL_MS = 5000;

export class UptimeNode extends TimerNode {
	constructor() {
		super();
		this.registrations.uptime = {};
	}

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

	// Router TIMER subscriber: fire() emits an uptime poll if a sink exists.
	fire() {
		if ( ! this.sink ) {
			return;
		}
		this.counter++;
		this.sink.fill( this._pollMessage( 'uptime' ) );
	}

	// Poll TM_COMMAND to this.target (`_cwd`); FROM=name reply, LOCAL taints.
	_pollMessage( verb ) {
		return this.mint( verb );
	}

	// Hitchhike the Router TIMER and let the base fireCb() throttle to 5s.
	setTimer() {
		super.setTimer( POLL_INTERVAL_MS );
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
