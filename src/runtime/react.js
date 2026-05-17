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
	useEffect( () => {
		const node = Core.node( nodeName );
		if ( ! node ) {
			return undefined;
		}
		if ( ! ( event in node.registrations ) ) {
			node.registrations[ event ] = {};
		}
		const listenerId = `react/${ reactId }/${ event }`;
		node.register( event, listenerId, ( payload ) => {
			setValue( payload );
			return true;
		} );
		return () => node.unregister( event, listenerId );
	}, [ nodeName, event, reactId ] );
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
