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
	/** Idle profile entries older than this are trimmed each tick (Tachikoma: 900). */
	static PROFILE_TTL_S = 900;

	/** Clock seam (tests script a time sequence); null → Core.now(). */
	static clock = null;

	/** Per-node self-time profiles keyed by name; null = profiling off. */
	static _profiles = null;

	/** Open dispatch frames (innermost last). */
	static _profileStack = [];

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

		if ( null !== RouterNode._profiles ) {
			const before = this._pushProfile( head );
			try {
				// A throw must still pop, else later parents corrupt.
				target.fill( message );
			} finally {
				this._popProfile( before );
			}
			return;
		}
		target.fill( message );
	}

	// fireCb (Router::fire_cb): bracket notifyTimer with lock/flush.
	fireCb() {
		this.fireCount++;
		if ( this.beforeTimerNotify ) {
			this.beforeTimerNotify();
		}
		try {
			this.notifyTimer();
		} finally {
			if ( this.afterTimerNotify ) {
				this.afterTimerNotify();
			}
			if ( null !== RouterNode._profiles ) {
				this.trimProfiles();
			}
		}
	}

	/**
	 * Open a dispatch frame; returns the start time for _popProfile().
	 * @param {string} name Routed-to node name (the profile key).
	 */
	_pushProfile( name ) {
		RouterNode._profileStack.push( name );
		return null !== RouterNode.clock ? RouterNode.clock() : Core.now();
	}

	/**
	 * Close the innermost frame; elapsed is subtracted from its parent (self-time).
	 * @param {number} before Start time returned by _pushProfile().
	 */
	_popProfile( before ) {
		if ( null === RouterNode._profiles ) {
			return;
		}
		const name = RouterNode._profileStack.pop();
		if ( undefined === name ) {
			return;
		}
		const after =
			null !== RouterNode.clock ? RouterNode.clock() : Core.now();
		const profiles = RouterNode._profiles;
		const info = profiles[ name ] ?? {
			time: 0,
			count: 0,
			avg: 0,
			oldest: 0,
			timestamp: 0,
		};
		info.time += after - before;
		info.count++;
		info.avg = info.time / info.count;
		info.oldest = 0 !== info.oldest ? info.oldest : before;
		info.timestamp = after;
		profiles[ name ] = info;

		const stack = RouterNode._profileStack;
		if ( stack.length > 0 ) {
			const parent = stack[ stack.length - 1 ];
			profiles[ parent ] ??= {
				time: 0,
				count: 0,
				avg: 0,
				oldest: 0,
				timestamp: 0,
			};
			profiles[ parent ].time -= after - before;
		}
	}

	/** Drop entries idle past PROFILE_TTL_S (run from fireCb while profiling). */
	trimProfiles() {
		const profiles = RouterNode._profiles ?? {};
		for ( const key of Object.keys( profiles ) ) {
			if (
				Core.now() - profiles[ key ].timestamp >
				RouterNode.PROFILE_TTL_S
			) {
				delete profiles[ key ];
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

	/**
	 * Get/set the profile table; setting (even to null) resets the frame stack.
	 * @param {...any} set
	 */
	static profiles( ...set ) {
		if ( set.length > 0 ) {
			RouterNode._profiles = set[ 0 ];
			RouterNode._profileStack = [];
		}
		return RouterNode._profiles;
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
