/* global EventSource */
/**
 * Message-Stream SSE Connection Hook — subscribes to named logs / IPC
 * partitions on `/messages/stream`, tracking per-partition resume offsets.
 */

import { useState, useRef, useCallback } from '@wordpress/element';
import { getCommandClient } from '../utils/commandClient';

const TYPE = 0;
const FROM = 2;
const ID = 4;
const KEY = 5;
const VALUE = 6;

// Client keep-alive cadence; the slot TTL keys off this poke (not the
// server heartbeat). Half-TTL survives one missed poke without flooding.
const SLOT_HEARTBEAT_MS = 5000;
const SLOT_TTL_S = 10;

/**
 * Exponential backoff with a 30s cap.
 *
 * @param {number} retries Current retry count.
 * @return {number} Delay in milliseconds.
 */
const backoffDelay = ( retries ) =>
	Math.min( 30000, 1000 * Math.pow( 2, retries ) );

/**
 * @param {Object}   options
 * @param {string[]} options.subscriptions   Subscription names (CSV-joined server-side).
 * @param {Function} options.onMessage       Called per `msg` event with the parsed envelope.
 * @param {Function} options.onBeforeConnect Called before each (re)connect attempt.
 * @return {Object} { error, connect, close, lastEventTime }
 */
export default function useMessageStream( {
	subscriptions = [],
	onMessage,
	onBeforeConnect,
} ) {
	const [ error, setError ] = useState( null );
	const [ lastEventTime, setLastEventTime ] = useState( null );

	const sourceRef = useRef( null );
	const retryRef = useRef( 0 );
	const reconnectTimeoutRef = useRef( null );
	// Slot id from the `connected` envelope + setInterval handle for the
	// keep-alive poke that touches Sse_Slot_Pool's TTL on every tick.
	const slotIntervalRef = useRef( null );

	// Per-subscription per-partition positions. Shape:
	//   { 'firehose': { 0: { seg: 42, off: 1024 }, 1: { ... } } }
	const positionsRef = useRef( {} );

	// Refs let connect() stay stable across re-renders.
	const subsKeyRef = useRef( subscriptions.join( ',' ) );
	subsKeyRef.current = subscriptions.join( ',' );
	const onMessageRef = useRef( onMessage );
	onMessageRef.current = onMessage;
	const onBeforeConnectRef = useRef( onBeforeConnect );
	onBeforeConnectRef.current = onBeforeConnect;
	const lastSubsKeyRef = useRef( null );

	const close = useCallback( () => {
		if ( reconnectTimeoutRef.current ) {
			clearTimeout( reconnectTimeoutRef.current );
			reconnectTimeoutRef.current = null;
		}
		if ( slotIntervalRef.current ) {
			clearInterval( slotIntervalRef.current );
			slotIntervalRef.current = null;
		}
		if ( sourceRef.current ) {
			sourceRef.current.close();
			sourceRef.current = null;
		}
	}, [] );

	const connect = useCallback( () => {
		close();
		setError( null );

		// Drop saved positions when the subscription set changes (stale offsets).
		const currentSubsKey = subsKeyRef.current;
		if (
			lastSubsKeyRef.current !== null &&
			lastSubsKeyRef.current !== currentSubsKey
		) {
			positionsRef.current = {};
		}
		lastSubsKeyRef.current = currentSubsKey;

		if ( onBeforeConnectRef.current ) {
			onBeforeConnectRef.current();
		}

		const data = window.NewspackNodesData;
		if ( ! data || ! data.restUrl ) {
			setError( 'Dashboard configuration not available.' );
			return;
		}

		if ( ! currentSubsKey ) {
			// No subscriptions — caller is in a deselected/loading state.
			return;
		}

		const params = {
			subscribe: currentSubsKey,
			_wpnonce: data.nonce,
		};
		if ( Object.keys( positionsRef.current ).length > 0 ) {
			params.positions = JSON.stringify( positionsRef.current );
		}
		const qs = Object.entries( params )
			.map(
				( [ k, v ] ) =>
					`${ encodeURIComponent( k ) }=${ encodeURIComponent( v ) }`
			)
			.join( '&' );
		const url = `${ data.restUrl }newspack-nodes/v1/messages/stream?${ qs }`;
		const source = new EventSource( url, { withCredentials: true } );
		sourceRef.current = source;

		const touch = () => setLastEventTime( Date.now() );

		source.addEventListener( 'msg', ( ev ) => {
			touch();
			let envelope;
			try {
				envelope = JSON.parse( ev.data );
			} catch ( e ) {
				return;
			}
			if ( ! Array.isArray( envelope ) ) {
				return;
			}

			// First envelope (KEY='connected') carries the slot id; start the
			// keep-alive poker so an idle slot doesn't expire its TTL.
			if ( 'connected' === envelope[ KEY ] && envelope[ VALUE ] ) {
				const slot = envelope[ VALUE ].slot;
				if ( Number.isInteger( slot ) && slot >= 0 ) {
					if ( slotIntervalRef.current ) {
						clearInterval( slotIntervalRef.current );
					}
					slotIntervalRef.current = setInterval( () => {
						getCommandClient()
							.send( {
								to: 'workers',
								verb: 'heartbeat',
								args: `${ slot } ${ SLOT_TTL_S }`,
							} )
							.catch( () => {
								// Best-effort; TTL grace absorbs transient failures.
							} );
					}, SLOT_HEARTBEAT_MS );
				}
			}

			// Track resume position from FROM=`{sub}.pN` + ID=`seg:off`.
			const from = String( envelope[ FROM ] || '' );
			const dotP = from.lastIndexOf( '.p' );
			if ( dotP > 0 ) {
				const sub = from.substring( 0, dotP );
				const partition = parseInt( from.substring( dotP + 2 ), 10 );
				const id = String( envelope[ ID ] || '' );
				const colon = id.indexOf( ':' );
				if ( ! Number.isNaN( partition ) && colon > 0 ) {
					const seg = parseInt( id.substring( 0, colon ), 10 );
					const off = parseInt( id.substring( colon + 1 ), 10 );
					if ( ! Number.isNaN( seg ) && ! Number.isNaN( off ) ) {
						if ( ! positionsRef.current[ sub ] ) {
							positionsRef.current[ sub ] = {};
						}
						positionsRef.current[ sub ][ partition ] = {
							seg,
							off,
						};
					}
				}
			}

			// Hand off to caller (it filters by FROM/KEY as needed).
			if ( onMessageRef.current ) {
				onMessageRef.current( envelope, { type: envelope[ TYPE ] } );
			}
		} );

		source.addEventListener( 'heartbeat', touch );

		source.onerror = () => {
			// Reconnect-stack guard: EventSource fires `error` per readyState
			// change; without this we'd stack timers and burn the slot pool.
			if ( reconnectTimeoutRef.current ) {
				return;
			}
			source.close();
			sourceRef.current = null;
			retryRef.current += 1;
			const delay = backoffDelay( retryRef.current );
			setError( `Reconnecting in ${ Math.round( delay / 1000 ) }s...` );
			reconnectTimeoutRef.current = setTimeout( () => {
				reconnectTimeoutRef.current = null;
				connect();
			}, delay );
		};

		source.onopen = () => {
			retryRef.current = 0;
		};
	}, [ close ] );

	return { error, connect, close, lastEventTime };
}
