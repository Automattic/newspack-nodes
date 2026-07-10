/* global EventSource */
/**
 * SseInNode — the SSE receive-ingress node: opens an EventSource, snoops the
 * `connected` handshake for `pid()`, and fills each parsed `msg` frame into the
 * local graph. Composed UNNAMED by RemoteLink as the per-link inbound stream.
 *
 * Receive-only: inbound frames route through the EventSource listener →
 * `super.fill` (Node.fill, route-by-TO). The outgoing reply-FROM wrap
 * (`_sse:{pid}/{node}`) lives in RemoteIpc.
 *
 * Tachikoma-parity: no-arg ctor. Positional config arrives via `arguments=`; the
 * setter opts into the Schema_Reflection walk (parseSchemaArgs) and then splits
 * the comma-separated `subscribe` token into the array the runtime expects (the
 * walk only assigns strings).
 *
 * Visibility: lifecycle + errors are reported via set_state for dashboards —
 * CONNECTING (opening) → CONNECTED (handshake) → DISCONNECTED / RECONNECTING,
 * plus ERROR for stream-error / malformed frames. Every error path ALSO
 * `printLessOften`s so the rate is tunable. Per the substrate convention every
 * set_state payload is a STRING (the `connected` envelope is a flat `KEY VALUE`
 * string; pid is parsed into a plain field, not node state).
 */
import { Node, parseSchemaArgs } from './node';
import { Core } from './core';
import { IoTelemetry, byteLength } from './io-telemetry';
import { TYPE, FROM, TO, ID, VALUE, TM_ERROR, unpack } from './message';

// ID is the `segment:offset:length` breadcrumb; FROM carries the producer path.
const ID_POSITION_RE = /^(\d+):(\d+):(\d+)$/;

// Heartbeat-timeout watchdog: force a fresh stream after STALE + GRACE silence.
const HEARTBEAT_CADENCE_MS = 2000;
const STALE_AFTER_MS = HEARTBEAT_CADENCE_MS * 3;
const GRACE_MS = 4000;
const FORCE_AFTER_MS = STALE_AFTER_MS + GRACE_MS;
const WATCHDOG_INTERVAL_MS = 2000;

export class SseInNode extends Node {
	constructor() {
		super();
		this.subscribe = [];
		this.baseUrl = '';
		this.nonce = '';
		// Optional per-subscription seek seed; null/empty → tail-seek.
		this.positions = null;
		// Last record position per `[sub][partition]`, from each ID+FROM.
		this.lastPositions = {};
		this._es = null;
		// Wall-clock of the last inbound frame; the stream-liveness clock.
		this.lastEventTime = null;
		// Watchdog state: open-baseline, interval handle, last-force instant.
		this._watchdogBase = 0;
		this._watchdog = null;
		this._lastForce = 0;
		// Session identity from `connected` envelope; PLAIN fields (pid, slot).
		this.sessionPid = null;
		this.sessionSlot = null;
		this.registrations.CONNECTED = {};
	}

	get arguments() {
		return super.arguments;
	}

	set arguments( value ) {
		super.arguments = value;
		parseSchemaArgs( this, value );
		// The walk assigns `subscribe` as a comma-separated token; split it.
		if ( 'string' === typeof this.subscribe ) {
			this.subscribe = this.subscribe.split( ',' ).filter( Boolean );
		}
	}

	// A node owns its teardown: drop the stream + watchdog first.
	removeNode() {
		this.close();
		super.removeNode();
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
		// Lifecycle: opening; CONNECTED on handshake, then DISCONNECTED/ERROR.
		this.setState( 'CONNECTING', this.subscribe.join( ',' ) );
		const es = new EventSource( url, { withCredentials: true } );
		this._es = es;
		// Baseline so a connect with no first frame still trips FORCE_AFTER_MS.
		this._watchdogBase = Date.now();
		this._watchdog = setInterval( () => {
			const ref = Math.max( this.lastEventTime ?? 0, this._watchdogBase );
			if ( Date.now() - ref > FORCE_AFTER_MS ) {
				this._forceReconnect();
			}
		}, WATCHDOG_INTERVAL_MS );
		// A frame from a closed/reopened stream must not drive the graph.
		const stale = () => this._es !== es;
		// CLOSED = browser gave up (nonce/401) → reopen; CONNECTING → leave it.
		es.addEventListener( 'error', () => {
			if ( stale() ) {
				return;
			}
			if ( EventSource.CLOSED === es.readyState ) {
				this.setState( 'DISCONNECTED', 'EventSource closed' );
				IoTelemetry.markSseDisconnected();
				Core.printLessOften(
					'ERROR: SseInNode: disconnected - EventSource closed by browser'
				);
				this._forceReconnect();
			}
		} );
		// Idle keepalive `event: heartbeat`: snoop for liveness, don't route.
		es.addEventListener( 'heartbeat', () => {
			if ( stale() ) {
				return;
			}
			this.lastEventTime = Date.now();
		} );
		// `connected` is its own SSE event: snoop pid/slot, don't route.
		es.addEventListener( 'connected', ( e ) => {
			if ( stale() ) {
				return;
			}
			this.lastEventTime = Date.now();
			this._applyConnected( unpack( e.data )[ VALUE ] );
		} );
		es.addEventListener( 'msg', ( e ) => {
			if ( stale() ) {
				return;
			}
			this.lastEventTime = Date.now();
			const message = unpack( e.data );
			// A typeless frame is malformed — reject it loudly here.
			if ( ! message[ TYPE ] ) {
				this.setState( 'ERROR', 'malformed typeless frame' );
				Core.printLessOften(
					'ERROR: SseInNode: dropped a malformed typeless SSE frame'
				);
				return;
			}
			// A SUBSCRIPTION (homeToTarget) re-homes each record to target.
			if ( this.homeToTarget && this.target ) {
				message[ TO ] = this.target;
			}
			this._trackPosition( message );
			// Inbound accounting: bytesRead + IoTelemetry (msg DATA only).
			const size = byteLength( e.data );
			this.bytesRead += size;
			this.largestMsgSent = Math.max( this.largestMsgSent, size );
			IoTelemetry.recordIn( size, 1 );
			if ( message[ TYPE ] & TM_ERROR ) {
				// Surface the stream error (still forwarded too).
				const errText =
					'string' === typeof message[ VALUE ]
						? message[ VALUE ]
						: 'stream error';
				this.setState( 'ERROR', errText );
				// Stable rate-limit key; errText rides the ERROR state.
				Core.printLessOften( 'ERROR: SseInNode: stream error frame' );
			}
			super.fill( message );
		} );
	}

