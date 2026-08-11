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
import names from './reserved-node-names.json';

/** The shared heartbeat every hitchhiking poller rides, in milliseconds. */
export const ROUTER_TICK_MS = 1000;

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

	/**
	 * Arm the Router's own 1s slot. Every other Timer hitchhikes that tick, so
	 * the Router cannot hitchhike itself — `isRouter` is what opts it out.
	 */
	constructor() {
		super();
		// Router self-starts its own 1s slot; isRouter skips the hitchhike.
		this.isRouter = true;
		this.setTimer( ROUTER_TICK_MS );
	}

	/**
	 * Route one message: peel the leading segment off TO, and hand the rest to
	 * the node that segment names. Unaddressed messages and FROM trails past
	 * MAX_FROM_SIZE are dropped. A name that resolves to nothing sets state
	 * NOT_AVAILABLE and bounces a TM_ERROR back down the FROM trail — unless the
	 * message is already an error, which would loop.
	 *
	 * @param {Array} message The 7-field positional message; TO is peeled in place.
	 */
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

	/**
	 * The Router tick (Router::fire_cb): run `notifyTimer()` bracketed by
	 * `_http`'s lock/flush, which HttpOut uses to batch a whole tick's
	 * commands into one POST. There is one `_http` per graph, so the bracket
	 * belongs here rather than with whichever consumer mounted last. Idle profile entries are trimmed
	 * here while profiling is on.
	 */
	fireCb() {
		this.fireCount++;
		const http = Core.node( names.HTTP );
		http?.lock();
		try {
			this.notifyTimer();
		} finally {
			http?.flush();
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

	/**
	 * Call `fireCb()` DIRECTLY on every TIMER-registered node (Router::
	 * notify_timer) — no message is routed. A registration whose node is gone
	 * would fire on every tick forever, so it is warned about and dropped.
	 */
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

	/**
	 * The Router has no sink: it routes by peeling TO.
	 *
	 * Accessor-over-property is the mechanism, not an accident: the base `Node`
	 * constructor assigns `this.sink = null` in its BODY, so that assignment
	 * runs through the setter below and every later one is refused.
	 *
	 * @return {null} Always null.
	 */
	// @ts-expect-error Accessor pair: ctor-body assign must hit the setter.
	get sink() {
		return null;
	}

	/**
	 * Reject every sink but null, so wiring one fails loudly instead of quietly
	 * creating a second, unrouted way out of the Router.
	 *
	 * @param {?Object} node Must be null; any node throws.
	 */
	set sink( node ) {
		if ( null !== node ) {
			throw new Error(
				'Router must not have a sink; it routes by TO and drops what it cannot peel.'
			);
		}
	}

	/**
	 * Console palette entry. Declares the three registration slots the base
	 * constructor seeds: FIRE (Timer subscribers), TIMER (the hitchhiking
	 * pollers this node ticks), and NOT_AVAILABLE (unroutable-TO watchers).
	 *
	 * @return {Object} The node schema.
	 */
	static nodeSchema() {
		return { registrations: [ 'FIRE', 'TIMER', 'NOT_AVAILABLE' ] };
	}
}
