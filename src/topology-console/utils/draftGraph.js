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

// `_repl`: worker's auto-mounted Partition; reserved anchor, never in a .tsl.
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

const edgeKey = ( e ) => `${ e.from } ${ e.to }`;

/**
 * A draft node built from an expand() borrowed-node record.
 *
 * @param {Object} record `topologies expand` node record.
 * @return {Object} Draft node.
 */
function borrowedNode( record ) {
	return {
		id: record.name,
		name: record.name,
		class: record.class,
		x: 0,
		y: 0,
		target: '',
		also: [],
		ctorArgs: record.args || [],
		verbInvocations: [],
		origin: record.origin || [],
		via: record.via || [],
	};
}

const isBorrowedNode = ( n ) =>
	Array.isArray( n.origin ) && n.origin.length > 0;

// Content equality for the draft-dirty compare (draftIsDirty is a JSON diff).
function sameGraphContent( a, b ) {
	return (
		JSON.stringify( a.nodes || [] ) === JSON.stringify( b.nodes || [] ) &&
		JSON.stringify( a.edges || [] ) === JSON.stringify( b.edges || [] )
	);
}

/**
 * Re-apply an include-set change to the draft: add what the new baseline brings,
 * drop what the old one provided and the new one doesn't, leave own edits alone.
 *
 * @param {Object} graph       Current draft.
 * @param {Object} oldBaseline Previous expand() result.
 * @param {Object} newBaseline Current expand() result.
 * @return {Object} New draft graph.
 */
export function reconcileIncludes( graph, oldBaseline, newBaseline ) {
	const oldNodes = new Set(
		( oldBaseline?.nodes || [] ).map( ( n ) => n.name )
	);
	const newByName = new Map(
		( newBaseline?.nodes || [] ).map( ( n ) => [ n.name, n ] )
	);
	const departed = new Set(
		[ ...oldNodes ].filter( ( name ) => ! newByName.has( name ) )
	);

	// Rebuild IN PLACE: re-ordering reads as dirty against the open baseline.
	const nodes = [];
	const placed = new Set();
	for ( const n of graph.nodes || [] ) {
		if ( ! isBorrowedNode( n ) ) {
			nodes.push( n );
			continue;
		}
		const record = newByName.get( n.id );
		if ( record ) {
			nodes.push( borrowedNode( record ) );
			placed.add( n.id );
		}
	}
	for ( const [ name, record ] of newByName ) {
		if ( ! placed.has( name ) ) {
			nodes.push( borrowedNode( record ) );
		}
	}

	const oldEdges = new Set( ( oldBaseline?.edges || [] ).map( edgeKey ) );
	const newEdgeList = newBaseline?.edges || [];
	const newEdges = new Set( newEdgeList.map( edgeKey ) );
	const alive = new Set( nodes.map( ( n ) => n.id ) );
	const kept = ( graph.edges || [] ).filter( ( e ) => {
		const key = edgeKey( e );
		// A baseline edge the departed include provided and the new set lacks.
		if ( oldEdges.has( key ) && ! newEdges.has( key ) ) {
			return false;
		}
		// An own edge left dangling by a departed borrowed node.
		if ( departed.has( e.from ) || departed.has( e.to ) ) {
			return false;
		}
		return alive.has( e.from ) && alive.has( e.to );
	} );
	const keptKeys = new Set( kept.map( edgeKey ) );
	const added = newEdgeList
		.filter(
			( e ) =>
				! oldEdges.has( edgeKey( e ) ) && ! keptKeys.has( edgeKey( e ) )
		)
		.map( ( e ) => ( { from: e.from, to: e.to } ) );

	const next = { ...graph, nodes, edges: [ ...kept, ...added ] };
	// Nothing moved: hand back the SAME graph so the draft stays clean.
	return sameGraphContent( graph, next ) ? graph : next;
}

/**
 * Re-expand `graph.includes` into borrowed nodes/edges on topology open.
 * `graph` is parseTsl's output (own nodes/edges + `disconnects`, the file's
 * `disconnect_node` lines); `baseline` is the include set's `topologies expand`
 * result. Baseline edges get `graph.disconnects` subtracted — that's what makes
 * a splice (a node dropped between two borrowed endpoints) survive a reopen
 * instead of the re-expanded baseline resurrecting the edge the splice removed.
 * Once applied, the draft's edge list is the single source of truth; disconnects
 * are cleared, and `serializeTsl` re-derives them by diffing against `baseline`.
 *
 * @param {Object} graph    parseTsl() output for the collapsed `.tsl` file.
 * @param {Object} baseline `topologies expand( graph.includes )` result.
 * @return {Object} Draft graph with borrowed nodes/edges merged in.
 */
export function applyLoadedBaseline( graph, baseline ) {
	const borrowed = ( baseline?.nodes || [] ).map( borrowedNode );
	const nodes = [ ...( graph.nodes || [] ), ...borrowed ];

	const disconnectKeys = new Set(
		( graph.disconnects || [] ).map( edgeKey )
	);
	// Same alive-filter reconcileIncludes applies, or a fresh open reads dirty.
	const alive = new Set( nodes.map( ( n ) => n.id ) );
	const baselineEdges = ( baseline?.edges || [] )
		.filter(
			( e ) =>
				! disconnectKeys.has( edgeKey( e ) ) &&
				alive.has( e.from ) &&
				alive.has( e.to )
		)
		.map( ( e ) => ( { from: e.from, to: e.to } ) );

	return {
		...graph,
		nodes,
		edges: [ ...( graph.edges || [] ), ...baselineEdges ],
		disconnects: [],
	};
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
