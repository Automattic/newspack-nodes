import { Node } from '../../runtime/node';
import { VALUE } from '../../runtime/message';

const MAX_LINES = 100000;
const LPS_WINDOW_MS = 10000;

/**
 * `rawlogs/view` — owns the Raw Logs view model and publishes it via
 * `setState('view', …)` for the React view (`useNodeState('rawlogs/view','view')`).
 *
 * `fill()` accepts two TM_STRUCT shapes:
 * - a row (`VALUE = { p, line }` from `rawlogs/transform`): appended newest-first
 *   to a capped buffer (unless paused), updating lines/second.
 * - a control (`VALUE = { action, … }`): `select` (set + clear), `pause`, `logs`.
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
	}

	fill( message ) {
		const value = message[ VALUE ];
		if ( value && value.action ) {
			this._control( value );
		} else if ( value ) {
			this._appendRow( value );
		}
		this._publish();
	}

	// A row from rawlogs/transform: { p, line }. Newest-first, capped.
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

	_publish() {
		this.setState( 'view', {
			lines: this.lines,
			logs: this.logs,
			selected: this.selected,
			lps: this.lps,
			paused: this.paused,
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
