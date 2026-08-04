/**
 * hullNodes — the graph nodes a hull encloses, i.e. the ones its include provides.
 *
 * This is what scopes a hull's stats: feed the result to processStats and the
 * source/sink roll-up counts the boundary's own traffic, not the whole graph's.
 */

// One frozen empty array so a no-selection scope keeps a stable hook identity.
const NONE = /** @type {Array} */ ( Object.freeze( [] ) );

/**
 * @param {Array}       nodes   Graph nodes (`parsed.nodes`).
 * @param {Array}       hulls   Hulls, each `{ include, nodeIds }`.
 * @param {string|null} include Selected topology, or null.
 * @return {Array} The member nodes; empty (same identity) when nothing is
 *                 scoped. Read it, don't mutate it: the empty case is one
 *                 shared frozen array, so a caller that pushes into it throws.
 */
export function hullNodes( nodes, hulls, include ) {
	const hull = ( hulls || [] ).find( ( h ) => h.include === include );
	if ( ! hull ) {
		return NONE;
	}
	const members = new Set( hull.nodeIds || [] );
	return ( nodes || [] ).filter( ( n ) => members.has( n.id ) );
}
