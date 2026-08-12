import { Node } from './node';
import { TYPE, FROM, TO, TM_ERROR } from './message';

/**
 * EchoNode — re-addresses a message instead of transforming it.
 *
 * Three cases, decided by `target` and the incoming TO: a target plus a TO
 * prefixes the path (`target/TO`, the symlink case); no target and no TO
 * bounces the message back to its sender (TO=FROM, the loopback case);
 * anything else passes through untouched. A TM_ERROR with no TO is dropped
 * rather than bounced, so an error trail never lands on a producer that is not
 * expecting one.
 */
export class EchoNode extends Node {
	/**
	 * Re-address the message per the rules above, then forward to the sink.
	 *
	 * @param {Array} message The 7-field positional message; TO is rewritten in place.
	 */
	fill( message ) {
		const to = message[ TO ];
		// Symlink (target/to) + loopback (TO=FROM); pathless TM_ERROR dropped.
		if ( message[ TYPE ] & TM_ERROR && '' === to ) {
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

	/**
	 * Console-palette entry. Routing node with no positional configuration.
	 *
	 * @return {Object} The node schema.
	 */
	static nodeSchema() {
		return {
			category: 'Routing',
			description: 'Bounces messages back to their FROM path.',
			arguments: [],
			commands: [],
		};
	}
}
