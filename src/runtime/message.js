export const TYPE = 0;
export const TIMESTAMP = 1;
export const FROM = 2;
export const TO = 3;
export const ID = 4;
export const KEY = 5;
export const VALUE = 6;

export const LAST_VALUE_INDEX = VALUE;

// LOCAL: provenance taint appended after the 7 canonical fields. Set only by a
// Shell on a command it mints in-process; pack() strips it so it never crosses
// the wire. The client authorization default gates on m[ LOCAL ] !== undefined.
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

export function newMessage() {
	return [ 0, Date.now() / 1000, '', '', '', '', '' ];
}

export function pack( m ) {
	// Emit the canonical 7 fields only; slicing drops any appended LOCAL taint so
	// it never crosses the wire.
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
		// Drop any trailing field (e.g. a tampered-in LOCAL) — canonical 7 only.
		return d.slice( 0, LAST_VALUE_INDEX + 1 );
	}
	return newMessage();
}

// UTF-8 byte length of a string (Blob, since jsdom lacks TextEncoder) to match
// PHP strlen(). Nullish/empty → 0. The single source of truth for byte counting
// across the runtime (valueSize here, and IoTelemetry's wire accounting).
export function byteLength( str ) {
	if ( str === null || str === undefined || str === '' ) {
		return 0;
	}
	return new Blob( [ str ] ).size;
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
