/**
 * Command signing, browser side. Mirrors PHP Command_Auth and implements the
 * client half of ADR-15: the minter signs, and the ingress only verifies.
 *
 * The browser holds no site secret and never could — anything shipped to
 * wp-admin is readable by whoever is sitting there. It signs with a SESSION key
 * issued by POST /auth, which the server hands out only after WordPress has
 * authenticated the request. The key is therefore a capability scoped to one
 * session, not a shared secret.
 *
 * Signing happens where a command is MINTED (the Shell), never in the transport.
 * HttpOut POSTs whatever reaches it, so a wire-arrived frame routed into `_http`
 * must go out unsigned and die at the server — that is what stops the egress
 * node being an oracle that confers authority on arrival.
 *
 * The canonical string is byte-for-byte identical to PHP's. That parity is
 * pinned by tests/fixtures/signatures.json, verified from both languages,
 * because neither language's own suite can catch a drift: each is internally
 * consistent, so both stay green while nothing verifies across the wire.
 *
 * The HMAC comes from @noble/hashes rather than crypto.subtle, because it must
 * be SYNCHRONOUS. WebCrypto returns promises as an API choice — HMAC-SHA256
 * over a few hundred bytes is microseconds of arithmetic, not work worth
 * deferring — and making the Shell's dispatch() async to await one moves every
 * graph mutation a microtask later, failing 105 tests across twelve suites and
 * reordering renders in the console. JS has no way to block on a promise
 * (Perl's Tachikoma::drain swaps in a sync framework and re-enters the loop;
 * JS's loop is the runtime and is not re-entrant), so the fix is to have no
 * async operation at all.
 */

import { Core } from './core';
import names from './reserved-node-names.json';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import {
	LOCAL,
	TYPE,
	TIMESTAMP,
	VALUE,
	TM_COMMAND,
	TM_RESPONSE,
	TM_ERROR,
} from './message';

/**
 * The canonical signing string: command semantics + ts + nonce. Never TYPE and
 * never TO/FROM — the SEMANTICS are signed, not the envelope, matching
 * Tachikoma's Command::sign (`id:timestamp:name:arguments:payload`). Leaving
 * TYPE out is what lets a mint sign at build time instead of after every flag.
 *
 * PHP encodes this with JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
 * precisely so it matches JSON.stringify. Do not "normalize" either side.
 *
 * A command whose VALUE carries no name or no arguments signs as `''` and `[]`.
 * PHP's canonical() falls back to the same two values. Change one side's
 * fallback alone and the signature never verifies.
 *
 * @param {number}   ts    Unix seconds.
 * @param {string}   name  Command verb.
 * @param {string[]} args  Argument tokens.
 * @param {string}   nonce Single-use nonce (hex).
 * @return {string} The string to HMAC.
 */
function canonical( ts, name, args, nonce ) {
	return JSON.stringify( [
		ts,
		String( name ?? '' ),
		Array.isArray( args ) ? args : [],
		nonce,
	] );
}

/**
 * HMAC-SHA256 of `string` under `key`, lowercase hex — matching PHP's
 * hash_hmac( 'sha256', … ). Synchronous by design; see the file header.
 *
 * @param {string} string Message to sign.
 * @param {string} key    Session key.
 * @return {string} Lowercase hex digest.
 */
function hmacHex( string, key ) {
	return bytesToHex(
		hmac( sha256, utf8ToBytes( key ), utf8ToBytes( string ) )
	);
}

/**
 * Mint a single-use nonce, the same shape as PHP's
 * bin2hex( random_bytes( 16 ) ). It rides in the envelope and the verifier
 * claims it with an atomic add(), so it has only to be unpredictable and
 * unique — 16 bytes of CSPRNG output is both.
 *
 * @return {string} 32 lowercase hex characters.
 */
function newNonce() {
	const bytes = new Uint8Array( 16 );
	crypto.getRandomValues( bytes );
	return Array.from( bytes )
		.map( ( b ) => b.toString( 16 ).padStart( 2, '0' ) )
		.join( '' );
}

