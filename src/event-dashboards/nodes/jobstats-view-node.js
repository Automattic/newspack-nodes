import { ProbeStreamViewNode } from './probe-stream-view-node';
import {
	IDENTITY,
	HANDLER,
	RUNS_DELTA,
	ERRORS_DELTA,
	DURATION_MS_DELTA,
	QUEUE_MS_DELTA,
	ITEMS_OK_DELTA,
	ITEMS_ERR_DELTA,
	LAST_TS,
	LAST_DURATION_MS,
	LAST_STATUS,
	LAST_MESSAGE,
	ELAPSED_MS,
} from '../../runtime/jobstats-record';

/**
 * `jobstats:view` — owns the Jobstats stream view model.
 *
 * Each inbound frame is one job identity's lean POSITIONAL record (the
 * `Jobstats_Record` layout); the snapshot instant is the Message TIMESTAMP. Per
 * identity `IDENTITY` the view pushes each record onto a bounded series carrying its
 * raw deltas (what the table sums into WINDOWED totals) alongside the per-second
 * rates the charts plot — every value read off THAT record, never differenced
 * across records, so a worker recycle is just another window rather than a
 * counter reset to detect. Windowed totals (runs, errors, items, delta-weighted
 * avg duration) are summed over the retained window in `_entryView`, so they
 * shrink with the series as old samples prune. Last-run detail comes from the
 * latest record. Shares ProbeStreamViewNode's ring/throttle/TTL machinery;
 * supplies only the IDENTITY identity + the jobstats field mapping.
 *
 * @param {number} [maxSamples] Per-identity ring cap.
 * @param {number} [ttlMs]      Identity liveness TTL.
 */
export class JobstatsViewNode extends ProbeStreamViewNode {
	/**
	 * Publishes under the `handlers` model key; the rest is the base's machinery.
	 *
	 * @param {number} [maxSamples] Per-identity ring cap; base default when omitted.
	 * @param {number} [ttlMs]      Identity liveness TTL (ms); base default when omitted.
	 */
	constructor( maxSamples, ttlMs ) {
		super( maxSamples, ttlMs );
		this.modelKey = 'handlers';
	}

	/**
	 * The published per-identity snapshot: the windowed rollup the table reads, the
	 * newest record's last-run detail, and a copy of the series the charts plot.
	 *
	 * @param {Object} c The internal entry (its series plus the last-run detail).
	 * @return {Object} { key, handler, windowed, latest, series }.
	 */
	_entryView( c ) {
		return {
			key: c.key,
			handler: c.handler,
			// Windowed rollup (Runs/Failures/Avg) — the retained-window truth.
			windowed: this._windowedTotals( c.series ),
			latest: {
				lastTs: c.lastTs,
				lastDurationMs: c.lastDurationMs,
				lastStatus: c.lastStatus,
				lastMessage: c.lastMessage,
			},
			// Copy, not the live ref (else memo freezes + tears mid-burst).
			series: c.series.slice(),
		};
	}

	/**
	 * Sum the retained series' deltas into windowed totals + a delta-weighted mean
	 * duration + queue latency (Σ Δ / Σ Δruns; 0 when no runs). Derived on each
	 * snapshot, NOT running-summed, so the base's prune (which shifts old samples
	 * off `series`) shrinks these totals for free — no eviction bookkeeping.
	 *
	 * @param {Array<Object>} series The per-identity ring of samples.
	 * @return {Object} { runs, errors, itemsOk, itemsErr, avgDurationMs }.
	 */
	_windowedTotals( series ) {
		let runs = 0;
		let errors = 0;
		let itemsOk = 0;
		let itemsErr = 0;
		let durationMs = 0;
		let queueMs = 0;
		for ( const s of series ) {
			runs += s.runsDelta;
			errors += s.errorsDelta;
			itemsOk += s.itemsOkDelta;
			itemsErr += s.itemsErrDelta;
			durationMs += s.durationDelta;
			queueMs += s.queueDelta;
		}
		return {
			runs,
			errors,
			itemsOk,
			itemsErr,
			avgDurationMs: runs > 0 ? durationMs / runs : 0,
			avgQueueMs: runs > 0 ? queueMs / runs : 0,
		};
	}

	/**
	 * Push one jobstats record onto its identity's series.
	 *
	 * Every value is read off THIS record: its deltas (clamped non-negative) are
	 * what the table sums, `elapsed` is the interval they cover, and the rates are
	 * their quotient — 0 for an empty window rather than a division by zero. The
	 * last-run detail rides as the entry's newest values. A record older than the
	 * live window is dropped; an unseen identity gets a fresh entry.
	 *
	 * @param {string}               key   Job identity (`handler:id` or `handler`).
	 * @param {Array<string|number>} value The positional `Jobstats_Record` VALUE.
	 * @param {number}               ts    Snapshot instant (epoch seconds) from TIMESTAMP.
	 * @return {void}
	 */
	_accumulate( key, value, ts ) {
		if ( this._isExpired( ts ) ) {
			return;
		}
		let c = this.entries[ key ];
		if ( ! c ) {
			c = { key, handler: '', series: [], _lastSeen: 0 };
			this.entries[ key ] = c;
		}
		c._lastSeen = Date.now();
		c.handler = String( value[ HANDLER ] ?? c.handler );

		// Last-run detail — the newest table columns.
		c.lastTs = Number( value[ LAST_TS ] ) || 0;
		c.lastDurationMs = Number( value[ LAST_DURATION_MS ] ) || 0;
		c.lastStatus = String( value[ LAST_STATUS ] || '' );
		c.lastMessage = String( value[ LAST_MESSAGE ] || '' );

		const runsDelta = this._delta( value[ RUNS_DELTA ] );
		const queueDelta = this._delta( value[ QUEUE_MS_DELTA ] );
		const errorsDelta = this._delta( value[ ERRORS_DELTA ] );
		const itemsOkDelta = this._delta( value[ ITEMS_OK_DELTA ] );
		const elapsed = this._delta( value[ ELAPSED_MS ] ) / 1000;
		c.series.push( {
			ts,
			elapsed,
			runsDelta,
			errorsDelta,
			itemsOkDelta,
			queueDelta,
			itemsErrDelta: this._delta( value[ ITEMS_ERR_DELTA ] ),
			durationDelta: this._delta( value[ DURATION_MS_DELTA ] ),
			runsRate: elapsed > 0 ? runsDelta / elapsed : 0,
			errorsRate: elapsed > 0 ? errorsDelta / elapsed : 0,
			itemsRate: elapsed > 0 ? itemsOkDelta / elapsed : 0,
			// Per-window avg queue wait — the latency chart's metric.
			queueLatencyMs: runsDelta > 0 ? queueDelta / runsDelta : 0,
		} );
		this._capSeries( c.series );
	}

	/**
	 * The per-entry identity the base folds on: a jobstats record's `IDENTITY` slot.
	 *
	 * @param {Array<string|number>} value The positional `Jobstats_Record` VALUE.
	 * @return {string|number} Job identity (`handler:id` or `handler`).
	 */
	_identityOf( value ) {
		return value[ IDENTITY ];
	}

	/**
	 * Hidden from the node palette: the dashboard wires this sink itself, and it
	 * takes no arguments and no target.
	 *
	 * @return {Object} The `node_schema()` descriptor the console and `help` read.
	 */
	static nodeSchema() {
		return {
			category: 'Hidden',
			description:
				'Jobstats stream render-model sink (the React view node).',
			has_target: false,
			arguments: [],
			commands: [],
		};
	}
}
