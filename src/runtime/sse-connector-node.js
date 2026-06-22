/* global EventSource */
import { Node, parseSchemaArgs } from './node';
import { Core } from './core';
import { TYPE, TO, KEY, VALUE, TM_INFO, unpack } from './message';

// Heartbeat-timeout watchdog. The server beats every 2s; force a fresh stream
// only after STALE (3 missed beats) + GRACE (self-recovery observe window) of
// total silence, long enough not to fight the browser's own EventSource retry.
const HEARTBEAT_CADENCE_MS = 2000;
const STALE_AFTER_MS = HEARTBEAT_CADENCE_MS * 3;
const GRACE_MS = 4000;
const FORCE_AFTER_MS = STALE_AFTER_MS + GRACE_MS;
const WATCHDOG_INTERVAL_MS = 2000;

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
		// Optional per-subscription seek seed, `{ <sub>: { <partition>: pos } }`
		// where pos is 'start' (replay from the oldest retained record), 'end'
		// (tail — the default when unset), or a `{seg,off}`. Set programmatically
		// (a structured blob, NOT a positional arg); serialized into the stream
		// URL by start(). null/empty → omit the param → the server tail-seeks.
		this.positions = null;
		this._es = null;
		// Wall-clock of the last inbound frame (data row OR idle heartbeat). The
		// connector is the only node that sees every frame, so it owns stream
		// liveness — dashboards read this for their "Xs ago" staleness, which must
		// reset on a heartbeat and only climb on a real drop. null = no live frame.
		this.lastEventTime = null;
		// Heartbeat-timeout watchdog: a baseline stamped at each open (so a dead
		// INITIAL connect that never delivers a first frame still gets forced),
		// the interval handle, and the last forced-reconnect instant (tight-loop
		// guard so a persistently-failing reopen can't spin).
		this._watchdogBase = 0;
		this._watchdog = null;
		this._lastForce = 0;
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
		let url =
			`${ this.baseUrl }newspack-nodes/v1/messages/stream` +
			`?subscribe=${ encodeURIComponent( this.subscribe.join( ',' ) ) }` +
			`&_wpnonce=${ this.nonce }`;
		if ( this.positions && Object.keys( this.positions ).length > 0 ) {
			url += `&positions=${ encodeURIComponent(
				JSON.stringify( this.positions )
			) }`;
		}
		const es = new EventSource( url, { withCredentials: true } );
		this._es = es;
		// Baseline so a connect that never delivers a first frame still trips FORCE_AFTER_MS.
		this._watchdogBase = Date.now();
		this._watchdog = setInterval( () => {
			const ref = Math.max( this.lastEventTime ?? 0, this._watchdogBase );
			if ( Date.now() - ref > FORCE_AFTER_MS ) {
				this._forceReconnect();
			}
		}, WATCHDOG_INTERVAL_MS );
		// A frame from a stream we've since close()d (or reopened past) must not
		// drive the graph — on teardown the sink is gone and fill() throws.
		const stale = () => this._es !== es;
		// CLOSED = browser gave up retrying (nonce/401) → reopen; CONNECTING = it's still retrying → leave it.
		es.addEventListener( 'error', () => {
			if ( stale() ) {
				return;
			}
			if ( EventSource.CLOSED === es.readyState ) {
				this._forceReconnect();
			}
		} );
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
			// Every real frame carries a type flag: the server packs full Messages,
			// and even a tailed log line arrives as a Consumer-unpacked Message with
			// the producer's type. A typeless frame is therefore always malformed —
			// a partial/empty flush (e.g. while the server restarts) that unpack()
			// turned into a pristine Message. Routing it only earns a router
			// "message not addressed - TYPE_UNKNOWN" drop, so reject it loudly here.
			if ( ! message[ TYPE ] ) {
				Core.printLessOften(
					'SseConnectorNode: dropped a malformed typeless SSE frame'
				);
				return;
			}
			if ( message[ TYPE ] & TM_INFO && 'connected' === message[ KEY ] ) {
				// Snoop-only: the envelope drives pid()/the `connected` event; it is
				// metadata, not a graph message — don't route it (it would land in
				// the transcript).
				this.setState( 'connected', message[ VALUE ] );
				return;
			}
			// A log/topic SUBSCRIPTION (RemoteLink, homeToTarget) re-homes every
			// received record to its target: records replayed from a PARTITION carry
			// the TO the producer stamped server-side (routing it to that partition)
			// — a path that means nothing here, so the router would silently drop it.
			// RemoteIpc leaves this off so worker reply frames keep their TO=FROM
			// breadcrumb routing.
			if ( this.homeToTarget && this.target ) {
				message[ TO ] = this.target;
			}
			super.fill( message );
		} );
	}

	// Reopen the stream, throttled to one attempt per watchdog interval.
	_forceReconnect() {
		const now = Date.now();
		if ( now - this._lastForce < WATCHDOG_INTERVAL_MS ) {
			return;
		}
		this._lastForce = now;
		// Resume live, not a replay: a recovery reconnect tail-follows so a
		// history-seeded link doesn't re-stream its whole window on every drop.
		this.positions = null;
		this.start();
	}

	// A node owns its teardown: drop the stream + watchdog before unregistering.
	removeNode() {
		this.close();
		super.removeNode();
	}

	close() {
		if ( this._watchdog ) {
			clearInterval( this._watchdog );
			this._watchdog = null;
		}
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
