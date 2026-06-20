import { Node } from '../../runtime/node';
import { VALUE } from '../../runtime/message';

// 24h of probe records at the 15s sweep cadence ≈ 5760 samples per consumer.
const MAX_SAMPLES = 5760;
// Throttle the React-facing publish: a 'start' replay delivers thousands of
// records in a burst, so publishing per record would thrash. Each frame is a
// separate EventSource callback (wall-clock advances between them), so a
// time-throttle collapses a replay burst to a handful of publishes. It is
// leading-edge WITH a trailing flush so a burst's final sample (the newest —
// what 'history' is for) always lands, instead of waiting for the next live
// record ~15s later.
const PUBLISH_THROTTLE_MS = 500;
// Drop a consumer not seen (a fresh frame) within this wall-clock window — a
// stopped/renamed worker stops appending, so its offset_dir would otherwise
// linger forever. Generous vs the 15s sweep so a brief gap never evicts a live
// one; measured against arrival time (Date.now()), NOT the record's `ts`, so a
// 24h replay (all records old) never self-evicts mid-stream.
const CONSUMER_TTL_MS = 300000; // 5 min

/**
 * `topicprobe:view` — owns the TopicProbe stream view model.
 *
 * Each inbound frame is one Consumer's probe record (`Consumer_Node::probe_stats()`
 * shape: `{ ts, consumer, offset_dir, source, worker_type, bytes_read,
 * bytes_behind, … }`). The view accumulates, PER `offset_dir`, a bounded series
 * of `{ ts, rate, backlog }`:
 *
 *  - **rate** (bytes/sec) = Δ`bytes_read` / Δ`ts` against the previous sample.
 *    `bytes_read` is per-PROCESS-monotonic, so a worker restart resets it below
 *    the prior value — a negative delta is a counter reset, reported as rate 0
 *    (not a negative spike). The first sample has no prior, so rate 0.
 *  - **backlog** = the record's `bytes_behind` (already exact, off the probe).
 *
 * High-frequency note (mirrors `rawLogsView`): accumulation is O(1) per record
 * and does NOT publish; `setState('view', …)` is time-throttled so a 24h replay
 * burst doesn't thrash React. The series is ring-capped at `MAX_SAMPLES`.
 *
 * @param {number} [maxSamples] Per-consumer ring cap (defaults to MAX_SAMPLES).
 * @param {number} [ttlMs]      Consumer liveness TTL (defaults to CONSUMER_TTL_MS).
 */
export class TopicProbeViewNode extends Node {
	constructor( maxSamples, ttlMs ) {
		super();
		this.maxSamples = maxSamples || MAX_SAMPLES;
		this.ttlMs = ttlMs || CONSUMER_TTL_MS;
		// offset_dir → { worker_type, source, consumer, series:[{ts,rate,backlog}],
		// _lastBytesRead, _lastTs, _lastSeen }.
		this.consumers = {};
		this._lastPublish = 0;
		this._flushTimer = null;
	}

	fill( message ) {
		// Terminal node (no sink) — count here so the overlay's per-node
		// throughput stays honest.
		this.counter += 1;

		const value = message[ VALUE ];
		const offsetDir =
			value && 'object' === typeof value ? value.offset_dir : undefined;
		if ( 'string' !== typeof offsetDir || '' === offsetDir ) {
			return; // not a probe record (or a control/typeless frame) — ignore.
		}

		this._accumulate( offsetDir, value );
		this._evictStale();
		this._maybePublish();
	}

	_accumulate( offsetDir, value ) {
		let c = this.consumers[ offsetDir ];
		if ( ! c ) {
			c = {
				worker_type: '',
				source: '',
				consumer: '',
				series: [],
				_lastBytesRead: null,
				_lastTs: null,
				_lastSeen: 0,
			};
			this.consumers[ offsetDir ] = c;
		}
		c._lastSeen = Date.now();
		c.worker_type = String( value.worker_type ?? c.worker_type );
		c.source = String( value.source ?? c.source );
		c.consumer = String( value.consumer ?? c.consumer );

		const ts = Number( value.ts ) || 0;
		const bytesRead = Number( value.bytes_read ) || 0;
		const backlog = Number( value.bytes_behind ) || 0;

		// rate = Δbytes / Δt; a counter reset (bytes_read dropped on restart) or a
		// non-advancing clock yields 0, never a negative or infinite spike.
		let rate = 0;
		if (
			null !== c._lastBytesRead &&
			bytesRead >= c._lastBytesRead &&
			ts > c._lastTs
		) {
			rate = ( bytesRead - c._lastBytesRead ) / ( ts - c._lastTs );
		}
		c._lastBytesRead = bytesRead;
		c._lastTs = ts;

		c.series.push( { ts, rate, backlog } );
		if ( c.series.length > this.maxSamples ) {
			c.series.shift();
		}
	}

	// Drop consumers whose last frame is older than the TTL (stopped/renamed
	// workers) so neither this.consumers nor the published model grows without
	// bound. O(consumers) — trivially small.
	_evictStale() {
		const cutoff = Date.now() - this.ttlMs;
		for ( const [ offsetDir, c ] of Object.entries( this.consumers ) ) {
			if ( c._lastSeen < cutoff ) {
				delete this.consumers[ offsetDir ];
			}
		}
	}

	// Leading-edge throttle WITH a trailing flush: publish immediately when the
	// window has elapsed, else schedule one flush at the window's end so a burst's
	// newest sample is never swallowed (a replay's final point, or records 2..N of
	// a live sweep that all arrive within one window).
	_maybePublish() {
		const now = Date.now();
		if ( now - this._lastPublish < PUBLISH_THROTTLE_MS ) {
			if ( null === this._flushTimer ) {
				const wait = PUBLISH_THROTTLE_MS - ( now - this._lastPublish );
				this._flushTimer = setTimeout(
					() => this._publishNow(),
					Math.max( 0, wait )
				);
			}
			return;
		}
		this._publishNow();
	}

	_publishNow() {
		if ( null !== this._flushTimer ) {
			clearTimeout( this._flushTimer );
			this._flushTimer = null;
		}
		this._lastPublish = Date.now();
		this.setState( 'view', { consumers: this.snapshot() } );
	}

	/**
	 * Per-consumer view: identity + the latest rate/backlog + the bounded series.
	 *
	 * @return {Object<string,{worker_type:string,source:string,consumer:string,
	 *   latest:{ts:number,rate:number,backlog:number},
	 *   series:Array<{ts:number,rate:number,backlog:number}>}>} Each active
	 *   consumer's identity + latest rate/backlog + its bounded sample series.
	 */
	snapshot() {
		const out = {};
		for ( const [ offsetDir, c ] of Object.entries( this.consumers ) ) {
			const latest = c.series[ c.series.length - 1 ] || {
				ts: 0,
				rate: 0,
				backlog: 0,
			};
			out[ offsetDir ] = {
				worker_type: c.worker_type,
				source: c.source,
				consumer: c.consumer,
				// Copies, not the live mutating refs: each publish must hand React
				// a fresh identity (push/shift mutate c.series in place, so a shared
				// ref would freeze memoized consumers + tear mid-burst).
				latest: { ...latest },
				series: c.series.slice(),
			};
		}
		return out;
	}

	// Cancel a pending trailing flush so no setState fires after teardown.
	removeNode() {
		if ( null !== this._flushTimer ) {
			clearTimeout( this._flushTimer );
			this._flushTimer = null;
		}
		super.removeNode();
	}

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
