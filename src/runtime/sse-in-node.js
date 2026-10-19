/* global requestAnimationFrame */
/**
 * Bring a server's message stream into the browser node graph.
 *
 * `SseInNode` opens a stream presenting the command session it signs
 * with, snoops the `connected` handshake for that session, the slot and the
 * lease owner, and fills every parsed `msg` frame into the local graph.
 * RemoteLink composes it as the per-link `<patron>:sse-in`, and takes each
 * record through `onMessage`.
 *
 * The node is receive-only. Each inbound frame `onMessage` declines reaches the
 * graph through an EventSource listener that calls `super.fill`, the base
 * Node's route-by-TO.
 * RemoteIpc, not this node, wraps an outgoing reply FROM as
 * `_sse:{session}/{node}`, and the server passes a stream only the replies
 * headed with the session it presented — across every reconnect.
 *
 * Tachikoma parity keeps the constructor argument-free. Positional config
 * arrives through `arguments=`, whose `SchemaReflection` setter walks it onto
 * the declared properties; this class then splits the comma-separated
 * `subscribe` token, because the walk assigns strings where the runtime wants
 * an array.
 *
 * Dashboards read the lifecycle through `setState`: CONNECTING on open,
 * CONNECTED on handshake, then DISCONNECTED or RECONNECTING, and ERROR for a
 * stream error or a malformed frame. Every error path also calls
 * `printLessOften`, which prints one line per key per window, so a flapping
 * endpoint cannot flood the console. Every payload is a STRING, the substrate
 * convention: the `connected` envelope is a flat `KEY VALUE` string, and the
 * session lands in a plain field rather than in node state.
 */
import { SchemaReflection } from './schema-reflection';
import { TimerNode } from './timer-node';
import { Core } from './core';
import { nodesData, refreshNodesNonce } from './nodes-data';
import { ensureSession, renewSession, sessionHandle } from './command-auth';
import { IoTelemetry, byteLength } from './io-telemetry';
import { FetchEventSource } from './fetch-event-source';
import {
	TYPE,
	FROM,
	ID,
	KEY,
	VALUE,
	TM_BATCH,
	TM_BYTESTREAM,
	TM_ERROR,
	TM_INFO,
	TM_UNTYPED,
	infoPairs,
	newMessage,
	unpack,
	unpacked,
} from './message';
import { anyCarries, isGlob, splitStamp } from './log-stamp';
import { formatPosition, parseCrumb, parsePosition } from './log-position';

/**
 * A PHP lease owner as it travels: a canonical positive decimal string.
 * Never parsed into a Number — an owner id can exceed
 * `Number.MAX_SAFE_INTEGER`, so rounding one hands the heartbeat a lease
 * nobody holds. `HeartbeatNode` carries the same pattern for the same reason.
 */
const LEASE_OWNER_RE = /^[1-9][0-9]*$/;

/**
 * A `retry` VALUE must be a canonical decimal, as PHP's
 * `Core::canonical_decimal()` requires, and the delay it names is capped at
 * `MAX_BACKOFF_MS` as `SSE_In_Node::schedule_reconnect()` caps it. PHP also
 * rounds up to whole seconds, which the browser has no reason to copy.
 * `Number()` alone would take `''` and `' '` as 0: reopen at once.
 */
const RETRY_MS_RE = /^(?:0|[1-9][0-9]*)$/;

/**
 * Split a comma-separated `key=value` token, the shape of `CURSORS` and
 * `COUNTS`, into its pairs; a pair naming no key is skipped.
 *
 * @param {*} token The token; absent yields no pairs.
 * @return {Array<[string,string]>} Each key with the value after its `=`.
 */
function pairsOf( token ) {
	return String( token ?? '' )
		.split( ',' )
		.flatMap( ( pair ) => {
			const eq = pair.indexOf( '=' );
			return eq > 0
				? [ [ pair.slice( 0, eq ), pair.slice( eq + 1 ) ] ]
				: [];
		} );
}

/**
 * A line of a source's raw block as the record a Tail emits for it.
 *
 * @param {string} line The line, without its newline.
 * @return {Array} A TM_BYTESTREAM carrying the line, newline restored.
 */
function textRecord( line ) {
	const m = newMessage();
	m[ TYPE ] = TM_BYTESTREAM;
	m[ VALUE ] = `${ line }\n`;
	return m;
}

