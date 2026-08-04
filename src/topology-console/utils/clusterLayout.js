/**
 * clusterLayout — position one include's nodes as a cohesive cluster.
 *
 * autoLayout over just that include's subgraph, translated so the cluster's
 * top-left corner lands on the drop point. Cross-boundary edges are ignored
 * here; the compound picture is the union of the clusters plus your own nodes.
 *
 * A node already positioned (e.g. diamond-shared with an earlier include) is
 * excluded from the returned map — it keeps the position it already has
 * rather than jumping to wherever this include's own layout would put it.
 */

import { autoLayout } from './autoLayout';

/**
 * Lay out the nodes one include contributed, landing them on the drop point.
 *
 * @param {Array<{name: string, class: string, origin?: string[]}>} nodes      Every expanded node; `origin` lists the includes that contributed it.
 * @param {Array<{from: string, to: string}>}                       edges      Every expanded edge; only those internal to the cluster shape it.
 * @param {string}                                                  origin     Include name whose nodes to lay out.
 * @param {{x: number, y: number}}                                  drop       Canvas point the cluster top-left corner lands on.
 * @param {Object<string, {x: number, y: number}>}                  positioned Already-positioned node ids, keyed by name; each is left where it is.
 * @return {Object<string, {x: number, y: number}>} New positions, keyed by node name. Empty when the include contributed nothing.
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
	/** @type {Object<string, {x: number, y: number}>} */
	const out = {};
	for ( const n of laid.nodes ) {
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
