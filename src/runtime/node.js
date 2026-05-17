import { Core } from './core';
import { FROM, TO, valueSize } from './message';

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
}
