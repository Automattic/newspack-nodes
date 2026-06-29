/**
 * Dumper — the `_output` node. `_router` delivers typed-command replies here;
 * it renders each positional Message into the shared REPL transcript, mirroring
 * the substrate cli Dumper. Transcript-only — canvas metadata + uptime are
 * their own nodes (`_metadata` / `_uptime`).
 */

import { Node } from './node';
import {
	TYPE,
	TIMESTAMP,
	FROM,
	TO,
	ID,
	KEY,
	VALUE,
	TM_BYTESTREAM,
	TM_EOF,
	TM_PING,
	TM_COMMAND,
	TM_RESPONSE,
	TM_ERROR,
	TM_INFO,
	TM_STRUCT,
	TM_REQUEST,
	TM_NOREPLY,
} from './message';

export const TRANSCRIPT_MAX = 200;

const has = ( type, flag ) => ( type & flag ) !== 0;

const TM_LABELS = [
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
];

export function formatTypeLabel( type ) {
	const flags = TM_LABELS.filter( ( [ flag ] ) => has( type, flag ) ).map(
		( [ , label ] ) => label
	);
	return flags.length
		? flags.join( ' | ' )
		: `TM_UNKNOWN(0x${ type.toString( 16 ) })`;
}

// Objects/arrays → pretty JSON, strings pass through, null/undefined → ''.
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

// debug_level 1 header: `<TM_FLAGS> from <FROM>:`.
export function buildDebugHeader1( message ) {
	return `${ formatTypeLabel( message[ TYPE ] ) } from ${
		message[ FROM ] || ''
	}:`;
}

// debug_level 2 header: full positional-envelope dump.
export function buildDebugHeader2( message ) {
	const ts = message[ TIMESTAMP ] ?? '';
	const tsHuman =
		typeof ts === 'number' && Number.isFinite( ts )
			? ` (${ new Date( ts * 1000 )
					.toISOString()
					.replace( 'T', ' ' )
					.replace( /\.\d+Z$/, ' UTC' ) })`
			: '';
	const indented = stringifyValue( message[ VALUE ] )
		.split( '\n' )
		.map( ( line, i ) => ( i === 0 ? line : '               ' + line ) )
		.join( '\n' );
	return [
		'Message {',
		'    type:      ' + formatTypeLabel( message[ TYPE ] ),
		'    from:      ' + ( message[ FROM ] ?? '' ),
		'    to:        ' + ( message[ TO ] ?? '' ),
		'    id:        ' + ( message[ ID ] ?? '' ),
		'    key:       ' + ( message[ KEY ] ?? '' ),
		'    timestamp: ' + ts + tsHuman,
		'    value:     ' + indented,
		'}',
	].join( '\n' );
}

/**
 * Render one positional Message into a `{ kind, text }` transcript entry, or
 * null to drop. Structured (object/array) payloads render as pretty JSON — a
 * command reply's `value.payload` and any object VALUE go through stringifyValue
 * so a `dump_node` struct renders instead of dropping / showing `[object Object]`.
 *
 * @param {Array} message Positional Message array.
 */
export function renderMessage( message ) {
	const type = message[ TYPE ];
	const value = message[ VALUE ];
	if ( has( type, TM_EOF ) ) {
		return null;
	}
	// A command reply's VALUE is `{ name, payload }`; payload may be structured.
	if ( has( type, TM_COMMAND ) ) {
		const unwrap = () =>
			value && typeof value === 'object'
				? stringifyValue( value.payload )
				: stringifyValue( value );
		if ( has( type, TM_RESPONSE ) ) {
			const payload = unwrap();
			return payload ? { kind: 'recv', text: payload } : null;
		} else if ( has( type, TM_ERROR ) ) {
			return { kind: 'error', text: unwrap() };
		}
	}
	if ( has( type, TM_ERROR ) ) {
		return { kind: 'error', text: stringifyValue( value ) };
	}
	if ( has( type, TM_PING ) ) {
		const rtt = (
			( Date.now() / 1000 - parseFloat( value ) ) *
			1000
		).toFixed( 2 );
		return { kind: 'info', text: `round trip time: ${ rtt } ms` };
	}
	if (
		has( type, TM_BYTESTREAM ) ||
		has( type, TM_STRUCT ) ||
		has( type, TM_INFO ) ||
		has( type, TM_REQUEST ) ||
		has( type, TM_COMMAND )
	) {
		return { kind: 'recv', text: stringifyValue( value ) };
	}
	return null;
}

export class DumperNode extends Node {
	/**
	 * Tachikoma-parity: no-arg ctor. The `debugLevelRef` is a programmatic
	 * dependency (a React useRef object) — callers assign it as a public
	 * property after construction: `const d = new DumperNode(); d.debugLevelRef = ref;`
	 */
	constructor() {
		super();
		// Safe default — a fresh ref reading as `verbosity 0`. Callers assign
		// their own ref after construction to wire up the live debug-level dial.
		this.debugLevelRef = { current: 0 };
		this._transcript = [];
		// React subscribes to this via useNodeState( '_output', 'transcript' ).
		this.registrations.transcript = {};
	}

	fill( message ) {
		this.counter += 1;
		const level = this.debugLevelRef.current;
		if ( level >= 2 ) {
			// Level 2 replaces the render with the full envelope dump.
			this._push( { kind: 'info', text: buildDebugHeader2( message ) } );
			return;
		}
		if ( level >= 1 ) {
			this._push( { kind: 'info', text: buildDebugHeader1( message ) } );
		}
		const rendered = renderMessage( message );
		if ( rendered ) {
			this._push( {
				...rendered,
				text: rendered.text.replace( /\n+$/, '' ),
			} );
		}
	}

	// Append a caller-supplied entry (REPL echo of typed input / local info).
	append( entry ) {
		this._push( entry );
	}

	_push( entry ) {
		const next = this._transcript.concat( {
			...entry,
			key: `${ Date.now() }-${ Math.random()
				.toString( 36 )
				.slice( 2, 7 ) }`,
		} );
		this._transcript =
			next.length > TRANSCRIPT_MAX
				? next.slice( next.length - TRANSCRIPT_MAX )
				: next;
		this.setState( 'transcript', this._transcript );
	}

	// Seed the transcript from a persisted snapshot [87] — caps to the most-recent
	// TRANSCRIPT_MAX and notifies subscribers, so a reopened console shows recent
	// history and later appends build on it.
	restore( entries ) {
		const list = Array.isArray( entries ) ? entries : [];
		this._transcript =
			list.length > TRANSCRIPT_MAX
				? list.slice( list.length - TRANSCRIPT_MAX )
				: list;
		this.setState( 'transcript', this._transcript );
	}

	// Empty the transcript (the `clear` builtin); emits a fresh empty array.
	clear() {
		this._transcript = [];
		this.setState( 'transcript', [] );
	}

	// Programmatic-deps node: no positional config to round-trip via arguments=.
	static nodeSchema() {
		return {
			category: 'Hidden',
			description: 'REPL transcript renderer (the `_output` node).',
			// The `_output` terminal renders to the transcript; it never forwards.
			has_target: false,
			arguments: [],
			commands: [],
		};
	}
}
