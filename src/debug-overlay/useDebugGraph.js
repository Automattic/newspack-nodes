import { useCallback, useRef, useState } from '@wordpress/element';
import { Core } from '../runtime/core';
import { snapToGrid } from '../topology-console/utils/autoLayout';
import { useGraphSource } from '../topology-console/hooks/useGraphSource';
import { useGraphHandlers } from '../topology-console/hooks/useGraphHandlers';
import { FROM, LOCAL, applyReplyFlags } from '../runtime/message';
import names from '../runtime/reserved-node-names.json';

/**
 * The page's own live graph + the command handlers that mutate it. The
 * canvas reads `_metadata`'s published `metadata` state (Metadata polls
 * dump_metadata at the live cwd each Router TIMER tick and parses the reply
 * via parseMetadata) — the same data source the topology console uses.
 *
 * Before the first poll lands, falls back to `coreToGraph()` so the local
 * graph paints instantly; `ready` is true as soon as either source yields a
 * node (coreToGraph can make it sync-true on open).
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
 * @return {{ graph: { nodes: Array, edges: Array }, ready: boolean, handlers: Object }} The live graph, readiness flag, and gesture handlers.
 */
export function useDebugGraph(
	_active = true,
	shell,
	catalogClasses = [],
	onPositionChange = null
) {
	// A drop on a class with declared positional args stages here; the
	// parent renders the NewNodeModal until commitDrop / cancelDrop. The
	// ref-mirror lets commitDrop run side effects (sendCommand,
	// onPositionChange) without putting them inside a setState callback,
	// which React.StrictMode would invoke twice.
	const [ pendingDrop, setPendingDrop ] = useState( null );
	const pendingDropRef = useRef( null );
	pendingDropRef.current = pendingDrop;
	// Shared metadata‖coreToGraph source; ready = the graph carries a node.
	const { graph, hasNodes: ready } = useGraphSource( { active: _active } );

	// Echo the equivalent commandline into the `_output` Dumper, then dispatch via
	// shell.sendCommand. A GUI gesture / Inspector click must read back in the
	// transcript like the typed verb would (the reply already routes to _output
	// via FROM; this adds the matching `sent` line) — parity with
	// TopologyConsole.handleInspectorAction's appendTranscript echo.
	const sendVerb = useCallback(
		( echoText, path, name, args = '', flags = null ) => {
			Core.node( names.OUTPUT )?.append( {
				kind: 'sent',
				text: echoText,
				prompt: `/${ shell.path }`,
			} );
			// Use shell.dispatch so useGraphReset's tap sees it.
			const parsed = shell.parse( echoText );
			if ( Array.isArray( parsed ) ) {
				if ( ! parsed[ FROM ] ) {
					parsed[ FROM ] = names.OUTPUT;
				}
				if ( undefined === parsed[ LOCAL ] ) {
					parsed[ LOCAL ] = true;
				}
				// Compose modal's TM_RESPONSE / TM_ERROR checkboxes.
				applyReplyFlags( parsed, flags );
				shell.dispatch( parsed );
			} else {
				shell.sendCommand( path, name, args );
			}
		},
		[ shell ]
	);

	// Every non-invoke verb echoes + routes through sendVerb (so the useGraphReset
	// dispatch tap sees a mutating verb). Bound to path '' — the overlay is local-only.
	const dispatch = useCallback(
		( echoLine, name, args, flags ) =>
			sendVerb( echoLine, '', name, args, flags ),
		[ sendVerb ]
	);

	// Append straight to the `_output` Dumper (invoke echo + sse error). The
	// overlay never blocks invoke (no attached worker), so sseGuard stays default.
	const append = useCallback(
		( entry ) => Core.node( names.OUTPUT )?.append( entry ),
		[]
	);

	// Shared handlers. Inject the Shell's prefix/replyFrom so invoke honors the
	// cwd at a non-root scope (the Path menu can `cd /_http`); invoke here
	// doesn't route through shell.sendCommand, so it must carry them explicitly.
	// sseGuard stays default (the overlay never blocks invoke — no attached worker).
	const handlers = useGraphHandlers( {
		shell,
		graph,
		catalogClasses,
		dispatch,
		append,
		onDropStage: setPendingDrop,
		prefix: ( target ) => shell?.prefix( target ),
		replyFrom: ( node ) => shell?.replyFrom( node ),
	} );

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
			// Optimistically inject the dropped node so it appears at once (no poll
			// wait, no dump_metadata round-trip); the next full poll reconciles.
			Core.node( names.METADATA )?.optimisticPatch( name, {
				class: current.shellName,
				target: '',
			} );
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

	return { graph, ready, handlers, pendingDrop, commitDrop, cancelDrop };
}
