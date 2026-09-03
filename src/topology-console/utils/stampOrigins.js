/**
 * stampOrigins — mark each canvas node with the includes that provide it.
 *
 * Provenance lives in the TSL, not in the runtime: the nodes a `dump_metadata`
 * poll returns carry no `origin` of their own, so live mode has nothing to read
 * it off. Taking it from the expand baseline instead — the same membership map
 * the hulls are drawn from — holds the mark steady across polls and leaves the
 * mark and the hulls unable to disagree about who provides a node.
 *
 * A non-empty `origin` is what makes a node borrowed, and three surfaces act on
 * it: SchematicCanvas draws the lock, GraphView refuses the delete key, and the
 * Inspector renders the read-only form.
 */

/**
 * Stamps `origin` onto every node an include provides.
 *
 * Stamped nodes are copies. The baseline graph is memoized upstream and read by
 * the hull membership too, so a mutation would outlive this render: a node an
 * include no longer provides would keep the stale `origin` and stay locked. A
 * node in no include keeps its identity, and an empty membership returns the
 * graph itself, so the memo downstream skips its work.
 *
 * A node several includes provide carries every one of them, in membership
 * order. Cluster drag and cluster layout both select on that list, so such a
 * node moves with either include.
 *
 * @param {Object}                  graph      The canvas graph, `{ nodes, edges }`.
 * @param {Object<string,string[]>} membership Member node ids keyed by include
 *                                             name, from the expand baseline.
 * @return {Object} The graph, its member nodes carrying `origin`.
 */
export function stampOrigins( graph, membership ) {
	const origins = new Map();
	for ( const [ include, ids ] of Object.entries( membership || {} ) ) {
		for ( const id of ids || [] ) {
			origins.set( id, [ ...( origins.get( id ) || [] ), include ] );
		}
	}
	if ( ! origins.size ) {
		return graph;
	}
	return {
		...graph,
		nodes: ( graph.nodes || [] ).map( ( n ) =>
			origins.has( n.id ) ? { ...n, origin: origins.get( n.id ) } : n
		),
	};
}
