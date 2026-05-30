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

export class RouterNode extends Node {
	constructor() {
		super();
		// TIMER hitchhike slot — fired once per `startTimer` interval.
		this.registrations.TIMER = {};
		// Pre-declared so setState('NOT_AVAILABLE', ...) doesn't throw.
		this.registrations.NOT_AVAILABLE = {};
		// setInterval handle for the periodic TIMER fire.
		this._timerHandle = null;
		// Optional hooks injected by the console to bracket each TIMER notify (e.g.
		// HttpOut lock/flush so one tick's emissions batch into ONE POST). Kept here
		// so the substrate Router stays decoupled from any console node.
		this.beforeTimerNotify = null;
		this.afterTimerNotify = null;
		// Router self-starts its 1s TIMER (Tachikoma fidelity: the Router IS
		// timer-driven). Tests that don't want it running can stopTimer().
		this.startTimer( 1000 );
	}

	// Fire TIMER once immediately, then every `ms`. Mirrors PHP Router notifying
	// TIMER on its periodic fire; the lock hooks are injected by the console.
	startTimer( ms ) {
		this.stopTimer();
		this._tick();
		this._timerHandle = setInterval( () => this._tick(), ms );
	}

	_tick() {
		if ( this.beforeTimerNotify ) {
			this.beforeTimerNotify();
		}
		try {
			this.notify( 'TIMER', { now: Core.now() } );
		} finally {
			if ( this.afterTimerNotify ) {
				this.afterTimerNotify();
			}
		}
	}

	stopTimer() {
		if ( null !== this._timerHandle ) {
			clearInterval( this._timerHandle );
			this._timerHandle = null;
		}
	}

	// Ensure the self-started setInterval doesn't leak past Core.unregisterNode.
	removeNode() {
		this.stopTimer();
		super.removeNode();
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
