import { Node } from '../../runtime/node';
import { FROM, KEY, VALUE, ID } from '../../runtime/message';
import { PendingReplies } from '../../shared/pendingReplies';
import { SeekTracker } from '../../shared/nodes/seekTracker';
import { RateSmoother } from '../rateSmoother';

const MAX_LINES = 100000;
const MAX_LINE_LENGTH = 1000;
const PARTITION_RE = /\.p(\d+)$/;

/**
 * `partition:view` — owns the Partition Viewer view model.
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
 *   `useNodeState('partition:view','view')`.
 *
 * `fill()` ALSO handles the canonical
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
 *   (logic inlined from the deleted `partition:transform`) and appended newest-first
 *   to a capped buffer (unless paused), updating lines/second.
 *
 * @param {number} [maxLines] Buffer cap (defaults to MAX_LINES; injectable for tests).
 */
export class PartitionViewerViewNode extends Node {
	// View-model/infra node: never a user-added node (see useGraphReset).
	static isSystemNode = true;
	constructor( maxLines ) {
		super();
		this.maxLines = maxLines || MAX_LINES;
		// Ring buffer: append at _head (mod maxLines), overwrite oldest; O(1).
		this._ring = [];
		this._head = 0;
		this._count = 0;
		this.lineCounter = 0;
		// Windowed-average + EMA lines/s (the overlay's I/O counters share it).
		this.lpsSmoother = new RateSmoother();
		this.lps = 0;
		this.logs = [];
		this.selected = '';
		this.paused = false;
		this.connectionError = false;
		// Seek/live feedback (rail highlight + replay→live flip).
		this.seek = new SeekTracker();
		// Hook-stamped ID → { resolve, reject }; settled when its reply lands.
		this.replies = new PendingReplies();
	}

	// Seek feedback surfaced for the published model (and view-node tests).
	get mode() {
		return this.seek.mode;
	}
	get lastReceivedSegment() {
		return this.seek.lastReceivedSegment;
	}

	fill( message ) {
		// Terminal node (no sink): count here for overlay throughput (not lps).
		this.counter += 1;
		const value = message[ VALUE ];

		// Settle a pending Promise; gate on VALUE.name so raw logs can't.
		if (
			value &&
			'object' === typeof value &&
			'name' in value &&
			this.replies.settle( message )
		) {
			return;
		}

		if ( value && 'object' === typeof value && value.action ) {
			// Low-frequency control/catalog path; publish to re-render.
			this._control( value );
			this._publish();
			return;
		}

		// Otherwise a raw SSE log envelope: shape inline, append to buffer.
		this._appendEnvelope( message );
	}

	_control( value ) {
		if ( 'select' === value.action ) {
			this.selected = value.log;
			// A fresh log tails live from a clean slate — drop browse cursor.
			this.seek.select();
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
		} else if ( 'browse' === value.action ) {
			// Replaying: capture the live boundary to detect catch-up against.
			this.seek.browse( value.endSegment ?? null, value.endOffset ?? 0 );
		} else if ( 'follow' === value.action ) {
			this.seek.follow();
		}
	}

	// Clear buffer + counter + LPS window on a log switch.
	_clear() {
		this.lines = [];
		this.lineCounter = 0;
		this.lpsSmoother.reset();
		this.lps = 0;
	}

	// Publish only the low-freq model; lines/lps stay off setState (perf).
	_publish() {
		this.setState( 'view', {
			logs: this.logs,
			selected: this.selected,
			paused: this.paused,
			connectionError: this.connectionError,
			mode: this.seek.mode,
			lastReceivedSegment: this.seek.lastReceivedSegment,
		} );
	}

	// Track the position breadcrumb; publishes on segment/catch-up change only.
	_trackPosition( message ) {
		if ( this.seek.track( message[ ID ] ) ) {
			this._publish();
		}
	}

	// Shape a raw SSE log envelope into a row and append it to the buffer.
	_appendEnvelope( message ) {
		const value = message[ VALUE ];
		if ( value === '' || value === null || value === undefined ) {
			return;
		}
		this._trackPosition( message );
		let line = 'string' === typeof value ? value : JSON.stringify( value );
		const key = message[ KEY ];
		if ( 'string' === typeof key && '' !== key ) {
			line = `${ key }: ${ line }`;
		}
		if ( line.length > MAX_LINE_LENGTH ) {
			line = line.substring( 0, MAX_LINE_LENGTH ) + '...';
		}
		// Prefer .pN column; else stable first-seen index (no collapse to 0).
		const dir = String( message[ FROM ] || '' ).split( '/' )[ 0 ];
		const match = dir.match( PARTITION_RE );
		let partition;
		if ( match ) {
			partition = parseInt( match[ 1 ], 10 );
		} else {
			const index = ( this._partitionIndex ??= new Map() );
			if ( ! index.has( dir ) ) {
				index.set( dir, index.size );
			}
			partition = index.get( dir );
		}
		this._appendRow( partition, line );
	}

	// Write a shaped row into the ring (O(1)); no setState on this hot path.
	_appendRow( partition, line ) {
		// Belt: drops frames arriving in the pause-click→async-close window.
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

	// Lines/sec over a 10s window, smoothed with a 0.1 EMA (RateSmoother).
	_updateLinesPerSecond( newCount ) {
		this.lps = this.lpsSmoother.add( newCount, Date.now() );
	}

	// Whole buffer newest-first, O(n): filter path + tests only, not frames.
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

	// The i-th row newest-first (i=0 newest), O(1); undefined out of range.
	lineAt( i ) {
		if ( i < 0 || i >= this._count ) {
			return undefined;
		}
		const idx = ( this._head - 1 - i + this.maxLines ) % this.maxLines;
		return this._ring[ idx ];
	}

	// Number of live rows in the ring (O(1)).
	get linesCount() {
		return this._count;
	}

	static nodeSchema() {
		return {
			category: 'Hidden',
			description:
				'Partition Viewer render-model sink (the React view node).',
			// Terminal receiver: settles replies, no target → no out-port.
			has_target: false,
			arguments: [],
			commands: [],
		};
	}
}
