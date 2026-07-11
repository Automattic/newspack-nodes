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
		// Optional hooks to bracket each tick's notify (HttpOut lock/flush).
		this.beforeTimerNotify = null;
		this.afterTimerNotify = null;
		// Router self-starts its own 1s slot; isRouter skips the hitchhike.
		this.isRouter = true;
		this.setTimer( 1000 );
	}

	fill( message ) {
		// One inbound miss increments counter by 2 via the bounce (PHP).
		this.counter++;

		// Drop before routing: empty TO, then a FROM trail over MAX_FROM_SIZE.
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
			// setState fires before the TM_ERROR-drop branch.
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
			// Re-fill so the error walks the FROM trail; drops if unrouted.
			this.fill( err );
			return;
		}

		target.fill( message );
	}

	// fireCb (Router::fire_cb): bracket notifyTimer with lock/flush.
	fireCb() {
		this.fire_count++;
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

	// notifyTimer (Router::notify_timer): call each TIMER node's fireCb.
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

	// The Router has no sink: it routes by peeling TO; reject any set.
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

	// FIRE + TIMER + NOT_AVAILABLE registrations; base ctor seeds all three.
	static nodeSchema() {
		return { registrations: [ 'FIRE', 'TIMER', 'NOT_AVAILABLE' ] };
	}
}
