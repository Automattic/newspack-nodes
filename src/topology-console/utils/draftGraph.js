/**
 * draftGraph — pure helpers for the edit-mode draft topology.
 *
 * Graph shape mirrors parseMetadata's output. Every helper returns a NEW
 * graph reference (never mutates) so React bails out only on true no-ops.
 */

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

export function addEdge( graph, { from, to } ) {
	if ( from === to ) {
		return graph;
	}
	const exists = graph.edges.some( ( e ) => e.from === from && e.to === to );
	if ( exists ) {
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
	return { ...graph, nodes, edges: [ ...graph.edges, { from, to } ] };
}

// `_repl` is the worker's auto-mounted Partition — `log`/`tell` broadcast
// handle. Not part of any topology .tsl, but the editor anchors it on the
// canvas so the user can draw edges TO it. Reserved → no rename/no delete
// (the refusal lives in renameNode/removeNode here, and `serializeTsl`
// already skips reserved nodes so it never round-trips into the .tsl).
const REPL_ANCHOR = {
	id: '_repl',
	name: '_repl',
	class: 'Partition',
	reserved: true,
};
export function withReplAnchor( graph ) {
	if ( graph.nodes.some( ( n ) => n.id === '_repl' ) ) {
		return graph;
	}
	return { ...graph, nodes: [ ...graph.nodes, REPL_ANCHOR ] };
}

export function removeNode( graph, id ) {
	const target = graph.nodes.find( ( n ) => n.id === id );
	if ( target && target.reserved ) {
		return graph;
	}
	const nodes = graph.nodes.filter( ( n ) => n.id !== id );
	const edges = graph.edges.filter( ( e ) => e.from !== id && e.to !== id );
	return { ...graph, nodes, edges };
}

/**
 * Rename a node + rewrite edges referencing the old id (no-op on empty,
 * unchanged, or taken name). Does NOT rewrite verb-arg refs — caller does.
 *
 * @param {Object} graph   Current graph.
 * @param {string} oldId   Existing node id.
 * @param {string} newName Desired new name.
 * @return {Object} New graph reference, or the original on a no-op.
 */
export function renameNode( graph, oldId, newName ) {
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
	return { ...graph, nodes, edges };
}

export function removeEdge( graph, fromId, toId ) {
	const edges = graph.edges.filter(
		( e ) => ! ( e.from === fromId && e.to === toId )
	);
	return { ...graph, edges };
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

/**
 * True when the draft has diverged from the edit-entry snapshot.
 *
 * @param {Object} draft    Current draft graph.
 * @param {Object} baseline Snapshot taken when edit mode was entered.
 * @return {boolean} True if draft has diverged.
 */
export function draftIsDirty( draft, baseline ) {
	return JSON.stringify( draft ) !== JSON.stringify( baseline );
}

/**
 * Produce a unique name for a new `shellName` instance (`echo`, `echo-2`, …).
 *
 * @param {Object} graph     Graph to search for collisions.
 * @param {string} shellName Class name (e.g. 'Echo').
 * @return {string} Unique node name.
 */
export function generateNodeName( graph, shellName ) {
	const base = shellName.toLowerCase();
	const taken = new Set( graph.nodes.map( ( n ) => n.id ) );
	if ( ! taken.has( base ) ) {
		return base;
	}
	let i = 2;
	while ( taken.has( `${ base }-${ i }` ) ) {
		i++;
	}
	return `${ base }-${ i }`;
}
