/* eslint-disable no-bitwise -- TYPE field uses bitmask flags (Tachikoma convention). */
import { Node } from '../../runtime/node';
import { ID, TYPE, VALUE, TM_ERROR } from '../../runtime/message';

const MAX_LINES = 100000;
const LPS_WINDOW_MS = 10000;

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
 * - HIGH frequency (the log stream): `_appendRow` pushes each row onto `this.lines`
 *   and recomputes `this.lps`, but does NOT publish. The React view reads these
 *   directly off the node each animation frame (`Core.node('rawlogs:view').lines`
 *   / `.lps`) so a high-volume stream never re-renders React per line.
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
 * - a row (`VALUE = { p, line }` from `rawlogs:transform`): appended newest-first
 *   to a capped buffer (unless paused), updating lines/second.
 * - a control (`VALUE = { action, … }`): `select` (set + clear), `pause`, `logs`,
 *   `connection` (the SSE connection-status surface from the route).
 *
 * Buffer + LPS logic migrated verbatim from `RawLogs.js`.
 */
class RawLogsViewNode extends Node {
	constructor() {
		super();
		this.lines = [];
		this.lineCounter = 0;
		this.lineHistory = [];
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

		if ( value && value.action ) {
			// Control + catalog changes are the LOW-frequency path — publish so
			// the dropdown / pause button / selected value re-render.
			this._control( value );
			this._publish();
		} else if ( value ) {
			// A log row is the HIGH-frequency path — update node.lines / node.lps
			// only; the rAF reads them directly. Publishing here would re-render
			// React per line and defeat the whole point.
			this._appendRow( value );
		}
	}

	// A row from rawlogs:transform: { p, line }. Newest-first, capped.
	_appendRow( row ) {
		if ( this.paused ) {
			return;
		}
		this.lineCounter += 1;
		this.lines.unshift( {
			id: this.lineCounter,
			partition: row.p,
			content: row.line,
			isEven: this.lineCounter % 2 === 0,
		} );
		if ( this.lines.length > MAX_LINES ) {
			this.lines.length = MAX_LINES;
		}
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

	// Clear buffer + counter + LPS history (matches handleLogChange in RawLogs.js).
	_clear() {
		this.lines = [];
		this.lineCounter = 0;
		this.lineHistory = [];
		this.smoothedLPS = 0;
		this.lps = 0;
	}

	// Lines per second over a 10s window, smoothed with a 0.1 EMA.
	_updateLinesPerSecond( newCount ) {
		const now = Date.now();
		if ( newCount > 0 ) {
			this.lineHistory.push( { time: now, count: newCount } );
		}
		this.lineHistory = this.lineHistory.filter(
			( entry ) => now - entry.time < LPS_WINDOW_MS
		);
		const totalInWindow = this.lineHistory.reduce(
			( sum, entry ) => sum + entry.count,
			0
		);
		const LPS = totalInWindow / ( LPS_WINDOW_MS / 1000 );
		this.smoothedLPS += ( LPS - this.smoothedLPS ) * 0.1;
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

/**
 * Create and register the Raw Logs view-model node.
 *
 * @param {string} name Node name.
 * @return {RawLogsViewNode} The view-model node.
 */
export function createRawLogsView( name ) {
	const node = new RawLogsViewNode();
	node.setName( name );
	return node;
}
