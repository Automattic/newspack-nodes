import { Node } from './node';
import { Core } from './core';
import {
	FROM,
	TO,
	TYPE,
	ID,
	VALUE,
	TIMESTAMP,
	TM_ERROR,
	newMessage,
} from './message';

export class Router extends Node {
	constructor() {
		super();
		// TIMER hitchhike slot (not fired browser-side yet) so future ticks can subscribe.
		this.registrations.TIMER = {};
		// Pre-declared so setState('NOT_AVAILABLE', ...) doesn't throw.
		this.registrations.NOT_AVAILABLE = {};
	}

	// The Router has no sink: it routes by peeling TO and drops what it cannot
	// peel (an empty or unknown head → NOT_AVAILABLE). Reject any attempt to set
	// one; the getter always returns null. (The base constructor's `this.sink =
	// null` passes through harmlessly.)
	get sink() {
		return null;
	}
	set sink( node ) {
		if ( null !== node ) {
			throw new Error(
				'Router must not have a sink; it routes by TO and drops what it cannot peel.'
			);
		}
	}

	fill( message ) {
		// One inbound miss increments counter by 2 via the bounce (matches PHP).
		this.counter += 1;

		const to = message[ TO ];
		const slash = to.indexOf( '/' );
		const head = -1 === slash ? to : to.slice( 0, slash );
		const rest = -1 === slash ? '' : to.slice( slash + 1 );
		message[ TO ] = rest;

		const target = Core.node( head );
		if ( null === target ) {
			// setState fires before the TM_ERROR-drop branch so observers
			// still see NOT_AVAILABLE even when the message is dropped.
			this.setState( 'NOT_AVAILABLE', {
				node: head,
				from: message[ FROM ],
			} );
			// eslint-disable-next-line no-bitwise
			if ( message[ TYPE ] & TM_ERROR ) {
				return;
			}
			const err = newMessage();
			err[ TYPE ] = TM_ERROR;
			// Explicit so a mocked Core.now() in tests wins (matches PHP).
			err[ TIMESTAMP ] = Core.now();
			err[ FROM ] = this.name;
			err[ TO ] = message[ FROM ];
			err[ ID ] = message[ ID ];
			err[ VALUE ] = 'NOT_AVAILABLE\n';
			// Re-fill so the error walks the FROM trail (drops on the TM_ERROR branch if unrouted).
			this.fill( err );
			return;
		}

		target.fill( message );
	}
}
