export const TYPE = 0;
export const TIMESTAMP = 1;
export const FROM = 2;
export const TO = 3;
export const ID = 4;
export const KEY = 5;
export const VALUE = 6;

export const LAST_VALUE_INDEX = VALUE;

// LOCAL: provenance taint after the 7 fields; pack() strips it off the wire.
export const LOCAL = 7;

export const TM_BYTESTREAM = 1;
export const TM_EOF = 2;
export const TM_PING = 4;
export const TM_COMMAND = 8;
export const TM_STRUCT = 16;
export const TM_ERROR = 32;
export const TM_INFO = 64;
export const TM_REQUEST = 128;
export const TM_RESPONSE = 256;
export const TM_NOREPLY = 512;

/**
 * The mint default: a message that exists but has not been typed yet.
 *
 * A free HIGH bit, so it matches NO type gate — an untyped message is inert
 * rather than every type at once (which is what a -1 sentinel would be as a
 * bitmask). Every minter assigns TYPE and overwrites it; one that reaches a sink
 * still carrying it is a bug, and the drop audit names it. A naked array (no
 * TYPE at all) stays TYPE_UNKNOWN — a different failure, worth telling apart.
 */
export const TM_UNTYPED = 1024;

export function newMessage() {
	return [ TM_UNTYPED, Date.now() / 1000, '', '', '', '', '' ];
}

export function pack( m ) {
	// Emit the canonical 7 fields only; slicing drops any LOCAL taint.
	return JSON.stringify( m.slice( 0, LAST_VALUE_INDEX + 1 ) );
}

export function unpack( s ) {
	let d;
	try {
		d = JSON.parse( s );
	} catch ( e ) {
		return newMessage();
	}
	if ( Array.isArray( d ) && d.length >= 7 ) {
		// Drop any trailing field (e.g. a tampered LOCAL) — canonical 7 only.
		return d.slice( 0, LAST_VALUE_INDEX + 1 );
	}
	return newMessage();
}

// UTF-8 byte length (Blob, jsdom lacks TextEncoder) to match PHP strlen().
export function byteLength( str ) {
	if ( str === null || str === undefined || str === '' ) {
		return 0;
	}
	return new Blob( [ str ] ).size;
}

/**
 * Composer inputs → TYPE bits + FROM/ID/KEY/TIMESTAMP, mutating `m` in place.
 *
 * One-shot per mint: unlike the Shell's `message.*` vars nothing persists into
 * the next statement, and a blank input leaves the parsed field as-is.
 *
 * @param {Array}  m      Parsed message, mutated.
 * @param {Object} fields `{ response, error, from, id, key, timestamp }`.
 * @return {Array} The same message.
 */
export function applyComposeFields( m, fields ) {
	if ( ! fields ) {
		return m;
	}
	m[ TYPE ] |=
		( fields.response ? TM_RESPONSE : 0 ) | ( fields.error ? TM_ERROR : 0 );
	for ( const [ name, index ] of [
		[ 'from', FROM ],
		[ 'id', ID ],
		[ 'key', KEY ],
		[ 'timestamp', TIMESTAMP ],
	] ) {
		if ( fields[ name ] ) {
			m[ index ] = fields[ name ];
		}
	}
	return m;
}

export function valueSize( m ) {
	const v = m[ VALUE ];
	if ( typeof v === 'string' ) {
		return byteLength( v );
	}
	if ( v === null || v === undefined ) {
		return 0;
	}
	return JSON.stringify( v ).length;
}
