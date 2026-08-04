import { TeeNode } from './tee-node';
import { TO } from './message';

/**
 * Tap: Tee with hard targets and passthrough.
 *
 * Each target receives a copy addressed straight to it — the target path alone,
 * with none of the incoming TO appended, which is what "hard" means and what
 * separates a Tap from a Tee. The original message then continues to the sink
 * untouched, so a Tap can be spliced into a pipeline without diverting it.
 */
export class TapNode extends TeeNode {
	/**
	 * Copy the message to every live target, then pass the original downstream.
	 *
	 * Targets whose head node has left this registry are pruned first, and a
	 * target that throws is logged rather than allowed to cancel the rest of the
	 * fan-out or the passthrough.
	 *
	 * @param {Array} message 7-field positional message, forwarded unchanged;
	 *                        only the per-target copies get their TO rewritten.
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
