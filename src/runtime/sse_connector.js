/* global EventSource */
import { Node } from './node';
import { TYPE, KEY, VALUE, TM_INFO, unpack } from './message';

/**
 * Browser-side Node opening an EventSource and filling each `msg` into the
 * local graph. Snoops the `connected` envelope so `pid()` can read it back.
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
		this.close();
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
				// Snoop-only: the envelope drives pid()/the `connected` event; it is
				// metadata, not a graph message — don't route it (it would land in
				// the transcript).
				this.setState( 'connected', msg[ VALUE ] );
				return;
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
