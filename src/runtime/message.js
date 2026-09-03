/**
 * The one message shape in the browser: the 7-field positional array, its type
 * bitmask, and the JSON codec that puts it on the wire.
 *
 * Index through the constants below. There is no object form and no hash form
 * (ADR-2): the array in memory IS the array on the wire, so no boundary pays
 * for a key-to-index translation and a forwarding path indexes rather than
 * hashes.
 *
 * `includes/class-message.php` decides the layout. Every index, flag and label
 * here mirrors it, and `__tests__/message.test.js` pins them, so a drift
 * between the two ports fails a suite rather than a production decode. The
 * ports part company on malformed input alone: PHP throws where `unpack()`
 * hands back a fresh message.
 */

/**
 * Bitmask of the TM_* flags below. Test it with `&` — a strict `===` misses
 * every composite, and composites are routine (`TM_COMMAND | TM_RESPONSE`).
 */
export const TYPE = 0;

/** Unix timestamp in seconds, a float, stamped at mint. */
export const TIMESTAMP = 1;

/** Slash-delimited path the message came from; a reply addresses TO=FROM. */
export const FROM = 2;

/** Slash-delimited path it is bound for; Router peels one segment per hop. */
export const TO = 3;

/** Producer-owned identifier — a reader's `{segment}:{offset}:{length}`. */
export const ID = 4;

/** Partition and grouping key. A forwarder carries it, never overwrites it. */
export const KEY = 5;

/** The payload: a string under TM_BYTESTREAM, a struct under TM_STRUCT. */
export const VALUE = 6;

/**
 * Last canonical index. `pack()` and `unpack()` slice through it, which is what
 * drops whatever sits past VALUE.
 *
 * @testonly Exported so the wire-shape test can pin the layout.
 */
export const LAST_VALUE_INDEX = VALUE;

/**
 * Provenance taint appended AFTER the canonical seven, so its presence means
 * "minted in this process". `pack()` slices it off and nothing arriving over
 * the wire can carry it, which is what makes it trustworthy as the
 * interpreter's default authorization gate (ADR-15).
 */
export const LOCAL = 7;

/** A string VALUE — one raw line or frame. Mutually exclusive with TM_STRUCT. */
export const TM_BYTESTREAM = 1;

/** End of a stream. An interpreter bounces an unaddressed one TO=FROM. */
export const TM_EOF = 2;

/** Round-trip probe carrying its send time; the receiver bounces it back. */
export const TM_PING = 4;

/** Graph construction and administration, dispatched by an interpreter. */
export const TM_COMMAND = 8;

/**
 * A structured VALUE — an array or an object. Consumers gate on this flag, not
 * on the VALUE's runtime type.
 */
export const TM_STRUCT = 16;

/** A failure, addressed TO=FROM so it walks the breadcrumb trail back. */
export const TM_ERROR = 32;

/** An unsolicited notice; its VALUE is a flat string, never a struct. */
export const TM_INFO = 64;

/** A live query, answered in the addressed node's own `fill()`. */
export const TM_REQUEST = 128;

/** Marks an answer, so the interpreter it passes does not re-dispatch it. */
export const TM_RESPONSE = 256;

/** Fire-and-forget command: the interpreter suppresses the routed reply. */
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
 * Message::TYPE_NAMES, in that file's order — the order both ports RENDER in,
 * which is not numeric order.
 *
 * @type {Array<[number,string]>}
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
 * An enveloped VALUE with no `payload` unwraps to `fallback` — null by
 * default, so a payload-less ack cannot blank a poller's grid. `_metadata`
 * passes the value itself, because `dump_metadata` answers bare as often as
 * enveloped and the bare map IS the answer.
 *
 * @param {*} value      The message VALUE.
 * @param {*} [fallback] What an enveloped value with no payload unwraps to.
 * @return {*} The payload, or the value itself.
 */
export function payloadOf( value, fallback = null ) {
	if ( null === value || undefined === value || 'object' !== typeof value ) {
		return value ?? null;
	}
	return Array.isArray( value ) ? value : value.payload ?? fallback;
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
 * Mint a message: TM_UNTYPED, a timestamp, and empty strings everywhere else.
 * The caller assigns TYPE.
 *
 * TIMESTAMP is Unix SECONDS as a float rather than `Date.now()` milliseconds,
 * because PHP stamps seconds and a message crosses between the two ports.
 *
 * The slots are heterogeneous — VALUE carries a string, a struct, or a command
 * object — so the array is untyped on purpose; the field constants above are
 * what say which index means what.
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
 * The Compose modal's inputs for one mint. Every field is optional, and a blank
 * one means "leave the minted value alone" rather than "clear it".
 *
 * @typedef {Object} ComposeFields
 * @property {boolean}       [response]  ORs TM_RESPONSE onto TYPE.
 * @property {boolean}       [error]     ORs TM_ERROR onto TYPE.
 * @property {string}        [from]      Replaces FROM.
 * @property {string}        [id]        Replaces ID.
 * @property {string}        [key]       Replaces KEY.
 * @property {string|number} [timestamp] Replaces TIMESTAMP.
 */

/**
 * Stamp the Compose modal's inputs onto a minted message: `response` and
 * `error` OR their TYPE bits on, and FROM, ID, KEY and TIMESTAMP each take the
 * field that names them.
 *
 * The stamp is one-shot per mint. The Shell's `message.*` vars are shell state
 * and persist across statements; these do not, so the modal addresses the one
 * message the operator composed and nothing after it.
 *
 * @param {Array}          m      Parsed message, mutated in place.
 * @param {?ComposeFields} fields Compose inputs; nullish is a no-op.
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
