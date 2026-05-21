/**
 * Dumper-style transcript-render helpers, mirroring the substrate cli Dumper.
 */

export const TM_BYTESTREAM = 1;
export const TM_EOF = 2;
export const TM_PING = 4;
export const TM_COMMAND = 8;
export const TM_RESPONSE = 16;
export const TM_ERROR = 32;
export const TM_INFO = 64;
export const TM_STRUCT = 256;

// eslint-disable-next-line no-bitwise
export const has = ( type, flag ) => ( type & flag ) !== 0;

// TM_FLAGS as a pipe-joined label string; empty type → unknown-hex form.
const TM_LABELS = [
	[ TM_BYTESTREAM, 'TM_BYTESTREAM' ],
	[ TM_EOF, 'TM_EOF' ],
	[ TM_PING, 'TM_PING' ],
	[ TM_COMMAND, 'TM_COMMAND' ],
	[ TM_RESPONSE, 'TM_RESPONSE' ],
	[ TM_ERROR, 'TM_ERROR' ],
	[ TM_INFO, 'TM_INFO' ],
	[ TM_STRUCT, 'TM_STRUCT' ],
];

export function formatTypeLabel( type ) {
	const flags = TM_LABELS.filter( ( [ flag ] ) => has( type, flag ) ).map(
		( [ , label ] ) => label
	);
	return flags.length
		? flags.join( ' | ' )
		: `TM_UNKNOWN(0x${ type.toString( 16 ) })`;
}

// Stringify VALUE: objects → JSON, strings pass through, else String().
export function stringifyValue( value ) {
	if ( typeof value === 'string' ) {
		return value;
	}
	if ( value === null || value === undefined ) {
		return '';
	}
	try {
		return JSON.stringify( value, null, 2 );
	} catch ( _e ) {
		return String( value );
	}
}

// debug_level 1 header: `<TM_FLAGS> from <FROM>:` (value comes from the render).
export function buildDebugHeader1( msg ) {
	const label = formatTypeLabel(
		typeof msg.type === 'number' ? msg.type : 0
	);
	const from = msg.from || '';
	return `${ label } from ${ from }:`;
}

// debug_level 2 header: full envelope dump (mirrors format_envelope_dump).
export function buildDebugHeader2( msg ) {
	const label = formatTypeLabel(
		typeof msg.type === 'number' ? msg.type : 0
	);
	const ts = msg.ts ?? '';
	const tsHuman =
		typeof ts === 'number' && Number.isFinite( ts )
			? ` (${ new Date( ts * 1000 )
					.toISOString()
					.replace( 'T', ' ' )
					.replace( /\.\d+Z$/, ' UTC' ) })`
			: '';
	const value = stringifyValue( msg.value );
	const indentedValue = value
		.split( '\n' )
		.map( ( line, i ) => ( i === 0 ? line : '               ' + line ) )
		.join( '\n' );
	return [
		'Message {',
		'    type:      ' + label,
		'    from:      ' + ( msg.from ?? '' ),
		'    to:        ' + ( msg.to ?? '' ),
		'    id:        ' + ( msg.id ?? '' ),
		'    key:       ' + ( msg.key ?? '' ),
		'    timestamp: ' + ts + tsHuman,
		'    value:     ' + indentedValue,
		'}',
	].join( '\n' );
}

/**
 * Convert a raw SSE msg envelope into a transcript entry (cli Dumper rules).
 *
 * @param {Object} msg Raw SSE msg envelope (type, from, to, value, ...).
 * @return {Object|null} { kind, text } transcript entry or null to drop.
 */
export function dumperRender( msg ) {
	const type = typeof msg.type === 'number' ? msg.type : 0;
	const value = msg.value;
	if ( has( type, TM_EOF ) ) {
		return null;
	}
	const unwrapPayload = () => {
		if ( value && typeof value === 'object' ) {
			return typeof value.payload === 'string' ? value.payload : '';
		}
		return typeof value === 'string' ? value : '';
	};
	if ( has( type, TM_COMMAND ) && has( type, TM_RESPONSE ) ) {
		const payload = unwrapPayload();
		if ( ! payload ) {
			return null;
		}
		return { kind: 'recv', text: payload };
	}
	if ( has( type, TM_COMMAND ) && has( type, TM_ERROR ) ) {
		return { kind: 'error', text: unwrapPayload() };
	}
	if ( has( type, TM_ERROR ) ) {
		return { kind: 'error', text: String( value ?? '' ) };
	}
	if ( has( type, TM_PING ) ) {
		const sent = parseFloat( value );
		const now = Date.now() / 1000;
		const rtt = ( ( now - sent ) * 1000 ).toFixed( 2 );
		return { kind: 'info', text: `round trip time: ${ rtt } ms` };
	}
	if ( has( type, TM_STRUCT ) ) {
		return {
			kind: 'recv',
			text:
				typeof value === 'string'
					? value
					: JSON.stringify( value, null, 2 ),
		};
	}
	// TM_INFO and default TM_BYTESTREAM both render as plain payload.
	if ( has( type, TM_INFO ) || has( type, TM_BYTESTREAM ) ) {
		return { kind: 'recv', text: String( value ?? '' ) };
	}
	return null;
}
