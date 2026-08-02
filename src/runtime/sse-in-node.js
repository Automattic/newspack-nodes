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
import { parseSchemaArgs } from './node';
import { TimerNode } from './timer-node';
import { Core } from './core';
import { nodesData, refreshNodesNonce } from './nodes-data';
import { IoTelemetry, byteLength } from './io-telemetry';
import {
	TYPE,
	FROM,
	TO,
	ID,
	KEY,
	VALUE,
	TM_ERROR,
	TM_UNTYPED,
	unpack,
} from './message';

// ID is the `segment:offset:length` breadcrumb; FROM carries the producer path.
const ID_POSITION_RE = /^(\d+):(\d+):(\d+)$/;

// PHP lease owners travel as canonical decimals; never convert them to Number.
const LEASE_OWNER_RE = /^[1-9][0-9]*$/;

// PHP Log_Discovery::GROUPS prefixed roots: positions key on the FULL stamp.
const GROUP_PREFIXES = new Set( [ 'offsets', 'deadletter' ] );

// Default REST route opened; RemoteLink overrides it for /log/stream.
const DEFAULT_STREAM_ENDPOINT = 'newspack-nodes/v1/messages/stream';

// Heartbeat-timeout watchdog: force a fresh stream after STALE + GRACE silence.
const HEARTBEAT_CADENCE_MS = 2000;
const STALE_AFTER_MS = HEARTBEAT_CADENCE_MS * 3;
const GRACE_MS = 4000;
const FORCE_AFTER_MS = STALE_AFTER_MS + GRACE_MS;
const WATCHDOG_INTERVAL_MS = 2000;

