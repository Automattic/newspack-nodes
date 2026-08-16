import { Core } from './core';
import { Node } from './node';
import names from './reserved-node-names.json';
import {
	newMessage,
	TYPE,
	TIMESTAMP,
	FROM,
	TO,
	KEY,
	VALUE,
	TM_BYTESTREAM,
} from './message';

/**
 * Where the whole grid sits on the wall clock — ONE offset for every cadence,
 * never one per interval.
 *
 * Harmonics are the point: a 10s boundary is every second 5s boundary and a 30s
 * boundary every sixth, so with a shared origin all four cadences on a page meet
 * every 30s and ride ONE POST. A per-interval phase destroys exactly that,
 * sliding each cadence a few hundred milliseconds off the others so they never
 * share a tick again. The offset itself only keeps the grid off :00, where every
 * other cron already is.
 *
 * @testonly Exported for tests that pin a clock to a boundary; the grid is
 * TimerNode's alone, and `lint-contract`'s `grid-math` rule keeps it that way.
 */
export const GRID_PHASE_MS = 360;

/**
 * The first grid boundary strictly after `after`.
 *
 * The grid is a pure function of the wall clock, so two surfaces
 * polling on the same cadence land on the same boundary however far apart they
 * were opened — which is what puts their commands in ONE batched POST instead
 * of one each. Paced from its own arming time, a 5s poll opened at :02 and
 * another opened at :04 never share a tick again. Borrowed from `LRU_Cache`'s
 * bucket rotation, where the same property makes a restarted process keep its
 * predecessor's phase.
 *
 * @testonly Exported for the tests that pin a clock to a boundary; every
 * caller inside the runtime is in this file.
 *
 * @param {number} after      Seconds; the last fire.
 * @param {number} intervalMs The cadence.
 * @return {number} The next boundary, in seconds.
 */
export function nextBoundary( after, intervalMs ) {
	const interval = intervalMs / 1000;
	if ( ! ( interval > 0 ) ) {
		return after;
	}
	const phase = GRID_PHASE_MS / 1000;
	return (
		( Math.floor( ( after - phase ) / interval ) + 1 ) * interval + phase
	);
}

/**
 * Timer — periodic / one-shot fire in two modes (Tachikoma parity):
 *  - own slot: `setTimer(ms)` / `make_node Timer t 1000` — a setInterval slot.
 *  - Router-hitchhike: `setTimer()` (no args) / `make_node Timer t` — registers
 *    'TIMER' on the _router and rides its per-tick `notify_timer`, which calls
 *    this node's `fireCb()` DIRECTLY (no routed message). Timer does NOT override
 *    `fill()`.
 * `fireCb()` returns early without a sink; otherwise `fire()` emits a TM_BYTESTREAM
 * carrying the timestamp via sink to target and notifies 'FIRE' subscribers.
 * Subclasses override `fire()`; consumers register on 'FIRE'.
 */
export class TimerNode extends Node {
	/**
	 * Start disarmed: no slot, no Router registration, `interval_ms` 0.
	 * `setTimer()` — from `set arguments` or from a subclass — arms the node.
	 */
	constructor() {
		super();
		this._handle = null;
		// Predeclared so the schema setter walker assigns it from `arguments=`.
		this.interval_ms = 0;
		// 'inactive' | 'event_framework' (own slot) | 'router' (hitchhike).
		this.mode = 'inactive';
		this.fireCount = 0;
		this.oneshot = false;
		// Router can't hitchhike its own TIMER; RouterNode self-arms instead.
		this.isRouter = false;
		// Throttle clock for hitchhike timers with interval_ms > 1000.
		this.lastFireTime = 0;
		// Stamped onto each message's KEY (Tachikoma STREAM); '' = unset.
		this.key = '';
	}

	/**
	 * The token list as stored by the base Node — Timer keeps it verbatim and
	 * reads it only in the setter below.
	 *
	 * @return {string[]} Last-set argument tokens.
	 */
	get arguments() {
		return super.arguments;
	}

