import { Core } from './core';
import {
	FROM,
	TO,
	TYPE,
	KEY,
	VALUE,
	TM_INFO,
	newMessage,
	valueSize,
} from './message';

export const MAX_FROM_SIZE = 1024;

export class Node {
	constructor() {
		this.name = '';
		this.sink = null;
		this.target = '';
		this.counter = 0;
		this.largestMsgSent = 0;
		this.registrations = {};
		this.setStateCache = {};
		this.patron = null;
		this.interpreter = null;
	}

	setName( name ) {
		if ( '' !== this.name ) {
			Core.unregisterNode( this.name );
		}
		if ( Core.node( name ) !== null ) {
			throw new Error(
				`node name collision: ${ name } already registered`
			);
		}
		this.name = name;
		Core.registerNode( name, this );
	}

	fill( message ) {
		if (
			'' === message[ TO ] &&
			'string' === typeof this.target &&
			this.target
		) {
			message[ TO ] = this.target;
		}
		this.counter += 1;
		const size = valueSize( message );
		if ( size > this.largestMsgSent ) {
			this.largestMsgSent = size;
		}
		if ( this.sink ) {
			this.sink.fill( message );
		}
	}

	stampMessage( message, name ) {
		if ( '' === name ) {
			// Programming error — unlikely to spam, won't recover.
			Core.stderr(
				`ERROR: ${ this.constructor.name } stampMessage() called with empty name`
			);
			return false;
		}
		const from = message[ FROM ];
		const next = '' === from ? name : `${ name }/${ from }`;
		if ( next.length > MAX_FROM_SIZE ) {
			// Could spam if a routing cycle triggers it per-message —
			// rate-limit.
			Core.printLessOften(
				`ERROR: path exceeded ${ MAX_FROM_SIZE } bytes; dropping from: ${ next }`
			);
			return false;
		}
		message[ FROM ] = next;
		return true;
	}

	/**
	 * Multi-modal listener registration. The `event` MUST have been
	 * pre-declared by the Node subclass via `this.registrations[event] = {}`;
	 * `register` throws otherwise. This is intentional (not a defensive
	 * check) — it forces subclasses to declare the events they emit.
	 *
	 * `cb === null` selects node-name dispatch: at notify time, the
	 * `listener` string is looked up via `Core.node(listener)` and a
	 * TM_INFO message is forwarded to that node. Otherwise `cb` is a
	 * closure called with the payload; returning `false` self-unregisters.
	 *
	 * If the event has a cached `setState` payload, the new listener
	 * receives it immediately at register time.
	 *
	 * @param {string}        event    Pre-declared event name on this node.
	 * @param {string}        listener Listener id; in node-name mode this MUST be a registered node name.
	 * @param {Function|null} cb       Closure dispatch when truthy; node-name dispatch when null.
	 */
	register( event, listener, cb = null ) {
		if ( ! ( event in this.registrations ) ) {
			throw new Error( `no such event: ${ event }` );
		}
		this.registrations[ event ][ listener ] = cb;
		if ( event in this.setStateCache ) {
			this._dispatchListener(
				event,
				listener,
				this.setStateCache[ event ]
			);
		}
	}

	unregister( event, listener ) {
		if ( this.registrations[ event ] ) {
			delete this.registrations[ event ][ listener ];
		}
	}

	notify( event, payload = null ) {
		const listeners = this.registrations[ event ];
		if ( ! listeners ) {
			return;
		}
		for ( const listener of Object.keys( listeners ) ) {
			const keep = this._dispatchListener( event, listener, payload );
			if ( false === keep ) {
				delete this.registrations[ event ][ listener ];
			}
		}
	}

	setState( event, payload = null ) {
		this.setStateCache[ event ] = payload;
		this.notify( event, payload );
	}

	_dispatchListener( event, listener, payload ) {
		const cb = this.registrations[ event ]?.[ listener ];
		if ( 'function' === typeof cb ) {
			return cb( payload );
		}
		// Node-name mode: forward TM_INFO to named node.
		const target = Core.node( listener );
		if ( ! target ) {
			// Stale listener could fire on every notify — rate-limit.
			Core.printLessOften(
				`WARNING: ${ listener } forgot to unregister from ${ event } on ${ this.name }`
			);
			return false;
		}
		const msg = newMessage();
		msg[ TYPE ] = TM_INFO;
		msg[ FROM ] = this.name;
		msg[ TO ] = listener;
		msg[ KEY ] = event;
		msg[ VALUE ] = payload;
		target.fill( msg );
		return true;
	}
}