/**
 * What POST /auth issues. The response also carries the granted `scope`, which
 * the server enforces on its own side; nothing here reads it, and a client
 * cannot widen what it was given.
 *
 * @typedef {Object} CommandSession
 * @property {string} handle     Addresses the session server-side, stamped
 *                               into every envelope beside the signature.
 * @property {string} key        The HMAC key. The /auth response is the only
 *                               place it is ever disclosed.
 * @property {number} expires_in Issued lifetime, in seconds.
 * @property {number} [now]      The server's clock, in Unix seconds. Both
 *                               numbers are read defensively: the /auth body
 *                               is unvalidated JSON.
 */

/**
 * The live session, or null while none is held.
 *
 * @type {CommandSession|null}
 */
let session = null;

/**
 * The /auth round trip currently in flight, memoised so N concurrent commands
 * share ONE request rather than racing to mint N sessions the server would
 * then have to keep. Cleared in a `finally`, so a failure re-arms it.
 *
 * @type {Promise<CommandSession|null>|null}
 */
let establishing = null;

/** Whether /auth has ever returned a body. Silence before that is expected. */
let attempted = false;

/**
 * Monotonic invalidation counter. Every auth-shaped failure — a refused session,
 * a renewed nonce, an expiry — bumps this, and reconciled loaders re-establish
 * because it moved. That is what lets state initialised once at mount recover
 * without a per-call-site retry: the loader does not need to know WHICH failure
 * happened, only that what it was told is no longer true.
 */
let generation = 0;

/**
 * @testonly Observability for command-auth.test.js, which asserts the counter
 * advances on each auth-shaped failure and settles when nothing more happens.
 * @return {number} The current invalidation generation.
 */
export function authGeneration() {
	return generation;
}

/** Invalidate everything derived from the current session. */
export function invalidateAuth() {
	generation++;
}

/**
 * Width of the first re-auth window. A session the server refuses would
 * otherwise spin — every poll tick minting, being refused, renewing, minting
 * again — which reaches ~150 requests per second. The window widens while
 * /auth keeps failing, so a broken session costs one request per window.
 */
const BACKOFF_START_MS = 1000;

/** Ceiling on the doubling: a long outage settles at one /auth every 30s. */
const BACKOFF_MAX_MS = 30_000;

/** The current window width. A successful /auth resets it to the start. */
let backoffMs = BACKOFF_START_MS;

/** clock() ms before which no /auth is attempted; 0 means "attempt now". */
let retryAfter = 0;

/**
 * Clock seam standing in for the Date.now() every backoff and expiry decision
 * reads. Tests reassign it to step time forward rather than wait, which leaves
 * the memoisation, the widening and the expiry checks running as production
 * code. Signature: `function (): number`, milliseconds since the epoch.
 *
 * @type {(() => number)|null}
 */
let now = null;

/**
 * @testonly Exported for the backoff test; production reaches `now` directly.
 * @param {(() => number)|null} fn Replacement clock, or null for Date.now.
 */
export function __setBackoffClock( fn ) {
	now = fn;
}

/**
 * Read the current time through the seam.
 *
 * @return {number} Milliseconds since the epoch.
 */
function clock() {
	return ( now ?? Date.now )();
}

/**
 * The server's clock minus ours, in seconds, learned from /auth's `now`.
 * signCommand() adds it to TIMESTAMP: the minter signs TIMESTAMP, so the
 * ingress cannot re-anchor a skewed client, and aligning here is what keeps a
 * skewed browser inside the verifier's MAX_PAST_S / MAX_FUTURE_S window.
 */
let clockOffset = 0;

/**
 * One /auth round trip, resolving to the issued session or to null when none
 * could be had. It may reject instead — ensureSession() catches, and a
 * rejection and a null cost the same widened backoff.
 *
 * @typedef {() => Promise<CommandSession|null>} AuthFetch
 */

/**
 * /auth transport seam, lazily defaulted to postAuth() so the memoisation, the
 * issued-session predicate and the clock alignment around it all run as
 * production code under test. Tests reassign it to hand back a fixed session,
 * or to refuse.
 *
 * @type {AuthFetch|null}
 */
let authFetch = null;

/**
 * Install a replacement /auth transport. Exported from the runtime package, so
 * a consumer's own tests can establish a session without a REST round trip.
 *
 * @param {AuthFetch|null} fn Replacement transport, or null for the real POST.
 */
export function __setAuthFetch( fn ) {
	authFetch = fn;
}

/**
 * When the issued session stops being usable, in clock() ms, or Infinity when
 * the server named no lifetime. Honouring it is what makes expiry cheap to
 * discover: otherwise the only way to learn a session has died is to have a
 * command refused, and that command is the one thing lost.
 */