export class SseInNode extends TimerNode {
	constructor() {
		super();
		this.subscribe = [];
		// REST route opened; /log/stream mirrors /messages/stream on the wire.
		this.endpoint = DEFAULT_STREAM_ENDPOINT;
		// Empty falls back to the localized global (see the getters below).
		this._baseUrl = '';
		this._nonce = '';
		// Optional per-subscription seek seed; null/empty → tail-seek.
		this.positions = null;
		// Last record position per `[sub][partition]`, from each ID+FROM.
		this.lastPositions = {};
		this._es = null;
		// Wall-clock of the last inbound frame; the stream-liveness clock.
		this.lastEventTime = null;
		// Watchdog state: open-baseline and last-force instant.
		this._watchdogBase = 0;
		this._lastForce = 0;
		this._mayRenewNonce = true;
		// Session identity from `connected`; lease owner remains a string.
		this.sessionPid = null;
		this.sessionSlot = null;
		this.sessionLeaseOwner = null;
		// Last terminal server control event for this EventSource connection.
		this.terminalDisconnect = null;
		this._handleVisibilityChange = () => {
			if ( 'visible' === document.visibilityState && this._es ) {
				this._restart( 'visibility', true );
			}
		};
		this.registrations.CONNECTING = {};
		this.registrations.CONNECTED = {};
		this.registrations.DISCONNECTED = {};
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

	/**
	 * One watchdog tick. A half-open EventSource never fires `error`, so total
	 * silence past the heartbeat timeout is the only evidence the stream died.
	 *
	 * `fireCb()` keeps the scheduling — counter, throttle, oneshot — and calls
	 * `fire()` last; a Timer subclass REPLACES `fire()` with whatever its tick
	 * means, as Uptime mints its command and Router runs notifyTimer. So this
	 * does not call `super.fire()`. Here that also matters concretely: the base
	 * emits a TM_BYTESTREAM timestamp down its sink, and this node's sink is the
	 * DATA path, where a timestamp is indistinguishable from a record.
	 */
	fire() {
		const ref = Math.max( this.lastEventTime ?? 0, this._watchdogBase );
		if ( Date.now() - ref > FORCE_AFTER_MS ) {
			this._forceReconnect();
		}
	}

	start( mayRenewNonce = true ) {
		this.close();
		this._mayRenewNonce = mayRenewNonce;
		if ( 'undefined' !== typeof document ) {
			document.addEventListener(
				'visibilitychange',
				this._handleVisibilityChange
			);
		}
		let url =
			`${ this.baseUrl }${ this.endpoint }` +
			`?subscribe=${ encodeURIComponent( this.subscribe.join( ',' ) ) }` +
			`&_wpnonce=${ this.nonce }`;
		if ( this.positions && Object.keys( this.positions ).length > 0 ) {
			url += `&positions=${ encodeURIComponent(
				JSON.stringify( this.positions )
			) }`;
		}
		// Lifecycle: opening; CONNECTED on handshake, then DISCONNECTED/ERROR.
		delete this.setStateCache.CONNECTED;
		this.setState( 'CONNECTING', this.subscribe.join( ',' ) );
		const es = new EventSource( url, { withCredentials: true } );
		this._es = es;
		// Baseline so a connect with no first frame still trips FORCE_AFTER_MS.
		this._watchdogBase = Date.now();
		// Rides the Router TIMER; >1000 throttles the tick to this cadence.
		this.setTimer( WATCHDOG_INTERVAL_MS );
		// A frame from a closed/reopened stream must not drive the graph.
		const stale = () => this._es !== es;
		// CLOSED = browser gave up (nonce/401) → reopen; CONNECTING → leave it.
		es.addEventListener( 'error', () => {
			if ( stale() ) {
				return;
			}
			if ( EventSource.CLOSED === es.readyState ) {
				if ( ! this.terminalDisconnect ) {
					this._reportDisconnected(
						'EventSource closed',
						'EventSource closed by browser'
					);
				}
				this._recoverConnection();
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
		// Deliberate server termination: consume and retain its safe reason.
		es.addEventListener( 'disconnect', ( e ) => {
			if ( stale() ) {
				return;
			}
			this.lastEventTime = Date.now();
			const message = unpack( e.data );
			if (
				message[ TYPE ] & TM_UNTYPED ||
				! message[ TYPE ] ||
				'string' !== typeof message[ VALUE ] ||
				'' === message[ VALUE ].trim()
			) {
				this.setState( 'ERROR', 'unparseable disconnect frame' );
				Core.printLessOften(
					'ERROR: SseInNode: dropped an unparseable disconnect frame'
				);
				return;
			}
			if (
				'string' !== typeof message[ KEY ] ||
				'' === message[ KEY ].trim()
			) {
				this.setState( 'ERROR', 'malformed disconnect envelope' );
				Core.printLessOften(
					'ERROR: SseInNode: dropped a malformed disconnect envelope'
				);
				return;
			}
			const reason = message[ KEY ].trim()
				.replace( /[\r\n]+/g, ' ' )
				.slice( 0, 512 );
			const displayMessage = message[ VALUE ].trim()
				.replace( /[\r\n]+/g, ' ' )
				.slice( 0, 512 );
			this.terminalDisconnect = {
				reason,
				message: displayMessage,
			};
			this._reportDisconnected(
				`Server closed stream: ${ displayMessage }`
			);
		} );
		es.addEventListener( 'msg', ( e ) => {
			if ( stale() ) {
				return;
			}
			this.lastEventTime = Date.now();
			const message = unpack( e.data );
			// unpack() mints a fresh untyped message when parsing fails.
			if ( message[ TYPE ] & TM_UNTYPED ) {
				this.setState( 'ERROR', 'unparseable frame' );
				Core.printLessOften(
					'ERROR: SseInNode: dropped an unparseable SSE frame'
				);
				return;
			}
			// Parsed fine but typed by nobody — a different bug from garbage.
			if ( ! message[ TYPE ] ) {
				this.setState( 'ERROR', 'typeless frame' );
				Core.printLessOften(
					'ERROR: SseInNode: dropped a typeless SSE frame'
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
		if ( ! Number.isFinite( pid ) ) {
			this._rejectConnected( 'missing PID' );
			return;
		}
		const slot = Number( info.SLOT );
		if ( ! Number.isInteger( slot ) || slot < 0 ) {
			this._rejectConnected( 'missing or invalid SLOT' );
			return;
		}
		const leaseOwner = info.OWNER;
		if (
			'string' !== typeof leaseOwner ||
			! LEASE_OWNER_RE.test( leaseOwner )
		) {
			this._rejectConnected( 'missing or invalid OWNER' );
			return;
		}
		this.terminalDisconnect = null;
		this.sessionPid = pid;
		this.sessionSlot = slot;
		this.sessionLeaseOwner = leaseOwner;
		this.setState( 'CONNECTED', raw );
		this._mayRenewNonce = true;
		// Stamp the live-stream connect time for the Overview SSE Uptime card.
		IoTelemetry.markSseConnected();
	}

	_rejectConnected( reason ) {
		this.sessionPid = null;
		this.sessionSlot = null;
		this.sessionLeaseOwner = null;
		const message = `connected envelope ${ reason }`;
		this.setState( 'ERROR', message );
		this.setState( 'DISCONNECTED', message );
		Core.printLessOften( `ERROR: SseInNode: ${ message }` );
	}

	_reportDisconnected( stateMessage, logMessage = stateMessage ) {
		this.setState( 'DISCONNECTED', stateMessage );
		IoTelemetry.markSseDisconnected();
		Core.printLessOften(
			`ERROR: SseInNode: disconnected - ${ logMessage }`
		);
	}

	// Remember a record's `{segment,offset}` keyed by its partition DIRECTORY.
	_trackPosition( message ) {
		const idMatch = ID_POSITION_RE.exec(
			'string' === typeof message[ ID ] ? message[ ID ] : ''
		);
		if ( ! idMatch ) {
			return;
		}
		const parts = String( message[ FROM ] || '' ).split( '/' );
		const dir =
			GROUP_PREFIXES.has( parts[ 0 ] ) && parts[ 1 ]
				? `${ parts[ 0 ] }/${ parts[ 1 ] }`
				: parts[ 0 ];
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

	// Reopen immediately from the exact next record after the last seen frame.
	_restart( reason, mayRenewNonce = this._mayRenewNonce ) {
		this.setState( 'RECONNECTING', reason );
		this.positions = this.resumePositions();
		this.start( mayRenewNonce );
	}

	// Global credentials can be renewed; explicit remote credentials cannot.
	_recoverConnection() {
		const stream = this._es;
		if ( ! stream ) {
			return;
		}
		if ( this._nonce || ! this._mayRenewNonce ) {
			this._forceReconnect();
			return;
		}
		refreshNodesNonce()
			.then( () => {
				if ( this._es === stream ) {
					this._restart( 'closed', false );
				}
			} )
			.catch( ( error ) => {
				if ( this._es !== stream ) {
					return;
				}
				const message = error?.message ?? String( error );
				this.setState( 'ERROR', message );
				Core.printLessOften(
					`ERROR: SseInNode: REST nonce renewal failed - ${ message }`
				);
			} );
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
		this.start( this._mayRenewNonce );
	}

	close() {
		if ( 'undefined' !== typeof document ) {
			document.removeEventListener(
				'visibilitychange',
				this._handleVisibilityChange
			);
		}
		this.stopTimer();
		if ( this._es ) {
			this._es.close();
		}
		this._es = null;
		// A later stream starts with no frame timestamp from this connection.
		this.lastEventTime = null;
		// Forget this connection's complete session lease and terminal event.
		this.sessionPid = null;
		this.sessionSlot = null;
		this.sessionLeaseOwner = null;
		this.terminalDisconnect = null;
	}

	// baseUrl/nonce fall back to the localized global when not set explicitly.
	get baseUrl() {
		return this._baseUrl || nodesData().restUrl;
	}

	set baseUrl( value ) {
		this._baseUrl = value ?? '';
	}

	get nonce() {
		return this._nonce || nodesData().nonce;
	}

	set nonce( value ) {
		this._nonce = value ?? '';
	}

	pid() {
		return this.sessionPid ?? null;
	}

	// Session slot from the `connected` envelope; RemoteLink's bridge reads it.
	slot() {
		return this.sessionSlot ?? null;
	}

	// Canonical decimal owner from `connected`; never a JavaScript Number.
	leaseOwner() {
		return this.sessionLeaseOwner ?? null;
	}

	static nodeSchema() {
		return {
			category: 'I/O',
			description:
				'Inbound SSE receive-ingress; opens an EventSource for the subscribed topics.',
			// accepts_fill UI hint: SseIn is pure ingress, so false.
			accepts_fill: false,
			has_target: true,
			// Only subscribe is positional; baseUrl/nonce from the global.
			arguments: [
				{ name: 'subscribe', type: 'string', required: true },
			],
			commands: [],
		};
	}
}
