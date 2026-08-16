/* global EventSource */
/**
 * SseInNode — the SSE receive-ingress node: opens an EventSource, snoops the
 * `connected` handshake for `pid()`, and fills each parsed `msg` frame into the
 * local graph. Composed by RemoteLink as the per-link `<patron>:sse-in`.
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
	TM_COMMAND,
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

/**
 * Seek sentinels carried in an offset field, mirroring `Consumer_Node::SEEK_*`
 * — Tachikoma's vocabulary (`Consumer.pm`: "valid offsets: start (0), recent
 * (-2), end (-1)"). A signed number expresses every seek, so 0 is the START of
 * the log rather than doubling as "no position given". The reader also accepts
 * the words `start` / `recent` / `end` as aliases.
 *
 * `recent` (-2) has no JS spelling. It is live on the PHP side — `wp nodes
 * reqgrep --recent` and the `request_grep` verb's `scope=recent` both seek it —
 * but both build a local Consumer rather than crossing this wire, so no browser
 * caller has ever asked for it. Add it when one does, not before.
 */
export const SEEK_START = 0;

/** @testonly The tail seek. Production names it inside seekMap(), not by import. */
export const SEEK_END = -1;

// Heartbeat-timeout watchdog: force a fresh stream after STALE + GRACE silence.
const HEARTBEAT_CADENCE_MS = 2000;
const STALE_AFTER_MS = HEARTBEAT_CADENCE_MS * 3;
const GRACE_MS = 4000;
const FORCE_AFTER_MS = STALE_AFTER_MS + GRACE_MS;
const WATCHDOG_INTERVAL_MS = 2000;
// @longform Bound on the CONNECTING stand-down. A browser between connections
// owns its own `retry:` gap, but one wedged in CONNECTING fires no `error`, so
// an unbounded stand-down leaves nothing to recover it. Comfortably above any
// advertised reopen delay, so a normal gap never trips it.
const CONNECTING_FORCE_AFTER_MS = 60000;

/**
 * Reconnect backoff, mirroring the PHP half's INITIAL_BACKOFF / MAX_BACKOFF
 * (`includes/class-sse-in-node.php`). Every reconnect path used to retry on the
 * flat watchdog interval and never widen, so a hard-down or 429ing endpoint got
 * 30 requests a minute per open tab, indefinitely — and each attempt takes a
 * slot from a pool capped at 10 per user/IP, whose refusal is itself a 429 that
 * feeds the same loop.
 */
const INITIAL_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 30000;

/**
 * The one field a patron sets on this node from the outside. RemoteLink is a
 * SUBSCRIPTION, so it sets `homeToTarget` and every received record is re-homed
 * to this node's target; RemoteIpc leaves it unset and lets each record keep
 * the TO it arrived with.
 *
 * @typedef {{ homeToTarget?: boolean }} PatronConfigured
 */

/**
 * The receive half of a remote link: one EventSource, the watchdog that
 * notices when it dies silently, and the session identity the `connected`
 * handshake hands back. `start()` opens the stream; each `msg` frame is
 * unpacked and filled into the local graph, while `connected`, `heartbeat`
 * and `disconnect` are snooped for liveness and lifecycle rather than routed.
 */
