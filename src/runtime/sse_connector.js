/* global EventSource */
import { Node } from './node';
import { TYPE, KEY, VALUE, TM_INFO, unpack } from './message';

/**
 * Browser-side Node that opens an EventSource against the substrate's
 * consolidated SSE endpoint and dispatches each `msg` event into the
 * local node graph via `fill()`. Also reads the server-side process pid
 * from the initial `connected` envelope so pivoted commands know which
 * `_http/<ssePid>` FROM path to stamp.
 *
 * The wire envelope is always `event: msg` with a JSON-encoded
 * Message-array body. The `connected` semantics are handled here by
 * snooping for TM_INFO + KEY='connected' and stashing the payload via
 * setState so `pid()` can read it back.
 */
export class SseConnector extends Node {
	constructor( { subscribe, interval, baseUrl, nonce } ) {
		super();
		this.subscribe = subscribe;
		this.interval = interval;
		this.baseUrl = baseUrl;
		this.nonce = nonce;
		this._es = null;
		this.registrations.connected = {};
	}

	pid() {
		return this.setStateCache.connected?.pid ?? null;
	}

	start() {
		const url =
			`${ this.baseUrl }newspack-nodes/v1/messages/stream` +
			`?subscribe=${ encodeURIComponent( this.subscribe.join( ',' ) ) }` +
			`&interval=${ this.interval }` +
			`&_wpnonce=${ this.nonce }`;
		this._es = new EventSource( url, { withCredentials: true } );
		this._es.addEventListener( 'msg', ( e ) => {
			const msg = unpack( e.data );
			if (
				// eslint-disable-next-line no-bitwise
				msg[ TYPE ] & TM_INFO &&
				'connected' === msg[ KEY ]
			) {
				this.setState( 'connected', msg[ VALUE ] );
			}
			this.fill( msg );
		} );
	}

	close() {
		if ( this._es ) {
			this._es.close();
		}
		this._es = null;
	}
}
