export const TYPE = 0;
export const TIMESTAMP = 1;
export const FROM = 2;
export const TO = 3;
export const ID = 4;
export const KEY = 5;
export const VALUE = 6;

/** @testonly Alias of VALUE; exported so the wire-shape test can pin it. */
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

/**
 * The ONE flags-to-names map, beside the constants it names. Renderers read it
 * through typeLabels() and supply their own separator and no-match label; a
 * private copy is how a renderer ends up omitting a flag. Mirror of PHP
 * Message::TYPE_NAMES.
 *
 * @type {Array<[number, string]>}
 */
const TYPE_NAMES = [
	[ TM_BYTESTREAM, 'TM_BYTESTREAM' ],
	[ TM_EOF, 'TM_EOF' ],
	[ TM_PING, 'TM_PING' ],
	[ TM_COMMAND, 'TM_COMMAND' ],
	[ TM_RESPONSE, 'TM_RESPONSE' ],
	[ TM_ERROR, 'TM_ERROR' ],
	[ TM_INFO, 'TM_INFO' ],
	[ TM_STRUCT, 'TM_STRUCT' ],
	[ TM_REQUEST, 'TM_REQUEST' ],
	[ TM_NOREPLY, 'TM_NOREPLY' ],
	[ TM_UNTYPED, 'TM_UNTYPED' ],
];

/**
 * The result inside a reply VALUE.
 *
 * A command reply wraps its result in `{ name, arguments, payload }` so the
 * reply can say which ask it answers; every other VALUE — a list, a line, a
 * refusal string — IS the result. Absent means null, never undefined, so a
 * consumer's `??` fallback fires on both.
 *
 * @param {*} value The message VALUE.
 * @return {*} The payload, or the value itself.
 */
export function payloadOf( value ) {
	if ( null === value || undefined === value || 'object' !== typeof value ) {
		return value ?? null;
	}
	return Array.isArray( value ) ? value : value.payload ?? null;
}

/**
 * Names of every flag set in `type`, in TYPE_NAMES order. Empty when no known
 * flag matches — the caller names that case (the drop audit says TYPE_UNKNOWN,
 * the Dumper prints the unmatched bits in hex). Mirror of PHP
 * Message::type_labels().
 *
 * @param {number} type The TYPE bitmask.
 * @return {string[]} Label per set flag.
 */
export function typeLabels( type ) {
	return TYPE_NAMES.filter( ( [ flag ] ) => 0 !== ( type & flag ) ).map(
		( [ , label ] ) => label
	);
}

/**
 * A fresh 7-field positional message. The slots are heterogeneous — VALUE
 * carries a string, a struct, or a command object — so the array is untyped
 * on purpose; `Message::*` constants are what say which index means what.
 *
 * @return {Array} The 7-field positional message.
 */
export function newMessage() {
	return [ TM_UNTYPED, Date.now() / 1000, '', '', '', '', '' ];
}

/**
 * Serialize a message for the wire as a JSON array of the canonical 7 fields.
 *
 * The `LOCAL` provenance taint lives past VALUE and never leaves this process,
 * so it is sliced off rather than encoded.
 *
 * @param {Array} m Message to serialize; extra fields past VALUE are dropped.
 * @return {string} JSON array of exactly 7 fields.
 */
export function pack( m ) {
	// Emit the canonical 7 fields only; slicing drops any LOCAL taint.
	return JSON.stringify( m.slice( 0, LAST_VALUE_INDEX + 1 ) );
}

/**
 * Parse a wire line back into a 7-field message.
 *
 * Never throws and never returns a short array: malformed JSON, a non-array, or
 * fewer than 7 fields all yield a fresh `newMessage()`, so a caller can index
 * `VALUE` unconditionally. A trailing eighth field — a peer claiming `LOCAL`
 * provenance — is truncated away.
 *
 * @param {string} s JSON array as produced by `pack()`.
 * @return {Array} The 7-field positional message.
 */
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

/**
 * UTF-8 byte length of a string, matching what PHP's `strlen()` reports.
 *
 * Measured via `Blob` rather than `TextEncoder`, which jsdom lacks.
 *
 * @param {string|null|undefined} str String to measure; nullish counts as 0.
 * @return {number} Byte length.
 */
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

/**
 * Size of a message's VALUE slot, for telemetry and dumper display.
 *
 * A string VALUE is measured in UTF-8 bytes; a struct or command object is
 * measured as the character length of its JSON encoding, which is an estimate,
 * not a wire-exact byte count.
 *
 * @param {Array} m Message whose VALUE to measure.
 * @return {number} Size; 0 when VALUE is null or undefined.
 */
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
