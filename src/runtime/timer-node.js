/**
 * Timer — the time-driven node base, and the wall-clock grid every periodic
 * poll on the page fires on.
 *
 * A timer recurring at 1000ms or more — riding the `_router` TIMER or in a
 * slot of its own — fires on a boundary of a grid derived from the clock alone
 * (ADR-17), never on elapsed time since its own last fire. Two surfaces polling on one
 * cadence therefore converge however far apart they were opened, harmonic
 * cadences meet on the same tick, and everything minted during that tick leaves
 * in `HttpOut`'s one batched POST. The grid lives here and nowhere else: a
 * subclass picks a harmonic interval and never computes a boundary.
 */

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
 * How early, in seconds, a Router tick may land before the grid boundary and
 * still fire a timer at the tick's own cadence: a tenth of the 1s tick, as
 * PHP's `Timer_Node` takes.
 */
const EARLY_TICK_S = 0.1;

/**
 * The first grid boundary strictly after `after`.
 *
 * The grid is a pure function of the wall clock, aligned to the epoch, so
 * every cadence dividing a minute lands on its :00, and two surfaces polling
 * on the same cadence land on the same boundary however far apart they were
 * opened — which is what puts their commands in ONE batched POST instead
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
	return ( Math.floor( after / interval ) + 1 ) * interval;
}

/**
 * Fires on a cadence, in one of two scheduling modes (Tachikoma parity).
 *
 * `setTimer()` picks between them. A named node without an interval, or with
 * one of 1000ms or more, registers 'TIMER' on `_router` and rides the tick the
 * graph already pays for, `fireCb()` throttling that ride down to the cadence
 * the node asked for. Everything else — a sub-second cadence, an unnamed node,
 * the Router itself — takes a slot of its own and needs a concrete interval:
 * a timeout re-armed for just after each grid boundary when it recurs at a
 * second or more, which the Router always does, and a `setInterval` otherwise.
 *
 * The hitchhike is a DIRECT call: `RouterNode.notifyTimer()` resolves each
 * registered name to its node and calls `fireCb()` on it. No message is routed,
 * and Timer does not override `fill()`.
 *
 * `fireCb()` is the framework-side hook and `fire()` the subclass override
 * point. The default `fire()` emits a TM_BYTESTREAM carrying the current
 * timestamp at `target` and notifies 'FIRE' subscribers, which is what a
 * consumer wanting nothing but the tick registers for.
 */
export class TimerNode extends Node {
	/**
	 * Start disarmed: no slot, no Router registration, `interval_ms` 0.
	 * `setTimer()` — from `set arguments` or from a subclass — arms the node.
	 */
	constructor() {
		super();
		// The own slot's timer handle; null whenever the slot is not armed.
		this._handle = null;
		// The grid boundary a gridded slot's next fire is due at; 0 before one.
		this._tickAt = 0;
		// The slot re-arms on the grid (setTimeout) rather than setInterval.
		this._gridded = false;
		// An own property, so SchemaReflection can assign the declared arg.
		this.interval_ms = 0;
		// 'inactive' | 'event_framework' (own slot) | 'router' (hitchhike).
		this.mode = 'inactive';
		// Dispatches that reached fire(), where counter counts messages sent.
		this.fireCount = 0;
		// Disarm after the first fire; one-time wakeups only, see setTimer().
		this.oneshot = false;
		// Router can't hitchhike its own TIMER; RouterNode self-arms instead.
		this.isRouter = false;
		// Last fire in either mode, kept on re-arm; seconds, Core.now() scale.
		this.lastFireTime = 0;
		// Asked for by markDue() and not yet served by a fire or markFired().
		this.due = false;
		// Stamped onto each message's KEY (Tachikoma STREAM); '' = unset.
		this.key = '';
	}

	/**
	 * The token list as stored by the base Node, kept verbatim and read only
	 * by the setter below.
	 *
	 * Redeclaring it is what keeps it reachable: a subclass defining only the
	 * setter shadows the inherited accessor pair, leaving the getter undefined
	 * and every read of `arguments` undefined with it.
	 *
	 * @return {string[]} Last-set argument tokens.
	 */
	get arguments() {
		return super.arguments;
	}