/**
 * Delete each key of `map` that `drop` names.
 *
 * @param {Object<string,*>}           map  The map, changed in place.
 * @param {( key: string ) => boolean} drop Whether a key goes.
 */
function dropKeys( map, drop ) {
	for ( const key of Object.keys( map ).filter( drop ) ) {
		delete map[ key ];
	}
}

/** REST route every stream opens. */
const STREAM_ENDPOINT = 'newspack-nodes/v1/messages/stream';

/**
 * Seek sentinels carried in an offset field, mirroring `Consumer_Node::SEEK_*`
 * — Tachikoma's vocabulary (`Consumer.pm`: "valid offsets: start (0), recent
 * (-2), end (-1)"). A signed number expresses every seek, so 0 is the START of
 * the log rather than doubling as "no position given". The reader also accepts
 * the words `start` / `recent` / `end` as aliases.
 *
 * `recent` (-2) has no JS spelling. It is live on the PHP side — `wp nodes
 * reqgrep --recent` and the `grep_requests` verb's `scope=recent` both seek it —
 * but both build a local Consumer rather than crossing this wire, so no browser
 * caller asks for it. Add it when one does, not before.
 */
export const SEEK_START = 0;

/** @testonly The tail seek. Production names it inside seekMap(), not by import. */
export const SEEK_END = -1;

/** The server's heartbeat cadence, mirroring `SSE_Out_Node::HEARTBEAT_MS`. */
const HEARTBEAT_CADENCE_MS = 2000;

/** Three heartbeats of silence: the point a stream reads as suspect. */
const STALE_AFTER_MS = HEARTBEAT_CADENCE_MS * 3;

/** Slack over the stale bound for a slow server or a throttled tab. */
const GRACE_MS = 4000;

/** Silence past this forces a fresh stream — the watchdog's one threshold. */
const FORCE_AFTER_MS = STALE_AFTER_MS + GRACE_MS;

/** How often `fire()` measures the silence; well under FORCE_AFTER_MS. */
const WATCHDOG_INTERVAL_MS = 2000;

/**
 * Bound on the CONNECTING stand-down. A browser between connections owns its
 * own `retry:` gap, but one wedged in CONNECTING fires no `error`, so an
 * unbounded stand-down leaves nothing to recover it. It sits comfortably above
 * any advertised reopen delay, so a normal gap never trips it.
 */
const CONNECTING_FORCE_AFTER_MS = 60000;

/**
 * Reconnect backoff floor, doubled on each failed attempt.
 *
 * Retrying on the flat watchdog interval instead gives a hard-down or 429ing
 * endpoint 30 requests a minute per open tab, indefinitely — and each attempt
 * takes a slot from the `sse_max_slots` pool, whose refusal is itself a 429
 * feeding the same loop.
 */
const INITIAL_BACKOFF_MS = 2000;

/** Backoff ceiling, matching the PHP half's `MAX_BACKOFF` of 30 seconds. */
const MAX_BACKOFF_MS = 30000;

/**
 * A stream id the server refuses by shape. `SSE_Out_Node::stream()` resolves
 * the session before it validates the id, so a probe carrying this answers
 * `401 sse_session_refused` for a dead session and `400 sse_stream_invalid`
 * for a live one — without opening a stream or taking a slot.
 */
const PROBE_STREAM_ID = '!';

/** The longest line a reader holds, PHP's `MAX_LINE_BUFFER_SIZE`. */
const MAX_LINE_BYTES = 33554432;

/** Milliseconds a block's split runs before it hands the page a turn. */
const SLICE_MS = 8;

/**
 * Hand the event loop back to the page and resume once it has painted: the
 * task after the next animation frame. Yielding a task alone lets the next
 * slice start before a frame is due, so a busy stream never paints. A hidden
 * page paints nothing and throttles its timers, so it takes no turn, and one
 * that hides while a frame is owed resumes then, since that frame never runs.
 *
 * @return {?Promise<void>} Settles once the page has had its turn, or null when there is no turn to give.
 */
function yieldToPage() {
	const doc = globalThis.document;
	if ( 'hidden' === doc?.visibilityState ) {
		return null;
	}
	if ( 'function' !== typeof requestAnimationFrame ) {
		return new Promise( ( resolve ) => setTimeout( resolve, 0 ) );
	}
	return new Promise( ( resolve ) => {
		const done = () => resolve();
		doc?.addEventListener( 'visibilitychange', done, { once: true } );
		requestAnimationFrame( () =>
			setTimeout( () => {
				doc?.removeEventListener( 'visibilitychange', done );
				done();
			}, 0 )
		);
	} );
}

