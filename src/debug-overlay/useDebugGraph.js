import { useEffect, useMemo, useState } from '@wordpress/element';
import { Core } from '../runtime/core';
import { coreToGraph } from '../topology-console/utils/coreToGraph';
import { dispatchLocal } from '../topology-console/utils/localCommand';
import { generateNodeName } from '../topology-console/utils/draftGraph';
import names from '../runtime/reserved-node-names.json';

// 1s redraw cadence (matches the console's dump_metadata poll feel).
const TICK_MS = 1000;

/**
 * The page's own live graph + the command handlers that mutate it. Reads
 * `coreToGraph()` on a 1s tick (counters animate) and dispatches gestures as
 * empty-TO commands into the page's own CommandInterpreter.
 *
 * @param {boolean} [active] When false, the 1s poll is gated off (no interval). Pass `enabled && open` so the timer only runs while the overlay is visible.
 * @return {{ graph: { nodes: Array, edges: Array }, handlers: Object }} The live graph and gesture handlers.
 */
export function useDebugGraph( active = true ) {
	const [ graph, setGraph ] = useState( () => coreToGraph() );

	useEffect( () => {
		if ( ! active ) {
			return undefined;
		}
		// Refresh once on activation so the panel shows the current graph instantly.
		setGraph( coreToGraph() );
		const id = setInterval( () => setGraph( coreToGraph() ), TICK_MS );
		return () => clearInterval( id );
	}, [ active ] );

	const ci = () => Core.node( names.COMMAND_INTERPRETER );

	const handlers = useMemo(
		() => ( {
			onConnect: ( from, to ) =>
				dispatchLocal( ci(), 'connect_node', `${ from } ${ to }` ),
			onRemoveNode: ( id ) => dispatchLocal( ci(), 'remove_node', id ),
			onDropNode: ( { shellName } ) => {
				// SchematicCanvas passes {shellName, x, y} — destructure to match.
				// generateNodeName uniques against the live graph (read off Core,
				// the source of truth) so the new id won't collide with an existing
				// node. Position is cosmetic and not sent — poll-reflect lays out.
				const name = generateNodeName( coreToGraph(), shellName );
				dispatchLocal( ci(), 'make_node', `${ shellName } ${ name }` );
			},
			onInspectorAction: ( action, nodeId, payload ) => {
				// Parity with TopologyConsole.handleInspectorAction: dump, tail
				// (connect_node with no target), disconnect, send, trace, invoke.
				if ( action === 'dump' ) {
					dispatchLocal( ci(), 'dump_node', nodeId );
				} else if ( action === 'tail' ) {
					dispatchLocal( ci(), 'connect_node', nodeId );
				} else if ( action === 'disconnect' ) {
					dispatchLocal( ci(), 'disconnect_node', nodeId );
				} else if ( action === 'send' ) {
					dispatchLocal(
						ci(),
						'send_node',
						`${ nodeId } ${ payload }`
					);
				} else if ( action === 'trace' ) {
					const level = typeof payload === 'number' ? payload : 1;
					dispatchLocal(
						ci(),
						'debug_state',
						`${ nodeId } ${ level }`
					);
				} else if ( action === 'invoke' && payload ) {
					const { verb, positional } = payload;
					dispatchLocal(
						Core.node( `${ nodeId }:config` ) || ci(),
						verb,
						positional || ''
					);
				}
			},
		} ),
		[]
	);

	return { graph, handlers };
}
