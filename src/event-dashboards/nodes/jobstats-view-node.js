/**
 * JobstatsViewNode — the job-throughput stream. See ProbeStreamViewNode for
 * the buckets, the retention window and the record decoding it shares.
 */

import * as Job from '../../runtime/jobstats-record';
import { ProbeStreamViewNode, bucketTotals } from './probe-stream-view-node';

/** The fields `_windowedTotals` sums over the retained buckets. */
const TOTALED = [
	'runsDelta',
	'errorsDelta',
	'itemsOkDelta',
	'itemsErrDelta',
	'durationDelta',
	'queueDelta',
	'maxDurationMs',
];

/**
 * `jobstats:view` — owns the Jobstats stream view model.
 *
 * Each inbound frame is one job identity's lean POSITIONAL record (the
 * `Jobstats_Record` layout), and the snapshot instant is the Message TIMESTAMP.
 * Per identity the view folds one sample into its bucket, carrying that
 * record's raw deltas, which the table sums into windowed totals and the
 * charts divide into rates and latencies. Every value is read off THAT record
 * and nothing is differenced across records, so a worker recycle is another
 * window rather than a counter reset the reader has to detect.
 *
 * The windowed rollup — runs, failures, items, mean and longest duration and
 * mean queue wait — is summed over the retained buckets in `_entryView`, so it
 * shrinks as the base prunes buckets out of the live window. Last-run detail
 * comes from the record naming the newest run, so a worker whose frame
 * arrives late cannot replace a newer run with an older one.
 *
 * @param {number} [ttlMs] Identity liveness TTL.
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
	 * the buckets the charts plot.
	 *
	 * @param {Object} c The internal entry (its buckets plus the last-run detail).
	 * @return {Object} { key, handler, windowed, latest, buckets }.
	 */
	_entryView( c ) {
		const buckets = this._buckets( c );
		return {
			key: c.key,
			handler: c.handler,
			// Windowed rollup (Runs/Failures/Avg) — the retained-window truth.
			windowed: this._windowedTotals( buckets ),
			latest: {
				lastTs: c.lastTs,
				lastDurationMs: c.lastDurationMs,
				lastStatus: c.lastStatus,
				lastMessage: c.lastMessage,
			},
			buckets,
		};
	}

	/**
	 * Sum the retained buckets' deltas into the rollup the table renders: the
	 * run, failure and item totals, the longest run, plus a mean run duration
	 * and a mean queue wait, each the summed milliseconds over the summed runs.
	 * All three are null for a window with no runs, which has none to show.
	 *
	 * Derived on every snapshot rather than running-summed, so the base's prune
	 * (which deletes aged-out buckets from each row) shrinks these totals for
	 * free, with no eviction bookkeeping to keep in step.
	 *
	 * @param {Array<import('./probe-stream-view-node').Bucket>} buckets The identity's buckets.
	 * @return {Object} { runs, errors, itemsOk, itemsErr, avgDurationMs, maxDurationMs, avgQueueMs }.
	 */
	_windowedTotals( buckets ) {
		const t = bucketTotals( buckets, TOTALED );
		const runs = t.runsDelta.sum;
		return {
			runs,
			errors: t.errorsDelta.sum,
			itemsOk: t.itemsOkDelta.sum,
			itemsErr: t.itemsErrDelta.sum,
			avgDurationMs: runs > 0 ? t.durationDelta.sum / runs : null,
			maxDurationMs: runs > 0 ? t.maxDurationMs.max : null,
			avgQueueMs: runs > 0 ? t.queueDelta.sum / runs : null,
		};
	}

	/**
	 * Fold one jobstats record into its identity's entry and yield its sample.
	 *
	 * Every value is read off THIS record: its deltas (clamped non-negative) are
	 * what the table sums and the charts divide, and `elapsed` is the interval
	 * they cover. The last-run detail rides on the entry, replaced only by a
	 * run at least as new as the one it holds.
	 *
	 * @param {Object}               c      The identity's entry, keyed by `IDENTITY`.
	 * @param {Array<string|number>} value  The positional `Jobstats_Record` VALUE.
	 * @param {number}               ts     Snapshot instant (epoch seconds) from TIMESTAMP.
	 * @param {string}               worker The worker that swept it, or `''`.
	 * @return {Object} The sample its bucket tallies.
	 */
	_fold( c, value, ts, worker ) {
		c.handler = String( value[ Job.HANDLER ] ?? c.handler ?? '' );

		// Last run: the newest any worker reported, not the newest frame.
		const lastTs = Number( value[ Job.LAST_TS ] ) || 0;
		if ( lastTs >= ( c.lastTs ?? 0 ) ) {
			c.lastTs = lastTs;
			c.lastDurationMs = Number( value[ Job.LAST_DURATION_MS ] ) || 0;
			c.lastStatus = String( value[ Job.LAST_STATUS ] || '' );
			c.lastMessage = String( value[ Job.LAST_MESSAGE ] || '' );
		}

		return {
			ts,
			worker,
			elapsed: this._delta( value[ Job.ELAPSED_MS ] ) / 1000,
			runsDelta: this._delta( value[ Job.RUNS_DELTA ] ),
			errorsDelta: this._delta( value[ Job.ERRORS_DELTA ] ),
			itemsOkDelta: this._delta( value[ Job.ITEMS_OK_DELTA ] ),
			queueDelta: this._delta( value[ Job.QUEUE_MS_DELTA ] ),
			itemsErrDelta: this._delta( value[ Job.ITEMS_ERR_DELTA ] ),
			durationDelta: this._delta( value[ Job.DURATION_MS_DELTA ] ),
			maxDurationMs: this._delta( value[ Job.MAX_DURATION_MS ] ),
		};
	}
}