/**
 * What `SseInNode.openStream` hands back: a `FetchEventSource`, or anything
 * with its surface, such as a test's fake `EventSource`.
 *
 * @typedef {{url: string, readyState: number, addEventListener: Function, close: () => void}} StreamSource
 */

/**
 * The receive half of a remote link: one stream, the watchdog that
 * notices when it dies silently, and the session identity the `connected`
 * handshake hands back. `start()` opens the stream; each `msg` frame is
 * unpacked and filled into the local graph, a raw block's records once its
 * TM_BATCH is split at its newlines, while `connected`, `retry`,
 * `heartbeat`, `disconnect` and `unparseable_lines` are snooped for lifecycle,
 * reopen cadence, liveness and skipped lines rather than routed.
 */
export class SseInNode extends SchemaReflection( TimerNode ) {
	/**
	 * Stream-opening seam, replacing `new FetchEventSource( url, {
	 * withCredentials: true } )`. Tests reassign it to hand back a fake with
	 * the same surface and drive its frames; null opens the real stream.
	 *
	 * Signature: `( url: string ) => { readyState: number, addEventListener: Function, close: Function }`.
	 *
	 * @type {?( url: string ) => StreamSource}
	 */
	static openStream = null;

	/**
	 * Start closed — no stream, no watchdog, no session. Every field is either
	 * configuration a patron may overwrite before `start()`, or per-connection
	 * state `close()` clears.
	 */
	constructor() {
		super();
		/** @type {string[]} */
		this.subscribe = [];
		// Empty falls back to the localized global (see the getters below).
		this._baseUrl = '';
		this._nonce = '';
		/**
		 * Optional per-subscription seek seed: an exact `{segment, offset}`, a
		 * SEEK sentinel, or an alias word. Unseeded names take SEEK_END.
		 *
		 * @type {?Object<string,{segment?:number,offset:number}|number|string>}
		 */
		this._positions = null;
		/**
		 * The patron's inbound seam, the counterpart of PHP
		 * `SSE_In_Node::$on_message`: handed each parsed record and the stamp
		 * its FROM opens with, it answers true for one it took. One it
		 * declines, and every record while it is null, leaves through this
		 * node's sink by its TO.
		 *
		 * @type {?( ( message: Array, stamp: string ) => boolean )}
		 */
		this.onMessage = null;
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
		// The session this stream presented; its replies are headed with it.
		this.presentedSession = null;
		// Session identity from `connected`; lease owner remains a string.
		this.sessionHandle = null;
		this.sessionSlot = null;
		this.sessionLeaseOwner = null;
		// Last terminal server control event for this EventSource connection.
		this.terminalDisconnect = null;
		// Lines the server skipped as unparseable; kept across reconnects.
		this.unparseableLines = 0;
		/**
		 * The same skips per stamp, from each frame's `COUNTS`.
		 *
		 * @type {Object<string,number>}
		 */
		this.unparseableByStamp = {};
		/**
		 * A line the last raw block cut short, per dir: where it begins and
		 * its text so far, joined to the block that continues it.
		 *
		 * @type {Object<string,{segment:number,offset:number,text:string}>}
		 */
		this._carries = {};
		/**
		 * The OFFSET of the header each dir's next batch must carry as its ID:
		 * a batch no header placed is dropped, as PHP drops it.
		 *
		 * @type {Object<string,string>}
		 */
		this._heads = {};
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
		this.registrations.UNPARSEABLE_LINES = {};
	}

	/**
	 * @return {string[]} The argument tokens last assigned.
	 */
	get arguments() {
		return super.arguments;
	}

