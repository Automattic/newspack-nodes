/* global EventSource */
/**
 * Topology Console SSE Connection Hook
 *
 * Subscribes to TopologyStreamController for a single (topology, partition)
 * pair. The endpoint is a pivoted-REPL-over-HTTP: it emits `hello` once,
 * `msg` for every Message the worker's _repl conduit forwards, and
 * `heartbeat` every five seconds while the connection is open.
 *
 * The hook keeps the EventSource open for the lifetime of the component.
 * Unmount closes the connection so the server-side loop's
 * connection_aborted() check fires and the worker stops being poked with
 * ls commands.
 */

import { useEffect, useRef, useState } from '@wordpress/element';

/**
 * Subscribe to the topology SSE stream.
 *
 * @param {string}   topology    Topology name (e.g. 'firehose-workers').
 * @param {number}   partition   Partition number.
 * @param {Function} [onMessage] Called synchronously for every `msg` event.
 *                               Bypasses React state, so a burst of
 *                               messages can't get coalesced away by
 *                               state batching the way setLastMessage
 *                               could (when a TM_STRUCT broadcast flood
 *                               clobbered a single setLastMessage call,
 *                               command responses got lost).
 * @return {{status, ssePid}} Connection state + the worker's pid from
 *                            the hello event.
 */
export function useTopologyStream( topology, partition, onMessage ) {
	const [ status, setStatus ] = useState( 'connecting' );
	const [ ssePid, setSsePid ] = useState( null );

	// Stash the latest onMessage in a ref so the EventSource handler
	// always sees the freshest closure without needing to re-subscribe
	// on every render.
	const onMessageRef = useRef( onMessage );
	useEffect( () => {
		onMessageRef.current = onMessage;
	}, [ onMessage ] );

	useEffect( () => {
		setSsePid( null );
		const data = window.NewspackNodesData;
		if ( ! data || ! data.restUrl ) {
			setStatus( 'error' );
			return undefined;
		}
		const baseUrl = data.restUrl;
		const nonce = data.nonce || '';
		const url = `${ baseUrl }newspack-nodes/v1/topology/${ encodeURIComponent(
			topology
		) }/p${ encodeURIComponent(
			partition
		) }/stream?_wpnonce=${ encodeURIComponent( nonce ) }`;
		const es = new EventSource( url, { withCredentials: true } );

		es.addEventListener( 'hello', ( e ) => {
			setStatus( 'open' );
			try {
				const hello = JSON.parse( e.data );
				if ( hello && typeof hello.pid === 'number' ) {
					setSsePid( hello.pid );
				}
			} catch ( err ) {
				// Stay connected even if the hello payload is unparseable;
				// command POSTs will simply have no pid to stamp.
			}
		} );
		es.addEventListener( 'heartbeat', () => {
			/* keep-alive only */
		} );
		es.addEventListener( 'msg', ( e ) => {
			try {
				const m = JSON.parse( e.data );
				if ( onMessageRef.current ) {
					onMessageRef.current( m );
				}
			} catch ( err ) {
				// Malformed payloads are dropped silently — the SSE
				// controller already validates JSON before emit, so this
				// branch is defensive against future protocol drift.
			}
		} );
		es.onerror = () => setStatus( 'error' );

		return () => {
			es.close();
			setStatus( 'closed' );
		};
	}, [ topology, partition ] );

	return { status, ssePid };
}
