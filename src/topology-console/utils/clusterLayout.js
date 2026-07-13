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
 *
 * @param {Object} positioned Already-positioned ids (e.g. positionOverrides).
 */

import { autoLayout } from './autoLayout';

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
