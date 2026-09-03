import { TeeNode } from './tee-node';
import { TO } from './message';

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
 * The backbone mounts one, `_shell`: every command a session sends reaches the
 * interpreter through it, so the console can watch its own traffic.
 */
export class TapNode extends TeeNode {
	/**
	 * Copy the message to every live target, then pass the original downstream.
	 *
	 * It drops any target whose head node has left this registry, and logs a
	 * target that throws rather than letting one broken branch cancel the rest of
	 * the fan-out or the passthrough.
	 *
	 * @param {Array} message 7-field positional message, forwarded unchanged;
	 *                        only the per-target copies get their TO rewritten.
	 * @throws {Error} When no sink is wired.
	 */
	fill( message ) {
		this.counter++;
		const targets = Array.isArray( this.target ) ? this.target : [];
		// Prune dead heads in THIS registry, or a draft loses every edge.
		const alive = targets.filter(
			( t ) => null !== this.registry.node( t.split( '/' )[ 0 ] )
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
