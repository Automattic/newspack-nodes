import { Core } from './core';
import { Node } from './node';
import names from './reserved-node-names.json';
import {
	newMessage,
	TYPE,
	FROM,
	TO,
	KEY,
	VALUE,
	TM_INFO,
	TM_BYTESTREAM,
} from './message';

/**
 * Timer — periodic / one-shot fire in two modes (Tachikoma parity):
 *  - own slot: `setTimer(ms)` / `make_node Timer t 1000` — a setInterval slot.
 *  - Router-hitchhike: `setTimer()` (no args) / `make_node Timer t` — registers
 *    'TIMER' on the _router and rides its per-tick `notify('TIMER')` instead of
 *    spending its own slot.
 * On each fire `fire()` emits a TM_BYTESTREAM carrying the timestamp via sink to
 * target; `fireCb()` also notifies 'FIRE' subscribers. Subclasses override
 * `fire()`; consumers register on 'FIRE'.
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

	setKey( key ) {
		this.key = key;
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

	get arguments() {
		return super.arguments;
	}

	// Mirror PHP Timer_Node::arguments — empty => Router-hitchhike, numeric =>
	// own interval, anything else => error.
	set arguments( value ) {
		super.arguments = value;
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

	// Detect Router-hitchhike TIMER notifications (TM_INFO, KEY='TIMER') and
	// fire; else forward to sink like any other Node.
	fill( message ) {
		if ( message[ TYPE ] & TM_INFO && 'TIMER' === message[ KEY ] ) {
			this.counter += 1;
			this.fireCb();
			return;
		}
		super.fill( message );
	}

	fireCb() {
		this.fire_count += 1;
		this.fire();
		this.notify( 'FIRE', Core.now() );
		if ( this.oneshot ) {
			this.stopTimer();
		}
	}

	// One tick: TM_BYTESTREAM with the timestamp (string VALUE, canonical — matches
	// PHP Timer_Node::fire), FROM=self, TO=target, fill sink.
	fire() {
		if ( ! this.sink ) {
			return;
		}
		const m = newMessage();
		m[ TYPE ] = TM_BYTESTREAM;
		m[ FROM ] = this.name;
		m[ TO ] = this.target;
		if ( '' !== this.key ) {
			m[ KEY ] = this.key;
		}
		m[ VALUE ] = String( Core.now() );
		this.sink.fill( m );
	}

	removeNode() {
		this.stopTimer();
		super.removeNode();
	}
}