	/**
	 * Arm the BASE Timer from its one optional token: no token hitchhikes the
	 * Router tick, an integer arms a slot of that many milliseconds, anything
	 * else throws. A subclass sets its own interval from `setTimer()`, so this
	 * auto-arm deliberately stops at `TimerNode` itself.
	 *
	 * @param {string[]} value Argument tokens; token 0 is the interval in ms.
	 */
	set arguments( value ) {
		super.arguments = value;
		if ( TimerNode !== this.constructor ) {
			return;
		}
		const tokens = Array.isArray( value ) ? value : [];
		const raw = tokens.length ? String( tokens[ 0 ] ).trim() : '';
		if ( '' === raw ) {
			this.setTimer();
		} else if ( /^[0-9]+$/.test( raw ) ) {
			this.setTimer( Number( raw ) );
		} else {
			throw new Error( 'Bad arguments for Timer' );
		}
	}

	/**
	 * One tick of whichever slot is armed (Timer::fire_cb). A oneshot timer
	 * disarms itself first; a sinkless timer does nothing. A hitchhiking timer
	 * whose `interval_ms` exceeds the 1s Router tick throttles here, so only
	 * ticks at or past its own cadence reach `fire()`.
	 */
	fireCb() {
		if ( this.oneshot ) {
			this.stopTimer();
		}
		if ( ! this.sink ) {
			return;
		}
		// Paces the 1s router tick; an own slot already fires at interval_ms.
		if ( 'router' === this.mode && this.interval_ms > 1000 ) {
			const now = Core.now();
			if ( now < nextBoundary( this.lastFireTime, this.interval_ms ) ) {
				return;
			}
			this.lastFireTime = now;
		}
		this.fireCount++;
		this.fire();
	}

	/**
	 * Emit one heartbeat (Timer::fire): a TM_BYTESTREAM whose VALUE is the
	 * current timestamp, sent through the sink to `target`, then notify 'FIRE'
	 * subscribers. An untargeted timer sinking straight into the command
	 * interpreter skips the send — the interpreter has nothing to do with it —
	 * and only notifies. Subclasses override this to define a tick.
	 */
	fire() {
		if (
			'' !== this.target ||
			'CommandInterpreterNode' !== this.sink?.constructor?.name
		) {
			const m = newMessage();
			m[ TYPE ] = TM_BYTESTREAM;
			m[ TIMESTAMP ] = Core.now();
			m[ FROM ] = this.name;
			m[ TO ] = this.target;
			if ( '' !== this.key ) {
				m[ KEY ] = this.key;
			}
			m[ VALUE ] = String( Core.now() );
			this.counter++;
			this.sink.fill( m );
		}
		this.notify( 'FIRE', Core.now() );
	}

	/**
	 * Arm the timer in one of the two modes. A named non-Router node asking
	 * for no interval, or for one of at least 1000ms, registers 'TIMER' on
	 * `_router` and rides its tick; everything else takes its own setInterval
	 * slot, which requires a concrete interval. Any live slot is cleared
	 * first, so re-arming never leaks one.
	 *
	 * `oneshot` is for a ONE-TIME wakeup — a debounce, a deadline, a
	 * flush-on-the-next-cycle. A node that PACES ITSELF must never re-arm a
	 * fresh oneshot at the bottom of its own `fire()`: `fireCb()` disarms a
	 * oneshot before dispatching (`stopTimer()`, which also clears the interval
	 * handle and zeroes `interval_ms`), so the node's continued existence in the
	 * loop then depends on reaching that last line on every single tick. One
	 * early return, one throw, one refactor that moves the re-arm under a
	 * conditional, and the node leaves the loop for good — no error, no timer,
	 * just a node that stops firing. `setInterval` is no protection: the first
	 * fire clears it. Instead hold a RECURRING timer and re-arm only when the
	 * cadence CHANGES, so a stop has to be explicit:
	 *
	 *     const nextMs = busy ? BUSY_MS : IDLE_MS;
	 *     if ( this.interval_ms !== nextMs ) {
	 *         this.setTimer( nextMs );
	 *     }
	 *
	 * (PHP parity: `Durable_Reader::fire()`, `Remote_Source_Node::fire()`,
	 * `Stdin_Node::fire()`. Note `stopTimer()` zeroes `interval_ms`, so that
	 * guard only reads true state while every arming site is recurring too.)
	 *
	 * @param {?number} ms      Interval in milliseconds; null means the Router's own cadence.
	 * @param {boolean} oneshot Disarm after the first fire. One-time wakeups only — see above.
	 * @throws {Error} When the hitchhike finds no `_router`, or an own slot gets no interval.
	 */
	setTimer( ms = null, oneshot = false ) {
		if (
			( null === ms || ms >= 1000 ) &&
			'' !== this.name &&
			! this.isRouter
		) {
			// THIS registry's router; a document registry has none.
			const router = this.registry.node( names.ROUTER );
			if ( ! router ) {
				throw new Error(
					'Router-hitchhike requires _router to be present'
				);
			}
			if ( 'event_framework' === this.mode ) {
				this.stopTimer();
			}
			router.register( 'TIMER', this.name );
			// No ms = the router's own cadence; list_timers prints this.
			this.interval_ms = null === ms ? router.interval_ms : ms;
			this.lastFireTime = 0;
			this.mode = 'router';
			// After the mode-switch stopTimer above, which resets the flag.
			this.oneshot = oneshot;
			return;
		}
		// Clear any live slot before re-arming, else a setInterval leaks.
		if ( 'router' === this.mode || null !== this._handle ) {
			this.stopTimer();
		}
		if ( null === ms ) {
			// Own-slot needs a concrete interval; only isRouter reaches null.
			throw new Error( 'Own-slot timer requires an interval (ms)' );
		}
		this._handle = setInterval( () => this.fireCb(), ms );
		this.interval_ms = ms;
		this.mode = 'event_framework';
		// After the re-arm stopTimer above, which resets the flag.
		this.oneshot = oneshot;
	}

