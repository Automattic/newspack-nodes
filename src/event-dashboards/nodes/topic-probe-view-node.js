/**
 * TopicProbeViewNode — the per-consumer throughput and backlog stream, and the
 * per-partition size stream, behind the Overview's panels and summary cards.
 * See ProbeStreamViewNode for the buckets, the retention window and the
 * eviction it shares.
 */

import * as Probe from '../../runtime/probe-record';
import { ProbeStreamViewNode } from './probe-stream-view-node';

/** The model Partition records publish under, beside `consumers`. */
const PARTITIONS = 'partitions';

/**
 * `topicprobe:view` — owns the Topic_Probe stream view model.
 *
 * Each inbound frame is one lean POSITIONAL probe record (the `Probe_Record`
 * layout), and the snapshot instant is the Message TIMESTAMP. A Consumer
 * record names its reader; a Partition record leaves READER blank and files
 * under `view.partitions` by its SOURCE, one sample `{ ts, worker, endBytes,
 * diskBytes }` a record. Several workers report one directory, each into its
 * own row, and a chart reads the newest of them. Per reader the view folds
 * one sample of `{ ts, worker, elapsed, msgs, bytes, backlog, cacheSize }`
 * into its bucket: the raw deltas `probe24hTotals` sums into the 24h cards
 * and `topicChartSeries` divides into rates, beside the levels it plots. The
 * entry's `latest` adds `msgRate`, which the live card sums.
 * Every value is read off THAT record and nothing is differenced across
 * records, so a worker recycle is another window rather than a counter reset
 * the reader has to detect.
 *
 * @param {number} [ttlMs] Consumer liveness TTL.
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
	 * A Partition record, READER blank, files under `partitions` by its
	 * SOURCE; a Consumer record files under `consumers` by its READER.
	 *
	 * @param {Array<string|number>} value The positional `Probe_Record` VALUE.
	 * @return {?import('./probe-stream-view-node').ProbeIdentity} Its model and key, or null.
	 */
	_identify( value ) {
		if ( '' !== value[ Probe.READER ] ) {
			return super._identify( value );
		}
		const source = value[ Probe.SOURCE ];
		return 'string' === typeof source && '' !== source
			? { model: PARTITIONS, key: source }
			: null;
	}

	/**
	 * The consumers, then the partitions.
	 *
	 * @return {Array<string>} The published model keys.
	 */
	_models() {
		return [ this.modelKey, PARTITIONS ];
	}

	/**
	 * Fold one probe record into its entry, keep its sample as the entry's
	 * `latest`, and yield it; a consumer's `latest` also carries `msgRate`.
	 *
	 * Every field is read off THIS record: `msgs`/`bytes` are its deltas (clamped
	 * non-negative), `elapsed` the seconds they cover, `msgRate` their quotient —
	 * 0 when the window is empty rather than a division by zero — and `backlog`
	 * and `cacheSize` its levels verbatim, a backlog the reader cannot measure
	 * staying null so the charts plot no point for it. A Partition record's sample is its
	 * two sizes, read verbatim. The source rides on the entry rather than
	 * the sample, because it names the log every one of that entry's samples
	 * came from; the worker rides on each sample, so a chart can plot each
	 * worker's stream apart.
	 *
	 * @param {Object}               c      The entry, keyed by `READER` or, for a partition, `SOURCE`.
	 * @param {Array<string|number>} value  The positional `Probe_Record` VALUE.
	 * @param {number}               ts     Snapshot instant (epoch seconds) from TIMESTAMP.
	 * @param {string}               worker The worker that swept it, or `''`.
	 * @param {string}               model  The model the entry files under.
	 * @return {Object} The sample its bucket tallies.
	 */
	_fold( c, value, ts, worker, model ) {
		c.source = String( value[ Probe.SOURCE ] ?? c.source ?? '' );
		if ( PARTITIONS === model ) {
			c.latest = {
				ts,
				worker,
				endBytes: Number( value[ Probe.END_BYTES ] ) || 0,
				diskBytes: Number( value[ Probe.END_DISK_BYTES ] ) || 0,
			};
			return c.latest;
		}

		const msgs = this._delta( value[ Probe.MSGS_DELTA ] );
		const bytes = this._delta( value[ Probe.BYTES_READ_DELTA ] );
		const elapsed = this._delta( value[ Probe.ELAPSED_MS ] ) / 1000;
		const sample = {
			ts,
			worker,
			elapsed,
			msgs,
			bytes,
			// A hub reader cannot see its spoke's end: no point, never 0.
			backlog:
				null === value[ Probe.DISTANCE ]
					? null
					: Number( value[ Probe.DISTANCE ] ) || 0,
			cacheSize: Number( value[ Probe.CACHE_SIZE ] ) || 0,
		};
		c.latest = { ...sample, msgRate: elapsed > 0 ? msgs / elapsed : 0 };
		return sample;
	}

	/**
	 * The published per-key snapshot: the source, the newest sample, which no
	 * fold changes, and the buckets the charts plot.
	 *
	 * @param {Object} c The internal entry (its buckets plus liveness bookkeeping).
	 * @return {Object} { source, latest, buckets }.
	 */
	_entryView( c ) {
		return {
			source: c.source,
			latest: c.latest,
			buckets: this._buckets( c ),
		};
	}
}
