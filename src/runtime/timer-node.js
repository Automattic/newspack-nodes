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
		// Predeclared so the schema setter walker (gated on `name in this`)
		// assigns it from `arguments=`.
		this.interval_ms = 0;
		// 'inactive' | 'event_framework' (own slot) | 'router' (hitchhike).
		this.mode = 'inactive';
		this.fire_count = 0;
		this.active = false;
		this.oneshot = false;
		// Stamped onto each emitted message's KEY (Tachikoma's STREAM). '' = unset.
		this.key = '';
		// 'FIRE' is the per-tick subscriber slot.
		this.registrations.FIRE = {};
	}

	get arguments() {
		return super.arguments;
	}

	// Only the BASE Timer auto-arms; interval_ms comes from setTimer(), not a schema walk.
	set arguments( value ) {
		super.arguments = value;
		if ( TimerNode !== this.constructor ) {
			return;
		}
		const raw =
			null === value || undefined === value ? '' : String( value ).trim();
		if ( '' === raw ) {
			this.setTimer();
		} else if ( /^[0-9]+$/.test( raw ) ) {
			this.setTimer( Number( raw ) );
		} else {
			throw new Error( 'Bad arguments for Timer' );
		}
	}

	// fire_cb (Perl Timer::fire_cb): deactivate a non-'forever' (oneshot) timer,
	// then return WITHOUT firing if there is no sink — so a sink-less Timer never
	// emits and never notifies 'FIRE'. The _router's notify_timer calls this
	// directly for hitchhikers; the Event_Framework calls it for own-slot timers.
	fireCb() {
		this.fire_count += 1;
		if ( this.oneshot ) {
			this.active = false;
			this.mode = 'inactive';
		}
		if ( ! this.sink ) {
			return;
		}
		this.fire();
	}

	// One tick (Perl Timer::fire). Emit a TM_BYTESTREAM heartbeat carrying the
	// timestamp ONLY when this timer has a target, or its sink isn't the
	// CommandInterpreter (the owner/CI guard — a target-less timer sinking into the
	// interpreter would just spam it); counter++ on emit. Always notify 'FIRE'.
	// (instanceof would cycle through command-interpreter-node's make_node map, so
	// the CI is matched by its build-preserved constructor name.)
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
			this.counter += 1;
			this.sink.fill( m );
		}
		this.notify( 'FIRE', Core.now() );
	}

	// No ms => Router-hitchhike (register 'TIMER' on _router); ms => own slot.
	setTimer( ms = null, oneshot = false ) {
		this.oneshot = oneshot;
		this.active = true;
		if ( null === ms ) {
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
			this.interval_ms = ms;
			this.mode = 'router';
			return;
		}
		// Clear any live slot before re-arming: router→own switches mode, and an
		// own→own re-arm must drop the prior setInterval (JS setInterval, unlike
		// PHP's node-deduped Event_Framework, would otherwise leak it).
		if ( 'router' === this.mode || null !== this._handle ) {
			this.stopTimer();
		}
		this._handle = setInterval( () => this.fireCb(), ms );
		this.interval_ms = ms;
		this.mode = 'event_framework';
	}

	// Unregister the active slot. Router mode unregisters immediately — notify()
	// iterates an Object.keys() snapshot, so a mid-notify self-stop is safe.
	stopTimer() {
		const mode = this.mode;
		this.active = false;
		this.mode = 'inactive';
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

	removeNode() {
		this.stopTimer();
		super.removeNode();
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
		};
	}
}
