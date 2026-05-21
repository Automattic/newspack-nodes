import { useState, useEffect, useCallback, useId } from '@wordpress/element';
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
	// Key the effect on the node instance so a swap under a stable name
	// re-subscribes to the new node, not the dead one.
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
		// Re-seed from the new node's cache so a swap doesn't strand old state.
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
