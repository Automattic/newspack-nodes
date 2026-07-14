/**
 * stampOrigins — give every node the includes that provide it.
 *
 * A node's provenance lives in the tsl, not in the runtime: dump_metadata nodes
 * carry no `origin` of their own. Reading it off the node therefore works only
 * until the first poll, which is why the borrowed-node lock used to appear on
 * entry and vanish a second later. Provenance comes from the expand baseline —
 * the same membership map the hulls are drawn from — so the two can't disagree.
 */

/**
 * @param {Object} graph      { nodes, edges }.
 * @param {Object} membership include => [nodeId, …], from the expand baseline.
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
