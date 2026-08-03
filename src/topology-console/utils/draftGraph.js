/**
 * draftGraph — the draft document's mutation operations.
 *
 * What remains after `consoleGraph.js` took the graph shaping every mode uses.
 * Every function here is `( graph, args ) => newGraph`, and every one has a TSL
 * verb: this is the half a draft interpreter replaces wholesale.
 */

import { edgeHasConnectRole, nodeUsesTeeSemantics } from './consoleGraph';

export function addNode( graph, { shellName, name, x, y } ) {
	const node = {
		id: name,
		name,
		class: shellName,
		x,
		y,
		target: '',
		also: [],
		ctorArgs: [],
		verbInvocations: [],
	};
	return { ...graph, nodes: [ ...graph.nodes, node ] };
}

function addEdge( graph, { from, to } ) {
	if ( from === to ) {
		return graph;
	}
	const existingIndex = graph.edges.findIndex(
		( edge ) => edge.from === from && edge.to === to
	);
	if (
		existingIndex >= 0 &&
		edgeHasConnectRole( graph.edges[ existingIndex ] )
	) {
		return graph;
	}
	// Mirror the edge onto the source node's target/also routing fields.
	const nodes = graph.nodes.map( ( n ) =>
		n.id === from
			? {
					...n,
					target: n.target ? n.target : to,
					also:
						n.target && n.target !== to
							? [ ...( n.also || [] ), to ]
							: n.also || [],
			  }
			: n
	);
	if ( existingIndex >= 0 ) {
		const edges = graph.edges.slice();
		const existing = edges[ existingIndex ];
		edges[ existingIndex ] = {
			...existing,
			roles: [ ...existing.roles, 'connect' ],
		};
		return { ...graph, nodes, edges };
	}
	return { ...graph, nodes, edges: [ ...graph.edges, { from, to } ] };
}

export function removeNode( graph, id ) {
	const target = graph.nodes.find( ( n ) => n.id === id );
	if ( target && target.reserved ) {
		return graph;
	}
	const nodes = graph.nodes.filter( ( n ) => n.id !== id );
	const edges = graph.edges.filter( ( e ) => e.from !== id && e.to !== id );
	const configOverrides = Array.isArray( graph.configOverrides )
		? graph.configOverrides
				.filter( ( override ) => override.from !== id )
				.map( ( override ) =>
					override.to === id ? { ...override, to: '' } : override
				)
		: null;
	return {
		...graph,
		nodes,
		edges,
		...( configOverrides ? { configOverrides } : {} ),
	};
}

/**
 * Declare an include; a duplicate is a no-op (the loader's `#pragma once`).
 *
 * @param {Object} graph Current graph.
 * @param {string} name  Topology name to include.
 * @return {Object} New graph reference, or the original on a no-op.
 */
export function addInclude( graph, name ) {
	const includes = graph.includes || [];
	if ( includes.includes( name ) ) {
		return graph;
	}
	return { ...graph, includes: [ ...includes, name ] };
}

/**
 * @param {Object} graph Current graph.
 * @param {string} name  Topology name to drop.
 * @return {Object} New graph reference, or the original on a no-op.
 */
export function removeInclude( graph, name ) {
	const includes = graph.includes || [];
	if ( ! includes.includes( name ) ) {
		return graph;
	}
	return { ...graph, includes: includes.filter( ( n ) => n !== name ) };
}

/**
 * The `move_node` verb: rename a node + rewrite edges referencing the old id
 * (no-op on empty, unchanged, or taken name). Does NOT rewrite verb-arg refs
 * — the caller does, since that needs the class catalog.
 *
 * @param {Object} graph   Current graph.
 * @param {string} oldId   Existing node id.
 * @param {string} newName Desired new name.
 * @return {Object} New graph reference, or the original on a no-op.
 */
export function moveNode( graph, oldId, newName ) {
	const target = graph.nodes.find( ( n ) => n.id === oldId );
	if ( target && target.reserved ) {
		return graph;
	}
	const trimmed = String( newName || '' ).trim();
	if ( ! trimmed || trimmed === oldId ) {
		return graph;
	}
	const taken = graph.nodes.some( ( n ) => n.id === trimmed );
	if ( taken ) {
		return graph;
	}
	const nodes = graph.nodes.map( ( n ) =>
		n.id === oldId ? { ...n, id: trimmed, name: trimmed } : n
	);
	const edges = graph.edges.map( ( e ) => {
		if ( e.from !== oldId && e.to !== oldId ) {
			return e;
		}
		return {
			...e,
			from: e.from === oldId ? trimmed : e.from,
			to: e.to === oldId ? trimmed : e.to,
		};
	} );
	const configOverrides = Array.isArray( graph.configOverrides )
		? graph.configOverrides.map( ( override ) => ( {
				...override,
				from: override.from === oldId ? trimmed : override.from,
				to: override.to === oldId ? trimmed : override.to,
		  } ) )
		: null;
	return {
		...graph,
		nodes,
		edges,
		...( configOverrides ? { configOverrides } : {} ),
	};
}

export function removeEdge( graph, fromId, toId ) {
	const index = graph.edges.findIndex(
		( edge ) =>
			edge.from === fromId &&
			edge.to === toId &&
			edgeHasConnectRole( edge )
	);
	if ( index < 0 ) {
		return graph;
	}
	const edge = graph.edges[ index ];
	const roles = Array.isArray( edge.roles )
		? edge.roles.filter( ( role ) => 'connect' !== role )
		: [];
	const edges = graph.edges.slice();
	if ( roles.length > 0 ) {
		edges[ index ] = { ...edge, roles };
	} else {
		edges.splice( index, 1 );
	}
	return { ...graph, edges };
}

export function connectDraftEdge( graph, from, to, catalog = [] ) {
	const source = graph.nodes.find( ( node ) => node.id === from );
	let next = graph;
	if ( source && ! nodeUsesTeeSemantics( source, catalog ) ) {
		for ( const edge of graph.edges ) {
			if ( edge.from === from && edgeHasConnectRole( edge ) ) {
				next = removeEdge( next, edge.from, edge.to );
			}
		}
	}
	return addEdge( next, { from, to } );
}

export function updateNodeArgs( graph, id, ctorArgs ) {
	const nodes = graph.nodes.map( ( n ) =>
		n.id === id ? { ...n, ctorArgs: ctorArgs.slice() } : n
	);
	return { ...graph, nodes };
}

export function updateNodeVerbs( graph, id, verbInvocations ) {
	const nodes = graph.nodes.map( ( n ) =>
		n.id === id ? { ...n, verbInvocations: verbInvocations.slice() } : n
	);
	return { ...graph, nodes };
}
