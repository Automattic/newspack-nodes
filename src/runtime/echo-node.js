import { Node } from './node';
import { TYPE, FROM, TO, TM_ERROR } from './message';

/**
 * EchoNode re-addresses a message and transforms nothing else, so a graph
 * re-routes traffic by splicing a node in rather than by rewiring sinks
 * (ADR-7). Mirror of PHP `Echo_Node`, ported from Tachikoma's `Nodes::Echo`.
 *
 * `target` and the incoming TO pick one of four cases. A target plus a TO
 * prefixes the path (`target/TO`), and because Router peels only the head
 * segment the original address still routes onward behind it. No target and no
 * TO returns the message to its sender (TO=FROM), which is what makes a bare
 * Echo a ping responder. The other two fall through to `Node.fill`: a TO with
 * no target passes through untouched, and a target with an empty TO takes the
 * base stamp, so the message goes to the target rather than back to FROM.
 *
 * A TM_ERROR with an empty TO is dropped instead of bounced. Returning it would
 * land an error trail on a producer that never asked for one.
 */
export class EchoNode extends Node {
	/**
	 * Re-address the message, then forward it to the sink unchanged.
	 *
	 * The TM_ERROR test is bitwise rather than the equality `Echo.pm` uses: the
	 * command interpreter mints its refusals as `TM_COMMAND|TM_ERROR`, and an
	 * exact match would let the substrate's commonest error shape bounce.
	 *
	 * A non-string target is Tee's fan-out list, which composes no path, so Echo
	 * reads it as no target and an empty TO still returns to sender.
	 *
	 * @param {Array} message The 7-field positional message; TO is rewritten in place.
	 */
	fill( message ) {
		const to = message[ TO ];
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
	 * Declare the console-palette entry: a routing primitive that takes no
	 * positional arguments and answers no verbs.
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
