/**
 * Synthesize "virtual" edges from a node's verb args so the layout (and canvas)
 * reflect routing the runtime's `target()` exposes but `parseTsl` doesn't emit.
 *
 * `connect_node` is the only edge-producing line `parseTsl` reads, so a target
 * wired via a config verb (e.g. RequestBuilder's `set_errors_target
 * errors:partition`) never lands in the draft graph's edges — autoLayout would
 * then stack the verb-targeted node at column 0 instead of placing it downstream.
 * For each node, this re-derives an edge per verb arg whose schema `type` is
 * `node_name`, flagged `virtual: true` so the canvas can dim it and skip
 * click-to-delete.
 *
 * Pure: returns the SAME graph reference when there's nothing to add (so React
 * bails on a true no-op), else a new graph with the virtual edges appended.
 *
 * @param {{nodes: Array, edges: Array}}                  graph   The graph to augment.
 * @param {Array<{shell_name: string, commands?: Array}>} classes Catalog class specs.
 * @return {{nodes: Array, edges: Array}} The graph, possibly with virtual edges added.
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
				const targetName = inv.args && inv.args[ i ];
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
	// Spread so non-edge fields (e.g. `pwd`, the reply pivot the Inspector matches)
	// survive the augmentation — only `edges` is replaced.
	return {
		...graph,
		edges: [ ...graph.edges, ...virtualEdges ],
	};
}
