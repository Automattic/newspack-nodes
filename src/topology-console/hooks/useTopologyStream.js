/**
 * Topology Console SSE Connection Hook
 *
 * Thin adapter over the substrate's shared `useMessageStream` hook. The
 * topology console no longer has its own SSE endpoint — it subscribes to
 * the worker's broadcast IPC partition through the generic
 * `/messages/stream` endpoint (subscription `{topology}.p{N}`, resolved
 * server-side via `Cli::attach_to_worker`), exactly like every other M4
 * dashboard.
 *
 * Two adaptations keep the rest of TopologyConsole unchanged:
 *
 *   1. The session pid the console needs for pivoted `/command` calls
 *      comes from the substrate's first `connected` envelope
 *      (KEY=='connected', VALUE.pid) instead of a bespoke `hello` event.
 *
 *   2. `useMessageStream` hands the caller a raw positional Message array
 *      (`[type, ts, from, to, id, key, value]`). The console's
 *      handleMessage was written against the old per-feed object shape
 *      (`{type, ts, from, to, id, key, value}`), so we convert here once
 *      rather than touch every reader downstream.
 *
 * The hook keeps the connection open for the component's lifetime and
 * closes it on unmount or when `enabled` flips false (edit mode), so the
 * server-side drain loop's `connection_aborted()` check fires and the
 * worker stops being poked.
 */

import { useEffect, useRef, useState } from '@wordpress/element';
import useMessageStream from '../../shared/hooks/useMessageStream';
import {
	TYPE,
	TIMESTAMP,
	FROM,
	TO,
	ID,
	KEY,
	VALUE,
} from '../../runtime/message';

/**
 * Subscribe to a single worker's broadcast partition over the unified
 * message-stream endpoint.
 *
 * @param {string}   topology    Topology name (e.g. 'firehose-workers').
 * @param {number}   partition   Partition number.
 * @param {Function} [onMessage] Called synchronously for every Message
 *                               (converted to object shape). Bypasses
 *                               React state so a burst can't be coalesced
 *                               away by batching.
 * @param {boolean}  [enabled]   Set false to short-circuit the stream —
 *                               edit mode uses this so the canvas stops
 *                               poking the live worker.
 * @return {{status: string, ssePid: ?number}} Connection state + the
 *                               session pid from the connected envelope.
 */
export function useTopologyStream(
	topology,
	partition,
	onMessage,
	enabled = true
) {
	const [ status, setStatus ] = useState( enabled ? 'connecting' : 'closed' );
	const [ ssePid, setSsePid ] = useState( null );

	// Stash the latest onMessage in a ref so the stream adapter always
	// sees the freshest closure without re-subscribing each render.
	const onMessageRef = useRef( onMessage );
	useEffect( () => {
		onMessageRef.current = onMessage;
	}, [ onMessage ] );

	// Adapter: intercept the substrate `connected` envelope to harvest the
	// session pid + flip to open; convert every other positional Message
	// array into the object shape the console's handleMessage expects.
	const handleEnvelope = useRef( null );
	handleEnvelope.current = ( envelope ) => {
		if ( ! Array.isArray( envelope ) ) {
			return;
		}
		if ( 'connected' === envelope[ KEY ] ) {
			setStatus( 'open' );
			const value = envelope[ VALUE ];
			if ( value && typeof value.pid === 'number' ) {
				setSsePid( value.pid );
			}
			return;
		}
		if ( onMessageRef.current ) {
			onMessageRef.current( {
				type: envelope[ TYPE ],
				ts: envelope[ TIMESTAMP ],
				from: envelope[ FROM ],
				to: envelope[ TO ],
				id: envelope[ ID ],
				key: envelope[ KEY ],
				value: envelope[ VALUE ],
			} );
		}
	};

	const subscription = `${ topology }.p${ partition }`;
	const { error, connect, close } = useMessageStream( {
		subscriptions: enabled ? [ subscription ] : [],
		onMessage: ( envelope ) => handleEnvelope.current( envelope ),
	} );

	// Connection lifecycle. `enabled: false` short-circuits — the operator
	// is authoring offline in edit mode, so streaming is wasted load and a
	// misleading LIVE LED.
	useEffect( () => {
		if ( ! enabled ) {
			setStatus( 'closed' );
			setSsePid( null );
			return undefined;
		}
		setStatus( 'connecting' );
		setSsePid( null );
		connect();
		return () => {
			close();
			setStatus( 'closed' );
		};
	}, [ topology, partition, enabled, connect, close ] );

	// useMessageStream surfaces transient connection trouble as a non-null
	// `error` string (it self-reconnects with backoff). Reflect it as the
	// `error` status the Header LED reads, overriding the lifecycle status.
	// Derived (not stored) so a later recovery automatically falls back to
	// the connecting/open/closed lifecycle value.
	const effectiveStatus = enabled && error ? 'error' : status;

	return { status: effectiveStatus, ssePid };
}
