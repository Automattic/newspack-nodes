import { useCallback, useMemo, useRef, useState } from '@wordpress/element';
import { Core } from '../runtime/core';
import { useNodeState } from '../runtime/react';
import { coreToGraph } from '../topology-console/utils/coreToGraph';
import { generateNodeName } from '../topology-console/utils/draftGraph';
import { snapToGrid } from '../topology-console/utils/autoLayout';
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
 * @param {boolean}  [_active]          Currently unused; kept for API parity (the
 *                                      subscription is naturally inert when no _metadata).
 * @param {Object}   shell              Shell instance owned by DebugOverlay; sink wired
 *                                      to the local interpreter.
 * @param {Array}    [catalogClasses]   Class catalog entries (shell_name + is_interpreter);
 *                                      the Inspector uses it to decide whether to target
 *                                      a node's `:config` sibling or the node itself.
 * @param {Function} [onPositionChange] (id, {x, y}) — invoked on a palette drop so the
 *                                      dropped node renders at the drop site (snapped to
 *                                      the grid) when the metadata poll surfaces it,
 *                                      instead of autoLayout's choice.
 * @return {{ graph: { nodes: Array, edges: Array }, handlers: Object }} The live graph and gesture handlers.
 */
export function useDebugGraph(
	_active = true,
	shell,
	catalogClasses = [],
	onPositionChange = null
) {
	const metadataGraph = useNodeState( names.METADATA, 'metadata' );

	// A drop on a class with declared positional args stages here; the
	// parent renders the NewNodeModal until commitDrop / cancelDrop. The
	// ref-mirror lets commitDrop run side effects (sendCommand,
	// onPositionChange) without putting them inside a setState callback,
	// which React.StrictMode would invoke twice.
	const [ pendingDrop, setPendingDrop ] = useState( null );
	const pendingDropRef = useRef( null );
	pendingDropRef.current = pendingDrop;
	// Evaluate the fallback live every render — useMemo would freeze on the
	// first render's coreToGraph(), which can fire BEFORE the page's exospine
	// mounts (DebugOverlay is a sibling of the dashboard graph; both run
	// useEffect after their first render).
	const graph =
		metadataGraph && Array.isArray( metadataGraph.nodes )
			? metadataGraph
			: coreToGraph() ?? EMPTY_GRAPH;

	// Echo the equivalent commandline into the `_output` Dumper, then dispatch via
	// shell.sendCommand. A GUI gesture / Inspector click must read back in the
	// transcript like the typed verb would (the reply already routes to _output
	// via FROM; this adds the matching `sent` line) — parity with
	// TopologyConsole.handleInspectorAction's appendTranscript echo.
	const sendVerb = useCallback(
		( echoText, path, name, args = '' ) => {
			Core.node( names.OUTPUT )?.append( {
				kind: 'sent',
				text: echoText,
				prompt: `/${ shell.path }`,
			} );
			shell.sendCommand( path, name, args );
		},
		[ shell ]
	);

	const handlers = useMemo(
		() => ( {
			// Every overlay dispatch goes through sendVerb → shell.sendCommand,
			// which stamps FROM = _output so verb replies (and `connect_node <id>`
			// with no target — `tail` mode, defaulting to FROM) route into the
			// transcript Dumper. Without it, replies fall off the end of the graph
			// (no return address) and the Inspector buttons appear to do nothing.
			onConnect: ( from, to ) =>
				sendVerb(
					`connect_node ${ from } ${ to }`,
					'',
					'connect_node',
					`${ from } ${ to }`
				),
			onRemoveNode: ( id ) =>
				sendVerb( `remove_node ${ id }`, '', 'remove_node', id ),
			onDropNode: ( { shellName, x, y } ) => {
				// Every palette drop in live mode goes through the NewNodeModal
				// so the user can override the auto-generated name (and add
				// args if the class declares them). commitDrop dispatches
				// make_node + records the drop position.
				const defaultName = generateNodeName( graph, shellName );
				const cls = catalogClasses?.find(
					( c ) => c.shell_name === shellName
				);
				const argSchema = cls?.arguments || [];
				setPendingDrop( { shellName, defaultName, argSchema, x, y } );
			},
			onInspectorAction: ( action, nodeId, payload ) => {
				// Parity with TopologyConsole.handleInspectorAction: dump, tail
				// (connect_node with no target), disconnect, send, trace, invoke.
				if ( action === 'dump' ) {
					sendVerb(
						`dump_node ${ nodeId }`,
						'',
						'dump_node',
						nodeId
					);
				} else if ( action === 'tail' ) {
					sendVerb(
						`connect_node ${ nodeId }`,
						'',
						'connect_node',
						nodeId
					);
				} else if ( action === 'disconnect' ) {
					sendVerb(
						`disconnect_node ${ nodeId }`,
						'',
						'disconnect_node',
						nodeId
					);
				} else if ( action === 'send' ) {
					sendVerb(
						`send_node ${ nodeId } ${ payload }`,
						'',
						'send_node',
						`${ nodeId } ${ payload }`
					);
				} else if ( action === 'trace' ) {
					const level = typeof payload === 'number' ? payload : 1;
					sendVerb(
						`debug_state ${ nodeId } ${ level }`,
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
					const args = positional || '';
					// Echo as `command_node <target> <verb> [<args>]`, matching the
					// console's invoke echo so a click reads back like the cmd verb.
					sendVerb(
						`command_node ${ target } ${ verb }${
							args ? ' ' + args : ''
						}`,
						target,
						verb,
						args
					);
				}
			},
		} ),
		// onPositionChange is consumed by commitDrop (below), not by any
		// handler in this useMemo — onDropNode just stages pendingDrop.
		[ sendVerb, graph, catalogClasses ]
	);

	// Modal "OK" — dispatch make_node with the user-edited name + args, then
	// record the drop position so the canvas renders the new node at the
	// drop site once the metadata poll surfaces it.
	const commitDrop = useCallback(
		( { name, args } ) => {
			const current = pendingDropRef.current;
			if ( ! current ) {
				return;
			}
			const trimmed = ( args || '' ).trim();
			const line = trimmed
				? `${ current.shellName } ${ name } ${ trimmed }`
				: `${ current.shellName } ${ name }`;
			sendVerb( `make_node ${ line }`, '', 'make_node', line );
			if (
				onPositionChange &&
				'number' === typeof current.x &&
				'number' === typeof current.y
			) {
				onPositionChange( name, snapToGrid( current.x, current.y ) );
			}
			setPendingDrop( null );
		},
		[ sendVerb, onPositionChange ]
	);

	const cancelDrop = useCallback( () => setPendingDrop( null ), [] );

	return { graph, handlers, pendingDrop, commitDrop, cancelDrop };
}
