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
 */
export class LogStreamViewNode extends Node {
	// View-model/infra node: never a user-added node (see useGraphReset).
	static isSystemNode = true;

	/**
	 * @param {number} [maxLines] Ring cap; defaults to MAX_LINES (100000).
	 */
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

	/**
	 * Route one arriving message: a verb reply belongs to the node that asked
	 * for it and is dropped here, a control payload runs through `_control()`
	 * and republishes, and anything else is a raw stream envelope the subclass
	 * shapes into a row.
	 *
	 * @param {Array} message The 7-field positional message.
	 */
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

	/**
	 * Apply one shared control verb: `pause`, `step`, `connection`, `browse`,
	 * `follow`, or `clear`. Subclasses handle their own verbs first and defer
	 * the rest here with `super._control( value )`.
	 *
	 * @param {{action: string, paused?: boolean, frames?: number, connectionError?: boolean, endSegment?: ?number, endOffset?: number}} value The control payload: `action` picks the verb, the remaining fields are that verb's arguments.
	 */
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

	/**
	 * Shape, track, and append one raw envelope — the hot path. An envelope
	 * the subclass declines to shape is dropped without touching the seek
	 * breadcrumb, so a filtered-out record never moves the rail highlight.
	 *
	 * @param {Array} message The 7-field positional message.
	 */
	_appendEnvelope( message ) {
		const row = this.shapeRow( message );
		if ( ! row ) {
			return;
		}
		this._trackPosition( message );
		this._appendRow( row );
	}

	/**
	 * Subclass hook: shape one raw envelope into the row fields `LogRowList`
	 * renders. Include the shared debug trio (`msgId`, `key`, `raw`) and
	 * `content` so debug rendering and the default filter work everywhere.
	 * The base declines every envelope.
	 *
	 * @param {Array} message The 7-field positional message.
	 * @return {?Object} Row fields, or null to drop the envelope.
	 */
	// eslint-disable-next-line no-unused-vars
	shapeRow( message ) {
		return null;
	}

	/**
	 * Feed the record's `segment:offset:length` breadcrumb to the seek
	 * tracker, republishing only when the segment changed or the replay
	 * caught up — never once per record.
	 *
	 * @param {Array} message The 7-field positional message.
	 */
	_trackPosition( message ) {
		if ( this.seekTracking() && this.seek.track( message[ ID ] ) ) {
			this._publish();
		}
	}

	/**
	 * Subclass hook: whether position breadcrumbs mean anything for the
	 * current source. False suspends tracking — a stream mixing several
	 * directories carries segment ids from unrelated sequences.
	 *
	 * @return {boolean} True while breadcrumbs should be tracked.
	 */
	seekTracking() {
		return true;
	}

	/**
	 * Publish the low-frequency model on the `view` state event, which is what
	 * re-renders the React tree.
	 */
	_publish() {
		this.setState( 'view', this.viewModel() );
	}

	/**
	 * The published low-frequency model: the paused belt, the connection
	 * indicator, and the seek feedback. Subclasses spread `super.viewModel()`
	 * and add their own fields.
	 *
	 * @return {Object} The render model.
	 */
	viewModel() {
		return {
			paused: this.paused,
			connectionError: this.connectionError,
			mode: this.seek.mode,
			lastReceivedSegment: this.seek.lastReceivedSegment,
		};
	}

	/**
	 * Admit one shaped row into the ring, O(1) and without publishing — this
	 * is the per-record path. A paused view drops the row unless the step
	 * budget still admits frames.
	 *
	 * @param {Object} fields Row fields from `shapeRow()`; the monotonic `id`
	 *                        and the `isEven` stripe are stamped on top.
	 */
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

	/**
	 * Drop every buffered row and reset the line counter and the rate window
	 * — what `select`, `browse`, and `clear` all fall back to.
	 */
	_clear() {
		this.lines = [];
		this.lineCounter = 0;
		this.lpsSmoother.reset();
	}

	/**
	 * The whole buffer newest-first, O(n) — the filter path and the tests
	 * read this; a render frame reads `lineAt()` instead.
	 *
	 * @return {Object[]} Every live row, newest first.
	 */
	get lines() {
		const out = new Array( this._count );
		for ( let i = 0; i < this._count; i++ ) {
			out[ i ] = this.lineAt( i );
		}
		return out;
	}

	/**
	 * Replace the buffer wholesale. Anything but an array empties the ring,
	 * which is how `_clear()` resets it.
	 *
	 * @param {Object[]} value Rows newest-first; they are seeded oldest-first
	 *                         so the newest one lands at the head.
	 */
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

	/**
	 * Write one row at the ring head and advance, capping the live count at
	 * `maxLines` — past the cap each write overwrites the oldest row.
	 *
	 * @param {Object} row The row to store, already stamped.
	 */
	_writeRow( row ) {
		this._ring[ this._head ] = row;
		this._head = ( this._head + 1 ) % this.maxLines;
		this._count = Math.min( this._count + 1, this.maxLines );
	}

	/**
	 * One row by newest-first index, O(1) — what the virtualized list reads
	 * per visible row per frame.
	 *
	 * @param {number} i Row index; 0 is the newest row.
	 * @return {Object|undefined} The row, or undefined when `i` is out of range.
	 */
	lineAt( i ) {
		if ( i < 0 || i >= this._count ) {
			return undefined;
		}
		const idx = ( this._head - 1 - i + this.maxLines ) % this.maxLines;
		return this._ring[ idx ];
	}

	/**
	 * Lines per second, read time-aware: an idle stream's rate decays toward
	 * zero instead of freezing at whatever it last measured.
	 *
	 * @return {number} The smoothed arrival rate.
	 */
	get lps() {
		return this.lpsSmoother.read( Date.now() );
	}

	/**
	 * @return {number} Live rows in the ring, O(1) — the list's row count.
	 */
	get linesCount() {
		return this._count;
	}

	/**
	 * Seek feedback surfaced for the published model (and the view-node tests).
	 *
	 * @return {string} `live` while tailing the head, `replay` while browsing.
	 */
	get mode() {
		return this.seek.mode;
	}

	/**
	 * @return {?number} Segment the last record arrived from — the rail
	 *                   highlight — or null before any record.
	 */
	get lastReceivedSegment() {
		return this.seek.lastReceivedSegment;
	}

	/**
	 * Schema behind the console palette and `help`. Hidden and target-less: a
	 * terminal receiver that settles replies has nothing to forward on.
	 *
	 * @return {Object} The node schema.
	 */
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
