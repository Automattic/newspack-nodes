import { useCallback, useRef, useState } from '@wordpress/element';
import { Core } from '../runtime/core';
import { snapToGrid } from '../topology-console/utils/autoLayout';
import { useGraphSource } from '../topology-console/hooks/useGraphSource';
import { useGraphHandlers } from '../topology-console/hooks/useGraphHandlers';
import { FROM, applyComposeFields } from '../runtime/message';
import { tokenize } from '../runtime/shell-node';
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
	// Drop with args stages here; ref-mirror avoids StrictMode double-run.
	const [ pendingDrop, setPendingDrop ] = useState( null );
	const pendingDropRef = useRef( null );
	pendingDropRef.current = pendingDrop;
	// Shared metadata‖coreToGraph source; ready = the graph carries a node.
	const { graph, hasNodes: ready } = useGraphSource( { active: _active } );

	// Echo the line into `_output` then dispatch (reply routes back via FROM).
	const sendVerb = useCallback(
		( echoText, path, name, args = '', fields = null ) => {
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
				// Compose modal's flag checkboxes + FROM / ID / KEY inputs.
				applyComposeFields( parsed, fields );
				shell.dispatch( parsed );
			} else {
				// Tokenize the raw arg tail at the producer boundary.
				shell.sendCommand( path, name, tokenize( args || '' ) );
			}
		},
		[ shell ]
	);

	// Non-invoke verbs echo + route via sendVerb (path '' — overlay local).
	const dispatch = useCallback(
		( echoLine, name, args, fields ) =>
			sendVerb( echoLine, '', name, args, fields ),
		[ sendVerb ]
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
			sendVerb( `make_node ${ line }`, '', 'make_node', line );
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
		[ sendVerb, onPositionChange ]
	);

	const cancelDrop = useCallback( () => setPendingDrop( null ), [] );

	return { graph, ready, handlers, pendingDrop, commitDrop, cancelDrop };
}
