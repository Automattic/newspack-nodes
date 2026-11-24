import { MetadataNode } from '../../runtime/metadata-node';
import names from '../../runtime/reserved-node-names.json';

/**
 * The force canvas's poller: `dump_metadata -s`, the whole graph and the row
 * of every sidecar at any depth. It shows the interpreter, which nearly every
 * node sinks into and the canvas's own `_metadata` hides, so only a canvas
 * drawing sinks has it to draw.
 */
export class ForceRowsNode extends MetadataNode {
	/**
	 * How many nodes of a graph the poll is paced on: those the canvas's own
	 * poll counts, so the two keep one interval.
	 *
	 * @param {import('../../runtime/metadata-node').MetadataGraph} graph The parsed graph.
	 * @return {number} Those neither a sidecar nor hidden on the canvas.
	 */
	sizeOf( { nodes } ) {
		const sidecars = new Set(
			nodes.flatMap( ( node ) =>
				( node.sidecars ?? [] ).map( ( { name } ) => name )
			)
		);
		return nodes.filter(
			( { id } ) =>
				! sidecars.has( id ) &&
				! MetadataNode.prototype.hidden.has( id )
		).length;
	}
}

/** @type {Set<string>} */
ForceRowsNode.prototype.hidden = new Set( [ names.ROUTER ] );
