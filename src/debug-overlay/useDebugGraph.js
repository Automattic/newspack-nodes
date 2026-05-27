import { useEffect, useMemo, useState } from '@wordpress/element';
import { Core } from '../runtime/core';
import { coreToGraph } from '../topology-console/utils/coreToGraph';
import { dispatchLocal } from '../topology-console/utils/localCommand';
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
			onDropNode: ( shellName ) =>
				dispatchLocal(
					ci(),
					'make_node',
					`${ shellName } ${ shellName.toLowerCase() }-${ Date.now() }`
				),
			onInspectorAction: ( action, nodeId, payload ) => {
				if ( action === 'dump' ) {
					dispatchLocal( ci(), 'dump_node', nodeId );
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