export class SseInNode extends TimerNode {
	/**
	 * Start closed — no stream, no watchdog, no session. Every field is either
	 * configuration a patron may overwrite before `start()`, or per-connection
	 * state `close()` clears.
	 */
	constructor() {
		super();
		/** @type {string[]} */
		this.subscribe = [];
		// REST route opened; /log/stream mirrors /messages/stream on the wire.
		this.endpoint = DEFAULT_STREAM_ENDPOINT;
		// Empty falls back to the localized global (see the getters below).
		this._baseUrl = '';
		this._nonce = '';
		/**
		 * Optional per-subscription seek seed: an exact `{segment, offset}`, a
		 * SEEK sentinel, or an alias word. Unseeded names take SEEK_END.
		 *
		 * @type {?Object<string,{segment:number,offset:number}|number|string>}
		 */
		this._positions = null;
		// Last record position per `[sub][partition]`, from each ID+FROM.
		this.lastPositions = {};
		this._es = null;
		// Wall-clock of the last inbound frame; the stream-liveness clock.
		this.lastEventTime = null;
		// Watchdog state: open-baseline and last-force instant.
		this._watchdogBase = 0;
		this._lastForce = 0;
		this._backoffMs = INITIAL_BACKOFF_MS;
		// Reopen delay the server advertised as a `retry` event; null = none.
		this._serverRetryMs = null;
		this._reopenTimer = null;
		this._mayRenewNonce = true;
		// Session identity from `connected`; lease owner remains a string.
		this.sessionPid = null;
		this.sessionSlot = null;
		this.sessionLeaseOwner = null;
		// Last terminal server control event for this EventSource connection.
		this.terminalDisconnect = null;
		this._handleVisibilityChange = () => {
			if ( 'visible' !== document.visibilityState ) {
				return;
			}
			// Background timers throttle to ~1/min; don't wait one out.
			if ( this._reopenTimer ) {
				this._restart( 'visibility', true );
				return;
			}
			if ( this._es ) {
				this._restart( 'visibility', true );
			}
		};
		this.registrations.CONNECTING = {};
		this.registrations.CONNECTED = {};
		this.registrations.DISCONNECTED = {};
	}

	/**
	 * @return {string[]} The argument tokens last assigned.
	 */
	get arguments() {
		return super.arguments;
	}

	/**
	 * Run the Schema_Reflection walk over the positional tokens, then repair
	 * the one field it cannot type: the walk assigns strings, so the
	 * comma-separated `subscribe` token becomes the array the stream URL and
	 * the CONNECTING payload both expect.
	 *
	 * @param {string[]} value Positional tokens; the first is the comma-separated subscription list.
	 */
	set arguments( value ) {
		super.arguments = value;
		parseSchemaArgs( this, value );
		// The walk assigns `subscribe` as a comma-separated token; split it.
		if ( 'string' === typeof this.subscribe ) {
			this.subscribe = /** @type {string} */ ( this.subscribe )
				.split( ',' )
				.filter( Boolean );
		}
	}

	/**
	 * One watchdog tick. A half-open EventSource never fires `error`, so total
	 * silence past the heartbeat timeout is the only evidence the stream died.
	 *
	 * Half-open means readyState OPEN with no data, so a browser already
	 * reconnecting is not silence — it is the server's `retry:` gap after a
	 * deliberate idle close, and forcing a reconnect through it only doubles
	 * the backoff. The `error` handler makes the same distinction.
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
		if (
			EventSource.CONNECTING === this._es?.readyState &&
			Date.now() - ref <= CONNECTING_FORCE_AFTER_MS
		) {
			return;
		}
		if ( Date.now() - ref > FORCE_AFTER_MS ) {
			this._forceReconnect();
		}
	}

	/**
	 * A node owns its teardown: drop the stream and the watchdog first, since
	 * the base `removeNode()` would leave the EventSource open.
	 */
	removeNode() {
		this.close();
		super.removeNode();
	}

	/**
	 * Parse the flat `KEY VALUE` connected envelope into plain session fields.
	 * PID, SLOT and OWNER must all arrive well-formed; anything else rejects
	 * the handshake rather than leaving a half-known session behind.
	 *
	 * @param {*} value The envelope's VALUE — space-separated `KEY VALUE` pairs.
	 */
	_applyConnected( value ) {
		// A live handshake clears the backoff, like PHP's dispatch_event.
		this._backoffMs = INITIAL_BACKOFF_MS;
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
		this._seedPositions( info.CURSORS );
		// SSE_In_Node's payload: the raw envelope also carries the lease OWNER.
		this.setState( 'CONNECTED', `PID ${ pid } SLOT ${ slot }` );
		this._mayRenewNonce = true;
		// Stamp the live-stream connect time for the Overview SSE Uptime card.
		IoTelemetry.markSseConnected();
	}

