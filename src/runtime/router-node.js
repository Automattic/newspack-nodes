/**
 * Router — `_router`, where a TO path becomes a delivery, and the one heartbeat
 * the whole page graph ticks on.
 *
 * Addressing is by name and path rather than by reference, so no node holds a
 * handle on its peers: `a/b/c` means "find `a`, give it `b/c`". The same node
 * owns the tick, because a graph already paying for one heartbeat should not
 * grow a second — every periodic poller hitchhikes this one, and everything
 * they mint during a tick leaves in `HttpOut`'s one batched POST.
 */

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

/**
 * One node's raw dispatch-profile record, as this Router accumulates it.
 *
 * @typedef {import('./command-interpreter-node').ProfileInfo} ProfileInfo
 */

/**
 * The one cadence every hitchhiking poller rides, in milliseconds.
 *
 * The value is load-bearing at both ends. `TimerNode.setTimer()` sends any
 * interval of at least 1000ms to the Router rather than to a slot of its own,
 * and `TimerNode.fireCb()` throttles a hitchhiker only when its interval
 * EXCEEDS the tick — so a poller armed at exactly this cadence fires on every
 * tick with no throttle of its own.
 */
export const ROUTER_TICK_MS = 1000;

/**
 * Dispatches messages by path and drives the TIMER channel.
 *
 * `fill()` peels the head segment off TO and hands the message to the node that
 * segment names. The Router has no sink and refuses one: what it cannot peel it
 * drops, and a miss answers NOT_AVAILABLE back along FROM.
 *
 * The second job is why it extends `TimerNode`. `fireCb()` calls each TIMER
 * registrant's own `fireCb()` directly — the Router-hitchhike pattern, which
 * buys a node periodic work without a slot of its own, ported from Tachikoma's
 * `Router::fire_cb` and `notify_timer`. Overriding is what makes the pattern
 * possible: `TimerNode.fireCb()` returns early on a node with no sink, and the
 * Router has none. The Router cannot hitchhike itself either, so it takes its
 * own slot in the constructor.
 *
 * Dispatch profiling stays off until `profiles()` is handed a table, and while
 * it is null `fill()` takes a branch that costs nothing.
 */
export class RouterNode extends TimerNode {
	/** Seconds of idleness after which `trimProfiles()` drops an entry (Tachikoma: 900). */
	static PROFILE_TTL_S = 900;

	/**
	 * Clock seam replacing the two `Core.now()` reads that bracket a profiled
	 * dispatch. Tests assign a closure returning a scripted sequence, so
	 * elapsed times are exact; production leaves it null.
	 *
	 * Signature: `function (): number`, seconds.
	 *
	 * @type {?(function(): number)}
	 */
	static clock = null;

	/**
	 * Per-node self-time profiles keyed by node name; null = profiling off.
	 * Static like Router.pm's package-global $PROFILES: the table belongs to
	 * the process rather than to any one Router instance.
	 *
	 * `time` is self-time in seconds, a nested dispatch having been subtracted
	 * back out of its parent. `oldest` and `timestamp` are the first and last
	 * dispatch recorded, which is the window `list_profiles` reports a rate
	 * over and the idleness `trimProfiles()` measures.
	 *
	 * @type {?Object<string,ProfileInfo>}
	 */
	static _profiles = null;

	/**
	 * Open dispatch frames, innermost last (Router.pm's @STACK). `_popProfile`
	 * reads the entry beneath the one it pops to find the parent the child's
	 * elapsed time comes out of.
	 *
	 * @type {string[]}
	 */
	static _profileStack = [];

	/**
	 * Arm the Router's own 1s slot. Every other Timer hitchhikes that tick, so
	 * the Router cannot hitchhike itself — `isRouter` is what opts it out.
	 */
	constructor() {
		super();
		this.isRouter = true;
		// Whether a coalesced tick is already queued; see requestTick().
		this._tickAsked = false;
		this.setTimer( ROUTER_TICK_MS );
	}

