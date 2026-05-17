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
		// TIMER-hitchhike pre-declaration: subscribers register via
		// node.register('TIMER', listener, cb). Router doesn't fire it
		// in M1 (no drain loop on the browser side yet); the slot
		// matters so future tick infrastructure can subscribe.
		this.registrations.TIMER = {};
		// Pre-declared so `setState('NOT_AVAILABLE', ...)` doesn't throw
		// when a routing failure occurs. Debug observers can subscribe
		// via `debug_state _router 1`-style introspection.
		this.registrations.NOT_AVAILABLE = {};
	}

	fill( message ) {
		// Counter increments once per fill, including the recursive call
		// we make on the NOT_AVAILABLE bounce — so one inbound miss
		// increments counter by 2. Intentional (matches PHP).
		this.counter += 1;

		const to = message[ TO ];
		if ( '' === to ) {
			if ( this.sink ) {
				this.sink.fill( message );
			}
			return;
		}

		const slash = to.indexOf( '/' );
		const head = -1 === slash ? to : to.slice( 0, slash );
		const rest = -1 === slash ? '' : to.slice( slash + 1 );
		message[ TO ] = rest;

		const target = Core.node( head );
		if ( null === target ) {
			// setState fires BEFORE the TM_ERROR-drop branch on purpose:
			// debug observers want to see the NOT_AVAILABLE event even
			// when the message itself is silently dropped to break a
			// potential error-cycle.
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
			// Re-set TIMESTAMP explicitly so a mocked Core.now() in
			// tests overrides the newMessage() default clock. Matches
			// PHP class-router.php where the same explicit re-set is used.
			err[ TIMESTAMP ] = Core.now();
			err[ FROM ] = this.name;
			err[ TO ] = message[ FROM ];
			err[ ID ] = message[ ID ];
			err[ VALUE ] = 'NOT_AVAILABLE\n';
			// Re-fill via this Router so the error walks the FROM trail.
			// If the FROM head resolves, the error reaches the originator;
			// if not, the recursive call drops on the TM_ERROR branch above
			// instead of bouncing forever.
			this.fill( err );
			return;
		}

		target.fill( message );
	}
}