	/**
	 * Abandon a malformed handshake: forget every session field, publish ERROR
	 * and DISCONNECTED, and log at the rate limit.
	 *
	 * @param {string} reason What was wrong with the envelope, e.g. 'missing PID'.
	 */
	_rejectConnected( reason ) {
		this.sessionPid = null;
		this.sessionSlot = null;
		this.sessionLeaseOwner = null;
		const message = `connected envelope ${ reason }`;
		this.setState( 'ERROR', message );
		this.setState( 'DISCONNECTED', message );
		Core.printLessOften( `ERROR: SseInNode: ${ message }` );
	}

	/**
	 * Reopen immediately, resuming from the exact next record after the last
	 * frame seen — no gap, no replay.
	 *
	 * @param {string}  reason        Why the stream is restarting; published as the RECONNECTING payload.
	 * @param {boolean} mayRenewNonce Whether the reopened stream may renew the REST nonce; defaults to the current setting.
	 */
	_restart( reason, mayRenewNonce = this._mayRenewNonce ) {
		this.setState( 'RECONNECTING', reason );
		this.start( mayRenewNonce );
	}

	/**
	 * Recover from a stream the browser gave up on. A stale nonce is the usual
	 * cause, so global credentials are renewed and the stream restarted;
	 * explicit remote credentials cannot be renewed, leaving a reconnect as
	 * the only move.
	 */
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

	/**
	 * Own the reopen the browser was about to make for us.
	 *
	 * EventSource reconnects by itself on the server's `retry:`
	 * field, which SSE_Out no longer sends — the interval arrives as a `retry`
	 * EVENT instead, so the browser would fall back to its own default and the
	 * two halves of one link would disagree about the cadence. Closing the
	 * stream is what stops that built-in retry from racing this one. Backoff
	 * covers the case where the server advertised nothing.
	 */
	_scheduleReopen() {
		if ( this._reopenTimer ) {
			return;
		}
		// Never reached a live server: back off, don't hammer it flat.
		const delay = this._serverRetryMs ?? this._backoffMs;
		if ( null === this._serverRetryMs ) {
			this._backoffMs = Math.min( MAX_BACKOFF_MS, this._backoffMs * 2 );
		}
		// close() drops _es, so `stale()` retires this connection's listeners.
		this.close();
		// close() unregisters it; a hidden tab still recovers on sight.
		if ( 'undefined' !== typeof document ) {
			document.addEventListener(
				'visibilitychange',
				this._handleVisibilityChange
			);
		}
		this._reopenTimer = setTimeout( () => {
			this._reopenTimer = null;
			this._restart( 'scheduled reopen' );
		}, delay );
	}

	/**
	 * Reopen the stream from the last seen offset, throttled to the current
	 * backoff so a dead endpoint is not hammered.
	 */
	_forceReconnect() {
		const now = Date.now();
		if ( now - this._lastForce < this._backoffMs ) {
			return;
		}
		this._backoffMs = Math.min( MAX_BACKOFF_MS, this._backoffMs * 2 );
		this.setState( 'RECONNECTING', 'watchdog' );
		IoTelemetry.markSseDisconnected();
		Core.printLessOften(
			'ERROR: SseInNode: reconnecting - SSE silent past timeout'
		);
		this._lastForce = now;
		this.start( this._mayRenewNonce );
	}

