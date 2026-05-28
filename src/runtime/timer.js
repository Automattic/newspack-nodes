import { Core } from './core';
import { Node } from './node';
import { newMessage, TYPE, FROM, TO, VALUE, TM_INFO } from './message';

/**
 * Timer — a repeating setInterval Node. `make_node Timer t 1000` auto-starts
 * a 1s timer. On each tick `fire()` emits a TM_INFO carrying the timestamp
 * via sink to target, and notifies 'FIRE' subscribers (Tachikoma parity).
 * Subclasses override `fire()`; consumers register on 'FIRE'.
 */
export class Timer extends Node {
	constructor() {
		super();
		this._handle = null;
		// Predeclared so the Tachikoma schema setter walker (gated on
		// `name in this`) actually assigns it from `arguments=`.
		this.interval_ms = 0;
		// 'FIRE' is the per-tick subscriber slot (Tachikoma parity).
		this.registrations.FIRE = {};
	}

	static nodeSchema() {
		return {
			category: 'Control',
			description: 'Repeating setInterval Node; fires each tick.',
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

	// Tachikoma arguments() setter: schema walker assigns interval_ms; if >0,
	// auto-start (mirrors Router self-start). Calling with 0 / empty stops.
	set arguments( value ) {
		super.arguments = value;
		const ms = Number.isInteger( this.interval_ms ) ? this.interval_ms : 0;
		if ( ms > 0 ) {
			this.setInterval( ms );
		} else {
			this.stop();
		}
	}

	// One tick: TM_INFO with timestamp, FROM=self, TO=target, fill sink.
	// Notifies 'FIRE' so registered subscribers run their per-tick work.
	fire() {
		const now = Core.now();
		if ( this.sink ) {
			const m = newMessage();
			m[ TYPE ] = TM_INFO;
			m[ FROM ] = this.name;
			m[ TO ] = this.target;
			m[ VALUE ] = now;
			this.counter += 1;
			this.sink.fill( m );
		}
		this.notify( 'FIRE', now );
	}

	setInterval( ms ) {
		this.stop();
		this.interval_ms = ms;
		this._handle = setInterval( () => this.fire(), ms );
	}

	stop() {
		if ( null !== this._handle ) {
			clearInterval( this._handle );
			this._handle = null;
		}
	}

	removeNode() {
		this.stop();
		super.removeNode();
	}
}
