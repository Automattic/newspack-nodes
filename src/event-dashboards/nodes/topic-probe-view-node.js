/**
 * TopicProbeViewNode — the per-consumer throughput and backlog stream behind the
 * Overview's Topics panels and summary cards. See ProbeStreamViewNode for the
 * ring, the retention window and the eviction it shares.
 */

import * as Probe from '../../runtime/probe-record';
import { ProbeStreamViewNode } from './probe-stream-view-node';

/**
 * `topicprobe:view` — owns the Topic_Probe stream view model.
 *
 * Each inbound frame is one Consumer's lean POSITIONAL probe record (the
 * `Probe_Record` layout), and the snapshot instant is the Message TIMESTAMP. Per
 * reader the view pushes one sample onto a bounded series of
 * `{ ts, elapsed, msgs, bytes, msgRate, byteRate, backlog, cacheSize }`: the raw
 * deltas `probe24hTotals` integrates into the 24h cards, beside the rates and
 * levels `topicChartSeries` plots. Every value is read off THAT record and
 * nothing is differenced across records, so a worker recycle is another window
 * rather than a counter reset the reader has to detect.
 *
 * @param {number} [maxSamples] Per-consumer ring cap.
 * @param {number} [ttlMs]      Consumer liveness TTL.
 */
export class TopicProbeViewNode extends ProbeStreamViewNode {
	/**
	 * Record slot the base keys entries by: the reader id, which is the basename
	 * of the consumer's offsetlog directory.
	 */
	identitySlot = Probe.READER;

	/**
	 * Wrapper key the published model uses, so React reads `view.consumers`.
	 */
	modelKey = 'consumers';

	/**
	 * What `nodeSchema()` reports to the console palette and to `help`.
	 */
	static description =
		'Topic_Probe stream render-model sink (the React view node).';

	/**
	 * Fold one probe record into its consumer's entry and yield its sample.
	 *
	 * Every field is read off THIS record: `msgs`/`bytes` are its deltas (clamped
	 * non-negative), `elapsed` the seconds they cover, the rates their quotient —
	 * 0 when the window is empty rather than a division by zero — and `backlog`
	 * and `cacheSize` its levels verbatim. The source partition rides on the entry
	 * rather than the sample, because it names the topic every one of that
	 * reader's samples came from.
	 *
	 * @param {Object}               c     The consumer's entry, keyed by `READER`.
	 * @param {Array<string|number>} value The positional `Probe_Record` VALUE.
	 * @param {number}               ts    Snapshot instant (epoch seconds) from TIMESTAMP.
	 * @return {Object} The sample to push onto the entry's series.
	 */
	_fold( c, value, ts ) {
		c.source = String( value[ Probe.SOURCE ] ?? c.source ?? '' );

		const msgs = this._delta( value[ Probe.MSGS_DELTA ] );
		const bytes = this._delta( value[ Probe.BYTES_READ_DELTA ] );
		const elapsed = this._delta( value[ Probe.ELAPSED_MS ] ) / 1000;
		return {
			ts,
			elapsed,
			msgs,
			bytes,
			msgRate: elapsed > 0 ? msgs / elapsed : 0,
			byteRate: elapsed > 0 ? bytes / elapsed : 0,
			backlog: Number( value[ Probe.DISTANCE ] ) || 0,
			cacheSize: Number( value[ Probe.CACHE_SIZE ] ) || 0,
		};
	}

	/**
	 * The published per-consumer snapshot: the source partition, a copy of the newest
	 * sample, and a copy of the series the charts plot.
	 *
	 * @param {Object} c The internal entry (its series plus liveness bookkeeping).
	 * @return {Object} { source, latest, series }.
	 */
	_entryView( c ) {
		const latest = c.series[ c.series.length - 1 ];
		return {
			source: c.source,
			// Copies, not live refs (else memo freezes + tears mid-burst).
			latest: { ...latest },
			series: c.series.slice(),
		};
	}
}