	/**
	 * Arm the BASE Timer from its one optional token: an absent token takes the
	 * Router's own cadence, an integer arms that cadence in milliseconds, and
	 * anything else throws. A subclass sets its own interval from `setTimer()`,
	 * so this auto-arm deliberately stops at `TimerNode` itself.
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
	 * disarms itself first; a sinkless timer does nothing.
	 *
	 * A hitchhiker whose `interval_ms` exceeds the 1s Router tick throttles
	 * here against the shared wall-clock grid, never against elapsed time since
	 * its own last fire (ADR-17): the tick that reaches `fire()` is the first at
	 * or past the next boundary, so two nodes on one cadence fire on the same
	 * tick however far apart they were armed. A hitchhiker at the tick's own
	 * cadence reads the same grid with a tenth of a tick's slack: it skips a
	 * tick landing more than 0.1s short of the boundary after its last fire,
	 * such as an extra one `requestTick()` asked for, so a tick at least 0.9s
	 * after the last fire always fires. The Router ticks just after each
	 * boundary, so a fire stamped late costs the next tick nothing unless it
	 * was stamped after the boundary that tick is due at. A tick within that
	 * tenth fires, so an extra tick just short of the boundary and the cadence
	 * tick after it both fire. A `lastFireTime` more than an interval ahead,
	 * left by a clock stepped back, is forgotten, so the next tick fires.
	 * An own slot skips both tests: it re-arms on the grid itself at a second
	 * or more, and runs a `setInterval` below that. Every dispatch records
	 * `lastFireTime`, which `setTimer()` keeps, so a retuned hitchhiker waits
	 * for its new cadence's boundary after its last fire.
	 */
	fireCb() {
		if ( this.oneshot ) {
			this.stopTimer();
		}
		if ( ! this.sink ) {
			return;
		}
		const now = Core.now();
		// A last fire over an interval ahead means the clock stepped back.
		const stepped = this.lastFireTime - now > this.interval_ms / 1000;
		const last = stepped ? 0 : this.lastFireTime;
		// Paces the 1s router tick; an own slot already fires at interval_ms.
		const slack = this.interval_ms > 1000 ? 0 : EARLY_TICK_S;
		if (
			'router' === this.mode &&
			this.interval_ms >= 1000 &&
			now < nextBoundary( last, this.interval_ms ) - slack
		) {
			return;
		}
		this.lastFireTime = now;
		this.due = false;
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
	 * Arm the timer in one of the two modes. A named non-Router node without
	 * an interval, or with one of at least 1000ms, registers 'TIMER' on
	 * `_router` and rides its tick; everything else takes a slot of its own,
	 * which requires a concrete interval. Any live slot is cleared
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
			this.mode = 'router';
			// After the mode-switch stopTimer above, which resets the flag.
			this.oneshot = oneshot;
			return;
		}
		// Clear any live slot before re-arming, else its timer leaks.
		if ( 'router' === this.mode || null !== this._handle ) {
			this.stopTimer();
		}
		if ( null === ms ) {
			// Own-slot needs a concrete interval; only isRouter reaches null.
			throw new Error( 'Own-slot timer requires an interval (ms)' );
		}
		this.interval_ms = ms;
		this.mode = 'event_framework';
		// After the re-arm stopTimer above, which resets the flag.
		this.oneshot = oneshot;
		this._gridded = this.isRouter || ( ! oneshot && ms >= 1000 );
		if ( this._gridded ) {
			this._tickAt = 0;
			this._armGridTick();
		} else {
			this._handle = setInterval( () => this.fireCb(), ms );
		}
	}

	/**
	 * Arm the slot's next fire for just after the next grid boundary, past
	 * both now and the boundary the last fire was due at: a late fire does not
	 * shift the next, and a boundary never fires twice. A clock stepped back
	 * past a whole interval re-anchors at now. The next fire is armed before
	 * this one runs, so a fire that throws still leaves the next.
	 */
	_armGridTick() {
		const now = Core.now();
		const stepped = this._tickAt - now > this.interval_ms / 1000;
		this._tickAt = nextBoundary(
			stepped ? now : Math.max( now, this._tickAt ),
			this.interval_ms
		);
		this._handle = setTimeout(
			() => {
				this._armGridTick();
				this.fireCb();
			},
			Math.ceil( ( this._tickAt - now ) * 1000 )
		);
	}

	/**
	 * Disarm before teardown, so neither an own slot nor a Router
	 * 'TIMER' registration outlives the node.
	 */
	removeNode() {
		this.stopTimer();
		super.removeNode();
	}

	/**
	 * Disarm whichever slot is active — unregister from the Router's 'TIMER'
	 * list, or clear the slot's handle — and reset `interval_ms` and the
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
			( this._gridded ? clearTimeout : clearInterval )( this._handle );
			this._handle = null;
		}
	}

	/**
	 * Due on the next tick, whatever the cadence says — what a caller means by
	 * "this changed, poll now". The grid resumes from wherever that fire lands.
	 * Asked from inside a tick, the Router fires it before that tick's flush.
	 *
	 * Only a hitchhiker reads `lastFireTime`, so this changes nothing for an
	 * own slot.
	 *
	 * @return {void}
	 */
	markDue() {
		this.lastFireTime = 0;
		this.due = true;
	}

	/**
	 * The caller just did this poll itself, so the next one waits out an
	 * interval rather than firing on the next tick. The inverse of `markDue()`.
	 *
	 * Not `lastFireTime = now`: the next boundary after an arbitrary instant is
	 * anywhere in `(0, interval]`, so arming just before one fires again a tick
	 * later — the duplicate request this exists to suppress. It counts from the
	 * NEXT boundary instead: a timer above the tick waits a full interval at
	 * minimum, still on the grid. A timer at the tick's own cadence keeps a
	 * tenth of a tick's slack, so its next fire waits until 0.1s short of the
	 * boundary after that one: at least nine tenths of its interval.
	 *
	 * @return {void}
	 */
	markFired() {
		this.due = false;
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
	 * milliseconds; omitting it takes the Router's own cadence.
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
