import { TeeNode } from './tee-node';
import { TO } from './message';
import { attemptEach, raise } from './failures';

/**
 * Tap: Tee with hard targets and passthrough.
 *
 * Each target receives a copy addressed straight at it — the target path alone,
 * with none of the incoming TO appended. That is what "hard" means, and it is
 * the whole difference from Tee, which prepends the remainder so Router keeps
 * routing past the hop; a tap is the end of its own branch. The original then
 * continues down `sink` addressed as it arrived, so a Tap splices into a live
 * pipeline without diverting it, and every tap is served before that
 * passthrough runs.
 *
 * The backbone mounts one, `_shell`: every command an interactive session
 * sends reaches the interpreter through it, so the console can watch its own
 * traffic. A dashboard's commands pass `<group>:shell` instead, one Tap per
 * group, which `mountExospine` raises for every mount whose nodes target it.
 */
export class TapNode extends TeeNode {
	/**
	 * Copy the message to every live target, then pass the original downstream.
	 *
	 * Every target is attempted, and the passthrough after them, whatever an
	 * earlier one threw; everything caught — the passthrough's failure included —
	 * is raised after the last, as the PHP twin raises it.
	 *
	 * @param {Array} message 7-field positional message, forwarded unchanged;
	 *                        only the per-target copies get their TO rewritten.
	 * @throws {Error} When no sink is wired, or what the fan-out threw.
	 */
	fill( message ) {
		this.counter++;
		const alive = this.liveTargets();
		if ( ! this.sink ) {
			throw new Error( 'fill requires a wired sink' );
		}
		const caught = attemptEach( alive, ( t ) => {
			const copy = message.slice();
			copy[ TO ] = t;
			this.sink.fill( copy );
		} );
		try {
			this.sink.fill( message );
		} catch ( e ) {
			caught.push( e );
		}
		raise( caught );
	}
}
