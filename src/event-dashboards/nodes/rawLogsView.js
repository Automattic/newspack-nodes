import { Node } from '../../runtime/node';
import { FROM, ID, KEY, TYPE, VALUE, TM_ERROR } from '../../runtime/message';

const MAX_LINES = 100000;
const LPS_WINDOW_SEC = 10;
const LPS_SMOOTHING = 0.1;
const MAX_LINE_LENGTH = 1000;
const PARTITION_RE = /\.p(\d+)$/;

// Coerce a TM_ERROR payload (string / { message } / anything else) to a
// human-readable string for the Error / view-model error field.
function _errorMessage( payload ) {
	if ( 'string' === typeof payload && payload.length > 0 ) {
		return payload;
	}
	if (
		payload &&
		'object' === typeof payload &&
		'string' === typeof payload.message &&
		payload.message.length > 0
	) {
		return payload.message;
	}
	return 'Operation failed';
}

/**
 * `rawlogs:view` — owns the Raw Logs view model.
 *
 * Two cadences, deliberately split for performance:
 * - HIGH frequency (the log stream): `_appendRow` writes each row into a fixed
 *   ring buffer (O(1): write at head, advance, overwrite oldest — no shift, no
 *   copy, no truncation) and updates `this.lps`, but does NOT publish. The React
 *   canvas reads the VISIBLE window straight off the ring each frame via
 *   `linesCount` + `lineAt(i)` (newest-first) — O(rows-on-screen), not O(buffer)
 *   — so neither a busy stream nor a full buffer re-renders or re-copies per
 *   frame. `lines` materializes the whole buffer newest-first for the rare
 *   full-scan consumers (the filter path + tests); it is NOT on the frame path.
 * - LOW frequency (control + catalog): only `_control` publishes the small view
 *   model via `setState('view', { logs, selected, paused, connectionError })` —
 *   the dropdown + pause button + selected value + reconnect banner, consumed by
 *   `useNodeState('rawlogs:view','view')`.
 *
 * Post-migration to substrate `_http`, `fill()` ALSO handles the canonical
 * command-reply shape (VALUE = `{ name, payload }`) using a pending-Map gate
 * (mirrors serversView): the hook stashes `{ resolve, reject }` keyed by
 * `message[ID]` to await a verb's reply (list_logs / future CRUD). A
 * pending-matched TM_ERROR rejects the Promise but does NOT pollute the
 * view-model's global state.
 *
 * `fill()` accepts three message shapes:
 * - a TM_COMMAND|TM_RESPONSE reply (VALUE.name): settled via the pending Map.
 * - a control (`VALUE = { action, … }`): `select` (set + clear), `pause`, `logs`,
 *   `connection` (the SSE connection-status surface, hook-minted).
 * - a raw SSE log envelope (anything else): shaped inline into `{ p, line }`
 *   (logic inlined from the deleted `rawlogs:transform`) and appended newest-first
 *   to a capped buffer (unless paused), updating lines/second.
 *
 * @param {number} [maxLines] Buffer cap (defaults to MAX_LINES; injectable for tests).
 */
export class RawLogsViewNode extends Node {
	constructor( maxLines ) {
		super();
		this.maxLines = maxLines || MAX_LINES;
		// Ring buffer: rows written at `_head` (mod maxLines), oldest overwritten
		// once full. `_count` is how many slots hold a live row. No shifting,
		// concatenation, or truncation — append and cap-drop are both O(1).
		this._ring = [];
		this._head = 0;
		this._count = 0;
		this.lineCounter = 0;
		// Per-second LPS buckets ({ sec, count }) + their running total — bounded
		// to the window instead of one entry per line.
		this.lpsBuckets = [];
		this.lpsWindowTotal = 0;
		this.smoothedLPS = 0;
		this.lps = 0;
		this.logs = [];
		this.selected = '';
		this.paused = false;
		this.connectionError = false;
		// Hook-stamped ID → { resolve, reject }; resolved/rejected when the
		// matching reply lands here. Cleared on resolution.
		this.pending = new Map();
	}

	// Number of live rows in the ring (O(1)).
	get linesCount() {
		return this._count;
	}

	// The i-th row newest-first (i=0 is newest), O(1); undefined out of range.
	// The canvas reads only its on-screen window through this — never the whole
	// buffer — so the frame cost is O(rows-on-screen) regardless of buffer size.
	lineAt( i ) {
		if ( i < 0 || i >= this._count ) {
			return undefined;
		}
		const idx = ( this._head - 1 - i + this.maxLines ) % this.maxLines;
		return this._ring[ idx ];
	}

	// The whole buffer materialized newest-first — O(n), for the filter path and
	// tests only, NOT the per-frame canvas path. Assigning (`node.lines = []` from
	// handleClear / select) reseeds the ring from the given newest-first array.
	get lines() {
		const out = new Array( this._count );
		for ( let i = 0; i < this._count; i++ ) {
			out[ i ] = this.lineAt( i );
		}
		return out;
	}

	set lines( value ) {
		this._ring = [];
		this._head = 0;
		this._count = 0;
		if ( Array.isArray( value ) ) {
			// Seed oldest-first so the newest row lands last (at head-1).
			for ( let i = value.length - 1; i >= 0; i-- ) {
				this._writeRow( value[ i ] );
			}
		}
	}

	// Write one row into the ring at the head and advance, capping at maxLines.
	_writeRow( row ) {
		this._ring[ this._head ] = row;
		this._head = ( this._head + 1 ) % this.maxLines;
		this._count = Math.min( this._count + 1, this.maxLines );
	}

