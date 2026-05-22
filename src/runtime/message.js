export const TYPE = 0;
export const TIMESTAMP = 1;
export const FROM = 2;
export const TO = 3;
export const ID = 4;
export const KEY = 5;
export const VALUE = 6;

export const LAST_VALUE_INDEX = VALUE;

export const TM_BYTESTREAM = 1;
export const TM_EOF = 2;
export const TM_PING = 4;
export const TM_COMMAND = 8;
export const TM_STRUCT = 16;
export const TM_ERROR = 32;
export const TM_INFO = 64;
export const TM_REQUEST = 128;
export const TM_RESPONSE = 256;

export function newMessage() {
	return [ 0, Date.now() / 1000, '', '', '', '', '' ];
}

export function pack( m ) {
	return JSON.stringify( m );
}

export function unpack( s ) {
	let d;
	try {
		d = JSON.parse( s );
	} catch ( e ) {
		return newMessage();
	}
	if ( Array.isArray( d ) && d.length >= 7 ) {
		return d;
	}
	return newMessage();
}

export function valueSize( m ) {
	const v = m[ VALUE ];
	if ( typeof v === 'string' ) {
		// UTF-8 byte count (Blob, since jsdom lacks TextEncoder) to match PHP strlen().
		return new Blob( [ v ] ).size;
	}
	if ( v === null || v === undefined ) {
		return 0;
	}
	return JSON.stringify( v ).length;
}
