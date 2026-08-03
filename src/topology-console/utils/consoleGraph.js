/**
 * consoleGraph — shaping and reading a console graph, in EITHER mode.
 *
 * Split out of `draftGraph.js`, which was two things under one misleading name:
 * 147 lines of draft mutation, and this — 581 lines that `Inspector`,
 * `SchematicCanvas`, `useConsoleGraph`, `useExpandedIncludes` and
 * `useGraphHandlers` all use to render a LIVE graph. Only the mutation half is
 * the draft's, and only that half goes when the draft becomes an interpreter.
 */

// @longform Edges without role metadata predate the composed-baseline contract
// and are physical connect_node edges. Config-only edges describe routing;
// they are not editor-removable connections.
export function edgeHasConnectRole( edge ) {
	return ! Array.isArray( edge?.roles ) || edge.roles.includes( 'connect' );
}

const CONFIG_TOKEN_RE = /^<[a-zA-Z_]\w*:[a-zA-Z_]\w*>$/;

const CONFIG_TARGET_VERB_RE = /^set_\w*target$/;

/**
 * Attach the server-resolved config edge contract to a parsed topology.
 * A missing contract is only invalid when the file actually needs token
 * resolution; ordinary token-free fixtures and older saved files need none.
 *
 * @param {Object} graph Parsed topology graph.
 * @param {*}      edges `topologies get.resolved_config_edges`.
 * @return {Object} Graph carrying the resolved edge list.
 */
export function withResolvedConfigEdges( graph, edges ) {
	if ( Array.isArray( edges ) ) {
		return { ...graph, resolvedConfigEdges: edges };
	}
	const ownTokenTarget = ( graph.nodes || [] ).some( ( node ) =>
		( node.verbInvocations || [] ).some(
			( invocation ) =>
				CONFIG_TARGET_VERB_RE.test( invocation.verb ) &&
				( invocation.args || [] ).some( ( arg ) =>
					CONFIG_TOKEN_RE.test( arg )
				)
		)
	);
	const borrowedTokenTarget = ( graph.configOverrides || [] ).some(
		( override ) => CONFIG_TOKEN_RE.test( override.to )
	);
	if ( ownTokenTarget || borrowedTokenTarget ) {
		throw new Error(
			'Missing resolved_config_edges in topologies get response.'
		);
	}
	return graph;
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

const configSlotsOf = ( edge ) =>
	Array.isArray( edge?.config_slots ) ? edge.config_slots : [];

const edgeRolesOf = ( edge ) =>
	Array.isArray( edge?.roles ) ? edge.roles : [ 'connect' ];

/**
 * Fold top-level config setters over an expanded include baseline. Slots are
 * independent: replacing errors routing must not erase completed routing, and
 * removing the last config slot must not erase a physical connect role.
 *
 * @param {Array} edges     Current explicit-role edge state.
 * @param {Array} overrides Ordered borrowed-node config target setters.
 * @param {?Set}  alive     Optional node-name set for drawable endpoints.
 * @return {Array} Edge state after all setters run in source order.
 */
function applyConfigOverrides( edges, overrides, alive = null ) {
	let next = edges;
	for ( const override of overrides || [] ) {
		next = next
			.map( ( edge ) => {
				const roles = edgeRolesOf( edge );
				if (
					edge.from !== override.from ||
					! roles.includes( 'config' ) ||
					! configSlotsOf( edge ).includes( override.slot )
				) {
					return edge;
				}
				const configSlots = configSlotsOf( edge ).filter(
					( slot ) => slot !== override.slot
				);
				const updated = { ...edge };
				if ( configSlots.length > 0 ) {
					updated.config_slots = configSlots;
				} else {
					updated.roles = roles.filter(
						( role ) => 'config' !== role
					);
					delete updated.config_slots;
				}
				return updated;
			} )
			.filter( ( edge ) => edgeRolesOf( edge ).length > 0 );

		if (
			! override.to ||
			( alive &&
				( ! alive.has( override.from ) || ! alive.has( override.to ) ) )
		) {
			continue;
		}
		const index = next.findIndex(
			( edge ) => edge.from === override.from && edge.to === override.to
		);
		if ( index < 0 ) {
			next.push( {
				from: override.from,
				to: override.to,
				roles: [ 'config' ],
				config_slots: [ override.slot ],
			} );
			continue;
		}
		const edge = next[ index ];
		const roles = edgeRolesOf( edge );
		const rolesWithConfig = roles.includes( 'config' )
			? roles
			: [ ...roles, 'config' ];
		next[ index ] = {
			...edge,
			roles: rolesWithConfig,
			config_slots: [ ...configSlotsOf( edge ), override.slot ],
		};
	}
	return next;
}

/**
 * Resolve tokenized override targets for graph folding without changing the
 * raw overrides that serialize back into the topology file.
 *
 * @param {Array} overrides     Raw parsed config overrides.
 * @param {Array} resolvedEdges Server-resolved config edges.
 * @return {Array} Overrides carrying concrete graph targets.
 */
function resolveConfigOverrideTargets( overrides, resolvedEdges ) {
	return ( overrides || [] ).map( ( override ) => {
		if ( ! CONFIG_TOKEN_RE.test( override.to ) ) {
			return override;
		}
		const resolved = ( resolvedEdges || [] ).find(
			( edge ) =>
				edge.from === override.from &&
				configSlotsOf( edge ).includes( override.slot )
		);
		return { ...override, to: resolved?.to || '' };
	} );
}

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
		verbInvocations: ( record.verbs || [] ).map( ( v ) => ( {
			verb: v.verb,
			args: v.args || [],
		} ) ),
		origin: record.origin || [],
		via: record.via || [],
		fansOut: record.fans_out ?? 'Tee' === record.class,
	};
}

