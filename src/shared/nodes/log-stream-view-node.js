import { Node } from '../../runtime/node';
import { VALUE, ID } from '../../runtime/message';
import { SeekTracker } from './seekTracker';
import { RateSmoother } from '../rateSmoother';
import { isControl } from '../helpers/controlMsg';

/**
 * Default ring cap, and with it the ceiling on a view's memory: every live row
 * holds its whole shaped payload, so the cap times the row size is what a
 * dashboard left open all day costs. Past it each arrival overwrites the
 * oldest row, which is why the ring never grows and never compacts.
 */
const MAX_LINES = 100000;

/**
 * LogStreamViewNode — the shared view-node base of every log-stream dashboard
 * (Partition Viewer, Log Viewer, and downstream adopters like ELN's Request
 * Log / Error Log). One improvement here lands in all of them.
 *
 * Owns the whole common core:
 * - the O(1) newest-first ring (`linesCount` / `lineAt(i)` / `lines`) that
 *   `LogRowList` walks, the monotonic `id` each row carries as its React key,
 *   and the `isEven` flag a row renderer stripes from;
 * - the paused belt + step budget (a `step` control admits N frames);
 * - the decaying `lps` readout (`RateSmoother.read` — idle rates fall to 0);
 * - seek tracking (`SeekTracker` breadcrumbs; publishes on segment change or
 *   the replay→live flip only, never per record);
 * - the shared control verbs: `pause`, `step`, `connection`, `browse`
 *   (which CLEARS — a rewind starts from a clean slate), `follow`, `clear`,
 *   `filter`, and `select` (the subscription switch, which resets the tracker,
 *   clears the ring, and arms breadcrumbs for the dir it names).
 *
 * Subclasses implement `shapeRow( message )` → row fields (or null to drop),
 * and extend `_control()` / `viewModel()` for their extra verbs and model
 * fields (call `super`). Row fields should include the shared debug-mode
 * trio (`msgId`, `key`, `raw`) plus `content` so debug rendering and the
 * default filter work everywhere.
 */
export class LogStreamViewNode extends Node {
	/**
	 * Build the empty view: an empty ring, a live seek tracker, and no
	 * controller — the graph assigns `controlFrom` before a control arrives.
	 *
	 * @param {number} [maxLines] Ring cap; `MAX_LINES` when omitted or zero.
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
		// @longform FROM of whoever drives this view's controls — the graph
		// sets it, and a graph that forgets loses pause/step/clear in silence,
		// because a control whose FROM matches nothing is just a record. The
		// minters throw rather than stamp an empty origin.
		this.controlFrom = '';
		this.paused = false;
		// Paused-step allowance: a `step` control admits this many rows.
		this.stepBudget = 0;
		this.connectionError = false;
		// @longform Ingest gate, lowercased: rows that miss it never enter the
		// ring, so `lineCounter` counts ADMITTED rows and the `isEven` stripe
		// alternates across what is displayed while staying pinned to its row.
		// Filtering at render instead cost both — the stripe reflected a
		// position in the unfiltered stream, and non-matches still consumed
		// ring slots, so a rare match aged out while its filter still stood.
		this.filter = '';
		// Breadcrumb arming: a `select` naming a dir sets it, a glob clears it.
		this.seekActive = true;
		// Seek/live feedback (rail highlight + replay→live flip).
		this.seek = new SeekTracker();
	}

	/**
	 * Route one arriving message: a control from `controlFrom` runs through
	 * `_control()` and republishes; anything else is a raw stream envelope the
	 * subclass shapes into a row.
	 *
	 * The origin alone says which it is — ADR-7 addressing, applied to
	 * controls. A record whose VALUE happens to carry an `action` field is
	 * still a record, so sniffing the payload for one runs the view's verbs on
	 * live data and swallows whole streams.
	 *
	 * @param {Array} message The 7-field positional message.
	 */
	fill( message ) {
		// Terminal node (no sink): count here for overlay throughput (not lps).
		this.counter += 1;

		if ( isControl( this, message ) ) {
			// Low-frequency control path; publish to re-render.
			this._control( message[ VALUE ] );
			this._publish();
			return;
		}

		// Otherwise a raw stream envelope: subclass shapes it into a row.
		this._appendEnvelope( message );
	}

