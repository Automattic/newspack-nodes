/**
 * Uptime — the `_uptime` node. `_router` delivers the `uptime` poll reply here;
 * it publishes the trimmed uptime string ( useNodeState( '_uptime', 'uptime' ) ).
 */

import { Node } from '../../runtime/node';
import { VALUE } from '../../runtime/message';

export class Uptime extends Node {
	constructor() {
		super();
		this.registrations.uptime = {};
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
