/**
 * The one graph source both canvas surfaces read — the debug overlay and the
 * topology console — so an in-page graph and a worker's graph go through the
 * same precedence rule and the same emptiness test.
 *
 * Readiness stays split. This hook reports only whether the graph carries a
 * node of its own, and each consumer ANDs in what else must hold before it
 * paints: the overlay adds `replReady`, the console `serverFetchResolved`.
 */

import { useNodeState } from '../../runtime/react';
import { coreToGraph } from '../utils/coreToGraph';
import names from '../../runtime/reserved-node-names.json';

/**
 * The graph a consumer draws while nothing has published one and the Core
 * fallback is off. It carries no node, so `hasNodes` reports false.
 */
const EMPTY_GRAPH = { nodes: [], edges: [], pwd: '' };

/**
 * Scaffolding a graph carries before any topology is built: the exospine
 * backbone the browser mounts (`_shell`, `_http`, `_heartbeat`) and the
 * worker's auto-mounted `_repl` Partition. None of it counts as "the graph has
 * content", because laying the scaffolding out alone fixes the layout, and
 * every real node arriving on the next `dump_metadata` is then stacked below
 * it in one column (`placeBelow`) instead of joining a full layout pass.
 */
const BACKBONE_FIXTURES = new Set( [
	names.CONSOLE_TAP,
	names.HTTP,
	names.HEARTBEAT,
	names.REPL,
] );

/**
 * Read the graph on screen, preferring the `metadata` state `_metadata`
 * publishes once that graph carries at least one node.
 *
 * A published graph of zero nodes means "nothing has answered yet" rather than
 * "the graph is empty", so a poll that returns nothing cannot blank the
 * in-process graph the Core fallback is already drawing.
 *
 * @param {Object}  [opts]              Options.
 * @param {boolean} [opts.active]       Accepted and ignored. The overlay forwards its own
 *                                      active flag, and the subscription costs nothing
 *                                      while no `_metadata` node holds the name:
 *                                      `useNodeState` registers no listener and yields
 *                                      undefined.
 * @param {boolean} [opts.coreFallback] Paint the in-process graph through `coreToGraph()`
 *                                      until a metadata graph carries a node. The overlay
 *                                      leaves it on, because its Core holds the COMPLETE
 *                                      local graph. The console passes `false`: its canvas
 *                                      is scoped to a worker, and `coreToGraph()` would
 *                                      surface the browser's own reserved scaffolding,
 *                                      which the worker graph never contains.
 * @return {{graph: {nodes: Array, edges: Array, pwd: string, profiling?: boolean}, hasNodes: boolean}} The graph to
 *   draw, and whether it carries a node that is not backbone scaffolding. The Inspector
 *   reads `pwd` for its Tail toggle and `profiling` for the Router one.
 */
export function useGraphSource( {
	active: _active = true,
	coreFallback = true,
} = {} ) {
	const metadataGraph = useNodeState( names.METADATA, 'metadata' );
	const hasMetadata = !! (
		metadataGraph &&
		Array.isArray( metadataGraph.nodes ) &&
		metadataGraph.nodes.length > 0
	);
	let graph;
	if ( hasMetadata ) {
		graph = metadataGraph;
	} else {
		graph = coreFallback ? coreToGraph() ?? EMPTY_GRAPH : EMPTY_GRAPH;
	}
	const hasNodes = graph.nodes.some(
		( n ) => ! BACKBONE_FIXTURES.has( n.id )
	);
	return { graph, hasNodes };
}
