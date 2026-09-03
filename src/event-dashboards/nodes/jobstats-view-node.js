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
 * `Jobstats_Record` layout), and the snapshot instant is the Message TIMESTAMP.
 * Per identity the view pushes one sample onto a bounded series carrying that
 * record's raw deltas — what the table sums into windowed totals — beside the
 * per-second rates the charts plot. Every value is read off THAT record and
 * nothing is differenced across records, so a worker recycle is another window
 * rather than a counter reset the reader has to detect.
 *
 * The windowed rollup — runs, failures, items, mean duration and mean queue
 * wait — is summed over the retained series in `_entryView`, so it shrinks with
 * the series as the base prunes samples out of the live window. Last-run
 * detail comes from the newest record.
 *
 * @param {number} [maxSamples] Per-identity ring cap.
 * @param {number} [ttlMs]      Identity liveness TTL.
 */
export class JobstatsViewNode extends ProbeStreamViewNode {
	/**
	 * Record slot the base keys entries by: `handler:id`, or `handler` when the
	 * job carries no id.
	 */
	identitySlot = Job.IDENTITY;

	/**
	 * Wrapper key the published model uses, so React reads `view.handlers`.
	 */
	modelKey = 'handlers';

	/**
	 * What `nodeSchema()` reports to the console palette and to `help`.
	 */
	static description =
		'Jobstats stream render-model sink (the React view node).';

	/**
	 * The published per-identity snapshot: its identity and handler name, the
	 * windowed rollup the table reads, the newest record's last-run detail, and
	 * a copy of the series the charts plot.
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
	 * Sum the retained series' deltas into the rollup the table renders: the
	 * run, failure and item totals, plus a mean run duration and a mean queue
	 * wait, each the summed milliseconds over the summed runs — 0 for a window
	 * with no runs rather than a division by zero.
	 *
	 * Derived on every snapshot rather than running-summed, so the base's prune
	 * (which shifts aged-out samples off `series`) shrinks these totals for
	 * free, with no eviction bookkeeping to keep in step.
	 *
	 * @param {Array<Object>} series The per-identity ring of samples.
	 * @return {Object} { runs, errors, itemsOk, itemsErr, avgDurationMs, avgQueueMs }.
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
	 * what the table sums, `elapsed` is the interval they cover, and the rates
	 * are their quotient — 0 for an empty window rather than a division by zero.
	 * Queue latency is the exception, dividing by the window's runs rather than
	 * its seconds, because it is a mean wait per run. The last-run detail rides
	 * as the entry's newest values.
	 *
	 * @param {Object}               c     The identity's entry, keyed by `IDENTITY`.
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