	/**
	 * Open a fresh EventSource for the current subscription and arm the
	 * watchdog. Any previous stream is closed first, and every listener
	 * registered here ignores frames from a stream this node has replaced.
	 *
	 * @param {boolean} mayRenewNonce Whether a browser-side close may refresh the REST nonce and retry; false once explicit remote credentials are in play.
	 */
	start( mayRenewNonce = true ) {
		this.close();
		this._mayRenewNonce = mayRenewNonce;
		if ( 'undefined' !== typeof document ) {
			document.addEventListener(
				'visibilitychange',
				this._handleVisibilityChange
			);
		}
		const seeks = this.seekMap();
		let url =
			`${ this.baseUrl }${ this.endpoint }` +
			`?subscribe=${ encodeURIComponent( this.subscribe.join( ',' ) ) }` +
			`&_wpnonce=${ this.nonce }`;
		if ( Object.keys( seeks ).length > 0 ) {
			url += `&positions=${ encodeURIComponent(
				JSON.stringify( seeks )
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
				return;
			}
			// CONNECTING: we own that reopen, on the server's schedule.
			this._scheduleReopen();
		} );
		// The reopen schedule, as data — the protocol `retry:` field is gone.
		es.addEventListener( 'retry', ( e ) => {
			if ( stale() ) {
				return;
			}
			this.lastEventTime = Date.now();
			const ms = Number( unpack( e.data )[ VALUE ] );
			if ( Number.isFinite( ms ) && ms > 0 ) {
				this._serverRetryMs = ms;
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
			// @longform A SUBSCRIPTION (homeToTarget) re-homes each RECORD to
			// target. Never a command reply: the server addressed that to the
			// node that minted the command (TO=FROM, ADR-7), so overwriting it
			// delivers the reply to the subscription's view instead of its
			// receiver.
			if (
				/** @type {PatronConfigured} */ ( this ).homeToTarget &&
				this.target &&
				0 === ( message[ TYPE ] & TM_COMMAND )
			) {
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

	/**
	 * What to ask for per subscription: the position this stream reached, or
	 * SEEK_END when it has none. Stating the seek is the point — carrying "tail"
	 * by OMITTING the parameter is what left a real `{segment: 0, offset: 0}`
	 * unable to mean the start of the log on the PHP side.
	 *
	 * A reopen resumes past what it read, so a position reached wins over the
	 * seed that opened the stream. A stream that read NOTHING — refused by the
	 * slot pool before its first frame — has none, and there the seed stands:
	 * overwriting it with "wherever we got to" is what turned a chart asking to
	 * replay from the start of the log into one showing a single live point.
	 *
	 * A GLOB is the one seek a client cannot state: the server expands it into
	 * concrete dirs and keys positions by those, so an entry filed under
	 * `firehose.*` is one nothing reads. Its dirs take the server's default,
	 * which is this same tail. A non-glob subscription IS its dir name
	 * (`SSE_Out_Node::matched_dirs()` globs the name and `stamp_for()` stamps the
	 * basename), so stating it is exact.
	 *
	 * @return {Object<string,{segment:number,offset:number}|number|string>} Per-subscription seek.
	 */
	seekMap() {
		const stated = { ...( this._positions || {} ) };
		// A glob's dirs are named by the server, and only by the server.
		const anyGlob = this.subscribe.some( ( sub ) => sub.includes( '*' ) );
		for ( const [ dir, at ] of Object.entries( this.lastPositions ) ) {
			const carried =
				anyGlob ||
				this.subscribe.some(
					( sub ) => sub === dir || dir.startsWith( `${ sub }.` )
				);
			if ( carried ) {
				stated[ dir ] = at;
			}
		}
		for ( const sub of this.subscribe ) {
			if ( ! sub.includes( '*' ) && undefined === stated[ sub ] ) {
				stated[ sub ] = SEEK_END;
			}
		}
		return stated;
	}

	/**
	 * Close the stream and forget everything tied to this connection: the
	 * visibility listener, the watchdog, the frame clock, the session lease,
	 * and any terminal disconnect. Safe when nothing is open.
	 */
	close() {
		if ( this._reopenTimer ) {
			clearTimeout( this._reopenTimer );
			this._reopenTimer = null;
		}
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

	/**
	 * Seed each subscription's resume point from the `connected` envelope.
	 *
	 * A stream that closes having delivered nothing — the normal case for an
	 * idle close — hands the client no ID breadcrumb to advance from, so
	 * without this the reopen tail-seeks and drops whatever arrived in the gap.
	 * A delivered record overwrites the seed, since its breadcrumb is newer.
	 *
	 * @param {*} token `dir=segment:offset` pairs, comma-separated.
	 */
	_seedPositions( token ) {
		String( token ?? '' )
			.split( ',' )
			.forEach( ( pair ) => {
				const eq = pair.indexOf( '=' );
				if ( eq < 1 ) {
					return;
				}
				const colon = pair.indexOf( ':', eq );
				if ( colon < 0 ) {
					return;
				}
				const offset = Number( pair.slice( colon + 1 ) );
				if ( ! Number.isFinite( offset ) ) {
					return;
				}
				this.lastPositions[ pair.slice( 0, eq ) ] = {
					segment: Number( pair.slice( eq + 1, colon ) ),
					offset,
				};
			} );
	}

	/**
	 * @return {?Object<string,{segment:number,offset:number}|number|string>} The seek this stream was asked to open at.
	 */
	get positions() {
		return this._positions;
	}

	/**
	 * A new seek supersedes where the old stream got to — otherwise a seek back
	 * to the start of the log would be beaten by the resume it is replacing.
	 *
	 * @param {?Object<string,{segment:number,offset:number}|number|string>} value Per-subscription seek, or null to tail every name.
	 */
	set positions( value ) {
		this._positions = value;
		this.lastPositions = {};
	}

	/**
	 * Publish one disconnect three ways: DISCONNECTED for dashboards, the
	 * telemetry mark the Overview uptime card reads, and a rate-limited log.
	 *
	 * @param {string} stateMessage Cause published as the DISCONNECTED payload.
	 * @param {string} logMessage   Cause for the log line; defaults to `stateMessage`.
	 */
	_reportDisconnected( stateMessage, logMessage = stateMessage ) {
		this.setState( 'DISCONNECTED', stateMessage );
		IoTelemetry.markSseDisconnected();
		Core.printLessOften(
			`ERROR: SseInNode: disconnected - ${ logMessage }`
		);
	}

	/**
	 * Remember a record's next-record boundary, keyed by the partition
	 * DIRECTORY its FROM names, so a reopened stream resumes exactly where
	 * this one stopped. A frame whose ID is not a `segment:offset:length`
	 * breadcrumb carries no position and is ignored.
	 *
	 * @param {Array} message The positional Message just received.
	 */
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

	/**
	 * The current reconnect throttle: doubles per failed attempt to a 30s
	 * ceiling, and `_applyConnected` puts it back to the floor.
	 *
	 * @return {number} Milliseconds to wait before the next attempt.
	 */
	reconnectDelayMs() {
		return this._backoffMs;
	}

	/**
	 * @return {string} REST root the stream is opened against; the localized global unless a base was set explicitly.
	 */
	get baseUrl() {
		return this._baseUrl || nodesData().restUrl;
	}

	/**
	 * @param {string} value Explicit REST root; empty restores the localized global.
	 */
	set baseUrl( value ) {
		this._baseUrl = value ?? '';
	}

	/**
	 * @return {string} REST nonce the stream is opened with; the localized global unless a nonce was set explicitly.
	 */
	get nonce() {
		return this._nonce || nodesData().nonce;
	}

	/**
	 * @param {string} value Explicit REST nonce; empty restores the localized global. An explicit nonce is never renewed on a failure.
	 */
	set nonce( value ) {
		this._nonce = value ?? '';
	}

	/**
	 * @return {?number} PID of the server process behind the live stream, or null before a handshake completes.
	 */
	pid() {
		return this.sessionPid ?? null;
	}

	/**
	 * @return {?number} Session slot from the `connected` envelope, which RemoteLink's bridge hands to the Heartbeat; null while disconnected.
	 */
	slot() {
		return this.sessionSlot ?? null;
	}

	/**
	 * @return {?string} Canonical decimal lease owner from `connected` — a STRING, never a JavaScript Number; null while disconnected.
	 */
	leaseOwner() {
		return this.sessionLeaseOwner ?? null;
	}

	/**
	 * Console palette entry — pure ingress, so it accepts no user-routed fill,
	 * and only `subscribe` is positional; the base URL and nonce come from the
	 * localized global.
	 *
	 * @return {Object} The node schema.
	 */
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
