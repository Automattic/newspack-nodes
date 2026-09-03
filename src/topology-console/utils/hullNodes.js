/**
 * hullNodes — the graph nodes a hull encloses, the ones its include provides.
 *
 * This is what scopes a hull's statistics. Feed the result to `processStats`
 * for the header totals and to `aggregateSeries` for the sparklines, and both
 * count the boundary's own traffic rather than the whole graph's. One member
 * selector serves both, so the totals and the sparklines cannot disagree about
 * what the hull contains.
 */

/**
 * The empty scope: one shared frozen array.
 *
 * Both empty cases — no selection, and an include with no hull on the canvas —
 * return this same array, so the `useMemo` scoping the rate series sees a
 * stable identity and stops re-deriving sparklines on every poll. It is frozen
 * because a caller that pushed into a shared empty would corrupt every other
 * empty scope; a throw at the push is the cheaper failure.
 */
const NONE = /** @type {Array} */ ( Object.freeze( [] ) );

/**
 * Picks the member nodes of the hull standing for `include`.
 *
 * Members come back in graph order, not `nodeIds` order, because the caller
 * renders them beside the rest of the graph.
 *
 * @param {Array}       nodes   Graph nodes (`parsed.nodes`), each carrying an `id`.
 * @param {Array}       hulls   Hulls, each `{ include, nodeIds }`.
 * @param {string|null} include Selected topology, or null when nothing is selected.
 * @return {Array} The member nodes. An unselected include, or one with no hull
 *                 drawn, yields the shared frozen empty array: read it, don't
 *                 mutate it, because a caller that pushes into it throws.
 */
export function hullNodes( nodes, hulls, include ) {
	const hull = ( hulls || [] ).find( ( h ) => h.include === include );
	if ( ! hull ) {
		return NONE;
	}
	const members = new Set( hull.nodeIds || [] );
	return ( nodes || [] ).filter( ( n ) => members.has( n.id ) );
}
