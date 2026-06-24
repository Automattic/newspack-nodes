import { TeeNode } from './tee-node';
import { TO } from './message';
import { Core } from './core';

export class TapNode extends TeeNode {
	fill( message ) {
		this.counter += 1;
		const targets = Array.isArray( this.target ) ? this.target : [];
		// Prune targets whose HEAD node is dead; a live head means the sink can route it.
		const alive = targets.filter(
			( t ) => null !== Core.node( t.split( '/' )[ 0 ] )
		);
		this.target = alive;
		for ( const t of alive ) {
			if ( ! this.sink ) {
				throw new Error( 'fill requires a wired sink' );
			}
			try {
				const copy = message.slice();
				copy[ TO ] = t;
				this.sink.fill( copy );
			} catch ( e ) {
				this.printLessOften(
					`WARNING: target ${ t } threw: ${ e.message }`
				);
			}
		}
		this.sink.fill( message );
	}
}
