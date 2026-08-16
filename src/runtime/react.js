import {
	useState,
	useEffect,
	useCallback,
	useId,
	useRef,
	useSyncExternalStore,
} from '@wordpress/element';
import { Core } from './core';

/**
 * Subscribe a component to a Node's `setState`, once per NOTIFY.
 *
 * Two notifications inside one React batch are one re-render carrying only the
 * later, so anything that ACTS on each publication — rather than rendering the
 * latest — has to register instead of reading state.
 *
 * The event is auto-declared, and that is load-bearing rather than lenient:
 * `removeNode()` empties `registrations`, so a node torn down between this
 * component's render and its effect would make `register()` throw. Switching
 * devtools tabs does exactly that — one graph comes down while the next goes
 * up — and the incoming tab took the crash.
 *
 * @param {string}   nodeName Registered node name.
 * @param {string}   event    Event key on `node.registrations`.
 * @param {Function} onNotify Called with each payload, including the cached
 *                            one replayed at registration.
 * @return {?Object} The node subscribed to, or null.
 */
export function useNodeEvent( nodeName, event, onNotify ) {
	const onNotifyRef = useRef( onNotify );
	onNotifyRef.current = onNotify;
	const reactId = useId();
	// Key the effect on the node instance so a name swap re-subscribes.
	const node = Core.node( nodeName );
	useEffect( () => {
		if ( ! node ) {
			return undefined;
		}
		if ( ! ( event in node.registrations ) ) {
			node.registrations[ event ] = {};
		}
		const listenerId = `react/${ reactId }/${ event }`;
		node.register( event, listenerId, ( payload ) => {
			onNotifyRef.current( payload );
			return true;
		} );
		return () => node.unregister( event, listenerId );
	}, [ node, event, reactId ] );
	return node;
}

/**
 * Subscribe a component to a Node's `setState` cache — the LATEST payload.
 *
 * @param {string} nodeName Registered node name.
 * @param {string} event    Event key on `node.registrations`.
 * @return {*} Current cached payload, or undefined.
 */
export function useNodeState( nodeName, event ) {
	const [ value, setValue ] = useState(
		() => Core.node( nodeName )?.setStateCache?.[ event ]
	);
	const node = useNodeEvent( nodeName, event, setValue );
	useEffect( () => {
		// A swap re-seeds, so a name change cannot strand the old state.
		setValue( node ? node.setStateCache?.[ event ] : undefined );
	}, [ node, event ] );
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
