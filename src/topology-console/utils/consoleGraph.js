/**
 * consoleGraph — shaping and reading a console graph, in EITHER mode.
 *
 * Split out of `draftGraph.js`, which was two things under one misleading name:
 * 147 lines of draft mutation, and this — 581 lines that `Inspector`,
 * `SchematicCanvas`, `useConsoleGraph`, `useExpandedIncludes` and
 * `useGraphHandlers` all use to render a LIVE graph. Only the mutation half is
 * the draft's, and only that half goes when the draft becomes an interpreter.
 */

/**
 * True when an edge is a physical `connect_node` connection — the only kind
 * the editor may remove.
 *
 * Edges without role metadata predate the composed-baseline contract and are
 * physical connect_node edges. Config-only edges describe routing; they are
 * not editor-removable connections.
 *
 * @param {Object} edge Graph edge; `roles` is absent on pre-contract edges.
 * @return {boolean} True when the edge carries a connect role.
 */
export function edgeHasConnectRole( edge ) {
	return ! Array.isArray( edge?.roles ) || edge.roles.includes( 'connect' );
}

/** A whole-argument `<ns:key>` token; char classes mirror PHP Core::resolve_config_tokens. */
const CONFIG_TOKEN_RE = /^<[a-zA-Z_]\w*:[a-zA-Z_]\w*>$/;

/** The verbs whose argument names a config TARGET, so it folds into an edge. */
export const CONFIG_TARGET_VERB_RE = /^set_\w*target$/;

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

/**
 * Fold `configOverrides` into the edge list as config-role edges.
 *
 * The last step of composing a document with its expansion: a `set_*target`
 * verb produces an edge, and a `<ns:key>` token in one has to be resolved
 * against the server's answer before it names anything.
 *
 * @param {Object} graph Graph carrying `configOverrides` + `resolvedConfigEdges`.
 * @return {Object} The graph with config edges folded in.
 */
export function withConfigEdges( graph ) {
	const alive = new Set( ( graph.nodes || [] ).map( ( n ) => n.id ) );
	return {
		...graph,
		edges: applyConfigOverrides(
			graph.edges || [],
			resolveConfigOverrideTargets(
				graph.configOverrides,
				graph.resolvedConfigEdges
			),
			alive
		),
	};
}

// `_repl`: worker's auto-mounted Partition; reserved anchor, never in a .tsl.
const REPL_ANCHOR = {
	id: '_repl',
	name: '_repl',
	class: 'Partition',
	reserved: true,
};

/**
 * Add the reserved `_repl` anchor node so the canvas can draw the edges a
 * topology points at the worker's auto-mounted REPL Partition. Idempotent: a
 * graph that already carries `_repl` comes back untouched.
 *
 * @param {Object} graph Graph whose `nodes` list receives the anchor.
 * @return {Object} Graph carrying the `_repl` anchor node.
 */
export function withReplAnchor( graph ) {
	if ( graph.nodes.some( ( n ) => n.id === '_repl' ) ) {
		return graph;
	}
	return { ...graph, nodes: [ ...graph.nodes, REPL_ANCHOR ] };
}

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
