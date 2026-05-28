/**
 * Uptime — the `_uptime` node. `_router` delivers the `uptime` poll reply here;
 * it publishes the trimmed uptime string ( useNodeState( '_uptime', 'uptime' ) ).
 */

import { Node } from '../../runtime/node';
import { Core } from '../../runtime/core';
import {
	newMessage,
	TYPE,
	FROM,
	TO,
	VALUE,
	LOCAL,
	TM_COMMAND,
} from '../../runtime/message';

export class Uptime extends Node {
	constructor() {
		super();
		this.registrations.uptime = {};
		// Last emit time (seconds) — uptime polls at most every 5s.
		this.lastFired = 0;
	}

	static nodeSchema() {
		return {
			category: 'Hidden',
			description:
				'Receives `uptime` poll reply; publishes for the canvas footer.',
			arguments: [],
			commands: [],
		};
	}

	// Build a poll TM_COMMAND addressed to this.target (the `_cwd` node, which
	// re-stamps the live cwd). FROM = own name is the reply pivot (the reply comes
	// back here); LOCAL taints it so the browser CI authorizes a local poll.
	_pollMessage( verb ) {
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND;
		m[ FROM ] = this.name;
		m[ TO ] = this.target;
		m[ VALUE ] = { name: verb, arguments: '', payload: '' };
		m[ LOCAL ] = true;
		return m;
	}

	// Router TIMER subscriber: emit an uptime poll at most every 5s. The timer
	// only runs while the graph is mounted and `_cwd` handles every scope, so
	// there's no per-scope gate — emit whenever a sink exists.
	onTimer() {
		if ( ! this.sink ) {
			return;
		}
		const now = Core.now();
		if ( now - this.lastFired < 5 ) {
			return;
		}
		this.lastFired = now;
		this.sink.fill( this._pollMessage( 'uptime' ) );
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
}
