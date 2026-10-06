/**
 * consoleGraph — the graph transforms the Topology Console's two modes share.
 *
 * Every function here READS a graph and returns a new one: whether an edge is
 * a removable physical connection, the fold of a document's `set_*target`
 * lines into config-role edges, the canvas's reserved `_repl` anchors, and the
 * unique name a palette drop takes. None of them mutates a document. Mutation
 * belongs to the draft interpreter, where a TSL verb can reach it, so a
 * transform here that DECIDED something would be in the wrong place.
 */

import names from '../../runtime/reserved-node-names.json';
import { Node } from '../../runtime/node';

/**
 * True when an edge is a physical `connect_node` connection — the only kind
 * the editor may remove.
 *
 * Removing an edge issues `disconnect_node`, which undoes nothing else: a
 * config-role edge exists because a `set_*target` verb named its destination,
 * and that line would outlive the gesture. An edge carrying no `roles` array
 * is physical — the live graph and the virtual-edge pass both emit bare edges,
 * and the config fold below is the only thing that ever labels one.
 *
 * @param {Object} edge Graph edge; `roles` is absent on a plain connection.
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
 *
 * A `<ns:key>` target names nothing client-side — only the server resolves the
 * token — so a document carrying one that arrives without the list would wire
 * an edge to the literal token text. Refusing is the loud half of that: the
 * missing contract is a server response the console cannot paint. A
 * token-free document needs no list and passes through untouched.
 *
 * @param {Object} graph Parsed topology graph.
 * @param {*}      edges `topologies get.resolved_config_edges`; anything but
 *                       an array counts as no contract at all.
 * @return {Object} Graph carrying the resolved edge list.
 * @throws {Error} When a token target has no resolved-edge list to name it.
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
 * against the server's answer before it names anything. An endpoint no node
 * provides is skipped, so a setter pointing at a node the composed graph lacks
 * draws nothing rather than a dangling edge.
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

/**
 * The nodes every worker mounts on its own, as reserved canvas nodes: the
 * REPL Partition, and the Consumer reading the worker's IPC input, whose
 * quarantine the `dl_*` verbs reach. No `.tsl` declares either, and the
 * document never gains a line that does.
 */
const REPL_ANCHORS = [
	{ id: names.REPL, name: names.REPL, class: 'Partition', reserved: true },
	{
		id: names.REPL_INPUT,
		name: names.REPL_INPUT,
		class: 'Consumer',
		reserved: true,
	},
];

/**
 * Add the reserved REPL anchors, so the graph drawn from a `.tsl` carries
 * them before the first `dump_metadata` answers with the live graph, and the
 * canvas can draw edges a topology points at `_repl`. Idempotent: an anchor
 * the graph already carries is not added again.
 *
 * @param {Object} graph Graph whose `nodes` list receives the anchors.
 * @return {Object} Graph carrying both anchors.
 */
export function withReplAnchor( graph ) {
	const held = new Set( graph.nodes.map( ( n ) => n.id ) );
	const missing = REPL_ANCHORS.filter(
		( anchor ) => ! held.has( anchor.id )
	);
	return missing.length
		? { ...graph, nodes: [ ...graph.nodes, ...missing ] }
		: graph;
}

/**
 * Add the nodes an owner builds for itself, which no `.tsl` line declares, so
 * the graph drawn from a `.tsl` carries them before `dump_metadata` answers.
 *
 * Each arrives as `topologies get` or `ownedOf()` names it, and is wired from
 * its owner as the owner's `extra_targets()` wire it at runtime: an `extra`
 * edge, never a `connect` one, so no edit offers to disconnect it. One whose
 * owner the graph lacks, or that the graph already holds, is skipped.
 *
 * @param {Object}                                              graph Graph whose `nodes` and `edges` receive them.
 * @param {Array<{name: string, class: string, owner: string}>} owned `topologies get.owned`, or `ownedOf()`.
 * @return {Object} Graph carrying every owned node and its owner's edge.
 * @throws {Error} When the reply carries no owned list.
 */
export function withOwnedNodes( graph, owned ) {
	if ( ! Array.isArray( owned ) ) {
		throw new Error( 'Missing owned in topologies get response.' );
	}
	const held = new Set( graph.nodes.map( ( n ) => n.id ) );
	const adding = owned.filter(
		( o ) => held.has( o.owner ) && ! held.has( o.name )
	);
	if ( ! adding.length ) {
		return graph;
	}
	return {
		...graph,
		nodes: [
			...graph.nodes,
			...adding.map( ( o ) => ( {
				id: o.name,
				name: o.name,
				class: o.class,
				owner: o.owner,
			} ) ),
		],
		edges: [
			...graph.edges,
			// A declared extra (ADR-19), never a `connect_node` an edit drops.
			...adding.map( ( o ) => ( {
				from: o.owner,
				to: o.name,
				roles: [ 'extra' ],
			} ) ),
		],
	};
}

/**
 * The owned nodes the console draws for the graph's owners, read off each
 * class's catalog `owns` declaration (suffix to class) as `topologies get`
 * names them from the same declaration. It follows the graph, so a renamed owner takes
 * its siblings along and a class that declares none builds none.
 *
 * @param {Object}                                     graph   Graph whose `nodes` own.
 * @param {Array<{shell_name: string, owns?: Object}>} catalog Class catalog entries.
 * @return {Array<{name: string, class: string, owner: string}>} The owned nodes.
 */
export function ownedOf( graph, catalog ) {
	const owns = new Map( catalog.map( ( c ) => [ c.shell_name, c.owns ] ) );
	return graph.nodes.flatMap( ( n ) =>
		Object.entries( owns.get( n.class ) ?? {} ).map(
			( [ suffix, cls ] ) => ( {
				name: Node.siblingNameOf( n.id, suffix ),
				class: cls,
				owner: n.id,
			} )
		)
	);
}

/**
 * The `set_*target` slots an edge stands for.
 *
 * @param {Object} edge Graph edge.
 * @return {Array<string>} The slot list, empty on an edge with no config role.
 */
const configSlotsOf = ( edge ) =>
	Array.isArray( edge?.config_slots ) ? edge.config_slots : [];

/**
 * An edge's roles, reading a bare edge as a physical connection — the same
 * default the server's expansion and the draft interpreter apply.
 *
 * @param {Object} edge Graph edge.
 * @return {Array<string>} The role list.
 */
const edgeRolesOf = ( edge ) =>
	Array.isArray( edge?.roles ) ? edge.roles : [ 'connect' ];

/**
 * Fold top-level config setters over an expanded include baseline.
 *
 * Each setter vacates its own slot wherever that slot currently sits, then
 * claims its new endpoint. Slots are independent: retargeting errors routing
 * must not erase completed routing, and vacating an edge's last config slot
 * must not erase a physical connect role the same edge carries. A setter with
 * an empty target only vacates.
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
 * A token the server's list does not answer resolves to an empty target, which
 * vacates the slot instead of drawing an edge to the token text.
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
 * The first instance takes the bare lowercased class, so a one-of-a-kind node
 * reads as `echo` rather than `echo-1`.
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