let expiresAt = Infinity;

/**
 * Whether the live session has outlived what the server issued it for.
 *
 * @return {boolean} True once the issued lifetime has elapsed.
 */
function sessionExpired() {
	return clock() >= expiresAt;
}

/**
 * Whether a session is live, dropping one that has aged out on the way past.
 * Emitters gate on this because a mint is synchronous and cannot wait.
 *
 * @return {boolean} True if signCommand() will produce a signature.
 */
export function hasSession() {
	if ( session && sessionExpired() ) {
		// Discovered, not refused: drop it so the next mint re-auths.
		session = null;
		invalidateAuth();
	}
	return null !== session;
}

/**
 * The server has forgotten our session — evicted from the cache, or restarted.
 * Drop it so the next ensureSession() establishes a new one; the poll that hit
 * the refusal is lost, and its next tick works.
 */
export function renewSession() {
	session = null;
	establishing = null;
	invalidateAuth();
	// Else an issued-then-refused session loops at the poll rate.
	retryAfter = clock() + backoffMs;
	backoffMs = Math.min( backoffMs * 2, BACKOFF_MAX_MS );
}

/**
 * Whether a command may be minted now — and, when it may not, ask for a session
 * so the next tick can. Emitters gate on THIS rather than hasSession(), so an
 * eviction or a server restart heals itself: the tick that finds the session
 * gone is the tick that re-auths. The backoff lives in ensureSession(), so a
 * session that stays broken costs one /auth per window, not one per tick.
 *
 * @return {boolean} True if a mint will produce a signed command.
 */
export function readyToMint() {
	// hasSession() drops an aged-out session, so the re-auth below is reached.
	if ( hasSession() ) {
		return true;
	}
	void ensureSession();
	return false;
}

/**
 * Drop the session so the next command re-authenticates, clearing the backoff,
 * the clock alignment and the expiry with it. A re-login starts from the same
 * clean slate a fresh page load would.
 */
export function forgetSession() {
	session = null;
	establishing = null;
	clockOffset = 0;
	attempted = false;
	backoffMs = BACKOFF_START_MS;
	retryAfter = 0;
	expiresAt = Infinity;
	// Generation stays monotonic: a reset could read as "nothing changed".
}

/**
 * POST /auth once, with whatever REST nonce the caller is holding.
 *
 * @param {{baseUrl: string, nonce: string}} client REST base and page nonce.
 * @return {Promise<Response>} The raw response; the caller reads the status.
 */
async function postAuthOnce( client ) {
	return fetch( `${ client.baseUrl }newspack-nodes/v1/auth`, {
		method: 'POST',
		headers: { 'X-WP-Nonce': client.nonce },
	} );
}

/**
 * Trade the page's REST nonce for a session, renewing a stale nonce once.
 *
 * A stale nonce refuses /auth at exactly the moment a session must be
 * re-minted — the tab that slept through the nonce's lifetime. Left to throw,
 * that 403 widens the backoff and the session cannot be re-established until
 * the window elapses, so a `rest_cookie_invalid_nonce` refusal buys a fresh
 * nonce and one retry. The command transport carries the same renew-once.
 *
 * The body is unvalidated here; ensureSession() is what decides whether it
 * carries a usable handle and key.
 *
 * @return {Promise<CommandSession|null>} The issued session, or null when the
 *                                        page carries no nonce to trade.
 * @throws {Error} When /auth answers anything but 2xx, retry included.
 */
async function postAuth() {
	const { nodesData, refreshNodesNonce } = await import( './nodes-data' );
	const { restUrl, nonce } = nodesData();
	const client = { baseUrl: restUrl, nonce };
	// No nonce: nothing to trade for a session. Don't POST into the dark.
	if ( ! client.nonce ) {
		return null;
	}
	let r = await postAuthOnce( client );
	if ( ! r.ok && 403 === r.status ) {
		const code = await r
			.text()
			.then( ( t ) => {
				try {
					return JSON.parse( t )?.code ?? '';
				} catch ( e ) {
					return '';
				}
			} )
			.catch( () => '' );
		if ( 'rest_cookie_invalid_nonce' === code ) {
			client.nonce = await refreshNodesNonce();
			invalidateAuth();
			r = await postAuthOnce( client );
		}
	}
	if ( ! r.ok ) {
		throw new Error( `/auth failed - HTTP ${ r.status }` );
	}
	return r.json();
}

