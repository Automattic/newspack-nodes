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

/** Highest debug-render level. The Shell validates against it; the setter clamps to it. Mirror of PHP Dumper_Node::MAX_DEBUG_LEVEL. */
export const MAX_DEBUG_LEVEL = 2;
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
	typeLabels,
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

function formatTypeLabel( type ) {
	const flags = typeLabels( type );
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

/**
 * The full positional-envelope dump — `debug_level 2`, and what the REPL
 * prints. Exported so any surface showing one message renders it identically
 * rather than inventing its own shape.
 *
 * @param {Array} message Positional Message array.
 * @return {string} The `Message { … }` block.
 */
export function formatMessageEnvelope( message ) {
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
		'    timestamp: ' + ts + tsHuman,
		'    from:      ' + ( message[ FROM ] ?? '' ),
		'    to:        ' + ( message[ TO ] ?? '' ),
		'    id:        ' + ( message[ ID ] ?? '' ),
		'    key:       ' + ( message[ KEY ] ?? '' ),
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

/**
 * The `_output` node: owns the `transcript` state slot React subscribes to, the
 * bounded ring that backs it, and the coalesced publish that holds a flood of
 * frames to one render per animation frame.
 */
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
		// React subscribes to these via useNodeState( '_output', <event> ).
		this.registrations.transcript = {};
		this.registrations.debug_level = {};
	}

	/**
	 * Render one delivered Message into the transcript. `debugLevelRef.current`
	 * picks the form: level 2 replaces the render with the full envelope dump,
	 * level 1 prefixes a type-and-FROM header, level 0 renders the payload
	 * alone. A command reply publishes immediately because it answers a typed
	 * statement; every other frame is floodable, so it coalesces to a frame.
	 *
	 * @param {Array} message The 7-field positional message.
	 */
	fill( message ) {
		this.counter++;
		const type = message[ TYPE ];
		const level = this.debugLevelRef.current;
		if ( level >= 2 ) {
			// Level 2 replaces the render with the full envelope dump.
			this._write( {
				kind: 'info',
				text: formatMessageEnvelope( message ),
			} );
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

	/**
	 * Queue one publish for the next frame, coalescing a burst of writes into a
	 * single flush. A no-op while a flush is already queued.
	 */
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

	/**
	 * Append a locally-produced entry — the REPL's echo of a typed statement, or
	 * a local info/error line — and publish at once. These are user-driven and
	 * low-frequency, so they never need the frame coalescing `fill()` uses.
	 *
	 * @param {Object} entry Transcript entry: `text`, a `kind` that selects the
	 *                       line's style ('sent', 'recv', 'info', 'error'), and
	 *                       the `prompt` an echo renders ahead of its text.
	 */
	append( entry ) {
		this._write( entry );
		this._flushNow();
	}

	/**
	 * Append a written text chunk as one `recv` entry per line — what the
	 * browser's `_stdout` stream hands over. A terminal takes bytes; the
	 * transcript takes lines, so this is where the two meet.
	 *
	 * @param {string} text Chunk as written, trailing newline included.
	 */
	appendText( text ) {
		if ( '' === text || 'string' !== typeof text ) {
			return;
		}
		const lines = text.split( '\n' );
		if ( '' === lines[ lines.length - 1 ] ) {
			lines.pop();
		}
		lines.forEach( ( line ) =>
			this._write( { kind: 'recv', text: line } )
		);
		this._flushNow();
	}

	/**
	 * Buffer one entry into the ring in O(1) and count it toward this flush's
	 * flood accounting. The caller picks the flush cadence.
	 *
	 * @param {Object} entry Unstamped transcript entry.
	 */
	_write( entry ) {
		this._writeRing( this._stamp( entry ) );
		this._sinceFlush += 1;
	}

	/**
	 * Publish synchronously: supersede any queued frame flush and emit now.
	 */
	_flushNow() {
		this._cancelPendingFlush();
		this._flush();
	}

	/**
	 * Materialize the ring and publish it once. Writes past the ring cap since
	 * the previous flush are already gone; they are counted and announced as a
	 * single rate-limited drop notice rather than one line per loss.
	 */
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

	/**
	 * Stamp an entry with a timeline `ts` in seconds (an entry that already
	 * carries one keeps it) and a `key` that serves as the React list key.
	 *
	 * @param {Object} entry Unstamped transcript entry.
	 * @return {Object} A copy carrying `ts` and `key`.
	 */
	_stamp( entry ) {
		return {
			...entry,
			ts: entry.ts ?? Date.now() / 1000,
			key: `${ Date.now() }-${ Math.random()
				.toString( 36 )
				.slice( 2, 7 ) }`,
		};
	}

	/**
	 * Seed the transcript from a persisted snapshot — the console and the debug
	 * overlay both restore last session's lines this way. Entries are taken
	 * as-is (already stamped) and the oldest beyond TRANSCRIPT_MAX are dropped.
	 *
	 * @param {Object[]} entries Stamped transcript entries, oldest first;
	 *                           anything else restores an empty transcript.
	 */
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

	/**
	 * Write into the ring at the head, overwriting the oldest entry once full.
	 * O(1) — no shifting, which is what keeps per-message work constant.
	 *
	 * @param {Object} entry Stamped transcript entry.
	 */
	_writeRing( entry ) {
		this._ring[ this._head ] = entry;
		this._head = ( this._head + 1 ) % TRANSCRIPT_MAX;
		this._count = Math.min( this._count + 1, TRANSCRIPT_MAX );
	}

	/**
	 * Unroll the ring into a fresh array, oldest first. Fresh each flush so
	 * React sees a new identity and re-renders.
	 *
	 * @return {Object[]} The live transcript entries, oldest first.
	 */
	_materialize() {
		const out = new Array( this._count );
		const start =
			( this._head - this._count + TRANSCRIPT_MAX ) % TRANSCRIPT_MAX;
		for ( let i = 0; i < this._count; i++ ) {
			out[ i ] = this._ring[ ( start + i ) % TRANSCRIPT_MAX ];
		}
		return out;
	}

	/**
	 * Empty the transcript — the REPL's `clear` builtin. Publishes a fresh empty
	 * array, which also clears the persisted snapshot through the subscriber.
	 */
	clear() {
		this._resetRing();
		this._droppedPending = 0;
		this._cancelPendingFlush();
		this._transcript = [];
		this._publish();
	}

	/**
	 * Emit the transcript to the `transcript` subscribers — the React render and
	 * the localStorage persist both hang off this one `setState`.
	 */
	_publish() {
		this.setState( 'transcript', this._transcript );
	}

	/**
	 * Drop every buffered entry and the flood accounting that goes with it.
	 * Leaves the drop-notice rate limit alone — that paces notices, not lines.
	 */
	_resetRing() {
		this._ring = [];
		this._head = 0;
		this._count = 0;
		this._sinceFlush = 0;
	}

	/**
	 * A node owns its teardown: cancel any queued flush before unregistering, so
	 * no frame callback fires against a node that has left the registry.
	 */
	removeNode() {
		this._cancelPendingFlush();
		super.removeNode();
	}

	/**
	 * Drop a queued frame flush. Teardown, `clear`, `restore`, and every
	 * synchronous publish supersede it.
	 */
	_cancelPendingFlush() {
		if ( this._flushScheduled ) {
			this._cancelSchedule( this._flushHandle );
			this._flushScheduled = false;
			this._flushHandle = null;
		}
	}

	/**
	 * Move the verbosity dial and publish it, so the ref `_render` reads and the
	 * React toggle that displays it can never disagree. The Shell's
	 * `debug_level` builtin is the only caller.
	 *
	 * @param {number} level New debug level (0/1/2).
	 */
	setDebugLevel( level ) {
		this.debugLevelRef.current = Math.max(
			0,
			Math.min( MAX_DEBUG_LEVEL, level )
		);
		this.setState( 'debug_level', this.debugLevelRef.current );
	}

	/**
	 * Console-palette entry. Hidden because the REPL graph wires this node
	 * itself, and its one dependency (`debugLevelRef`) is a programmatic
	 * assignment, so there is no positional config to round-trip.
	 *
	 * @return {Object} The node schema.
	 */
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
