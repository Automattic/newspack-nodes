import { ProbeStreamViewNode } from './probe-stream-view-node';
import {
	KEY,
	HANDLER,
	RUNS,
	ERRORS,
	DURATION_MS,
	QUEUE_MS,
	ITEMS_OK,
	ITEMS_ERR,
	LAST_TS,
	LAST_DURATION_MS,
	LAST_STATUS,
	LAST_MESSAGE,
} from '../../runtime/jobstats-record';

/**
 * `jobstats:view` — owns the Jobstats stream view model.
 *
 * Each inbound frame is one job identity's lean POSITIONAL record (the
 * `Jobstats_Record` layout); the snapshot instant is the Message TIMESTAMP. Per
 * identity `KEY` the view folds each record into a bounded series carrying, per
 * sample, both a per-second RATE the charts plot and the raw positive Δ the table
 * sums into WINDOWED totals. The Δ rule (in `_delta`) is the single source both
 * consume: a worker restart (counter reset, new < prior) or the first sample counts
 * the NEW record's value — a recycled generation's runs=1 is one new run, never
 * negative, never eaten — unlike TopicProbe's throughput rates, which zero on
 * restart. Windowed totals (runs, errors, items, delta-weighted avg duration) are
 * summed over the retained window in `_entryView`, so they shrink with the series as
 * old samples prune. Last-run detail + newest cumulative come from the latest
 * record. Shares ProbeStreamViewNode's ring/throttle/TTL machinery; supplies only
 * the KEY identity + the jobstats field mapping.
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
	 * Fold one jobstats record into its identity's entry and push a derived sample.
	 *
	 * Stores the record's cumulative counters and last-run detail as the entry's
	 * newest values, then derives — against the prior record — the per-second rates
	 * the charts plot and the raw positive Δs the table sums. A record older than the
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
			c = {
				key,
				handler: '',
				series: [],
				_lastRuns: null,
				_lastErrors: null,
				_lastItems: null,
				_lastItemsErr: null,
				_lastDuration: null,
				_lastQueue: null,
				_lastTs: 0,
				_lastSeen: 0,
			};
			this.entries[ key ] = c;
		}
		c._lastSeen = Date.now();
		c.handler = String( value[ HANDLER ] ?? c.handler );

		const runs = Number( value[ RUNS ] ) || 0;
		const errors = Number( value[ ERRORS ] ) || 0;
		const itemsOk = Number( value[ ITEMS_OK ] ) || 0;
		const itemsErr = Number( value[ ITEMS_ERR ] ) || 0;
		const durationMs = Number( value[ DURATION_MS ] ) || 0;
		const queueMs = Number( value[ QUEUE_MS ] ) || 0;
		const lastTs = Number( value[ LAST_TS ] ) || 0;
		// Hidden reset: recycle onto the SAME cumulative (flat runs, new ts).
		const reset =
			null !== c._lastRuns &&
			runs === c._lastRuns &&
			lastTs > ( c.lastTs || 0 );
		// Newest-record cumulative + last-run detail (newest table columns).
		c.runs = runs;
		c.errors = errors;
		c.durationMs = durationMs;
		c.itemsOk = itemsOk;
		c.itemsErr = itemsErr;
		c.lastTs = lastTs;
		c.lastDurationMs = Number( value[ LAST_DURATION_MS ] ) || 0;
		c.lastStatus = String( value[ LAST_STATUS ] || '' );
		c.lastMessage = String( value[ LAST_MESSAGE ] || '' );

		// Per-record rate (charts) + raw Δ (windowed totals) from one `_delta`.
		const dt = ts > c._lastTs ? ts - c._lastTs : 0;
		const runsRate = this._rate( c._lastRuns, runs, dt, reset );
		const errorsRate = this._rate( c._lastErrors, errors, dt, reset );
		const itemsRate = this._rate( c._lastItems, itemsOk, dt, reset );
		const runsDelta = this._delta( c._lastRuns, runs, reset );
		const errorsDelta = this._delta( c._lastErrors, errors, reset );
		const itemsOkDelta = this._delta( c._lastItems, itemsOk, reset );
		const itemsErrDelta = this._delta( c._lastItemsErr, itemsErr, reset );
		const durationDelta = this._delta( c._lastDuration, durationMs, reset );
		const queueDelta = this._delta( c._lastQueue, queueMs, reset );
		c._lastRuns = runs;
		c._lastErrors = errors;
		c._lastItems = itemsOk;
		c._lastItemsErr = itemsErr;
		c._lastDuration = durationMs;
		c._lastQueue = queueMs;
		c._lastTs = ts;

		c.series.push( {
			ts,
			runsRate,
			errorsRate,
			itemsRate,
			runsDelta,
			errorsDelta,
			itemsOkDelta,
			itemsErrDelta,
			durationDelta,
			queueDelta,
			// Per-window avg queue wait — the latency chart's metric.
			queueLatencyMs: runsDelta > 0 ? queueDelta / runsDelta : 0,
		} );
		this._capSeries( c.series );
	}

	/**
	 * Per-second rate: the positive Δ from `_delta` over the elapsed Δts. The first
	 * sample (no prior) or a zero/negative Δts yields 0, so a chart never spikes on
	 * the first record or on two records sharing one instant.
	 *
	 * @param {number|null} prior   Prior cumulative value (null on first sample).
	 * @param {number}      current This record's cumulative value.
	 * @param {number}      dt      Seconds since the prior record; 0 when not advancing.
	 * @param {boolean}     [reset] Force `_delta`'s reset path (hidden equal-value reset).
	 * @return {number} Units per second.
	 */
	_rate( prior, current, dt, reset = false ) {
		return null !== prior && dt > 0
			? this._delta( prior, current, reset ) / dt
			: 0;
	}

	/**
	 * Positive counter Δ — the single source of the reset rule for BOTH the rate
	 * and the windowed totals. First sample OR a reset (new < prior, or `reset`
	 * for a recycle that landed on an EQUAL cumulative — detected upstream via
	 * the last-run ts) counts the NEW record's value: a fresh worker
	 * generation's runs=1 is one new run, never negative, never eaten. A normal
	 * increment is the plain difference.
	 *
	 * @param {number|null} prior   Prior cumulative value (null on first sample).
	 * @param {number}      current This record's cumulative value.
	 * @param {boolean}     [reset] Force the reset path (hidden equal-value reset).
	 * @return {number} The non-negative delta contribution.
	 */
	_delta( prior, current, reset = false ) {
		return null === prior || reset || current < prior
			? current
			: current - prior;
	}

	/**
	 * The published per-identity snapshot: the windowed rollup the table reads, the
	 * newest record's cumulative counters and last-run detail, and a copy of the
	 * series the charts plot.
	 *
	 * @param {Object} c The internal entry (series plus its `_last*` fold state).
	 * @return {Object} { key, handler, windowed, latest, series }.
	 */
	_entryView( c ) {
		return {
			key: c.key,
			handler: c.handler,
			// Windowed rollup (Runs/Failures/Avg) — the retained-window truth.
			windowed: this._windowedTotals( c.series ),
			latest: {
				runs: c.runs,
				errors: c.errors,
				itemsOk: c.itemsOk,
				itemsErr: c.itemsErr,
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
	 * Sum the retained series' positive Δs into windowed totals + a delta-weighted
	 * mean duration + queue latency (Σ Δ / Σ Δruns; 0 when no runs). Derived
	 * on each snapshot, NOT running-summed, so the base's prune (which shifts old
	 * samples off `series`) shrinks these totals for free — no eviction bookkeeping.
	 *
	 * @param {Array<Object>} series The per-identity ring of derived samples.
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
	 * The per-entry identity the base folds on: a jobstats record's `KEY` slot.
	 *
	 * @param {Array<string|number>} value The positional `Jobstats_Record` VALUE.
	 * @return {string|number} Job identity (`handler:id` or `handler`).
	 */
	_identityOf( value ) {
		return value[ KEY ];
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
