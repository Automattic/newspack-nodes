import { useMemo } from '@wordpress/element';
import { useNodeState } from '../runtime/react';
import { coreToGraph } from '../topology-console/utils/coreToGraph';
import { generateNodeName } from '../topology-console/utils/draftGraph';
import names from '../runtime/reserved-node-names.json';

const EMPTY_GRAPH = { nodes: [], edges: [] };

/**
 * The page's own live graph + the command handlers that mutate it. The
 * canvas reads `_metadata`'s published `metadata` state (Metadata polls
 * dump_metadata at the live cwd each Router TIMER tick and parses the reply
 * via parseMetadata) — the same data source the topology console uses.
 *
 * Before the first poll lands (or while no Metadata is mounted), falls back
 * to `coreToGraph()` so the canvas isn't empty on first paint.
 *
 * @param {boolean} [active]         Currently unused; kept for API parity (the
 *                                   subscription is naturally inert when no _metadata).
 * @param {Object}  shell            Shell instance owned by DebugOverlay; sink wired
 *                                   to the local CI.
 * @param {Array}   [catalogClasses] Class catalog entries (shell_name + is_interpreter);
 *                                   the Inspector uses it to decide whether to target
 *                                   a node's `:config` sibling or the node itself.
 * @return {{ graph: { nodes: Array, edges: Array }, handlers: Object }} The live graph and gesture handlers.
 */
// eslint-disable-next-line no-unused-vars
export function useDebugGraph( active = true, shell, catalogClasses = [] ) {
	const metadataGraph = useNodeState( names.METADATA, 'metadata' );
	// Evaluate the fallback live every render — useMemo would freeze on the
	// first render's coreToGraph(), which can fire BEFORE the page's exospine
	// mounts (DebugOverlay is a sibling of the dashboard graph; both run
	// useEffect after their first render).
	const graph =
		metadataGraph && Array.isArray( metadataGraph.nodes )
			? metadataGraph
			: coreToGraph() ?? EMPTY_GRAPH;

	const handlers = useMemo(
		() => ( {
			// Every overlay dispatch goes through shell.sendCommand, which stamps
			// FROM = _output so verb replies (and `connect_node <id>` with no
			// target — `tail` mode, defaulting to FROM) route into the transcript
			// Dumper. Without it, replies fall off the end of the graph (no
			// return address) and the Inspector buttons appear to do nothing.
			onConnect: ( from, to ) =>
				shell.sendCommand( '', 'connect_node', `${ from } ${ to }` ),
			onRemoveNode: ( id ) => shell.sendCommand( '', 'remove_node', id ),
			onDropNode: ( { shellName } ) => {
				// SchematicCanvas passes {shellName, x, y} — destructure to match.
				// Unique the new id against the DISPLAYED graph (which is the
				// remote dump_metadata when cwd is remote, otherwise the local
				// Core) so the make_node we dispatch doesn't collide with a node
				// that already exists in the target realm. Position is cosmetic
				// and not sent — poll-reflect lays out.
				const name = generateNodeName( graph, shellName );
				shell.sendCommand(
					'',
					'make_node',
					`${ shellName } ${ name }`
				);
			},
			onInspectorAction: ( action, nodeId, payload ) => {
				// Parity with TopologyConsole.handleInspectorAction: dump, tail
				// (connect_node with no target), disconnect, send, trace, invoke.
				if ( action === 'dump' ) {
					shell.sendCommand( '', 'dump_node', nodeId );
				} else if ( action === 'tail' ) {
					shell.sendCommand( '', 'connect_node', nodeId );
				} else if ( action === 'disconnect' ) {
					shell.sendCommand( '', 'disconnect_node', nodeId );
				} else if ( action === 'send' ) {
					shell.sendCommand(
						'',
						'send_node',
						`${ nodeId } ${ payload }`
					);
				} else if ( action === 'trace' ) {
					const level = typeof payload === 'number' ? payload : 1;
					shell.sendCommand(
						'',
						'debug_state',
						`${ nodeId } ${ level }`
					);
				} else if ( action === 'invoke' && payload ) {
					const { verb, positional } = payload;
					// Mirror TopologyConsole: key on the catalog's
					// is_interpreter flag (the node's class metadata), NOT a
					// Core.node lookup — in remote scope the browser's Core
					// never holds server-side `:config` siblings, so a Core
					// check ALWAYS falls back to nodeId and misroutes verbs
					// on non-interpreter PHP nodes.
					const node = graph.nodes.find( ( n ) => n.id === nodeId );
					const cls =
						node && catalogClasses
							? catalogClasses.find(
									( c ) => c.shell_name === node.class
							  )
							: null;
					const isInterpreter = !! ( cls && cls.is_interpreter );
					const target = isInterpreter
						? nodeId
						: `${ nodeId }:config`;
					shell.sendCommand( target, verb, positional || '' );
				}
			},
		} ),
		[ shell, graph, catalogClasses ]
	);

	return { graph, handlers };
}