	/**
	 * Route one message: peel the head segment off TO and fill the node it
	 * names.
	 *
	 * The counter counts messages taken in rather than delivered, so a miss
	 * that bounces a TM_ERROR back through this same `fill()` bumps it twice.
	 * The PHP Router counts identically.
	 *
	 * FROM is measured here rather than trusted. `stampMessage()` guards the
	 * path on the way out of each node, but a message arriving off the wire was
	 * stamped in another process; dropping over `MAX_FROM_SIZE` is what keeps a
	 * routing cycle from growing an unbounded path.
	 *
	 * TO becomes the remainder before the target sees it, so each hop reads
	 * only the path below itself and a deeper Router peels its own head in
	 * turn.
	 *
	 * A head that resolves to nothing publishes NOT_AVAILABLE first, so a
	 * registrant sees the miss even when there is no FROM to answer, and then
	 * bounces a TM_ERROR back down the FROM trail. A message already carrying
	 * TM_ERROR gets the state change and nothing else: answering an error trail
	 * with another error is how two dead paths loop.
	 *
	 * @param {Array} message The 7-field positional message; TO is peeled in place.
	 */
	fill( message ) {
		this.counter++;

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
			this.setState( 'NOT_AVAILABLE', {
				node: head,
				from: message[ FROM ],
			} );
			if ( message[ TYPE ] & TM_ERROR ) {
				return;
			}
			const err = newMessage();
			err[ TYPE ] = TM_ERROR;
			// Restamped: newMessage() reads the wall clock, not Core.now().
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
				// A throw must still pop, or the parent frame is wrong.
				target.fill( message );
			} finally {
				this._popProfile( before );
			}
			return;
		}
		target.fill( message );
	}

	/**
	 * The tick: fire every TIMER registrant, bracketed by `_http`'s lock and
	 * flush.
	 *
	 * This replaces `TimerNode.fireCb()` rather than extending it. That one
	 * returns early on a sinkless node and emits a heartbeat message the Router
	 * would have nowhere to send; this one dispatches `notifyTimer()` instead,
	 * which is the whole hitchhike.
	 *
	 * The bracket is what lets `HttpOut` batch a whole tick's commands into one
	 * POST. There is one `_http` per graph and the Router looks it up itself,
	 * so batching is a property of having a graph rather than of which consumer
	 * mounted last: a mount opening a bracket of its own would make that tick
	 * pay for a second POST. The `finally` flushes even when a subscriber
	 * throws, and trims idle profile entries while profiling is on.
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
	 * Open a dispatch frame for `name`.
	 *
	 * @param {string} name Node the message is about to be handed to.
	 * @return {number} Start time in seconds, handed straight back to `_popProfile()`.
	 */
	_pushProfile( name ) {
		RouterNode._profileStack.push( name );
		return null !== RouterNode.clock ? RouterNode.clock() : Core.now();
	}

	/**
	 * Close the innermost frame and fold its elapsed time into that node's
	 * entry.
	 *
	 * The same elapsed comes back out of the enclosing frame, so every entry
	 * reports SELF time: a node whose work is one nested dispatch shows the
	 * cost against the callee, not against itself.
	 *
	 * Profiling can be switched off between the push and the pop, so
	 * `_profiles` is re-read; the frame left open then costs nothing, because
	 * `profiles()` empties the stack on any set.
	 *
	 * @param {number} before Start time from `_pushProfile()`.
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

	/**
	 * Drop profile entries idle longer than `PROFILE_TTL_S`, which the tick
	 * does on every pass while profiling is on. Idleness is measured against
	 * `Core.now()`: the `clock` seam times dispatches, not this sweep.
	 */
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
	 * Call each TIMER registrant's `fireCb()` DIRECTLY — no message, no
	 * `fill()`.
	 *
	 * The channel holds NAMES, so each is resolved fresh on every tick: a name
	 * whose node is gone would be looked up on every tick forever, so it costs
	 * one warning and loses its registration.
	 *
	 * Iterating `Object.keys()` walks a snapshot, so a registrant unregistering
	 * itself or a peer from inside its own `fireCb()` cannot disturb the walk.
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
	 * Ask for a tick NOW, coalesced: many asks in one commit run ONE tick.
	 *
	 * A mount that wants its first load says so here rather than opening a
	 * bracket of its own. Three mounts in one commit are three asks and one
	 * tick — running one each would send a tick-cadence hitchhiker's command
	 * once per asker, since only an interval ABOVE the tick throttles.
	 *
	 * The window is the microtask checkpoint closing the current commit, and
	 * the ask is cleared before the tick runs, so an ask arriving afterwards is
	 * a later tick rather than a lost one.
	 *
	 * @return {void}
	 */
	requestTick() {
		if ( this._tickAsked ) {
			return;
		}
		this._tickAsked = true;
		Promise.resolve().then( () => {
			this._tickAsked = false;
			this.fireCb();
		} );
	}

	/**
	 * Get the profile table, or set it: an object turns profiling on, null
	 * turns it off. Either kind of set empties the frame stack, because
	 * whatever frames stood open belonged to a table that is no longer the one
	 * being written.
	 *
	 * Variadic because null is a VALUE here, so a `set = null` parameter could
	 * not tell a disable from a read.
	 *
	 * @param {...?Object<string,ProfileInfo>} set New table when given.
	 * @return {?Object<string,ProfileInfo>} The table, or null while profiling is off.
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
	 * @throws {Error} When given anything but null.
	 */
	set sink( node ) {
		if ( null !== node ) {
			throw new Error(
				'Router must not have a sink; it routes by TO and drops what it cannot peel.'
			);
		}
	}

	/**
	 * The three registration channels the base constructor seeds, and the only
	 * names `register()` accepts here: TIMER for the hitchhiking pollers this
	 * node fires, NOT_AVAILABLE for route-miss watchers, and FIRE inherited
	 * from `TimerNode`'s declaration — the Router's `fireCb()` runs
	 * `notifyTimer()` in place of `fire()`, so nothing notifies FIRE here.
	 *
	 * Nothing else is declared because nothing else reads it: the Router is
	 * placed by `mountExospine` and never listed in `includeNodes`, so no
	 * palette or `help` lookup reaches this schema. PHP spells the same
	 * exclusion as a `Hidden` category.
	 *
	 * @return {{registrations: string[]}} The node schema.
	 */
	static nodeSchema() {
		return { registrations: [ 'FIRE', 'TIMER', 'NOT_AVAILABLE' ] };
	}
}