	fill( message ) {
		const value = message[ VALUE ];
		const type = message[ TYPE ] || 0;
		const id = message[ ID ];

		// Pending-Map gating (canonical): settle any Promise the hook stashed
		// under this ID. A pending-matched reply is the caller's surface — we
		// don't ALSO act on it locally (so a list_logs reply doesn't accidentally
		// land in the row buffer below). NOTE: a command reply's VALUE has a
		// `name` field; the row/control shapes do not.
		if (
			id &&
			this.pending.has( id ) &&
			value &&
			'object' === typeof value &&
			'name' in value
		) {
			const { resolve, reject } = this.pending.get( id );
			this.pending.delete( id );
			if ( 0 !== ( type & TM_ERROR ) ) {
				reject( new Error( _errorMessage( value.payload ) ) );
			} else {
				resolve( value.payload );
			}
			return;
		}

		if ( value && 'object' === typeof value && value.action ) {
			// Hook-minted control + catalog changes are the LOW-frequency path
			// — publish so the dropdown / pause button / selected value re-render.
			this._control( value );
			this._publish();
			return;
		}

		// Otherwise: a raw SSE log envelope. Shape envelope → `{ p, line }`
		// inline (the work the deleted `rawlogs:transform` used to do) and
		// append to the HIGH-frequency buffer the rAF reads off the node.
		this._appendEnvelope( message );
	}

	// Shape a raw SSE log envelope into a row and append. Branches inlined
	// verbatim from the deleted `transformLogLine` helper:
	//   - empty/null/undefined VALUE → drop.
	//   - object VALUE → JSON-stringify; string VALUE passes through.
	//   - non-empty string KEY → prepend `${KEY}: `.
	//   - clip to MAX_LINE_LENGTH + '...'.
	//   - partition extracted from FROM stamp (`{sub}.pN`), default 0.
	_appendEnvelope( message ) {
		const value = message[ VALUE ];
		if ( value === '' || value === null || value === undefined ) {
			return;
		}
		let line = 'string' === typeof value ? value : JSON.stringify( value );
		const key = message[ KEY ];
		if ( 'string' === typeof key && '' !== key ) {
			line = `${ key }: ${ line }`;
		}
		if ( line.length > MAX_LINE_LENGTH ) {
			line = line.substring( 0, MAX_LINE_LENGTH ) + '...';
		}
		const from = String( message[ FROM ] || '' );
		const match = from.match( PARTITION_RE );
		const partition = match ? parseInt( match[ 1 ], 10 ) : 0;
		this._appendRow( partition, line );
	}

	// Write a shaped row into the ring (O(1)); the canvas reads it back via
	// lineAt/linesCount. No setState on the HIGH-frequency path.
	_appendRow( partition, line ) {
		if ( this.paused ) {
			return;
		}
		this.lineCounter += 1;
		this._writeRow( {
			id: this.lineCounter,
			partition,
			content: line,
			isEven: this.lineCounter % 2 === 0,
		} );
		this._updateLinesPerSecond( 1 );
	}

	_control( value ) {
		if ( 'select' === value.action ) {
			this.selected = value.log;
			this._clear();
		} else if ( 'pause' === value.action ) {
			this.paused = value.paused;
		} else if ( 'logs' === value.action ) {
			this.logs = value.logs;
			if ( ! this.selected && value.logs.length > 0 ) {
				this.selected = value.logs[ 0 ].key;
			}
		} else if ( 'connection' === value.action ) {
			this.connectionError = !! value.connectionError;
		}
	}

	// Clear buffer + counter + LPS window (matches handleLogChange in RawLogs.js).
	_clear() {
		this.lines = [];
		this.lineCounter = 0;
		this.lpsBuckets = [];
		this.lpsWindowTotal = 0;
		this.smoothedLPS = 0;
		this.lps = 0;
	}

	// Lines per second over a 10s window, smoothed with a 0.1 EMA. Counts are
	// aggregated into per-second buckets with a running total, so each line is
	// O(1) (one bucket bump + bounded expiry) — not an O(n) scan of the window.
	_updateLinesPerSecond( newCount ) {
		if ( newCount <= 0 ) {
			return;
		}
		const sec = Math.floor( Date.now() / 1000 );
		const last = this.lpsBuckets[ this.lpsBuckets.length - 1 ];
		if ( last && last.sec === sec ) {
			last.count += newCount;
		} else {
			this.lpsBuckets.push( { sec, count: newCount } );
		}
		this.lpsWindowTotal += newCount;
		const oldest = sec - LPS_WINDOW_SEC;
		while (
			this.lpsBuckets.length > 0 &&
			this.lpsBuckets[ 0 ].sec <= oldest
		) {
			this.lpsWindowTotal -= this.lpsBuckets[ 0 ].count;
			this.lpsBuckets.shift();
		}
		const lps = this.lpsWindowTotal / LPS_WINDOW_SEC;
		this.smoothedLPS += ( lps - this.smoothedLPS ) * LPS_SMOOTHING;
		this.lps = this.smoothedLPS;
	}

	// Publish ONLY the low-frequency view model. `lines` and `lps` are the
	// high-frequency buffer the rAF reads off the node directly — keeping them
	// out of setState is what stops a busy stream re-rendering React per row.
	// `connectionError` rides here so the reconnect banner re-renders at low
	// frequency (off the stream's connection controls).
	_publish() {
		this.setState( 'view', {
			logs: this.logs,
			selected: this.selected,
			paused: this.paused,
			connectionError: this.connectionError,
		} );
	}
}
