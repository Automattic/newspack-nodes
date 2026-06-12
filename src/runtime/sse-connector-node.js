/* global EventSource */
import { Node, parseSchemaArgs } from './node';
import { TYPE, KEY, VALUE, TM_INFO, unpack } from './message';

/**
 * Browser-side Node opening an EventSource and filling each `msg` into the
 * local graph. Snoops the `connected` envelope so `pid()` can read it back.
 *
 * Tachikoma-parity: no-arg ctor. Positional config arrives via `arguments=`;
 * the setter opts into the Schema_Reflection walk (parseSchemaArgs) and then
 * splits the comma-separated `subscribe` token into the array the runtime
 * expects (the walk only assigns strings).
 */
export class SseConnectorNode extends Node {
	constructor() {
		super();
		this.subscribe = [];
		this.baseUrl = '';
		this.nonce = '';
		this._es = null;
		// Wall-clock of the last inbound frame (data row OR idle heartbeat). The
		// connector is the only node that sees every frame, so it owns stream
		// liveness — dashboards read this for their "Xs ago" staleness, which must
		// reset on a heartbeat and only climb on a real drop. null = no live frame.
		this.lastEventTime = null;
		this.registrations.connected = {};
	}

	get arguments() {
		return super.arguments;
	}

	set arguments( value ) {
		super.arguments = value;
		parseSchemaArgs( this, value );
		// The walk assigns `subscribe` as the raw comma-separated token; split it.
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
		const es = new EventSource( url, { withCredentials: true } );
		this._es = es;
		// A frame from a stream we've since close()d (or reopened past) must not
		// drive the graph — on teardown the sink is gone and fill() throws.
		const stale = () => this._es !== es;
		// Idle keepalive: the server sends an `event: heartbeat` every couple of
		// seconds even when no data flows. It carries no graph payload — its only
		// job is to prove the stream is alive — so snoop it for liveness, don't
		// route it (routing would land it in the topology-console transcript).
		es.addEventListener( 'heartbeat', () => {
			if ( stale() ) {
				return;
			}
			this.lastEventTime = Date.now();
		} );
		es.addEventListener( 'msg', ( e ) => {
			if ( stale() ) {
				return;
			}
			this.lastEventTime = Date.now();
			const message = unpack( e.data );
			if ( message[ TYPE ] & TM_INFO && 'connected' === message[ KEY ] ) {
				// Snoop-only: the envelope drives pid()/the `connected` event; it is
				// metadata, not a graph message — don't route it (it would land in
				// the transcript).
				this.setState( 'connected', message[ VALUE ] );
				return;
			}
			super.fill( message );
		} );
	}

	close() {
		if ( this._es ) {
			this._es.close();
		}
		this._es = null;
		// A closed stream has no liveness — hide "Xs ago" until a reopen produces a
		// fresh frame. (A real drop is an EventSource error, not close(), so it
		// leaves lastEventTime frozen and "ago" climbs as the intended warning.)
		this.lastEventTime = null;
		// Forget the session identity so pid() doesn't report a stale pid after a
		// reopen (the stream can be closed/reopened on cd off/onto a worker); a
		// fresh `connected` envelope repopulates it.
		this.setStateCache.connected = undefined;
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
}
