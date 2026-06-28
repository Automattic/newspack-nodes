import { useNodeState } from '../../runtime/react';
import { coreToGraph } from '../utils/coreToGraph';
import names from '../../runtime/reserved-node-names.json';

const EMPTY_GRAPH = { nodes: [], edges: [], pwd: '' };

// Always-present, visible backbone fixtures — they don't count toward "has the
// graph any real content" (the empty-state / ready gate).
const BACKBONE_FIXTURES = new Set( [
	names.CONSOLE_TAP,
	names.HTTP,
	names.HEARTBEAT,
] );

/**
 * Shared graph source for the debug overlay and topology console: prefer the
 * `_metadata`-published `metadata` state once it carries ≥1 node. Readiness
 * *composition* stays in each consumer (overlay ANDs `replReady`; console ANDs
 * `serverFetchResolved`); this hook only reports the raw `hasNodes`.
 *
 * @param {Object}  [opts]              Options.
 * @param {boolean} [opts.active]       Currently unused; kept for API parity (the
 *                                      subscription is naturally inert with no _metadata).
 * @param {boolean} [opts.coreFallback] Overlay-only: before the first dump_metadata
 *                                      poll lands, paint the in-process graph via
 *                                      `coreToGraph()` (the overlay's Core holds the
 *                                      COMPLETE local graph). The console disables it
 *                                      (`false`) so its worker/local scope renders the
 *                                      published metadata graph only — coreToGraph there
 *                                      would surface browser-side reserved scaffolding the
 *                                      worker graph never includes.
 * @return {{ graph: { nodes: Array, edges: Array }, hasNodes: boolean }} The live graph and whether it carries any node.
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
	// The visible but always-present backbone fixtures (`_shell` command Tap,
	// `_http` egress, `_heartbeat` keepalive) must not, on their own, make an
	// otherwise-empty graph read as non-empty.
	const hasNodes = graph.nodes.some(
		( n ) => ! BACKBONE_FIXTURES.has( n.id )
	);
	return { graph, hasNodes };
}
