import { Node } from './node';
import { TO } from './message';
import { Core } from './core';

export class TeeNode extends Node {
	constructor() {
		super();
		this.target = [];
	}

	fill( message ) {
		this.counter += 1;
		const to = message[ TO ];
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
				copy[ TO ] = '' === to ? t : `${ t }/${ to }`;
				this.sink.fill( copy );
			} catch ( e ) {
				this.printLessOften(
					`WARNING: target ${ t } threw: ${ e.message }`
				);
			}
		}
	}

	connectNode( owner ) {
		if ( ! Array.isArray( this.target ) ) {
			this.target = '' === this.target ? [] : [ this.target ];
		}
		if ( ! this.target.includes( owner ) ) {
			this.target.push( owner );
		}
	}

	disconnectNode( target = '' ) {
		if ( ! Array.isArray( this.target ) ) {
			this.target = [];
			return;
		}
		this.target = this.target.filter( ( t ) => t !== target );
	}

	static nodeSchema() {
		return {
			category: 'Routing',
			description:
				'Fan-out: copies each message to multiple targets via Router.',
			arguments: [],
			commands: [],
			accepts_fill: true,
			has_target: true,
		};
	}
}