	/**
	 * Apply one shared control verb: `pause`, `step`, `connection`, `browse`,
	 * `follow`, `clear`, `filter`, or `select`. Subclasses handle their own
	 * verbs first and defer the rest here with `super._control( value )`.
	 *
	 * `select` is the subscription switch: it resets the seek tracker and drops
	 * every buffered row, since rows read under the previous subscription don't
	 * belong to the new one. A `dir` names one partition directory and arms
	 * breadcrumb tracking; `''` widens back to a glob, whose interleaved
	 * segment ids would jitter the rail highlight, and disarms it. A payload
	 * carrying no `dir` at all selects a single source and stays armed.
	 *
	 * @param {?{action?: string, paused?: boolean, frames?: number, connectionError?: boolean, endSegment?: ?number, endOffset?: number, term?: string, dir?: string}} value The control payload: `action` picks the verb, the remaining fields are that verb's arguments. An unrecognised or absent verb is a no-op.
	 */
	_control( value ) {
		const action = value?.action;
		if ( 'select' === action ) {
			this.seekActive = undefined === value.dir ? true : !! value.dir;
			this.seek.select();
			this._clear();
		} else if ( 'pause' === action ) {
			this.paused = value.paused;
			this.stepBudget = 0;
		} else if ( 'step' === action ) {
			this.stepBudget = Number( value.frames ?? 1 );
		} else if ( 'connection' === action ) {
			this.connectionError = !! value.connectionError;
		} else if ( 'browse' === action ) {
			// Replaying: capture the live boundary to detect catch-up against.
			this.seek.browse( value.endSegment, value.endOffset );
			// A rewind starts clean: replays must not mix into the live tail.
			this._clear();
		} else if ( 'follow' === action ) {
			this.seek.follow();
		} else if ( 'clear' === action ) {
			this._clear();
		} else if ( 'filter' === action ) {
			// The past is the past; `clear` is what empties the ring.
			this.filter = String( value.term ?? '' ).toLowerCase();
		}
	}

	/**
	 * Shape, track, and append one raw envelope — the hot path. An envelope the
	 * subclass declines to SHAPE is dropped without touching the seek
	 * breadcrumb: it was never this view's record. One the ingest FILTER
	 * rejects still moves the breadcrumb, because the stream really did
	 * advance past it and the rail reports position, not matches.
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
	 * Whether position breadcrumbs mean anything for the current source, as
	 * `select` last armed it. False suspends tracking — a stream mixing several
	 * directories carries segment ids from unrelated sequences.
	 *
	 * @return {boolean} True while breadcrumbs should be tracked.
	 */
	seekTracking() {
		return this.seekActive;
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
		// The gate precedes the belt: a dropped row must not spend step budget.
		if (
			'' !== this.filter &&
			! this.matchesFilter( fields, this.filter )
		) {
			return;
		}
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
	 * Whether one shaped row survives the ingest filter. The base matches
	 * `content`; a subclass with more searchable fields overrides.
	 *
	 * @param {Object} fields      Row fields from `shapeRow()`.
	 * @param {string} filterLower The active filter, already lowercased.
	 * @return {boolean} True to admit the row into the ring.
	 */
	matchesFilter( fields, filterLower ) {
		return String( fields.content ?? '' )
			.toLowerCase()
			.includes( filterLower );
	}

	/**
	 * Replace the buffer wholesale, on a fully `_clear()`ed view — so the id
	 * stamp and the rate window never survive a caller that meant to empty it.
	 *
	 * @param {Object[]} value Rows newest-first; they are seeded oldest-first
	 *                         so the newest one lands at the head.
	 */
	set lines( value ) {
		this._clear();
		if ( Array.isArray( value ) ) {
			// Seed oldest-first so the newest row lands last (at head-1).
			for ( let i = value.length - 1; i >= 0; i-- ) {
				this._writeRow( value[ i ] );
			}
		}
	}

	/**
	 * Drop every buffered row and reset the line counter and the rate window
	 * — the ONE reset `select`, `browse`, the `clear` verb and assigning
	 * `lines` all land on, so no caller can half-clear the view.
	 */
	_clear() {
		this._emptyRing();
		this.lineCounter = 0;
		this.lpsSmoother.reset();
	}

	/**
	 * Drop the ring's storage; the counters `_clear()` owns are separate.
	 */
	_emptyRing() {
		this._ring = [];
		this._head = 0;
		this._count = 0;
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
	 * Schema behind the console palette and `help`. Hidden, because a
	 * dashboard graph wires this node rather than an operator, and
	 * target-less: it publishes a render model and forwards nothing, so it
	 * draws no out-port.
	 *
	 * @return {Object} The node schema.
	 */
	static nodeSchema() {
		return {
			category: 'Hidden',
			description: 'Log-stream render-model sink (the React view node).',
			has_target: false,
			arguments: [],
			commands: [],
		};
	}
}
