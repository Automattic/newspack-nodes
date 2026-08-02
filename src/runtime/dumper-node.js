/* global requestAnimationFrame, cancelAnimationFrame */
/**
 * Dumper — the `_output` node. `_router` delivers typed-command replies here;
 * it renders each positional Message into the shared REPL transcript, mirroring
 * the substrate cli Dumper. Transcript-only — canvas metadata + uptime are
 * their own nodes (`_metadata` / `_uptime`).
 *
 * Flood-safe: a console connected to a firehose Tee can receive thousands of
 * frames/sec (a full-speed segment replay). Per-message work is O(1) — write
 * into a bounded ring and mark dirty — and the expensive publish (React render +
 * localStorage persist, both hung off `setState('transcript')`) is COALESCED to
 * one frame-scheduled flush. Past the ring cap between flushes, lines drop with a
 * rate-limited count (MemorySieve degrade) rather than OOM the tab.
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

// Rate-limit the flood drop notice: at most one entry per this interval (ms).
const DROP_NOTICE_INTERVAL_MS = 1000;

// Coalesced-publish frame scheduler (test seam); rAF, or a setTimeout shim.
const scheduleFrame =
	'function' === typeof requestAnimationFrame
		? ( cb ) => requestAnimationFrame( cb )
		: ( cb ) => setTimeout( cb, 16 );
const cancelFrame =
	'function' === typeof cancelAnimationFrame
		? ( handle ) => cancelAnimationFrame( handle )
		: ( handle ) => clearTimeout( handle );

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

function formatTypeLabel( type ) {
	const flags = TM_LABELS.filter( ( [ flag ] ) => has( type, flag ) ).map(
		( [ , label ] ) => label
	);
	return flags.length
		? flags.join( ' | ' )
		: `TM_UNKNOWN(0x${ type.toString( 16 ) })`;
}

// Objects/arrays → pretty JSON, strings pass through, null/undefined → ''.
function stringifyValue( value ) {
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
function buildDebugHeader1( message ) {
	return `${ formatTypeLabel( message[ TYPE ] ) } from ${
		message[ FROM ] || ''
	}:`;
}

// debug_level 2 header: full positional-envelope dump.
function buildDebugHeader2( message ) {
	const ts = message[ TIMESTAMP ] ?? '';
	const tsHuman =
		typeof ts === 'number' && Number.isFinite( ts )
			? ` (${ new Date( ts * 1000 )
					.toISOString()
					.replace( 'T', ' ' )
					.replace( /\.\d+Z$/, ' UTC' ) })`
			: '';
	// Trim the value's trailing newline (else a blank line precedes `}`).
	const indented = stringifyValue( message[ VALUE ] )
		.replace( /\n+$/, '' )
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
function renderMessage( message ) {
	const type = message[ TYPE ];
	const value = message[ VALUE ];
	if ( has( type, TM_EOF ) ) {
		return null;
	}
	// Command reply's VALUE is `{name, payload}`; payload may be structured.
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
		// Safe default: a fresh ref reading `verbosity 0`; callers assign one.
		this.debugLevelRef = { current: 0 };
		// Bounded ring: newest TRANSCRIPT_MAX entries; O(1) overwrite write.
		this._ring = [];
		this._head = 0;
		this._count = 0;
		// Last published array (fresh each flush for React identity).
		this._transcript = [];
		// Flood accounting: writes since the last flush, and un-noticed drops.
		this._sinceFlush = 0;
		this._droppedPending = 0;
		this._lastDropNoticeAt = 0;
		// Coalesced-publish state + the injectable frame scheduler (test seam).
		this._flushScheduled = false;
		this._flushHandle = null;
		this._schedule = scheduleFrame;
		this._cancelSchedule = cancelFrame;
		// React subscribes to this via useNodeState( '_output', 'transcript' ).
		this.registrations.transcript = {};
		// One-shot command-reply capture: { verb, callback } or null.
		this._captureReply = null;
	}

	fill( message ) {
		this.counter++;
		this._maybeCapture( message );
		const type = message[ TYPE ];
		const level = this.debugLevelRef.current;
		if ( level >= 2 ) {
			// Level 2 replaces the render with the full envelope dump.
			this._write( { kind: 'info', text: buildDebugHeader2( message ) } );
		} else {
			if ( level >= 1 ) {
				this._write( {
					kind: 'info',
					text: buildDebugHeader1( message ),
				} );
			}
			const rendered = renderMessage( message );
			if ( rendered ) {
				this._write( {
					...rendered,
					text: rendered.text.replace( /\n+$/, '' ),
				} );
			}
		}
		// Replies publish now; floodable data frames coalesce to a frame.
		if ( has( type, TM_COMMAND ) ) {
			this._flushNow();
		} else {
			this._scheduleFlush();
		}
	}

	// Queue one publish per frame; coalesces a burst into a single flush.
	_scheduleFlush() {
		if ( this._flushScheduled ) {
			return;
		}
		this._flushScheduled = true;
		this._flushHandle = this._schedule( () => {
			this._flushScheduled = false;
			this._flush();
		} );
	}

	// Fork a matching command reply to a one-shot capture, then clear it.
	_maybeCapture( message ) {
		const cap = this._captureReply;
		if ( ! cap ) {
			return;
		}
		const type = message[ TYPE ];
		const isResponse = has( type, TM_RESPONSE );
		const isError = has( type, TM_ERROR );
		if ( ! has( type, TM_COMMAND ) || ( ! isResponse && ! isError ) ) {
			return;
		}
		const value = message[ VALUE ];
		const name = value && typeof value === 'object' ? value.name : null;
		if ( name !== cap.verb ) {
			return;
		}
		this._captureReply = null;
		const payload =
			value && typeof value === 'object' ? value.payload : value;
		cap.callback( payload, isError );
	}

	// REPL echo / local info: user-driven + low-freq, so publish immediately.
	append( entry ) {
		this._write( entry );
		this._flushNow();
	}

	// Buffer one entry into the ring (O(1)); caller picks the flush cadence.
	_write( entry ) {
		this._writeRing( this._stamp( entry ) );
		this._sinceFlush += 1;
	}

	// Publish synchronously: supersede any queued frame flush and emit now.
	_flushNow() {
		this._cancelPendingFlush();
		this._flush();
	}

	// Materialize + publish once; overflow past the cap drops (rate-limited).
	_flush() {
		const dropped = Math.max( 0, this._sinceFlush - TRANSCRIPT_MAX );
		this._sinceFlush = 0;
		if ( dropped > 0 ) {
			this._droppedPending += dropped;
			const now = Date.now();
			if ( now - this._lastDropNoticeAt >= DROP_NOTICE_INTERVAL_MS ) {
				this._writeRing(
					this._stamp( {
						kind: 'info',
						text: `… ${ this._droppedPending } lines dropped (console flooding)`,
					} )
				);
				this._droppedPending = 0;
				this._lastDropNoticeAt = now;
			}
		}
		this._transcript = this._materialize();
		this._publish();
	}

	// Stamp an entry with a timeline ts + a unique React key.
	_stamp( entry ) {
		return {
			...entry,
			ts: entry.ts ?? Date.now() / 1000,
			key: `${ Date.now() }-${ Math.random()
				.toString( 36 )
				.slice( 2, 7 ) }`,
		};
	}

	// Seed the transcript from a persisted snapshot; caps to TRANSCRIPT_MAX.
	restore( entries ) {
		const list = Array.isArray( entries ) ? entries : [];
		this._resetRing();
		const start = Math.max( 0, list.length - TRANSCRIPT_MAX );
		for ( let i = start; i < list.length; i++ ) {
			this._writeRing( list[ i ] );
		}
		this._cancelPendingFlush();
		this._transcript = this._materialize();
		this._publish();
	}

	// Write into the ring at the head; overwrite the oldest once full (O(1)).
	_writeRing( entry ) {
		this._ring[ this._head ] = entry;
		this._head = ( this._head + 1 ) % TRANSCRIPT_MAX;
		this._count = Math.min( this._count + 1, TRANSCRIPT_MAX );
	}

	// The ring's live entries oldest-first as a fresh array (O(count)).
	_materialize() {
		const out = new Array( this._count );
		const start =
			( this._head - this._count + TRANSCRIPT_MAX ) % TRANSCRIPT_MAX;
		for ( let i = 0; i < this._count; i++ ) {
			out[ i ] = this._ring[ ( start + i ) % TRANSCRIPT_MAX ];
		}
		return out;
	}

	// Empty the transcript (the `clear` builtin); emits a fresh empty array.
	clear() {
		this._resetRing();
		this._droppedPending = 0;
		this._cancelPendingFlush();
		this._transcript = [];
		this._publish();
	}

	// Emit the transcript to subscribers (React render + persistence).
	_publish() {
		this.setState( 'transcript', this._transcript );
	}

	// Drop every buffered entry + flood accounting.
	_resetRing() {
		this._ring = [];
		this._head = 0;
		this._count = 0;
		this._sinceFlush = 0;
	}

	// A node owns its teardown: cancel any queued flush before unregistering.
	removeNode() {
		this._cancelPendingFlush();
		super.removeNode();
	}

	// Drop a queued flush (teardown / clear / restore supersede it).
	_cancelPendingFlush() {
		if ( this._flushScheduled ) {
			this._cancelSchedule( this._flushHandle );
			this._flushScheduled = false;
			this._flushHandle = null;
		}
	}

	/**
	 * Grab the NEXT command reply whose VALUE.name matches `verb` — the live-save
	 * flow reuses the transcript round-trip to snapshot `dump_config` output. The
	 * reply still renders into the transcript; this only forks a copy to `callback`.
	 * One-shot: cleared as soon as it fires (a new call supersedes any pending one).
	 *
	 * @param {string}   verb     Command name to match (e.g. 'dump_config').
	 * @param {Function} callback (payload, isError) invoked once on the match.
	 * @return {void}
	 */
	captureNextReply( verb, callback ) {
		this._captureReply = { verb, callback };
	}

	// Programmatic-deps node: no positional config to round-trip.
	static nodeSchema() {
		return {
			category: 'Hidden',
			description: 'REPL transcript renderer (the `_output` node).',
			// The `_output` terminal renders to the transcript; never forwards.
			has_target: false,
			arguments: [],
			commands: [],
		};
	}
}
