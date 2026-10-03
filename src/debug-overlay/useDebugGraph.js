import { useCallback, useRef, useState } from '@wordpress/element';
import { Core } from '../runtime/core';
import { snapToGrid } from '../topology-console/utils/autoLayout';
import { useGraphSource } from '../topology-console/hooks/useGraphSource';
import { useGraphHandlers } from '../topology-console/hooks/useGraphHandlers';
import names from '../runtime/reserved-node-names.json';

/**
 * The overlay's live graph and the canvas gestures that mutate it, composed
 * from the two hooks the topology console also uses so both surfaces share one
 * graph source and one handler set.
 *
 * The canvas reads the `metadata` state `_metadata` publishes: that node rides
 * the `_router` TIMER, mints `dump_metadata` through `_cwd` so the snapshot
 * follows the REPL's directory, and publishes the reply parsed by
 * `parseMetadata`. Until the first poll lands, `useGraphSource` paints the
 * in-process graph through `coreToGraph()`, which is what can make `ready` true
 * on the first render. Readiness means the graph carries a node that is not
 * backbone scaffolding; the scaffolding alone leaves it false.
 *
 * Every gesture but `invoke` and a compose becomes a command line handed to
 * `sendLine`, the path the REPL prompt uses. That one path owns the transcript
 * echo, the cwd mirror and the `debug_state` persist, and a second one would
 * let `trace` skip all three. A compose arrives already minted, so the handlers
 * fill it into the Shell's gate themselves.
 *
 * @param {boolean}                _active          Forwarded to `useGraphSource`, which never reads
 *                                                  it: the subscription is inert on its own when no
 *                                                  `_metadata` node is mounted. It holds the first
 *                                                  position, so `shell` keeps the second.
 * @param {Object}                 shell            Shell instance owned by DebugOverlay; sink wired
 *                                                  to the local interpreter. Its `prefix` and
 *                                                  `replyFrom` scope an invoke to the current cwd.
 * @param {Array}                  catalogClasses   Class catalog entries. `is_interpreter` decides
 *                                                  whether an invoke targets the node or its
 *                                                  `:config` sibling, and `arguments` becomes the
 *                                                  drop modal's argument schema.
 * @param {?Function}              onPositionChange `( id, { x, y } ) => void` — invoked on a palette
 *                                                  drop so the dropped node renders at the drop site
 *                                                  (snapped to the grid) when the metadata poll
 *                                                  surfaces it, instead of at autoLayout's choice.
 * @param {(line: string) => void} sendLine         `( line ) => void` — THE dispatch path, the same
 *                                                  one the prompt injects (echo, cwd mirror,
 *                                                  debug_state persist).
 * @param {() => void}             onReplSend       `() => void` — the hook's one rule for when the
 *                                                  REPL shows; see `useGraphHandlers`.
 * @return {{ graph: { nodes: Array, edges: Array }, ready: boolean, handlers: Object, pendingDrop: ?Object, commitDrop: (node: { name: string, args: string }) => void, cancelDrop: () => void }} The live graph,
 *   readiness flag, gesture handlers, and the palette-drop staging trio: `pendingDrop` is
 *   the staged `{ shellName, defaultName, argSchema, x, y }` payload (null when no drop is
 *   pending), `commitDrop({ name, args })` makes the node, `cancelDrop()` discards it.
 */
export function useDebugGraph(
	_active,
	shell,
	catalogClasses,
	onPositionChange,
	sendLine,
	onReplSend
) {
	// A drop stages here; commitDrop reads the ref, so its identity holds.
	const [ pendingDrop, setPendingDrop ] = useState( null );
	const pendingDropRef = useRef( null );
	pendingDropRef.current = pendingDrop;
	// Shared source: the published metadata, else the coreToGraph fallback.
	const { graph, hasNodes: ready } = useGraphSource( { active: _active } );

	// The invoke echo appends straight to the `_output` Dumper's transcript.
	const append = useCallback(
		( entry ) => Core.node( names.OUTPUT )?.append( entry ),
		[]
	);

	const handlers = useGraphHandlers( {
		shell,
		graph,
		catalogClasses,
		dispatch: sendLine,
		append,
		onReplSend,
		onDropStage: setPendingDrop,
	} );

	// Modal OK: make_node with the edited name and args, then the position.
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
			sendLine( `make_node ${ line }` );
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
		[ sendLine, onPositionChange ]
	);

	const cancelDrop = useCallback( () => setPendingDrop( null ), [] );

	return { graph, ready, handlers, pendingDrop, commitDrop, cancelDrop };
}
