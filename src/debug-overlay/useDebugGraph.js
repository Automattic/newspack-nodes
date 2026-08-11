import { useCallback, useRef, useState } from '@wordpress/element';
import { Core } from '../runtime/core';
import { snapToGrid } from '../topology-console/utils/autoLayout';
import { useGraphSource } from '../topology-console/hooks/useGraphSource';
import { useGraphHandlers } from '../topology-console/hooks/useGraphHandlers';
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
 * @param {boolean}  _active            Currently unused; kept for API parity (the
 *                                      subscription is naturally inert when no _metadata).
 *                                      Defaults to true, but `shell` follows it, so a
 *                                      caller wanting a shell passes it positionally.
 * @param {Object}   shell              Shell instance owned by DebugOverlay; sink wired
 *                                      to the local interpreter.
 * @param {Array}    [catalogClasses]   Class catalog entries (shell_name + is_interpreter);
 *                                      the Inspector uses it to decide whether to target
 *                                      a node's `:config` sibling or the node itself.
 * @param {Function} [onPositionChange] (id, {x, y}) — invoked on a palette drop so the
 *                                      dropped node renders at the drop site (snapped to
 *                                      the grid) when the metadata poll surfaces it,
 *                                      instead of autoLayout's choice.
 * @return {{ graph: { nodes: Array, edges: Array }, ready: boolean, handlers: Object, pendingDrop: ?Object, commitDrop: (node: { name: string, args: string }) => void, cancelDrop: () => void }} The live graph,
 *   readiness flag, gesture handlers, and the palette-drop staging trio: `pendingDrop` is
 *   the staged `{ shellName, defaultName, argSchema, x, y }` payload (null when no drop is
 *   pending), `commitDrop({ name, args })` makes the node, `cancelDrop()` discards it.
 * @param {Function} [sendLine]         `( line, fields ) => void` — THE dispatch path,
 *                                      the same one the console injects (echo, compose
 *                                      fields, cwd mirror, debug_state persist).
 */
export function useDebugGraph(
	_active = true,
	shell,
	catalogClasses = [],
	onPositionChange = null,
	sendLine = null
) {
	// Drop with args stages here; ref-mirror avoids StrictMode double-run.
	const [ pendingDrop, setPendingDrop ] = useState( null );
	const pendingDropRef = useRef( null );
	pendingDropRef.current = pendingDrop;
	// Shared metadata‖coreToGraph source; ready = the graph carries a node.
	const { graph, hasNodes: ready } = useGraphSource( { active: _active } );

	// ONE dispatch path — a second one let `trace` skip sendLine's bookkeeping.
	const dispatch = useCallback(
		( echoLine, name, args, fields ) => sendLine?.( echoLine, fields ),
		[ sendLine ]
	);

	// Append straight to the `_output` Dumper (invoke echo + sse error).
	const append = useCallback(
		( entry ) => Core.node( names.OUTPUT )?.append( entry ),
		[]
	);

	// Inject Shell prefix/replyFrom so invoke honors cwd (skips sendCommand).
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

	// Modal "OK": make_node with edited name + args, then record drop position.
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
			dispatch( `make_node ${ line }`, 'make_node', line );
			// Optimistically inject the dropped node; next poll reconciles.
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
		[ dispatch, onPositionChange ]
	);

	const cancelDrop = useCallback( () => setPendingDrop( null ), [] );

	return { graph, ready, handlers, pendingDrop, commitDrop, cancelDrop };
}
