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
 */

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
 * hash_hmac( 'sha256', … ).
 *
 * @param {string} string Message to sign.
 * @param {string} key    Session key.
 * @return {Promise<string>} Lowercase hex digest.
 */
export async function hmacHex( string, key ) {
	const encoder = new TextEncoder();
	const imported = await crypto.subtle.importKey(
		'raw',
		encoder.encode( key ),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		[ 'sign' ]
	);
	const digest = await crypto.subtle.sign(
		'HMAC',
		imported,
		encoder.encode( string )
	);
	return Array.from( new Uint8Array( digest ) )
		.map( ( b ) => b.toString( 16 ).padStart( 2, '0' ) )
		.join( '' );
}

/** Hex nonce, same shape as PHP's bin2hex( random_bytes( 16 ) ). */
export function newNonce() {
	const bytes = new Uint8Array( 16 );
	crypto.getRandomValues( bytes );
	return Array.from( bytes )
		.map( ( b ) => b.toString( 16 ).padStart( 2, '0' ) )
		.join( '' );
}
