/* global EventSource */
/**
 * `rawlogs/stream` — the SSE-in node that owns the live connection for the
 * *selected* log.
 *
 * `subscribe(logKey)` (re)connects an SSE source for that subscription; each
 * inbound `msg` event is parsed into a Message envelope and emitted to the sink
 * (→ `rawlogs/transform`). Switching logs closes the old source and opens a new
 * one. `close()` tears the connection down.
 *
 * The connection itself — EventSource open, `msg` parse, the slot-heartbeat poke
 * that keeps `Sse_Slot_Pool`'s TTL alive, and the reconnect backoff — is the
 * connection logic of the `useMessageStream` React hook, extracted into a NODE.
 * It lives behind an injectable `connector` seam: tests pass `opts.connector`
 * (a fake) so they never touch a real EventSource; production lazily defaults to
 * the real-EventSource connector below.
 */

import { Node } from '../../runtime/node';
import { KEY, VALUE, unpack } from '../../runtime/message';
import { getCommandClient } from '../../shared/utils/commandClient';

// Client keep-alive cadence; the slot TTL keys off this poke (not the server
// heartbeat). Half-TTL survives one missed poke without flooding.
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
 * The default connector — the real-EventSource transport for `rawlogs/stream`.
 *
 * `connect( subscription, onEnvelope )` opens an EventSource at `/messages/stream`
 * for the subscription, parses each `msg` into a Message envelope and hands it to
 * `onEnvelope`, starts the slot-heartbeat poke once the `connected` envelope
 * arrives, and reconnects with backoff on error. `close()` tears all three down.
 *
 * Faked in tests by swapping `global.EventSource`; the node-level tests inject
 * their own connector entirely.
 */
function makeDefaultConnector() {
	let source = null;
	let reconnectTimer = null;
	let slotInterval = null;
	let retries = 0;
	let current = null;
	let handler = null;

	const clearReconnect = () => {
		if ( reconnectTimer ) {
			clearTimeout( reconnectTimer );
			reconnectTimer = null;
		}
	};
	const clearSlot = () => {
		if ( slotInterval ) {
			clearInterval( slotInterval );
			slotInterval = null;
		}
	};

	const close = () => {
		clearReconnect();
		clearSlot();
		if ( source ) {
			source.close();
			source = null;
		}
	};

	const open = () => {
		const data =
			( 'undefined' !== typeof window && window.NewspackNodesData ) || {};
		const qs =
			`subscribe=${ encodeURIComponent( current ) }` +
			`&_wpnonce=${ encodeURIComponent( data.nonce || '' ) }`;
		const url = `${
			data.restUrl || '/wp-json/'
		}newspack-nodes/v1/messages/stream?${ qs }`;
		source = new EventSource( url, { withCredentials: true } );

		source.addEventListener( 'msg', ( ev ) => {
			const envelope = unpack( ev.data );

			// First envelope (KEY='connected') carries the slot id; start the
			// keep-alive poker so an idle slot doesn't expire its TTL.
			if (
				'connected' === envelope[ KEY ] &&
				envelope[ VALUE ] &&
				Number.isInteger( envelope[ VALUE ].slot ) &&
				envelope[ VALUE ].slot >= 0
			) {
				const slot = envelope[ VALUE ].slot;
				clearSlot();
				slotInterval = setInterval( () => {
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

			if ( handler ) {
				handler( envelope );
			}
		} );

		source.onerror = () => {
			// Reconnect-stack guard: EventSource fires `error` per readyState
			// change; without this we'd stack timers and burn the slot pool.
			if ( reconnectTimer ) {
				return;
			}
			source.close();
			source = null;
			retries += 1;
			reconnectTimer = setTimeout( () => {
				reconnectTimer = null;
				open();
			}, backoffDelay( retries ) );
		};

		source.onopen = () => {
			retries = 0;
		};
	};

	return {
		connect( subscription, onEnvelope ) {
			current = subscription;
			handler = onEnvelope;
			retries = 0;
			open();
		},
		close,
	};
}

class RawLogsStreamNode extends Node {
	constructor( connector ) {
		super();
		this._connector = connector;
		this._subscribed = false;
	}

	// (Re)connect the live source for `logKey`. Switching logs closes the old
	// source first, then opens the new one; each inbound envelope goes to sink.
	subscribe( logKey ) {
		if ( this._subscribed ) {
			this._connector.close();
		}
		this._subscribed = true;
		this._connector.connect( logKey, ( envelope ) => {
			if ( this.sink ) {
				this.sink.fill( envelope );
			}
		} );
	}

	// Tear the connection down. Unconditional so teardown closes a never-yet-
	// subscribed stream too (the connector's close is idempotent/null-guarded).
	close() {
		this._connector.close();
		this._subscribed = false;
	}
}

/**
 * Create and register the Raw Logs stream node.
 *
 * @param {string} name             Node name.
 * @param {Object} [opts]           Options.
 * @param {Object} [opts.connector] Injectable connector seam (connect/close);
 *                                  defaults to the real-EventSource connector.
 * @return {RawLogsStreamNode} The stream node.
 */
export function createRawLogsStream( name, opts = {} ) {
	const connector = opts.connector || makeDefaultConnector();
	const node = new RawLogsStreamNode( connector );
	node.setName( name );
	return node;
}