	/**
	 * Disarm before teardown, so neither a setInterval slot nor a Router
	 * 'TIMER' registration outlives the node.
	 */
	removeNode() {
		this.stopTimer();
		super.removeNode();
	}

	/**
	 * Disarm whichever slot is active — unregister from the Router's 'TIMER'
	 * list, or clear the interval handle — and reset `interval_ms` and the
	 * oneshot flag. Stopping from inside a fire is safe: the Router iterates a
	 * snapshot of its registration keys.
	 */
	stopTimer() {
		const mode = this.mode;
		this.mode = 'inactive';
		this.interval_ms = 0;
		this.oneshot = false;
		if ( 'router' === mode ) {
			const router = this.registry.node( names.ROUTER );
			if ( router && '' !== this.name ) {
				router.unregister( 'TIMER', this.name );
			}
			return;
		}
		if ( null !== this._handle ) {
			clearInterval( this._handle );
			this._handle = null;
		}
	}

	/**
	 * Due on the next tick, whatever the cadence says — what a caller means by
	 * "this changed, poll now". The grid resumes from wherever that fire lands.
	 *
	 * @return {void}
	 */
	markDue() {
		this.lastFireTime = 0;
	}

	/**
	 * The caller just did this poll itself, so the next one owes a FULL
	 * interval. The inverse of `markDue()`.
	 *
	 * Not `lastFireTime = now`: the next boundary after an arbitrary instant is
	 * anywhere in `(0, interval]`, so arming just before one fires again a tick
	 * later — the duplicate request this exists to suppress. It counts from the
	 * NEXT boundary instead: a full interval at minimum, still on the grid.
	 *
	 * @return {void}
	 */
	markFired() {
		this.lastFireTime = nextBoundary( Core.now(), this.interval_ms );
	}

	/**
	 * The stream key stamped onto each emitted message's KEY (Tachikoma's
	 * STREAM field); '' leaves KEY unset.
	 *
	 * @return {string} Current key.
	 */
	get key() {
		return this._key;
	}

	/**
	 * Set the stream key every `fire()` stamps onto KEY.
	 *
	 * @param {string} key Stream key; '' stamps none.
	 */
	set key( key ) {
		this._key = key;
	}

	/**
	 * Console-palette entry. The one optional positional is the interval in
	 * milliseconds; omitting it rides the Router tick instead of taking a slot.
	 *
	 * @return {Object} The node schema.
	 */
	static nodeSchema() {
		return {
			category: 'Control',
			description:
				'Periodic firing — emits a heartbeat every N ms, or rides the Router tick when given no interval.',
			arguments: [
				{
					name: 'interval_ms',
					type: 'int',
					required: false,
					default: 0,
				},
			],
			commands: [],
			// 'FIRE' is the per-tick subscriber slot; the base ctor seeds it.
			registrations: [ 'FIRE' ],
		};
	}
}
