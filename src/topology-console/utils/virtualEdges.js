/**
 * One class-catalog entry, as far as this pass reads it: the verbs the class
 * declares, and the type of each verb argument. `node_name` is the type that
 * makes an argument a destination.
 *
 * @typedef {Object} CatalogClass
 * @property {string}                                               shell_name The class name a node's `class` matches.
 * @property {Array<{name: string, args?: Array<{type?: string}>}>} [commands] Verb specs; a class declaring none contributes no edge.
 */

/**
 * Synthesize "virtual" edges from a node's verb arguments, so the layout and
 * the canvas draw destinations a document never spells out as edges.
 *
 * `connect_node` is the only edge-producing line a document has, so a target
 * wired through a config verb — Request_Builder's `set_errors_target
 * errors:partition` — reaches the draft graph as an invocation and never as an
 * edge. The runtime has no such gap: the node declares that destination through
 * `extra_targets()`, and `dump_metadata` ships it in the `targets` display
 * union live mode draws from
 * ([ADR-19](../../../docs/architecture-decisions.md)). Underived, the
 * verb-targeted node has no inbound edge at all, so `autoLayout` reads it as a
 * source and pins it to column 0 instead of placing it downstream of its
 * producer.
 *
 * Each verb argument whose class-schema `type` is `node_name` yields one edge,
 * flagged `virtual: true`: the canvas dims it and refuses click-to-delete,
 * because the `disconnect_node` a deletion issues would not remove the verb
 * line that named the target.
 *
 * A `<ns:key>` argument names nothing client-side — only the server resolves a
 * config token — so it is looked up in `resolvedConfigEdges` by this node and
 * this verb slot. A token the server resolved to nothing draws no edge, which
 * is how a cleared config target reads as cleared rather than as an edge to the
 * literal token text.
 *
 * Pure: returns the SAME graph reference when there is nothing to add, so React
 * bails on a true no-op, and otherwise a new graph with the virtual edges
 * appended.
 *
 * @param {{nodes: Array, edges: Array, resolvedConfigEdges?: ?Array}} graph   The graph to augment; `resolvedConfigEdges` is the server's answer for `<ns:key>` config targets, and is absent or null when the document carries no token to resolve.
 * @param {Array<CatalogClass>}                                        classes Class catalog, the source of each verb's declared argument types.
 * @return {{nodes: Array, edges: Array, resolvedConfigEdges?: ?Array}} The graph, with any virtual edges appended.
 */
export function augmentWithVirtualEdges( graph, classes ) {
	const classByName = new Map();
	for ( const c of classes || [] ) {
		classByName.set( c.shell_name, c );
	}
	const virtualEdges = [];
	for ( const node of graph.nodes ) {
		const schema = classByName.get( node.class );
		if ( ! schema || ! schema.commands ) {
			continue;
		}
		for ( const inv of node.verbInvocations || [] ) {
			const cspec = schema.commands.find( ( v ) => v.name === inv.verb );
			if ( ! cspec || ! cspec.args ) {
				continue;
			}
			cspec.args.forEach( ( argSpec, i ) => {
				if ( argSpec.type !== 'node_name' ) {
					return;
				}
				let targetName = inv.args && inv.args[ i ];
				if ( /^<[a-zA-Z_]\w*:[a-zA-Z_]\w*>$/.test( targetName ) ) {
					const resolved = ( graph.resolvedConfigEdges || [] ).find(
						( edge ) =>
							edge.from === node.id &&
							( edge.config_slots || [] ).includes( inv.verb )
					);
					targetName = resolved?.to || '';
				}
				if ( ! targetName ) {
					return;
				}
				virtualEdges.push( {
					from: node.id,
					to: targetName,
					virtual: true,
				} );
			} );
		}
	}
	if ( ! virtualEdges.length ) {
		return graph;
	}
	// Spread so non-edge fields (e.g. `pwd`) survive; only `edges` is replaced.
	return {
		...graph,
		edges: [ ...graph.edges, ...virtualEdges ],
	};
}
