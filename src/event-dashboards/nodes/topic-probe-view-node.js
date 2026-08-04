import { ProbeStreamViewNode } from './probe-stream-view-node';
import {
	SOURCE,
	READER,
	DISTANCE,
	MSGS,
	END_BYTES,
	CACHE_SIZE,
} from '../../runtime/probe-record';

/**
 * `topicprobe:view` — owns the TopicProbe stream view model.
 *
 * Each inbound frame is one Consumer's lean POSITIONAL probe record (the
 * `Probe_Record` layout); the snapshot instant is the Message TIMESTAMP. The view
 * accumulates, PER `READER`, a bounded series of `{ ts, msgRate, byteRate, backlog,
 * cacheSize }`: `backlog` is the record's DISTANCE verbatim; `msgRate`/`byteRate`
 * are DERIVED from consecutive records (Δ MSGS|END_BYTES / Δ ts) — the only data
 * source is the probe stream, never a live value. A counter reset (worker restart)
 * or the first sample yields rate 0, never negative.
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
	 * Fold one probe record into its consumer's entry and push a derived sample.
	 *
	 * `backlog` and `cacheSize` are the record's DISTANCE and CACHE_SIZE verbatim;
	 * `msgRate`/`byteRate` are derived against the prior record (Δ MSGS|END_BYTES over
	 * Δts). A counter reset (worker restart) or the first sample yields rate 0, never
	 * negative. A record older than the live window is dropped; an unseen reader gets
	 * a fresh entry.
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
			c = {
				source: '',
				series: [],
				_lastMsgs: null,
				_lastEndBytes: null,
				_lastTs: 0,
				_lastSeen: 0,
			};
			this.entries[ reader ] = c;
		}
		c._lastSeen = Date.now();
		c.source = String( value[ SOURCE ] ?? c.source );

		const msgs = Number( value[ MSGS ] ) || 0;
		const endBytes = Number( value[ END_BYTES ] ) || 0;
		const backlog = Number( value[ DISTANCE ] ) || 0;
		const cacheSize = Number( value[ CACHE_SIZE ] ) || 0;
		// msgRate/byteRate from consecutive records (Δ/Δts); reset → 0.
		const dt = ts > c._lastTs ? ts - c._lastTs : 0;
		const msgRate =
			null !== c._lastMsgs && dt > 0 && msgs >= c._lastMsgs
				? ( msgs - c._lastMsgs ) / dt
				: 0;
		const byteRate =
			null !== c._lastEndBytes && dt > 0 && endBytes >= c._lastEndBytes
				? ( endBytes - c._lastEndBytes ) / dt
				: 0;
		c._lastMsgs = msgs;
		c._lastEndBytes = endBytes;
		c._lastTs = ts;

		c.series.push( { ts, msgRate, byteRate, backlog, cacheSize } );
		this._capSeries( c.series );
	}

	/**
	 * The published per-consumer snapshot: the source partition, a copy of the newest
	 * derived sample, and a copy of the series the charts plot.
	 *
	 * @param {Object} c The internal entry (series plus its `_last*` fold state).
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
				'TopicProbe stream render-model sink (the React view node).',
			has_target: false,
			arguments: [],
			commands: [],
		};
	}
}
