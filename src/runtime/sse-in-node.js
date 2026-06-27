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
import {
	TYPE,
	FROM,
	TO,
	ID,
	KEY,
	VALUE,
	TM_INFO,
	TM_ERROR,
	unpack,
} from './message';

// A record's ID is the Consumer's `seg:offset` breadcrumb; FROM carries the
// producer path `<sub>.p<partition>/…`. Parsing both lets the client resume a
// reconnect from exactly where it left off (no gap, no replay).
const ID_POSITION_RE = /^(\d+):(\d+)$/;

// Heartbeat-timeout watchdog. The server beats every 2s; force a fresh stream
// only after STALE (3 missed beats) + GRACE (self-recovery observe window) of
// total silence, long enough not to fight the browser's own EventSource retry.
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
		// Optional per-subscription seek seed, `{ <sub>: { <partition>: pos } }`
		// where pos is 'start' (replay from the oldest retained record), 'end'
		// (tail — the default when unset), or a `{seg,off}`. Set programmatically
		// (a structured blob, NOT a positional arg); serialized into the stream
		// URL by start(). null/empty → omit the param → the server tail-seeks.
		this.positions = null;
		// Last seen record position per `[sub][partition] = { seg, off }`, parsed
		// from each frame's ID + FROM — so a reconnect resumes from the exact offset.
		this.lastPositions = {};
		this._es = null;
		// Wall-clock of the last inbound frame (data row OR idle heartbeat). SseIn is
		// the only node that sees every frame, so it owns stream
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
		// Session identity parsed from the `connected` envelope into PLAIN fields
		// (set_state payloads are strings, so these can't ride the state cache):
		// pid for RemoteIpc's `_sse:{pid}` reply-FROM wrap; slot for the Heartbeat's
		// slot keep-alive (RemoteLink's bridge reads it on the CONNECTED event).
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
		// The walk assigns `subscribe` as the raw comma-separated token; split it.
		if ( 'string' === typeof this.subscribe ) {
			this.subscribe = this.subscribe.split( ',' ).filter( Boolean );
		}
	}

	// A node owns its teardown: drop the stream + watchdog before unregistering.
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
		// Lifecycle visibility: opening the stream. CONNECTED replaces it on the
		// `connected` handshake; DISCONNECTED / RECONNECTING / ERROR on trouble.
		this.setState( 'CONNECTING', this.subscribe.join( ',' ) );
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
				this.setState( 'DISCONNECTED', 'EventSource closed' );
				IoTelemetry.markSseDisconnected();
				Core.printLessOften(
					'ERROR: SseInNode: disconnected - EventSource closed by browser'
				);
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
				this.setState( 'ERROR', 'malformed typeless frame' );
				Core.printLessOften(
					'ERROR: SseInNode: dropped a malformed typeless SSE frame'
				);
				return;
			}
			if ( message[ TYPE ] & TM_INFO && 'connected' === message[ KEY ] ) {
				// Snoop-only handshake: parse it into fields + the CONNECTED state;
				// metadata, not a graph message — don't route it (the transcript).
				this._applyConnected( message[ VALUE ] );
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
			this._trackPosition( message );
			// Inbound boundary accounting for the debug overlay: one received frame
			// + its wire bytes. The error tally for a TM_ERROR frame rides the
			// `ERROR:` log below — Core.stderr records it off the keyword, so an
			// explicit recordError() here would double-count.
			IoTelemetry.recordIn( byteLength( e.data ), 1 );
			if ( message[ TYPE ] & TM_ERROR ) {
				// Surface the stream error for dashboards (snoop; still forwarded so
				// the consumer's own error handling runs). setState for the visible
				// last-error + printLessOften so the rate is tunable (and the count).
				const errText =
					'string' === typeof message[ VALUE ]
						? message[ VALUE ]
						: 'stream error';
				this.setState( 'ERROR', errText );
				// Stable rate-limit key (errText rides the ERROR state, not the log
				// key) so a varying-text stream-error storm coalesces instead of
				// flooding + leaking Core._lastPrint. The error tally rides this
				// `ERROR:` log via Core.stderr — deliberately rate-limited for a
				// stream, unlike CommandClient's per-reply explicit count.
				Core.printLessOften( 'ERROR: SseInNode: stream error frame' );
			}
			super.fill( message );
		} );
	}

	// Parse the flat `KEY VALUE` connected envelope into plain session fields.
	// TM_INFO / set_state values are STRINGS, so pid lives on the node (not the
	// state cache) and the CONNECTED state carries the raw string for subscribers
	// to split themselves. A handshake with no PID is malformed — report it both
	// ways (state + rate-limited log).
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
			// Stable rate-limit key; raw rides the ERROR state. Don't emit CONNECTED
			// on a malformed handshake (mirror PHP, which returns without CONNECTED).
			Core.printLessOften(
				'ERROR: SseInNode: connected envelope missing PID'
			);
			return;
		}
		this.setState( 'CONNECTED', raw );
		// Stamp the live-stream connect time for the Overview's SSE Uptime card.
		IoTelemetry.markSseConnected();
	}

	// Remember a record's `{seg,off}` keyed by its concrete partition DIRECTORY —
	// the FROM's first path segment (`completed.p0`, or any layout the producer
	// stamped). Each directory is its own unique partition; we never parse a
	// `.p{N}` integer out of the name. A non-`seg:offset` ID (a command reply's
	// correlation id) is ignored.
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
		this.lastPositions[ dir ] = {
			seg: Number( idMatch[ 1 ] ),
			off: Number( idMatch[ 2 ] ),
		};
	}

	// A flat `{ <concrete-dir>: pos }` seed resuming each seen partition from its
	// last offset, or null when nothing's been tracked yet (→ the caller
	// tail-seeks). The server seeds only the dirs it opens and ignores the rest,
	// so no per-subscription filtering is needed.
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
		// Resume from the last seen offset (no gap, no replay); null when nothing
		// was tracked → tail, so a history seed is never re-streamed on a drop.
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
		// A closed stream has no liveness — hide "Xs ago" until a reopen produces a
		// fresh frame. (A real drop is an EventSource error, not close(), so it
		// leaves lastEventTime frozen and "ago" climbs as the intended warning.)
		this.lastEventTime = null;
		// Forget the session pid so pid() doesn't report a stale one after a reopen
		// (the stream can be closed/reopened on cd off/onto a worker); a fresh
		// `connected` envelope repopulates it.
		this.sessionPid = null;
	}

	pid() {
		return this.sessionPid ?? null;
	}

	// Session slot parsed from the `connected` envelope (mirrors PHP slot()). The
	// RemoteLink bridge reads it to keep the Heartbeat's slot keepalive alive.
	slot() {
		return this.sessionSlot ?? null;
	}

	static nodeSchema() {
		return {
			category: 'I/O',
			description:
				'Inbound SSE receive-ingress; composed (unnamed) by RemoteLink as the per-link stream.',
			// accepts_fill is a UI wireability hint: SseIn is a pure ingress source
			// composed by RemoteLink, not a drag-into target, so it's false.
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
