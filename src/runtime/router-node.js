import { TimerNode } from './timer-node';
import { MAX_FROM_SIZE } from './node';
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

/**
 * Router — path-based dispatch + the TIMER event hub. Extends Timer: it owns a
 * self-started 1s event-framework slot whose `fireCb` runs `notifyTimer`, the
 * DIRECT `fireCb` dispatch to every TIMER-registered node (Tachikoma
 * Router::fire_cb → notify_timer). The Router has no sink; it routes by peeling
 * TO and drops what it cannot peel.
 */
export class RouterNode extends TimerNode {
	constructor() {
		super();
		// TIMER hitchhike slot + the NOT_AVAILABLE state observers can watch.
		this.registrations.TIMER = {};
		this.registrations.NOT_AVAILABLE = {};
		// Optional hooks injected by the console to bracket each tick's notify (e.g.
		// HttpOut lock/flush so one tick's emissions batch into ONE POST). Kept here
		// so the substrate Router stays decoupled from any console node.
		this.beforeTimerNotify = null;
		this.afterTimerNotify = null;
		// Router self-starts its own 1s slot (Tachikoma fidelity: the Router IS
		// timer-driven). Tests that don't want it running can stopTimer().
		this.setTimer( 1000 );
	}

	// fire_cb (Perl Router::fire_cb): bracket notify_timer with the console's
	// lock/flush hooks; afterTimerNotify always runs (finally). Overrides Timer's
	// fire_cb — the Router has no sink and dispatches TIMER instead of emitting.
	fireCb() {
		if ( this.beforeTimerNotify ) {
			this.beforeTimerNotify();
		}
		try {
			this.notifyTimer();
		} finally {
			if ( this.afterTimerNotify ) {
				this.afterTimerNotify();
			}
		}
	}

	// notify_timer (Perl Router::notify_timer): call each TIMER-registered node's
	// fireCb DIRECTLY; a name with no live node is warned + dropped (forgot to
	// unregister). No message, no fill().
	notifyTimer() {
		const registrations = this.registrations.TIMER;
		for ( const name of Object.keys( registrations ) ) {
			const node = Core.node( name );
			if ( ! node ) {
				this.stderr( `WARNING: ${ name } forgot to unregister` );
				delete registrations[ name ];
				continue;
			}
			node.fireCb();
		}
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

		// Perl Router::fill drops before routing, in this order: an unaddressed
		// message (empty TO), then one whose FROM trail exceeded MAX_FROM_SIZE
		// (path explosion on a routing cycle). dropMessage is rate-limited.
		if ( '' === message[ TO ] ) {
			this.dropMessage( message, 'message not addressed' );
			return;
		}
		if ( ( message[ FROM ]?.length ?? 0 ) > MAX_FROM_SIZE ) {
			this.dropMessage(
				message,
				`path exceeded ${ MAX_FROM_SIZE } bytes`
			);
			return;
		}

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
