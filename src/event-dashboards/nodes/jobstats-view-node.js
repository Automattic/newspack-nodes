/**
 * JobstatsViewNode — the job-throughput stream. See ProbeStreamViewNode for
 * the ring, the retention window and the record decoding it shares.
 */

import * as Job from '../../runtime/jobstats-record';
import { ProbeStreamViewNode } from './probe-stream-view-node';

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
 * latest record.
 *
 * @param {number} [maxSamples] Per-identity ring cap.
 * @param {number} [ttlMs]      Identity liveness TTL.
 */
export class JobstatsViewNode extends ProbeStreamViewNode {
	identitySlot = Job.IDENTITY;
	modelKey = 'handlers';
	static description =
		'Jobstats stream render-model sink (the React view node).';

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
	 * Fold one jobstats record into its identity's entry and yield its sample.
	 *
	 * Every value is read off THIS record: its deltas (clamped non-negative) are
	 * what the table sums, `elapsed` is the interval they cover, and the rates are
	 * their quotient — 0 for an empty window rather than a division by zero. The
	 * last-run detail rides as the entry's newest values.
	 *
	 * @param {Object}               c     The identity's entry (`handler:id` or `handler`).
	 * @param {Array<string|number>} value The positional `Jobstats_Record` VALUE.
	 * @param {number}               ts    Snapshot instant (epoch seconds) from TIMESTAMP.
	 * @return {Object} The sample to push onto the entry's series.
	 */
	_fold( c, value, ts ) {
		c.handler = String( value[ Job.HANDLER ] ?? c.handler ?? '' );

		// Last-run detail — the newest table columns.
		c.lastTs = Number( value[ Job.LAST_TS ] ) || 0;
		c.lastDurationMs = Number( value[ Job.LAST_DURATION_MS ] ) || 0;
		c.lastStatus = String( value[ Job.LAST_STATUS ] || '' );
		c.lastMessage = String( value[ Job.LAST_MESSAGE ] || '' );

		const runsDelta = this._delta( value[ Job.RUNS_DELTA ] );
		const queueDelta = this._delta( value[ Job.QUEUE_MS_DELTA ] );
		const errorsDelta = this._delta( value[ Job.ERRORS_DELTA ] );
		const itemsOkDelta = this._delta( value[ Job.ITEMS_OK_DELTA ] );
		const elapsed = this._delta( value[ Job.ELAPSED_MS ] ) / 1000;
		return {
			ts,
			elapsed,
			runsDelta,
			errorsDelta,
			itemsOkDelta,
			queueDelta,
			itemsErrDelta: this._delta( value[ Job.ITEMS_ERR_DELTA ] ),
			durationDelta: this._delta( value[ Job.DURATION_MS_DELTA ] ),
			runsRate: elapsed > 0 ? runsDelta / elapsed : 0,
			errorsRate: elapsed > 0 ? errorsDelta / elapsed : 0,
			itemsRate: elapsed > 0 ? itemsOkDelta / elapsed : 0,
			// Per-window avg queue wait — the latency chart's metric.
			queueLatencyMs: runsDelta > 0 ? queueDelta / runsDelta : 0,
		};
	}
}
