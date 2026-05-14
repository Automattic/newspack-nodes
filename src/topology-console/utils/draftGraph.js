/**
 * draftGraph — pure helpers for the edit-mode draft topology.
 *
 * Graph shape mirrors `parseMetadata`'s output (so SchematicCanvas can
 * render either a parsed live graph or a draft without branching):
 *   {
 *     nodes: [
 *       {
 *         id, name, class,         // identity
 *         x, y,                    // canvas position
 *         target, also,            // parsed-style routing fields
 *         ctorArgs: [],            // edit-mode authoring fields
 *         verbInvocations: []
 *       }, ...
 *     ],
 *     edges: [ { from, to }, ... ]
 *   }
 *
 * Every helper returns a NEW graph reference (never mutates the input)
 * so React's setDraft( ( g ) => addNode( g, … ) ) bails out of an
 * update only when the operation is a true no-op.
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
	return { nodes: [ ...graph.nodes, node ], edges: graph.edges };
}

export function addEdge( graph, { from, to } ) {
	if ( from === to ) {
		return graph;
	}
	const exists = graph.edges.some( ( e ) => e.from === from && e.to === to );
	if ( exists ) {
		return graph;
	}
	// Mirror the connect_node side effect on the source node so a
	// downstream serializer (Task 9) can emit a single connect_node
	// per edge rather than walking node.target/also separately.
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
	return { nodes, edges: [ ...graph.edges, { from, to } ] };
}

export function removeNode( graph, id ) {
	const nodes = graph.nodes.filter( ( n ) => n.id !== id );
	const edges = graph.edges.filter( ( e ) => e.from !== id && e.to !== id );
	return { nodes, edges };
}

/**
 * Rename a node — updates the node's id + name and rewrites every
 * edge that referenced the old id. Returns the original graph
 * unchanged if `newName` is empty, equal to the existing name, or
 * already taken by another node (caller is responsible for surfacing
 * the rejection).
 *
 * Does NOT rewrite verb-arg references (those live on OTHER nodes
 * and require the schema to know which args are node_name typed) —
 * the caller (TopologyConsole) handles that with catalog access.
 *
 * @param {Object} graph   Current graph.
 * @param {string} oldId   Existing node id.
 * @param {string} newName Desired new name.
 * @return {Object} New graph reference, or the original on a no-op.
 */
export function renameNode( graph, oldId, newName ) {
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
	return { nodes, edges };
}

export function removeEdge( graph, fromId, toId ) {
	const edges = graph.edges.filter(
		( e ) => ! ( e.from === fromId && e.to === toId )
	);
	return { nodes: graph.nodes, edges };
}

export function updateNodeArgs( graph, id, ctorArgs ) {
	const nodes = graph.nodes.map( ( n ) =>
		n.id === id ? { ...n, ctorArgs: ctorArgs.slice() } : n
	);
	return { nodes, edges: graph.edges };
}

export function updateNodeVerbs( graph, id, verbInvocations ) {
	const nodes = graph.nodes.map( ( n ) =>
		n.id === id ? { ...n, verbInvocations: verbInvocations.slice() } : n
	);
	return { nodes, edges: graph.edges };
}

/**
 * True when the draft has diverged from the snapshot taken at
 * edit-mode entry. JSON.stringify is good enough — graphs are small,
 * the field set is fixed, and ordering is stable in our helpers (we
 * always append).
 *
 * @param {Object} draft    Current draft graph.
 * @param {Object} baseline Snapshot taken when edit mode was entered.
 * @return {boolean} True if draft has diverged.
 */
export function draftIsDirty( draft, baseline ) {
	return JSON.stringify( draft ) !== JSON.stringify( baseline );
}

/**
 * Produce a unique kebab-case name for a new instance of `shellName`.
 * First instance: lowercased class name. Subsequent: `-2`, `-3`, …
 * counting from the existing population — collisions are detected
 * against `graph.nodes[].id`.
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
