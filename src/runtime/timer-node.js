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

	get arguments() {
		return super.arguments;
	}

	// Only the BASE Timer auto-arms; interval_ms comes from setTimer().
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

	// fireCb (Timer::fire_cb): oneshot stops fully; no-op without a sink.
	fireCb() {
		if ( this.oneshot ) {
			this.stopTimer();
		}
		if ( ! this.sink ) {
			return;
		}
		// A hitchhike timer with interval_ms > 1000 throttles to that interval.
		if ( this.interval_ms > 1000 ) {
			const now = Core.now();
			if ( now - this.lastFireTime < this.interval_ms / 1000 ) {
				return;
			}
			this.lastFireTime = now;
		}
		this.fireCount++;
		this.fire();
	}

	// One tick (Timer::fire): emit a TM_BYTESTREAM heartbeat, notify 'FIRE'.
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

	// No ms or ms > 1000 → Router-hitchhike; ms <= 1000 → own setInterval slot.
	setTimer( ms = null, oneshot = false ) {
		// A >=1000ms timer hitchhikes the router notify; except isRouter.
		if ( ( null === ms || ms >= 1000 ) && ! this.isRouter ) {
			if ( '' === this.name ) {
				throw new Error(
					'Router-hitchhike requires Timer to have a name'
				);
			}
			const router = Core.node( names.ROUTER );
			if ( ! router ) {
				throw new Error(
					'Router-hitchhike requires _router to be present'
				);
			}
			if ( 'event_framework' === this.mode ) {
				this.stopTimer();
			}
			router.register( 'TIMER', this.name );
			this.interval_ms = null === ms ? 0 : ms;
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

	removeNode() {
		this.stopTimer();
		super.removeNode();
	}

	// Unregister the active slot; a mid-notify self-stop is safe.
	stopTimer() {
		const mode = this.mode;
		this.mode = 'inactive';
		this.interval_ms = 0;
		this.oneshot = false;
		if ( 'router' === mode ) {
			const router = Core.node( names.ROUTER );
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

	get key() {
		return this._key;
	}

	set key( key ) {
		this._key = key;
	}

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