	/**
	 * Let `SchemaReflection` walk the positional tokens, then repair the one
	 * field it cannot type: the walk assigns strings, so the comma-separated
	 * `subscribe` token becomes the array the stream URL and the CONNECTING
	 * payload both expect.
	 *
	 * @param {string[]} value Positional tokens; the first is the comma-separated subscription list.
	 */
	set arguments( value ) {
		super.arguments = value;
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
	 * means, as PollerNode replaces it with minting its poll command. So this
	 * does not call `super.fire()`. Here that also matters concretely: the base
	 * emits a TM_BYTESTREAM timestamp down its sink, and this node's sink is the
	 * DATA path, where a timestamp is indistinguishable from a record.
	 */
	fire() {
		const ref = Math.max( this.lastEventTime ?? 0, this._watchdogBase );
		if (
			FetchEventSource.CONNECTING === this._es?.readyState &&
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
	 * Restate where the named subscriptions open, leaving every other one's
	 * seed and read position alone: one stream carries several readers, and a
	 * seek on one must not move the rest.
	 *
	 * @param {string[]}                                                      subscribe The subscriptions being re-pointed.
	 * @param {?Object<string,{segment?:number,offset:number}|number|string>} positions Their seek seed; null tails them.
	 */
	reseek( subscribe, positions ) {
		this._dropPlace( ( dir ) => anyCarries( subscribe, dir ) );
		this._positions = { ...this._positions, ...positions };
	}

	/**
	 * Forget everything the stream holds for the dirs `drop` names: their
	 * seeds, their read positions and their skipped-line counts, so the next
	 * stream on one asks for the tail and counts afresh.
	 *
	 * @param {( dir: string ) => boolean} drop Whether a dir is forgotten.
	 */
	forget( drop ) {
		dropKeys( this.unparseableByStamp, drop );
		this._dropPlace( drop );
	}

	/**
	 * Drop the seeds and read positions of the dirs `drop` names. The seeds
	 * are copied first, so a map a caller handed in is never changed.
	 *
	 * @param {( dir: string ) => boolean} drop Whether a dir's place goes.
	 */
	_dropPlace( drop ) {
		this._positions = { ...this._positions };
		dropKeys( this._positions, drop );
		dropKeys( this.lastPositions, drop );
		dropKeys( this._carries, drop );
		dropKeys( this._heads, drop );
	}

	/**
	 * Parse the flat `KEY VALUE` connected envelope into plain session fields.
	 * SLOT and OWNER must arrive well-formed, and SESSION must echo the one the
	 * stream presented — none when it presented none; anything else rejects
	 * the handshake rather than leaving a half-known session behind.
	 *
	 * @param {*} value The envelope's VALUE — space-separated `KEY VALUE` pairs.
	 */
	_applyConnected( value ) {
		// A live handshake clears the backoff, like PHP's dispatch_event.
		this._backoffMs = INITIAL_BACKOFF_MS;
		const info = infoPairs( value );
		if ( ! info ) {
			this._rejectConnected( 'malformed' );
			return;
		}
		if ( ( info.SESSION ?? null ) !== this.presentedSession ) {
			this._rejectConnected( 'names another SESSION' );
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
		this.sessionHandle = this.presentedSession;
		this.sessionSlot = slot;
		this.sessionLeaseOwner = leaseOwner;
		this._seedPositions( info.CURSORS );
		// SSE_In_Node's payload: the raw envelope also carries the lease OWNER.
		this.setState( 'CONNECTED', `SLOT ${ slot }` );
		this._mayRenewNonce = true;
		// Stamp the live-stream connect time for the Overview SSE Uptime card.
		IoTelemetry.markSseConnected();
	}

	/**
	 * Add one `unparseable_lines` frame to the running count, published as
	 * UNPARSEABLE_LINES, and resume past the lines it skipped.
	 *
	 * The server's readers keep no cursor, so a line that will not unpack is
	 * skipped rather than ending the stream, and this frame is how the reader
	 * of the page learns of it. `COUNT` covers only the skips since the last
	 * frame, so the total holds across reconnects; `CURSORS` moves each
	 * subscription's resume point past them, so a reopen does not read the same
	 * torn line and count it again.
	 *
	 * @param {*} value `COUNT n COUNTS stamp=n,… CURSORS dir=segment:offset,…`.
	 */
	_applyUnparseable( value ) {
		const info = infoPairs( value ) ?? {};
		const count = Number( info.COUNT );
		if ( ! Number.isSafeInteger( count ) || count < 1 ) {
			this.setState( 'ERROR', 'malformed unparseable_lines frame' );
			Core.printLessOften(
				'ERROR: SseInNode: dropped a malformed unparseable_lines frame'
			);
			return;
		}
		this._seedPositions( info.CURSORS );
		this._addSkipped(
			count,
			pairsOf( info.COUNTS ).map( ( [ stamp, n ] ) => [
				stamp,
				Number( n ),
			] )
		);
	}

	/**
	 * Abandon a malformed handshake: forget every session field, publish ERROR
	 * and DISCONNECTED, and log at the rate limit.
	 *
	 * @param {string} reason What was wrong with the envelope, e.g. 'missing or invalid SLOT'.
	 */
	_rejectConnected( reason ) {
		this.sessionHandle = null;
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
	 * cause, so this renews the global credentials and restarts. An explicit
	 * remote nonce cannot be renewed, and a caller can bar renewal outright
	 * through `mayRenewNonce`; both of those reconnect instead.
	 */
	_recoverConnection() {
		const stream = this._es;
		if ( ! stream ) {
			return;
		}
		if ( this.presentedSession ) {
			this._probeSession( stream );
			return;
		}
		this._renewNonceAndRestart( stream );
	}

	/**
	 * Ask the server whether the session this stream presented is why it was
	 * refused. An EventSource never exposes the status of a failed open, so
	 * the probe repeats the request with a stream id the server refuses by
	 * shape: a dead session answers `sse_session_refused` first. Streams share
	 * the page's one session, so only a refusal of the handle still current
	 * renews it; a stream refused for a handle already dropped or replaced
	 * just reopens under whatever session is live. Anything else goes the
	 * ordinary nonce-and-reconnect way.
	 *
	 * @param {StreamSource} stream The stream that was refused.
	 */
	_probeSession( stream ) {
		const refused = this.presentedSession;
		const probe = new URL( stream.url, window.location.href );
		probe.searchParams.set( 'stream', PROBE_STREAM_ID );
		fetch( probe.toString(), { credentials: 'include' } )
			.then( ( r ) => r.json() )
			.then( ( body ) => body?.code )
			.catch( () => null )
			.then( ( code ) => {
				if ( this._es !== stream ) {
					return;
				}
				if ( 'sse_session_refused' === code ) {
					if ( sessionHandle() === refused ) {
						renewSession();
					}
					this._reopenOnceSessionIs( stream );
					return;
				}
				this._renewNonceAndRestart( stream );
			} );
	}

	/**
	 * The ordinary recovery: renew a stale global nonce and reopen, or, where
	 * the nonce is explicit or renewal is barred, force a reconnect.
	 *
	 * @param {StreamSource} stream The stream the browser gave up on.
	 */
	_renewNonceAndRestart( stream ) {
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
	 * Own the reopen the browser is about to make for us.
	 *
	 * EventSource reconnects by itself on the server's `retry:` field, which
	 * SSE_Out does not send — the interval arrives as a `retry` EVENT instead,
	 * so a browser left to itself falls back to its own default and the two
	 * halves of one link disagree about the cadence. Closing the stream is what
	 * stops that built-in retry from racing this one; the backoff covers a
	 * connection that advertised nothing. The last `retry` wins, so a lifetime
	 * close's 0 reopens a busy stream at once.
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
		this.presentedSession = sessionHandle();
		let url =
			`${ this.baseUrl }${ STREAM_ENDPOINT }` +
			`?subscribe=${ encodeURIComponent( this.subscribe.join( ',' ) ) }` +
			`&_wpnonce=${ this.nonce }`;
		if ( this.presentedSession ) {
			url += `&session=${ encodeURIComponent( this.presentedSession ) }`;
			// Names this stream's lease, so its reconnect takes the lease over.
			if ( this.name ) {
				url += `&stream=${ encodeURIComponent( this.name ) }`;
			}
		}
		if ( Object.keys( seeks ).length > 0 ) {
			url += `&positions=${ encodeURIComponent(
				JSON.stringify( seeks )
			) }`;
		}
		// Lifecycle: opening; CONNECTED on handshake, then DISCONNECTED/ERROR.
		delete this.setStateCache.CONNECTED;
		this.setState( 'CONNECTING', this.subscribe.join( ',' ) );
		const es = (
			SseInNode.openStream ??
			( ( at ) => new FetchEventSource( at, { withCredentials: true } ) )
		)( url );
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
			if ( FetchEventSource.CLOSED === es.readyState ) {
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
		// The reopen schedule, as data rather than the protocol `retry:` field.
		es.addEventListener( 'retry', ( e ) => {
			if ( stale() ) {
				return;
			}
			this.lastEventTime = Date.now();
			const ms = unpack( e.data )[ VALUE ];
			// 0 is a schedule: a lifetime close sends it to reopen at once.
			if ( 'string' === typeof ms && RETRY_MS_RE.test( ms ) ) {
				this._serverRetryMs = Math.min( MAX_BACKOFF_MS, Number( ms ) );
			}
		} );
		// Idle keepalive `event: heartbeat`: snoop for liveness, don't route.
		es.addEventListener( 'heartbeat', () => {
			if ( stale() ) {
				return;
			}
			this.lastEventTime = Date.now();
		} );
		// `connected` is its own SSE event: snoop session/slot, don't route.
		es.addEventListener( 'connected', ( e ) => {
			if ( stale() ) {
				return;
			}
			this.lastEventTime = Date.now();
			this._applyConnected( unpack( e.data )[ VALUE ] );
		} );
		// Torn lines the server skipped: count them, resume past them.
		es.addEventListener( 'unparseable_lines', ( e ) => {
			if ( stale() ) {
				return;
			}
			this.lastEventTime = Date.now();
			this._applyUnparseable( unpack( e.data )[ VALUE ] );
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
		// A record, or a raw block or its header, which the TM_BATCH bit marks.
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
			const { dir } = splitStamp( message[ FROM ] );
			if ( message[ TYPE ] & TM_BATCH && message[ TYPE ] & TM_INFO ) {
				this._heads[ dir ] = infoPairs( message[ VALUE ] )?.OFFSET;
				return;
			}
			// Inbound accounting: bytesRead + IoTelemetry (msg DATA only).
			const size = byteLength( e.data );
			this.bytesRead += size;
			this.largestMsgSent = Math.max( this.largestMsgSent, size );
			if ( message[ TYPE ] & TM_BATCH ) {
				return this._takeBlock( message, size, stale );
			}
			this._trackPosition( message, dir );
			IoTelemetry.recordIn( size, 1 );
			this._deliver( message, dir );
		} );
	}

	/**
	 * Split a raw block into records, as PHP `Remote_Consumer_Node` does, the
	 * two held to `tests/fixtures/raw-blocks.json`. A batch no header placed
	 * is dropped. A line the last block cut short is joined when this one
	 * continues it, and torn when it does not. Each whole line is unpacked, or
	 * wrapped as a TM_BYTESTREAM when the block's type says its lines are
	 * text, then stamped FROM the stream and ID'd with its place in the
	 * spoke's bytes. A torn line is counted for its stream, since a view has
	 * no quarantine, and the resume point moves past it either way. What
	 * follows the last newline waits for the next block, and a reopen asks
	 * past it. Every `SLICE_MS` it hands a visible page a turn, and stops if its
	 * stream was replaced meanwhile; the frame's bytes and the records it
	 * delivered go to `IoTelemetry` once it is done.
	 *
	 * @param {Array}         block The TM_BATCH, its ID where the bytes begin.
	 * @param {number}        size  The frame's bytes on the wire.
	 * @param {() => boolean} stale Whether the stream it came on was replaced.
	 * @return {Promise<void>} Settles once every record is delivered.
	 */
	async _takeBlock( block, size, stale ) {
		const stamp = String( block[ FROM ] ?? '' );
		const { dir } = splitStamp( stamp );
		const head = this._heads[ dir ];
		delete this._heads[ dir ];
		if ( undefined === head || head !== block[ ID ] ) {
			Core.printLessOften(
				'ERROR: SseInNode: dropped a raw block no header placed'
			);
			IoTelemetry.recordIn( size, 0 );
			return;
		}
		const at = parsePosition( block[ ID ] );
		if ( '' === dir || undefined === at?.segment ) {
			Core.printLessOften(
				'ERROR: SseInNode: dropped a raw block naming no place'
			);
			IoTelemetry.recordIn( size, 0 );
			return;
		}
		let text = String( block[ VALUE ] ?? '' );
		let offset = at.offset;
		let torn = 0;
		const carry = this._carries[ dir ];
		delete this._carries[ dir ];
		if (
			carry?.segment === at.segment &&
			carry.offset + byteLength( carry.text ) === offset
		) {
			text = carry.text + text;
			offset = carry.offset;
		} else if ( carry ) {
			torn++;
		}
		// An ASCII block's bytes are its characters: no line needs measuring.
		const ascii = byteLength( text ) === text.length;
		const isText = 0 !== ( block[ TYPE ] & TM_BYTESTREAM );
		let delivered = 0;
		let pos = 0;
		let nl;
		let until = performance.now() + SLICE_MS;
		while ( -1 !== ( nl = text.indexOf( '\n', pos ) ) ) {
			const line = text.slice( pos, nl );
			const length = ( ascii ? line.length : byteLength( line ) ) + 1;
			const record = isText ? textRecord( line ) : unpacked( line );
			if ( null === record ) {
				torn++;
			} else if ( this.stampMessage( record, stamp ) ) {
				record[ ID ] = formatPosition( at.segment, offset, length );
				this.lastPositions[ dir ] = {
					segment: at.segment,
					offset: offset + length,
				};
				this._deliver( record, dir );
				delivered++;
			}
			offset += length;
			pos = nl + 1;
			const turn = performance.now() > until && yieldToPage();
			if ( turn ) {
				await turn;
				if ( stale() ) {
					IoTelemetry.recordIn( size, delivered );
					return;
				}
				// A split under way is a stream alive, however long it runs.
				this.lastEventTime = Date.now();
				until = performance.now() + SLICE_MS;
			}
		}
		let cut = text.slice( pos );
		let cutBytes = byteLength( cut );
		if ( cutBytes > MAX_LINE_BYTES ) {
			// No longer line is held: skip it, counted once.
			offset += cutBytes;
			cut = '';
			cutBytes = 0;
			torn++;
		}
		if ( '' !== cut ) {
			this._carries[ dir ] = { segment: at.segment, offset, text: cut };
		}
		// A reopen asks past the bytes of a cut line, which it already holds.
		this.lastPositions[ dir ] = {
			segment: at.segment,
			offset: offset + cutBytes,
		};
		if ( torn > 0 ) {
			this._addSkipped( torn, [ [ dir, torn ] ] );
		}
		IoTelemetry.recordIn( size, delivered );
	}

	/**
	 * Hand one record to the patron's `onMessage`, counting it once, or send
	 * it on by its TO when there is none or it declines. A TM_ERROR record
	 * also surfaces as ERROR.
	 *
	 * @param {Array}  message The positional Message just received.
	 * @param {string} stamp   The stamp its FROM opens with.
	 */
	_deliver( message, stamp ) {
		if ( message[ TYPE ] & TM_ERROR ) {
			this.setState(
				'ERROR',
				'string' === typeof message[ VALUE ]
					? message[ VALUE ]
					: 'stream error'
			);
		}
		if ( this.onMessage?.( message, stamp ) ) {
			this.counter++;
			return;
		}
		super.fill( message );
	}

	/**
	 * What to ask for per subscription: the position this stream reached, or
	 * SEEK_END when it has none. Stating the seek is the point — carrying
	 * "tail" by OMITTING the parameter leaves a real `{segment: 0, offset: 0}`
	 * unable to mean the start of the log on the PHP side.
	 *
	 * A reopen resumes past what it read, so a position reached wins over the
	 * seed that opened the stream. A stream that read NOTHING — refused by the
	 * slot pool before its first frame — has none, and there the seed stands:
	 * overwriting it with "wherever we got to" turns a chart asking to replay
	 * from the start of the log into one showing a single live point.
	 *
	 * A GLOB is the one seek a client cannot state: the server expands it into
	 * concrete dirs and keys positions by those, so an entry filed under
	 * `firehose.*` is one nothing reads. Its dirs take the server's default,
	 * which is this same tail, and a dir it has read resumes like any other.
	 * A non-glob subscription IS its dir's stamp (`Log_Discovery::dir_of()`
	 * resolves it by direct path), so stating it is exact. A seed or a read
	 * position no subscription `carries()` is not stated.
	 *
	 * @return {Object<string,{segment?:number,offset:number}|number|string>} Per-subscription seek.
	 */
	seekMap() {
		/** @type {Object<string,{segment?:number,offset:number}|number|string>} */
		const stated = {};
		for ( const [ dir, at ] of [
			...Object.entries( this._positions || {} ),
			...Object.entries( this.lastPositions ),
		] ) {
			if ( anyCarries( this.subscribe, dir ) ) {
				stated[ dir ] = at;
			}
		}
		for ( const sub of this.subscribe ) {
			if ( ! isGlob( sub ) && undefined === stated[ sub ] ) {
				stated[ sub ] = SEEK_END;
			}
		}
		return stated;
	}

	/**
	 * Close the stream and forget everything tied to this connection: any
	 * pending reopen, the visibility listener, the watchdog, the frame clock,
	 * the advertised reopen delay, the session lease, and any terminal
	 * disconnect. Safe when nothing is open, and `start()` calls it first.
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
		// Forget this connection's retry delay, lease and terminal event.
		this._serverRetryMs = null;
		this.presentedSession = null;
		this.sessionHandle = null;
		this.sessionSlot = null;
		this.sessionLeaseOwner = null;
		this.terminalDisconnect = null;
		this._heads = {};
	}

	/**
	 * Seed each subscription's resume point from the `connected` envelope.
	 *
	 * A stream that closes having delivered nothing — the normal case for an
	 * idle close — hands the client no ID breadcrumb to advance from, so
	 * without this the reopen tail-seeks and drops whatever arrived in the gap.
	 * A delivered record overwrites the seed, since its breadcrumb is newer.
	 * A file source that has not seen its generation states `dir=:offset`,
	 * and its seed carries no `segment`: 0 would name a foreign inode. Each
	 * position is read by `parsePosition()`, and one naming no place is
	 * skipped, as PHP `SSE_In_Node::stamp_values_of()` skips it.
	 *
	 * @param {*} token `dir=<position>` pairs, comma-separated.
	 */
	_seedPositions( token ) {
		for ( const [ dir, position ] of pairsOf( token ) ) {
			const at = parsePosition( position );
			if ( at ) {
				this.lastPositions[ dir ] = at;
			}
		}
	}

	/**
	 * Add skipped lines to the running total, published as UNPARSEABLE_LINES,
	 * and to each stamp's own count. A stamp's count that is not a positive whole
	 * number adds nothing to it.
	 *
	 * @param {number}                  total   Lines skipped in all.
	 * @param {Array<[string, number]>} byStamp Each stamp with its share.
	 */
	_addSkipped( total, byStamp ) {
		this.unparseableLines += total;
		for ( const [ stamp, n ] of byStamp ) {
			if ( Number.isSafeInteger( n ) && n > 0 ) {
				this.unparseableByStamp[ stamp ] =
					( this.unparseableByStamp[ stamp ] ?? 0 ) + n;
			}
		}
		this.setState( 'UNPARSEABLE_LINES', this.unparseableLines );
	}

	/**
	 * Reopen as soon as a command session is live again, waiting out the auth
	 * backoff between attempts rather than opening a sessionless stream.
	 *
	 * @param {StreamSource} stream The refused stream this reopen replaces.
	 */
	_reopenOnceSessionIs( stream ) {
		ensureSession().then( ( session ) => {
			if ( this._es !== stream ) {
				return;
			}
			if ( session ) {
				this._restart( 'session renewed' );
				return;
			}
			this._reopenTimer = setTimeout( () => {
				this._reopenTimer = null;
				this._reopenOnceSessionIs( stream );
			}, this._backoffMs );
		} );
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
	 * @param {Array}  message The positional Message just received.
	 * @param {string} dir     The partition directory its FROM opens with.
	 */
	_trackPosition( message, dir ) {
		const crumb = parseCrumb( message[ ID ] );
		if ( ! crumb || '' === dir ) {
			return;
		}
		// Resume at offset+length — the exact next-record boundary.
		this.lastPositions[ dir ] = {
			segment: crumb.segment,
			offset: crumb.offset + crumb.length,
		};
	}

	/**
	 * The dirs the stream holds a place for, by a seed or a read position:
	 * what a `reseek()` over them would drop.
	 *
	 * @return {string[]} The dirs, each named once.
	 */
	places() {
		return [
			...new Set( [
				...Object.keys( this._positions ?? {} ),
				...Object.keys( this.lastPositions ),
			] ),
		];
	}

	/**
	 * Whether the stream is open, or closed and waiting out its reopen: either
	 * way it is coming back without being started again.
	 *
	 * @return {boolean} True while open or reopening.
	 */
	isOpenOrReopening() {
		return Boolean( this._es || this._reopenTimer );
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
	 * @return {?string} Command session whose replies the live stream carries, or null before a handshake completes or when it presented none.
	 */
	session() {
		return this.sessionHandle ?? null;
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