const isBorrowedNode = ( n ) =>
	Array.isArray( n.origin ) && n.origin.length > 0;

// Content equality for the draft-dirty compare (draftIsDirty is a JSON diff).
function sameGraphContent( a, b ) {
	return (
		JSON.stringify( a.nodes || [] ) === JSON.stringify( b.nodes || [] ) &&
		JSON.stringify( a.edges || [] ) === JSON.stringify( b.edges || [] ) &&
		JSON.stringify( a.configOverrides || [] ) ===
			JSON.stringify( b.configOverrides || [] )
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

	const oldEdgeList = oldBaseline?.edges || [];
	const newEdgeList = newBaseline?.edges || [];
	const oldEdges = new Map(
		oldEdgeList.map( ( edge ) => [ edgeKey( edge ), edge ] )
	);
	const newEdges = new Map(
		newEdgeList.map( ( edge ) => [ edgeKey( edge ), edge ] )
	);
	const alive = new Set( nodes.map( ( n ) => n.id ) );
	const previousNodes = new Set( ( graph.nodes || [] ).map( ( n ) => n.id ) );
	const configOverrides = ( graph.configOverrides || [] )
		.filter( ( override ) => alive.has( override.from ) )
		.map( ( override ) =>
			override.to &&
			previousNodes.has( override.to ) &&
			! alive.has( override.to )
				? { ...override, to: '' }
				: override
		);
	const rolesOf = ( edge ) => new Set( edge ? edgeRolesOf( edge ) : [] );
	const reconciledRoles = ( graphEdge, oldEdge, newEdge ) => {
		const graphRoles = rolesOf( graphEdge );
		const oldRoles = rolesOf( oldEdge );
		const newRoles = rolesOf( newEdge );
		const connectWasEdited =
			oldEdge &&
			graphRoles.has( 'connect' ) !== oldRoles.has( 'connect' );
		let keepConnect = graphRoles.has( 'connect' );
		if ( oldEdge && ! connectWasEdited ) {
			keepConnect = newRoles.has( 'connect' );
		} else if ( ! oldEdge ) {
			keepConnect = keepConnect || newRoles.has( 'connect' );
		}
		let keepConfig = graphRoles.has( 'config' );
		if ( newEdge ) {
			keepConfig = newRoles.has( 'config' );
		} else if ( oldEdge ) {
			keepConfig = false;
		}
		return [
			...( keepConnect ? [ 'connect' ] : [] ),
			...( keepConfig ? [ 'config' ] : [] ),
		];
	};
	const withRoles = ( graphEdge, baselineEdge, roles ) => {
		const edge = graphEdge
			? { ...graphEdge }
			: { from: baselineEdge.from, to: baselineEdge.to };
		const explicit =
			Array.isArray( graphEdge?.roles ) ||
			Array.isArray( baselineEdge?.roles ) ||
			roles.includes( 'config' );
		if ( explicit ) {
			edge.roles = roles;
		} else {
			delete edge.roles;
		}
		if ( roles.includes( 'config' ) ) {
			const configSlots = configSlotsOf( baselineEdge || graphEdge );
			if ( configSlots.length > 0 ) {
				edge.config_slots = [ ...configSlots ];
			} else {
				delete edge.config_slots;
			}
		} else {
			delete edge.config_slots;
		}
		return edge;
	};

	const edges = [];
	const visited = new Set();
	for ( const graphEdge of graph.edges || [] ) {
		const key = edgeKey( graphEdge );
		visited.add( key );
		if (
			departed.has( graphEdge.from ) ||
			departed.has( graphEdge.to ) ||
			! alive.has( graphEdge.from ) ||
			! alive.has( graphEdge.to )
		) {
			continue;
		}
		const oldEdge = oldEdges.get( key );
		const newEdge = newEdges.get( key );
		if ( ! oldEdge && ! newEdge ) {
			edges.push( graphEdge );
			continue;
		}
		const roles = reconciledRoles( graphEdge, oldEdge, newEdge );
		if ( roles.length > 0 ) {
			edges.push( withRoles( graphEdge, newEdge || oldEdge, roles ) );
		}
	}
	for ( const newEdge of newEdgeList ) {
		const key = edgeKey( newEdge );
		if ( visited.has( key ) ) {
			continue;
		}
		const roles = reconciledRoles( null, oldEdges.get( key ), newEdge );
		if ( roles.length > 0 ) {
			edges.push( withRoles( null, newEdge, roles ) );
		}
	}

	const next = {
		...graph,
		nodes,
		edges: applyConfigOverrides(
			edges,
			resolveConfigOverrideTargets(
				configOverrides,
				graph.resolvedConfigEdges
			),
			alive
		),
		...( Array.isArray( graph.configOverrides )
			? { configOverrides }
			: {} ),
	};
	// Nothing moved: hand back the SAME graph so the draft stays clean.
	return sameGraphContent( graph, next ) ? graph : next;
}

/**
 * Re-expand `graph.includes` into borrowed nodes/edges on topology open.
 * `graph` is parseTsl's output; `baseline` is the include set's `topologies
 * expand` result. The file's ordered connect/disconnect operations fold over
 * that baseline with runtime Node/Tee semantics. Once applied, the draft's edge
 * list is the single source of truth; operations are cleared, and `serializeTsl`
 * re-derives the canonical disconnect-before-connect delta from `baseline`.
 *
 * @param {Object} graph    parseTsl() output for the collapsed `.tsl` file.
 * @param {Object} baseline `topologies expand( graph.includes )` result.
 * @param {Array}  catalog  Class catalog carrying the `fans_out` flag.
 * @return {Object} Draft graph with borrowed nodes/edges merged in.
 */
export function applyLoadedBaseline( graph, baseline, catalog = [] ) {
	const borrowed = ( baseline?.nodes || [] ).map( borrowedNode );
	const nodes = [ ...( graph.nodes || [] ), ...borrowed ];

	const nodesByName = new Map( nodes.map( ( node ) => [ node.id, node ] ) );
	const sourceIsTee = ( sourceName ) => {
		const source = nodesByName.get( sourceName );
		return nodeUsesTeeSemantics( source, catalog );
	};
	const withoutConnectRole = ( edge ) => ( {
		...edge,
		roles: edge.roles.filter( ( role ) => 'connect' !== role ),
	} );
	// Same alive-filter reconcileIncludes applies, or a fresh open reads dirty.
	const alive = new Set( nodes.map( ( n ) => n.id ) );
	let edgeStates = ( baseline?.edges || [] )
		.filter( ( edge ) => alive.has( edge.from ) && alive.has( edge.to ) )
		.map( ( edge ) => ( {
			from: edge.from,
			to: edge.to,
			roles: [ ...( edge.roles || [ 'connect' ] ) ],
			...( configSlotsOf( edge ).length > 0
				? { config_slots: [ ...configSlotsOf( edge ) ] }
				: {} ),
		} ) )
		.filter( ( edge ) => edge.roles.length > 0 );

	// Legacy split arrays are canonical disconnect-before-connect.
	const edgeOperations = graph.edgeOperations || [
		...( graph.disconnects || [] ).map( ( edge ) => ( {
			type: 'disconnect',
			...edge,
		} ) ),
		...( graph.edges || [] ).map( ( edge ) => ( {
			type: 'connect',
			...edge,
		} ) ),
	];
	for ( const operation of edgeOperations ) {
		if ( 'disconnect' === operation.type ) {
			// Tee's omitted target is the Shell FROM, never “clear all.”
			if ( sourceIsTee( operation.from ) && operation.to === undefined ) {
				continue;
			}
			edgeStates = edgeStates
				.map( ( edge ) => {
					if ( edge.from !== operation.from ) {
						return edge;
					}
					// Regular clears all; Tee removes only this target.
					if (
						sourceIsTee( operation.from ) &&
						edge.to !== operation.to
					) {
						return edge;
					}
					return withoutConnectRole( edge );
				} )
				.filter( ( edge ) => edge.roles.length > 0 );
			continue;
		}

		if ( ! sourceIsTee( operation.from ) ) {
			edgeStates = edgeStates
				.map( ( edge ) =>
					edge.from === operation.from && edge.to !== operation.to
						? withoutConnectRole( edge )
						: edge
				)
				.filter( ( edge ) => edge.roles.length > 0 );
		}
		const currentIndex = edgeStates.findIndex(
			( edge ) => edge.from === operation.from && edge.to === operation.to
		);
		if ( currentIndex >= 0 ) {
			const current = edgeStates[ currentIndex ];
			if ( ! current.roles.includes( 'connect' ) ) {
				edgeStates[ currentIndex ] = {
					...current,
					roles: [ ...current.roles, 'connect' ],
				};
			}
		} else {
			edgeStates.push( {
				from: operation.from,
				to: operation.to,
				roles: [ 'connect' ],
			} );
		}
	}
	edgeStates = applyConfigOverrides(
		edgeStates,
		resolveConfigOverrideTargets(
			graph.configOverrides,
			graph.resolvedConfigEdges
		),
		alive
	);

	return {
		...graph,
		nodes,
		edges: edgeStates,
		disconnects: [],
		edgeOperations: [],
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

export function nodeUsesTeeSemantics( node, catalog = [] ) {
	if ( 'boolean' === typeof node?.fansOut ) {
		return node.fansOut;
	}
	const schema = Array.isArray( catalog )
		? catalog.find( ( entry ) => entry.shell_name === node?.class )
		: catalog?.[ node?.class ];
	return schema?.fans_out ?? 'Tee' === node?.class;
}
