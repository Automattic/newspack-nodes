/**
 * clusterLayout — position one include's nodes as a cohesive cluster.
 *
 * Dropping a topology onto the canvas runs `include <name>`, and the nodes it
 * contributes arrive with no positions. This lays out that include's subgraph
 * alone and translates the result onto the drop point. Running `autoLayout`
 * over the whole document instead would re-flow every node the operator has
 * already placed. Edges crossing the include boundary shape nothing here; the
 * compound picture is the union of the clusters plus the document's own nodes.
 *
 * A node that already carries a position — diamond-shared with an earlier
 * include — keeps the one it has rather than jumping to wherever this
 * include's own layout would put it, so it is left out of the returned map.
 */

import { autoLayout } from './autoLayout';

/**
 * Lay out the nodes one include contributed, landing them on the drop point.
 *
 * Nothing snaps here. The caller hands in a drop point already on the grid,
 * and every offset added to it is a multiple of `X_STEP` in x and of half a
 * `Y_STEP` in y — the lattice `snapPosition` quantises to — so the whole
 * cluster lands on that lattice with the drop point as its top-left corner.
 *
 * @param {Array<{name: string, class: string, origin?: string[]}>} nodes        Every expanded node; `origin` lists the includes that contributed it.
 * @param {?Array<{from: string, to: string}>}                      edges        Every expanded edge; only those internal to the cluster shape it.
 * @param {string}                                                  origin       Name of the include whose nodes to lay out.
 * @param {{x: number, y: number}}                                  drop         Grid-snapped canvas point the cluster's top-left corner lands on.
 * @param {Object<string,{x: number, y: number}>}                   [positioned] Nodes that already hold a position, keyed by name; only its keys are read.
 * @return {Object<string,{x: number, y: number}>} New positions, keyed by node name. Empty when the include contributed no nodes, or when every node it contributed already holds a position.
 */
export function clusterLayout( nodes, edges, origin, drop, positioned = {} ) {
	const mine = nodes.filter( ( n ) => ( n.origin || [] ).includes( origin ) );
	const ids = new Set( mine.map( ( n ) => n.name ) );
	const sub = {
		nodes: mine.map( ( n ) => ( { id: n.name, class: n.class } ) ),
		edges: ( edges || [] ).filter(
			( e ) => ids.has( e.from ) && ids.has( e.to )
		),
	};
	const laid = autoLayout( sub );
	if ( ! laid.nodes.length ) {
		return {};
	}
	const minX = Math.min( ...laid.nodes.map( ( n ) => n.position.x ) );
	const minY = Math.min( ...laid.nodes.map( ( n ) => n.position.y ) );
	/** @type {Object<string,{x: number, y: number}>} */
	const out = {};
	for ( const n of laid.nodes ) {
		// Own-key test; a bare lookup reads `constructor` as positioned.
		if ( Object.prototype.hasOwnProperty.call( positioned, n.id ) ) {
			continue;
		}
		out[ n.id ] = {
			x: n.position.x - minX + drop.x,
			y: n.position.y - minY + drop.y,
		};
	}
	return out;
}
