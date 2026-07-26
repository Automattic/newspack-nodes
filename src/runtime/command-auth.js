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

import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import {
	TYPE,
	TIMESTAMP,
	VALUE,
	TM_COMMAND,
	TM_RESPONSE,
	TM_ERROR,
} from './message';

/**
 * The canonical signing string: message TYPE + command semantics + ts + nonce.
 * Never TO/FROM — Router peels TO and nodes stamp FROM in transit.
 *
 * PHP encodes this with JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
 * precisely so it matches JSON.stringify. Do not "normalise" either side.
 *
 * @param {number}   type  Message TYPE bitmask.
 * @param {number}   ts    Unix seconds.
 * @param {string}   name  Command verb.
 * @param {string[]} args  Argument tokens.
 * @param {string}   nonce Single-use nonce (hex).
 * @return {string} The string to HMAC.
 */
export function canonical( type, ts, name, args, nonce ) {
	return JSON.stringify( [
		type,
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

/** Drop the session so the next command re-authenticates. */
export function forgetSession() {
	session = null;
	establishing = null;
	clockOffset = 0;
}

async function postAuth() {
	const { CommandClient } = await import( './command-client' );
	const client = CommandClient.fromGlobal();
	const r = await fetch( `${ client.baseUrl }newspack-nodes/v1/auth`, {
		method: 'POST',
		headers: { 'X-WP-Nonce': client.nonce },
	} );
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
	if ( session ) {
		return session;
	}
	if ( ! establishing ) {
		establishing = ( authFetch ?? postAuth )()
			.then( ( issued ) => {
				session = issued?.handle && issued?.key ? issued : null;
				if ( session && 'number' === typeof issued.now ) {
					clockOffset = issued.now - Math.floor( Date.now() / 1000 );
				}
				return session;
			} )
			// Never rejects: mount fires this unawaited.
			.catch( () => null )
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

	// Unsigned is a state, not an error; the server refuses a crossing one.
	const live = session;
	if ( ! live ) {
		return;
	}

	// Server-aligned: TIMESTAMP is signed, so ingress cannot re-anchor it.
	message[ TIMESTAMP ] = Math.floor( Date.now() / 1000 ) + clockOffset;

	const nonce = newNonce();
	const string = canonical(
		type,
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
