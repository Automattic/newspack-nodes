import { Node } from './node';
import { TO, valueSize } from './message';

export class Tee extends Node {
	constructor() {
		super();
		// Array target (not string) so the parent's fill() skips stamping and
		// this subclass owns the fan-out below.
		this.target = [];
	}

	connectNode( owner ) {
		if ( ! Array.isArray( this.target ) ) {
			// Coerce a stray string target into an array without dropping it.
			this.target = '' === this.target ? [] : [ this.target ];
		}
		// Idempotent (matches PHP Tee::connect_node) so fanout doesn't dup.
		if ( this.target.includes( owner ) ) {
			return;
		}
		this.target.push( owner );
	}

	// Remove the matching target from the fan-out array — a value-filter, NOT a
	// clear-all (matches PHP Tee::disconnect_node). The disconnect_node verb
	// resolves a bare target to the issuing FROM before calling, so '' never
	// reaches here in practice (and filtering '' is a harmless no-op anyway).
	disconnectNode( target = '' ) {
		if ( ! Array.isArray( this.target ) ) {
			this.target = [];
			return;
		}
		this.target = this.target.filter( ( t ) => t !== target );
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
			// Per-target copy so stamping TO doesn't leak to caller or peers.
			const copy = message.slice();
			copy[ TO ] = owner;
			if ( this.sink ) {
				this.sink.fill( copy );
			}
		}
	}
}
