/**
 * Command signing, browser side. Mirrors PHP Command_Auth.
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
 * The HMAC is @noble/hashes, not crypto.subtle, because it must be SYNCHRONOUS.
 * WebCrypto returns promises as an API choice — HMAC-SHA256 over a few hundred
 * bytes is microseconds of arithmetic, not work worth deferring — and making the
 * Shell's dispatch() async to await it moved every graph mutation a microtask
 * later, failing 105 tests across twelve suites and changing render ordering in
 * the console. JS has no way to block on a promise (Perl's Tachikoma::drain
 * swaps in a sync framework and re-enters the loop; JS's loop is the runtime and
 * is not re-entrant), so the fix is to not have an async operation at all.
 */

import { Core } from './core';
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
 * @param {number}   ts    Unix seconds.
 * @param {string}   name  Command verb.
 * @param {string[]} args  Argument tokens.
 * @param {string}   nonce Single-use nonce (hex).
 * @return {string} The string to HMAC.
 */
export function canonical( ts, name, args, nonce ) {
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
export function hmacHex( string, key ) {
	return bytesToHex(
		hmac( sha256, utf8ToBytes( key ), utf8ToBytes( string ) )
	);
}

/** Hex nonce, same shape as PHP's bin2hex( random_bytes( 16 ) ). */
export function newNonce() {
	const bytes = new Uint8Array( 16 );
	crypto.getRandomValues( bytes );
	return Array.from( bytes )
		.map( ( b ) => b.toString( 16 ).padStart( 2, '0' ) )
		.join( '' );
}

/**
 * The session, and the in-flight promise establishing it. Memoised so N
 * concurrent commands share ONE /auth round trip rather than racing to mint N
 * sessions the server would have to keep.
 */
let session = null;
let establishing = null;

/** Whether a session was ever asked for. Silence before that is expected. */
let attempted = false;

/**
 * Monotonic invalidation counter. Every auth-shaped failure — a refused session,
 * a renewed nonce, an expiry — bumps this, and reconciled loaders re-establish
 * because it moved. That is what lets state initialised once at mount recover
 * without a per-call-site retry: the loader does not need to know WHICH failure
 * happened, only that what it was told is no longer true.
 */
let generation = 0;

/** @return {number} The current invalidation generation. */
export function authGeneration() {
	return generation;
}

/** Invalidate everything derived from the current session. */
export function invalidateAuth() {
	generation++;
}

/**
 * Re-auth backoff. A session the server refuses would otherwise spin — every
 * poll tick minting, being refused, renewing, minting again. The browser hit
 * ~150 requests/second that way. One /auth per window instead, widening while
 * it keeps failing.
 */
const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
let backoffMs = BACKOFF_START_MS;
let retryAfter = 0;

/** Clock seam so the backoff can be tested without waiting on it. */
let now = null;

/** @param {Function|null} fn Replacement clock, or null to restore. */
export function __setBackoffClock( fn ) {
	now = fn;
}

function clock() {
	return ( now ?? Date.now )();
}

/** Server clock minus ours, in seconds, learned from /auth. */
let clockOffset = 0;

/**
 * /auth transport seam. Lazily-defaulted to the real POST so the surrounding
 * memoisation, predicate and stamping run as production code under test.
 * Signature: `function (): Promise<{handle,key,expires_in}>`.
 */
let authFetch = null;

/** @param {Function|null} fn Replacement transport, or null to restore. */
export function __setAuthFetch( fn ) {
	authFetch = fn;
}

/**
 * When the issued session stops being usable, in clock() ms. The server tells us
 * the lifetime; without honouring it the only way to learn a session had died
 * was to have a command refused — and that command was the one thing lost.
 */
let expiresAt = Infinity;

/** Whether the live session has outlived what the server issued it for. */
function sessionExpired() {
	return clock() >= expiresAt;
}

/** Whether a session is live. Emitters gate on this: a mint cannot wait. */
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

/** Drop the session so the next command re-authenticates. */
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

// @longform
// A stale nonce refuses /auth exactly when a session must be re-minted — the
// tab that slept through the nonce's lifetime. Without this, that 403 throws,
// widens the backoff, and the session cannot be re-established until the window
// elapses. CommandClient.#post has carried the same renew-once for commands all
// along; /auth was the one request left without it.
async function postAuthOnce( client ) {
	return fetch( `${ client.baseUrl }newspack-nodes/v1/auth`, {
		method: 'POST',
		headers: { 'X-WP-Nonce': client.nonce },
	} );
}

async function postAuth() {
	const { CommandClient } = await import( './command-client' );
	const { refreshNodesNonce } = await import( './nodes-data' );
	const client = CommandClient.fromGlobal();
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
 * @return {Promise<Object|null>} The session, or null if it could not be had.
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
 * has to yield. No-op unless TYPE is a request
 * command — TM_COMMAND without TM_RESPONSE/TM_ERROR, with an object VALUE —
 * mirroring PHP's is_request_command(). TM_NOREPLY rides along fine.
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
 * LOCAL and the signature assert the same thing, so they are set in one place:
 * a mint that set only LOCAL would pass the browser's own authorize gate and
 * then be refused by the server, which is the bug the first deploy hit.
 *
 * @param {Array} message Positional Message, mutated in place.
 * @return {Array} The same message.
 */
export function markLocal( message ) {
	message[ LOCAL ] = true;
	signCommand( message );
	return message;
}
