/**
 * The React bridge onto a browser node graph: how a component reads what a Node
 * publishes, and how it hands one a message.
 *
 * Every hook here addresses a node by NAME and re-resolves it, because the
 * graph is rebuilt underneath the React tree — a station tab swap, the
 * overlay's Reset Graph — and a component holding an instance would go on
 * reading a removed node. A node publishes a string or number with
 * `setState`, which caches it and notifies; `register()` replays that cache.
 * Structured data lives in a node field published with `setField()`, and the
 * field is its own current value. Either way a component mounting mid-stream
 * renders current state rather than waiting for the next publication.
 */

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
 * component's render and its effect makes `register()` throw. Switching
 * station tabs does exactly that — one graph comes down while the next goes
 * up — and the crash lands in the incoming tab.
 *
 * The listener id carries the event as well as the React id, so one component
 * subscribing to two events on the same node holds two registrations instead
 * of overwriting its own.
 *
 * @param {string}                   nodeName Registered node name.
 * @param {string}                   event    Event key on `node.registrations`.
 * @param {( payload: any ) => void} onNotify Called with each payload, including
 *                                            the cached one replayed at
 *                                            registration.
 * @return {?Object} The node subscribed to, or null while the name is unbound.
 *                   Callers key their own effects on that instance, so a swap
 *                   under a stable name re-runs them.
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
 * The rendering half of the pair: a burst of notifications inside one React
 * batch costs one re-render, carrying the last payload. A dashboard widget
 * reads its own slice this way and owns its own empty state, which is what
 * keeps one widget from blanking another.
 *
 * The value is undefined until a node holds the name and has published once,
 * so every caller renders a valid empty state.
 *
 * @param {string} nodeName Registered node name.
 * @param {string} event    Event key on `node.registrations`.
 * @return {*} Current cached payload, or undefined.
 */
export function useNodeState( nodeName, event ) {
	return useNodeRead(
		nodeName,
		event,
		( node ) => node?.setStateCache?.[ event ]
	);
}

/**
 * Read a node FIELD — structured data a node publishes with `setField()` —
 * and re-read it on each announcement.
 *
 * The counterpart of `useNodeState` for everything that is not a string or
 * number: a transcript, the metadata tree, a view model. Nothing is cached,
 * because the field IS the current value, so a component mounting late reads
 * it straight off the node. The node assigns a new object on each change,
 * which is what makes the re-read a re-render.
 *
 * @param {string} nodeName Registered node name.
 * @param {string} field    The field, and the event its changes notify.
 * @return {*} The field's current value, or undefined while no node holds the
 *             name.
 */
export function useNodeField( nodeName, field ) {
	return useNodeRead( nodeName, field, ( node ) => node?.[ field ] );
}

/**
 * The one body behind `useNodeState` and `useNodeField`: seed from the node,
 * re-read on each notify of `event`, and re-seed when a rebuild swaps the node
 * under the name, so a name change cannot strand the old value.
 *
 * @param {string}                 nodeName Registered node name.
 * @param {string}                 event    Event whose notify triggers a re-read.
 * @param {( node: ?Object ) => *} read     What to read off the node, or off null.
 * @return {*} The latest read.
 */
function useNodeRead( nodeName, event, read ) {
	const [ value, setValue ] = useState( () => read( Core.node( nodeName ) ) );
	const node = useNodeEvent( nodeName, event, () =>
		setValue( read( Core.node( nodeName ) ) )
	);
	useEffect( () => {
		setValue( read( node ) );
		// eslint-disable-next-line react-hooks/exhaustive-deps -- read keys on event.
	}, [ node, event ] );
	return value;
}

/**
 * Subscribe to graph-generation bumps on behalf of `useSyncExternalStore`.
 *
 * Defined at module scope because React re-subscribes whenever `subscribe`
 * changes identity; a closure rebuilt per render would drop and re-add the
 * listener on every render.
 *
 * @param {() => void} onChange Called after each bump.
 * @return {() => boolean} Unsubscribe, for the effect cleanup. Its boolean is
 *                         what `Set.delete` answered; callers ignore it.
 */
const subscribeGeneration = ( onChange ) =>
	Core.subscribeGraphGeneration( onChange );

/**
 * Read the current generation. Serves as both snapshot getters, since the
 * server render sees the same module-scope counter.
 *
 * @return {number} `Core.graphGeneration`.
 */
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
 * The lookup runs at call time rather than at render, so the callback keeps
 * working across a rebuild that replaced the node under that name. It discards
 * the message while no node holds the name: a component can mount and take a
 * click before the graph it addresses is built, and throwing from the handler
 * would take the page down with it.
 *
 * @param {string} nodeName Registered node name.
 * @return {( message: Array ) => void} Fills the named node.
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
