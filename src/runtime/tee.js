import { Node } from './node';
import { TO, valueSize } from './message';

export class Tee extends Node {
	constructor() {
		super();
		// Tee overrides the parent's default target='' with an array. The
		// parent's fill() has a `typeof this.target === 'string'` guard that
		// keeps it from stamping TO when target is an array, which is what
		// lets this subclass own the fan-out stamping below.
		this.target = [];
	}

	connectNode( owner ) {
		if ( ! Array.isArray( this.target ) ) {
			// Legacy/parent default of '' becomes []. A non-empty string would
			// only show up if something mutated target directly after
			// construction; wrap it into a single-element array so we don't
			// silently drop the prior target.
			this.target = '' === this.target ? [] : [ this.target ];
		}
		this.target.push( owner );
	}

	fill( message ) {
		this.counter += 1;
		const size = valueSize( message );
		if ( size > this.largestMsgSent ) {
			this.largestMsgSent = size;
		}

		if ( ! Array.isArray( this.target ) || 0 === this.target.length ) {
			return;
		}
		for ( const owner of this.target ) {
			// Per-target shallow copy: stamping TO mutates this owner's copy
			// without leaking back to the caller's message or to peer targets.
			const copy = message.slice();
			copy[ TO ] = owner;
			if ( this.sink ) {
				this.sink.fill( copy );
			}
		}
	}
}
