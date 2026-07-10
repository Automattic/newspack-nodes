import {
	useState,
	useEffect,
	useCallback,
	useId,
	useSyncExternalStore,
} from '@wordpress/element';
import { Core } from './core';

/**
 * Subscribe a component to a Node's `setState` cache (auto-declares the event).
 *
 * @param {string} nodeName Registered node name.
 * @param {string} event    Event key on `node.registrations`.
 * @return {*} Current cached payload, or undefined.
 */
export function useNodeState( nodeName, event ) {
	const [ value, setValue ] = useState(
		() => Core.node( nodeName )?.setStateCache?.[ event ]
	);
	const reactId = useId();
	// Key the effect on the node instance so a name swap re-subscribes.
	const node = Core.node( nodeName );
	useEffect( () => {
		if ( ! node ) {
			// No node: drop any stale value.
			setValue( undefined );
			return undefined;
		}
		if ( ! ( event in node.registrations ) ) {
			node.registrations[ event ] = {};
		}
		// Re-seed from the new node's cache so a swap doesn't strand state.
		setValue( node.setStateCache?.[ event ] );
		const listenerId = `react/${ reactId }/${ event }`;
		node.register( event, listenerId, ( payload ) => {
			setValue( payload );
			return true;
		} );
		return () => node.unregister( event, listenerId );
	}, [ node, event, reactId ] );
	return value;
}

// Stable useSyncExternalStore refs — defined once so `subscribe` is stable.
const subscribeGeneration = ( onChange ) =>
	Core.subscribeGraphGeneration( onChange );
const getGeneration = () => Core.graphGeneration;

/**
 * Subscribe to Core's full-graph-rebuild signal. A change re-renders the caller
 * and, when included in a graph-building effect's deps, re-runs that effect
 * (cleanup tears down its nodes, the effect rebuilds them). The overlay's Reset
 * Graph bumps it to reconstruct the entire graph in place.
 *
 * @return {number} The current graph generation.
 */
export function useGraphGeneration() {
	return useSyncExternalStore(
		subscribeGeneration,
		getGeneration,
		getGeneration
	);
}

/**
 * Return a stable callback that fills a message into the named Node.
 *
 * @param {string} nodeName Registered node name.
 * @return {Function} `( message ) => void`.
 */
export function useNodeFill( nodeName ) {
	return useCallback(
		( message ) => {
			const node = Core.node( nodeName );
			if ( node ) {
				node.fill( message );
			}
		},
		[ nodeName ]
	);
}