/**
 * Establish the session, once. Call at mount — signing is synchronous and reads
 * whatever this leaves behind, so the round trip must finish before the first
 * command crosses to the server. Concurrent callers share the in-flight promise
 * rather than racing to mint sessions the server would keep.
 *
 * @return {Promise<CommandSession|null>} The session, or null if it could not
 *                                        be had.
 */
export async function ensureSession() {
	if ( session && ! sessionExpired() ) {
		return session;
	}
	if ( session ) {
		// Aged out. Drop it here so the mint below establishes a fresh one.
		session = null;
		invalidateAuth();
	}
	// Backing off: one /auth per window, not one per caller.
	if ( clock() < retryAfter ) {
		return null;
	}
	if ( ! establishing ) {
		establishing = ( authFetch ?? postAuth )()
			.then( ( issued ) => {
				// "Expected" only once a server actually answered.
				attempted = null !== issued;
				session = issued?.handle && issued?.key ? issued : null;
				if ( session ) {
					const ttl = Number( issued.expires_in );
					expiresAt =
						Number.isFinite( ttl ) && ttl > 0
							? clock() + ttl * 1000
							: Infinity;
					backoffMs = BACKOFF_START_MS;
					retryAfter = 0;
				} else {
					retryAfter = clock() + backoffMs;
					backoffMs = Math.min( backoffMs * 2, BACKOFF_MAX_MS );
				}
				if ( session && 'number' === typeof issued.now ) {
					clockOffset = issued.now - Math.floor( Date.now() / 1000 );
				}
				if ( session ) {
					// @longform Everything that ticked while this was in flight
					// sent nothing and is still due. Waking the router now
					// carries all of them in ONE batched POST, instead of each
					// waiting out the next tick of its own cadence.
					Core.node( names.ROUTER )?.requestTick();
				}
				return session;
			} )
			// Never rejects: mount fires this unawaited.
			.catch( () => {
				retryAfter = clock() + backoffMs;
				backoffMs = Math.min( backoffMs * 2, BACKOFF_MAX_MS );
				return null;
			} )
			.finally( () => {
				establishing = null;
			} );
	}
	return establishing;
}

/**
 * Sign a freshly-minted command in place. SYNCHRONOUS — it reads the session
 * ensureSession() established at mount, so a caller mid-graph-mutation never
 * has to yield. No-op unless TYPE is a request command — TM_COMMAND without
 * TM_RESPONSE or TM_ERROR, carrying an object VALUE — mirroring PHP's
 * is_request_command(). TM_NOREPLY rides along fine.
 *
 * Without a session the command is left UNSIGNED and the server refuses it.
 * That is the correct failure: better a refused command than one that looks
 * authorized.
 *
 * @param {Array} message Positional Message, mutated in place.
 */
export function signCommand( message ) {
	const type = message[ TYPE ];
	const value = message[ VALUE ];
	if (
		! ( type & TM_COMMAND ) ||
		type & ( TM_RESPONSE | TM_ERROR ) ||
		! value ||
		'object' !== typeof value
	) {
		return;
	}

	const live = session;
	if ( ! live ) {
		// Quiet where none was obtainable; loud where one was expected.
		if ( attempted ) {
			Core.printLessOften(
				'ERROR: no command session; this command will be refused'
			);
		}
		return;
	}

	// Server-aligned: TIMESTAMP is signed, so ingress cannot re-anchor it.
	message[ TIMESTAMP ] = Math.floor( Date.now() / 1000 ) + clockOffset;

	const nonce = newNonce();
	const string = canonical(
		message[ TIMESTAMP ],
		value.name,
		value.arguments,
		nonce
	);
	value.auth = {
		nonce,
		sig: hmacHex( string, live.key ),
		handle: live.handle,
	};
}

/**
 * Mark a message as minted by this process, and sign it if it is a command.
 *
 * LOCAL and the signature assert the same thing, so one call sets both: a mint
 * setting only LOCAL passes the browser's own authorize gate and is then
 * refused by the server, and the two gates disagreeing stays invisible until a
 * command crosses the wire.
 *
 * @param {Array} message Positional Message, mutated in place.
 * @return {Array} The same message.
 */
export function markLocal( message ) {
	message[ LOCAL ] = true;
	signCommand( message );
	return message;
}
