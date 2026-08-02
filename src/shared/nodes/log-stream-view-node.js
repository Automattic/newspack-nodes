import { Node } from '../../runtime/node';
import { VALUE, ID } from '../../runtime/message';
import { SeekTracker } from './seekTracker';
import { RateSmoother } from '../rateSmoother';

const MAX_LINES = 100000;

/**
 * LogStreamViewNode — the shared view-node base of every log-stream dashboard
 * (Partition Viewer, Log Viewer, and downstream adopters like ELN's Request
 * Log / Error Log). One improvement here lands in all of them.
 *
 * Owns the whole common core:
 * - the O(1) newest-first ring (`linesCount` / `lineAt(i)` / `lines`), the
 *   monotonic `id` stamp and `isEven` stripe `LogRowList` renders from;
 * - the paused belt + step budget (a `step` control admits N frames);
 * - the decaying `lps` readout (`RateSmoother.read` — idle rates fall to 0);
 * - seek tracking (`SeekTracker` breadcrumbs; publishes on segment change or
 *   the replay→live flip only, never per record);
 * - the shared control verbs: `pause`, `step`, `connection`, `browse`
 *   (which CLEARS — a rewind starts from a clean slate), `follow`, `clear`.
 *
 * Subclasses implement `shapeRow( message )` → row fields (or null to drop),
 * and extend `_control()` / `viewModel()` for their extra verbs and model
 * fields (call `super`). Row fields should include the shared debug-mode
 * trio (`msgId`, `key`, `raw`) plus `content` so debug rendering and the
 * default filter work everywhere.
 *
 * @param {number} [maxLines] Ring cap (defaults to MAX_LINES).
 */
export class LogStreamViewNode extends Node {
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
		// Windowed-average + EMA lines/s (read decays an idle stream to 0).
		this.lpsSmoother = new RateSmoother();
		this.paused = false;
		// Paused-step allowance: a `step` control admits this many rows.
		this.stepBudget = 0;
		this.connectionError = false;
		// Seek/live feedback (rail highlight + replay→live flip).
		this.seek = new SeekTracker();
	}

	fill( message ) {
		// Terminal node (no sink): count here for overlay throughput (not lps).
		this.counter += 1;
		const value = message[ VALUE ];

		// A verb reply belongs to the node that asked; this one gets stream.
		if ( value && 'object' === typeof value && 'name' in value ) {
			return;
		}

		if ( value && 'object' === typeof value && value.action ) {
			// Low-frequency control path; publish to re-render.
			this._control( value );
			this._publish();
			return;
		}

		// Otherwise a raw stream envelope: subclass shapes it into a row.
		this._appendEnvelope( message );
	}

	// Shared control verbs; subclasses extend with their own (call super).
	_control( value ) {
		if ( 'pause' === value.action ) {
			this.paused = value.paused;
			this.stepBudget = 0;
		} else if ( 'step' === value.action ) {
			this.stepBudget = Number( value.frames ?? 1 );
		} else if ( 'connection' === value.action ) {
			this.connectionError = !! value.connectionError;
		} else if ( 'browse' === value.action ) {
			// Replaying: capture the live boundary to detect catch-up against.
			this.seek.browse( value.endSegment ?? null, value.endOffset ?? 0 );
			// A rewind starts clean: replays must not mix into the live tail.
			this._clear();
		} else if ( 'follow' === value.action ) {
			this.seek.follow();
		} else if ( 'clear' === value.action ) {
			this._clear();
		}
	}

	// Shape + track + append one raw envelope (the hot path).
	_appendEnvelope( message ) {
		const row = this.shapeRow( message );
		if ( ! row ) {
			return;
		}
		this._trackPosition( message );
		this._appendRow( row );
	}

	// Subclass hook: shape one raw envelope into row fields, or null to drop.
	// eslint-disable-next-line no-unused-vars
	shapeRow( message ) {
		return null;
	}

	// Track the position breadcrumb; publishes on segment/catch-up change only.
	_trackPosition( message ) {
		if ( this.seekTracking() && this.seek.track( message[ ID ] ) ) {
			this._publish();
		}
	}

	// Subclass hook: false suspends breadcrumb tracking (e.g. mixed dirs).
	seekTracking() {
		return true;
	}

	_publish() {
		this.setState( 'view', this.viewModel() );
	}

	// The published low-freq model; subclasses spread super's and add fields.
	viewModel() {
		return {
			paused: this.paused,
			connectionError: this.connectionError,
			mode: this.seek.mode,
			lastReceivedSegment: this.seek.lastReceivedSegment,
		};
	}

	// Write a shaped row into the ring (O(1)); no setState on this hot path.
	_appendRow( fields ) {
		// Paused belt: drop frames, unless a step budget admits them.
		if ( this.paused ) {
			if ( this.stepBudget <= 0 ) {
				return;
			}
			this.stepBudget -= 1;
		}
		this.lineCounter += 1;
		this._writeRow( {
			id: this.lineCounter,
			...fields,
			isEven: this.lineCounter % 2 === 0,
		} );
		this.lpsSmoother.add( 1, Date.now() );
	}

	// Clear buffer + counter + rate window (select / browse / clear).
	_clear() {
		this.lines = [];
		this.lineCounter = 0;
		this.lpsSmoother.reset();
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

	// Time-aware readout: an idle stream's rate decays instead of freezing.
	get lps() {
		return this.lpsSmoother.read( Date.now() );
	}

	// Number of live rows in the ring (O(1)).
	get linesCount() {
		return this._count;
	}

	// Seek feedback surfaced for the published model (and view-node tests).
	get mode() {
		return this.seek.mode;
	}
	get lastReceivedSegment() {
		return this.seek.lastReceivedSegment;
	}

	static nodeSchema() {
		return {
			category: 'Hidden',
			description: 'Log-stream render-model sink (the React view node).',
			// Terminal receiver: settles replies, no target → no out-port.
			has_target: false,
			arguments: [],
			commands: [],
		};
	}
}
