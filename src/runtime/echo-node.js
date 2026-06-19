import { Node } from './node';
import { TYPE, FROM, TO, TM_ERROR } from './message';

export class EchoNode extends Node {
	fill( message ) {
		const to = message[ TO ];
		// Symlink (this.target/to) + loopback (TO=FROM); only a pathless pure
		// TM_ERROR is dropped (Tachikoma Echo.pm).
		if ( message[ TYPE ] === TM_ERROR && '' === to ) {
			return;
		}
		if (
			'string' === typeof this.target &&
			'' !== this.target &&
			'' !== to
		) {
			message[ TO ] = `${ this.target }/${ to }`;
		} else if (
			( 'string' !== typeof this.target || '' === this.target ) &&
			'' === to
		) {
			message[ TO ] = message[ FROM ];
		}
		super.fill( message );
	}

	static nodeSchema() {
		return {
			category: 'Routing',
			description: 'Bounces messages back to their FROM path.',
			arguments: [],
			commands: [],
		};
	}
}
