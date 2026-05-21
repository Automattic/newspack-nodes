import { useState, useEffect, useCallback, useId } from '@wordpress/element';
import { Core } from './core';

/**
 * Subscribe a component to a Node's `setState` cache.
 *
 * Registers a closure-mode listener on `node.registrations[event]` and
 * returns the latest cached payload. If the event has not yet been
 * pre-declared on the node, this auto-declares it (ergonomics — without
 * the auto-declare, every consumer would need to seed the registration
 * map before the hook could attach).
 *
 * Returns `undefined` until either (a) the node exists and `setState` has
 * been called for `event`, or (b) a later `setState` fires. Re-renders
 * the host component when the cached value changes.
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
	// Resolve the node during render and key the subscribe effect on the
	// instance (not just the name) so a node swapped under a stable name —
	// e.g. a per-session graph rebuilt on worker change — re-subscribes to
	// the NEW node instead of stranding the listener on the dead one.
	const node = Core.node( nodeName );
	useEffect( () => {
		if ( ! node ) {
			// No node (yet, or torn down): drop any stale value so the
			// component doesn't keep showing a removed node's state.
			setValue( undefined );
			return undefined;
		}
		if ( ! ( event in node.registrations ) ) {
			node.registrations[ event ] = {};
		}
		// Re-seed from the new node's cache (undefined if it has none) so a
		// swap doesn't leave the previous node's value on screen until the
		// next setState.
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
 * The callback is a no-op if no node is registered under `nodeName`.
 * Identity is stable across renders for any fixed `nodeName`, so the
 * callback can be passed to memoized children without churn.
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