	// Parse the flat `KEY VALUE` connected envelope into plain session fields.
	_applyConnected( value ) {
		const raw = String( value ?? '' );
		const parts = raw.split( ' ' );
		const info = {};
		for ( let i = 0; i + 1 < parts.length; i += 2 ) {
			info[ parts[ i ] ] = parts[ i + 1 ];
		}
		const pid = Number( info.PID );
		this.sessionPid = Number.isFinite( pid ) ? pid : null;
		const slot = Number( info.SLOT );
		this.sessionSlot = Number.isFinite( slot ) ? slot : null;
		if ( null === this.sessionPid ) {
			this.setState(
				'ERROR',
				`connected envelope missing PID: ${ raw }`
			);
			// Stable rate-limit key; no CONNECTED on a malformed handshake.
			Core.printLessOften(
				'ERROR: SseInNode: connected envelope missing PID'
			);
			return;
		}
		this.setState( 'CONNECTED', raw );
		// Stamp the live-stream connect time for the Overview SSE Uptime card.
		IoTelemetry.markSseConnected();
	}

	// Remember a record's `{segment,offset}` keyed by its partition DIRECTORY.
	_trackPosition( message ) {
		const idMatch = ID_POSITION_RE.exec(
			'string' === typeof message[ ID ] ? message[ ID ] : ''
		);
		if ( ! idMatch ) {
			return;
		}
		const dir = String( message[ FROM ] || '' ).split( '/' )[ 0 ];
		if ( '' === dir ) {
			return;
		}
		// Resume at offset+length — the exact next-record boundary.
		this.lastPositions[ dir ] = {
			segment: Number( idMatch[ 1 ] ),
			offset: Number( idMatch[ 2 ] ) + Number( idMatch[ 3 ] ),
		};
	}

	// A `{ <dir>: pos }` seed resuming each seen partition; null → tail-seek.
	resumePositions() {
		return Object.keys( this.lastPositions ).length > 0
			? { ...this.lastPositions }
			: null;
	}

	// Reopen the stream, throttled to one attempt per watchdog interval.
	_forceReconnect() {
		const now = Date.now();
		if ( now - this._lastForce < WATCHDOG_INTERVAL_MS ) {
			return;
		}
		this.setState( 'RECONNECTING', 'watchdog' );
		IoTelemetry.markSseDisconnected();
		Core.printLessOften(
			'ERROR: SseInNode: reconnecting - SSE silent past timeout'
		);
		this._lastForce = now;
		// Resume from the last seen offset (no gap/replay); null → tail.
		this.positions = this.resumePositions();
		this.start();
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
		// A closed stream has no liveness — hide 'Xs ago' until a reopen frame.
		this.lastEventTime = null;
		// Forget the session pid so pid() won't report a stale one.
		this.sessionPid = null;
	}

	pid() {
		return this.sessionPid ?? null;
	}

	// Session slot from the `connected` envelope; RemoteLink's bridge reads it.
	slot() {
		return this.sessionSlot ?? null;
	}

	static nodeSchema() {
		return {
			category: 'Hidden',
			description:
				'Inbound SSE receive-ingress; composed (unnamed) by RemoteLink as the per-link stream.',
			// accepts_fill UI hint: SseIn is pure ingress, so false.
			accepts_fill: false,
			has_target: true,
			arguments: [
				{ name: 'subscribe', type: 'string', required: true },
				{ name: 'baseUrl', type: 'string', required: true },
				{ name: 'nonce', type: 'string', required: true },
			],
			commands: [],
		};
	}
}
