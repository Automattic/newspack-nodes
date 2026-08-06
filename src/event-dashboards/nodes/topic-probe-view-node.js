import { ProbeStreamViewNode } from './probe-stream-view-node';
import {
	SOURCE,
	READER,
	DISTANCE,
	MSGS_DELTA,
	BYTES_READ_DELTA,
	CACHE_SIZE,
	ELAPSED_MS,
} from '../../runtime/probe-record';

/**
 * `topicprobe:view` — owns the Topic_Probe stream view model.
 *
 * Each inbound frame is one Consumer's lean POSITIONAL probe record (the
 * `Probe_Record` layout); the snapshot instant is the Message TIMESTAMP. The view
 * accumulates, PER `READER`, a bounded series of `{ ts, elapsed, msgs, bytes,
 * msgRate, byteRate, backlog, cacheSize }`. Every field comes from ONE record:
 * `msgs`/`bytes` are its deltas, `elapsed` the interval they cover, the rates
 * their quotient, `backlog`/`cacheSize` its levels verbatim. Nothing is
 * differenced across records, so a worker recycle (which used to look like a
 * counter reset) is just another window.
 *
 * The ring/throttle/TTL/eviction machinery lives in ProbeStreamViewNode; this
 * subclass supplies only the READER identity + the msgs/bytes field mapping.
 *
 * @param {number} [maxSamples] Per-consumer ring cap.
 * @param {number} [ttlMs]      Consumer liveness TTL.
 */
export class TopicProbeViewNode extends ProbeStreamViewNode {
	/**
	 * Publishes under the `consumers` model key; the rest is the base's machinery.
	 *
	 * @param {number} [maxSamples] Per-consumer ring cap; base default when omitted.
	 * @param {number} [ttlMs]      Consumer liveness TTL (ms); base default when omitted.
	 */
	constructor( maxSamples, ttlMs ) {
		super( maxSamples, ttlMs );
		this.modelKey = 'consumers';
	}

	/**
	 * The per-entry identity the base folds on: a probe record's `READER` slot,
	 * which is the basename of the consumer's offsetlog dir.
	 *
	 * @param {Array<string|number>} value The positional `Probe_Record` VALUE.
	 * @return {string|number} Consumer reader id.
	 */
	_identityOf( value ) {
		return value[ READER ];
	}

	/**
	 * Fold one probe record into its consumer's entry and push its sample.
	 *
	 * Every field is read off THIS record: `msgs`/`bytes` are its deltas (clamped
	 * non-negative), `elapsed` the seconds they cover, the rates their quotient —
	 * 0 when the window is empty rather than a division by zero — and `backlog`
	 * and `cacheSize` its levels verbatim. A record older than the live window is
	 * dropped; an unseen reader gets a fresh entry.
	 *
	 * @param {string}               reader Consumer reader id, from `_identityOf`.
	 * @param {Array<string|number>} value  The positional `Probe_Record` VALUE.
	 * @param {number}               ts     Snapshot instant (epoch seconds) from TIMESTAMP.
	 * @return {void}
	 */
	_accumulate( reader, value, ts ) {
		if ( this._isExpired( ts ) ) {
			return;
		}
		let c = this.entries[ reader ];
		if ( ! c ) {
			c = { source: '', series: [], _lastSeen: 0 };
			this.entries[ reader ] = c;
		}
		c._lastSeen = Date.now();
		c.source = String( value[ SOURCE ] ?? c.source );

		const msgs = this._delta( value[ MSGS_DELTA ] );
		const bytes = this._delta( value[ BYTES_READ_DELTA ] );
		const elapsed = this._delta( value[ ELAPSED_MS ] ) / 1000;
		c.series.push( {
			ts,
			elapsed,
			msgs,
			bytes,
			msgRate: elapsed > 0 ? msgs / elapsed : 0,
			byteRate: elapsed > 0 ? bytes / elapsed : 0,
			backlog: Number( value[ DISTANCE ] ) || 0,
			cacheSize: Number( value[ CACHE_SIZE ] ) || 0,
		} );
		this._capSeries( c.series );
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
				'Topic_Probe stream render-model sink (the React view node).',
			has_target: false,
			arguments: [],
			commands: [],
		};
	}
}
