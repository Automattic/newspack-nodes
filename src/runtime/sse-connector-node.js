/* global EventSource */
import { Node } from './node';
import { TYPE, KEY, VALUE, TM_INFO, unpack } from './message';

/**
 * Browser-side Node opening an EventSource and filling each `msg` into the
 * local graph. Snoops the `connected` envelope so `pid()` can read it back.
 *
 * Tachikoma-parity: no-arg ctor. Positional config arrives via `arguments=`,
 * which the base setter parses against `nodeSchema().arguments`. The setter
 * is overridden here to split the comma-separated `subscribe` token into the
 * array the runtime expects (the base walker only assigns strings).
 */
export class SseConnectorNode extends Node {
	constructor() {
		super();
		this.subscribe = [];
		this.baseUrl = '';
		this.nonce = '';
		this._es = null;
		this.registrations.connected = {};
	}

	static nodeSchema() {
		return {
			category: 'I/O',
			description: 'Browser-side EventSource boundary.',
			// Pure network-ingress SOURCE: EventSource calls fill() on inbound events.
			accepts_fill: false,
			arguments: [
				{ name: 'subscribe', type: 'string', required: true },
				{ name: 'baseUrl', type: 'string', required: true },
				{ name: 'nonce', type: 'string', required: true },
			],
			commands: [],
		};
	}

	get arguments() {
		return super.arguments;
	}

	set arguments( value ) {
		super.arguments = value;
		// Base walker assigned `subscribe` as the raw comma-separated token; split
		// into the array the runtime expects. The stored `_arguments` raw string is
		// left intact so dump_config round-trips byte-identically.
		if ( 'string' === typeof this.subscribe ) {
			this.subscribe = this.subscribe.split( ',' ).filter( Boolean );
		}
	}

	pid() {
		return this.setStateCache.connected?.pid ?? null;
	}

	start() {
		this.close();
		const url =
			`${ this.baseUrl }newspack-nodes/v1/messages/stream` +
			`?subscribe=${ encodeURIComponent( this.subscribe.join( ',' ) ) }` +
			`&_wpnonce=${ this.nonce }`;
		this._es = new EventSource( url, { withCredentials: true } );
		this._es.addEventListener( 'msg', ( e ) => {
			const msg = unpack( e.data );
			if ( msg[ TYPE ] & TM_INFO && 'connected' === msg[ KEY ] ) {
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
		// Forget the session identity so pid() doesn't report a stale pid after a
		// reopen (the stream can be closed/reopened on cd off/onto a worker); a
		// fresh `connected` envelope repopulates it.
		this.setStateCache.connected = undefined;
	}
}
