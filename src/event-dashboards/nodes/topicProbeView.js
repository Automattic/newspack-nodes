import { Node } from '../../runtime/node';
import { TIMESTAMP, VALUE } from '../../runtime/message';
import {
	SOURCE,
	READER,
	DISTANCE,
	MSGS,
	END_BYTES,
} from '../../runtime/probe-record';

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
// stopped/renamed worker stops appending, so its reader would otherwise linger
// forever. Generous vs the 15s sweep so a brief gap never evicts a live one;
// measured against arrival time (Date.now()), NOT the record's ts, so a 24h
// replay (all records old) never self-evicts mid-stream.
const CONSUMER_TTL_MS = 300000; // 5 min

/**
 * `topicprobe:view` — owns the TopicProbe stream view model.
 *
 * Each inbound frame is one Consumer's lean POSITIONAL probe record (the
 * `Probe_Record` layout); the snapshot instant is the Message TIMESTAMP. The
 * view accumulates, PER `READER`, a bounded series of `{ ts, rate, backlog }`:
 * `backlog` is the record's DISTANCE verbatim; `rate` is messages/sec DERIVED
 * from consecutive records (Δ MSGS / Δ ts) — the only data source is the probe
 * stream, never a live value. A counter reset (worker restart) or the first
 * sample yields rate 0, never negative.
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
		// reader → { source, series:[{ts,rate,backlog}], _lastMsgs, _lastTs, _lastSeen }.
		this.consumers = {};
		this._lastPublish = 0;
		this._flushTimer = null;
		this._lastFill = 0;
	}

	fill( message ) {
		// Terminal node (no sink) — count here so the overlay's per-node
		// throughput stays honest.
		this.counter += 1;

		const value = message[ VALUE ];
		if ( ! Array.isArray( value ) ) {
			return; // not a positional probe record — ignore.
		}
		const reader = value[ READER ];
		if ( 'string' !== typeof reader || '' === reader ) {
			return;
		}

		const now = Date.now();
		// A gap larger than the eviction window means the stream was closed/hidden
		// (Overview tab backgrounded) — NOT consumers dying. Re-baseline every lease
		// so the outage doesn't count against anyone, then evict on fresh time.
		if ( this._lastFill && now - this._lastFill > this.ttlMs ) {
			for ( const c of Object.values( this.consumers ) ) {
				c._lastSeen = now;
			}
		}
		this._lastFill = now;

		this._accumulate( reader, value, Number( message[ TIMESTAMP ] ) || 0 );
		this._evictStale();
		this._maybePublish();
	}

	_accumulate( reader, value, ts ) {
		let c = this.consumers[ reader ];
		if ( ! c ) {
			c = {
				source: '',
				series: [],
				_lastMsgs: null,
				_lastEndBytes: null,
				_lastTs: 0,
				_lastSeen: 0,
			};
			this.consumers[ reader ] = c;
		}
		c._lastSeen = Date.now();
		c.source = String( value[ SOURCE ] ?? c.source );

		const msgs = Number( value[ MSGS ] ) || 0;
		const endBytes = Number( value[ END_BYTES ] ) || 0;
		const backlog = Number( value[ DISTANCE ] ) || 0;
		// msgRate (messages/sec) + byteRate (bytes/sec) derived from consecutive
		// probe records (Δ / Δ ts) — each replayed record IS a distinct 15s sweep,
		// so the gap is the real probe interval. First sample, or a counter reset
		// (worker restart drops msgs / segment GC drops end_bytes) → 0, never negative.
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

		c.series.push( { ts, msgRate, byteRate, backlog } );
		if ( c.series.length > this.maxSamples ) {
			c.series.shift();
		}
	}

	// Drop consumers whose last frame is older than the TTL (stopped/renamed
	// workers) so neither this.consumers nor the published model grows without
	// bound. O(consumers) — trivially small.
	_evictStale() {
		const cutoff = Date.now() - this.ttlMs;
		for ( const [ reader, c ] of Object.entries( this.consumers ) ) {
			if ( c._lastSeen < cutoff ) {
				delete this.consumers[ reader ];
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
	 * Per-consumer view: source identity + the latest sample + the series.
	 *
	 * @return {Object<string,{source:string,
	 *   latest:{ts:number,msgRate:number,byteRate:number,backlog:number},
	 *   series:Array<{ts:number,msgRate:number,byteRate:number,backlog:number}>}>}
	 *   Each active consumer's source + latest sample + its bounded sample series.
	 */
	snapshot() {
		const out = {};
		for ( const [ reader, c ] of Object.entries( this.consumers ) ) {
			const latest = c.series[ c.series.length - 1 ] || {
				ts: 0,
				msgRate: 0,
				byteRate: 0,
				backlog: 0,
			};
			out[ reader ] = {
				source: c.source,
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
