import { Node } from '../../runtime/node';
import { TIMESTAMP, VALUE } from '../../runtime/message';
import {
	SOURCE,
	READER,
	DISTANCE,
	MSGS,
	END_BYTES,
	CACHE_SIZE,
} from '../../runtime/probe-record';

// The chart is a fixed 24h live window: records older than this are dropped on
// arrival and existing samples are pruned as wall-clock advances past them, so
// the axis never widens beyond 24h (the durable topicprobe log replays further
// back than the chart shows). Seconds — probe ts is epoch seconds.
const RETENTION_S = 86400;
// Per-consumer ring cap — a hard memory ceiling held ABOVE the 24h window so the
// wall-clock prune (_pruneExpired), not the ring, is the boundary authority. A
// 24h span at the 15s sweep cadence is 5760 intervals = 5761 samples (N intervals
// need N+1 points); capping at exactly 5760 would evict the boundary sample ~15s
// early. A faster-than-15s flood still hits the ceiling and caps memory.
const MAX_SAMPLES = RETENTION_S / 15 + 1; // 5761
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
 * burst doesn't thrash React. The series is bounded two ways: a hard ring cap at
 * `MAX_SAMPLES`, and the live 24h window — records older than `RETENTION_S` are
 * dropped on arrival and existing samples are pruned as wall-clock advances past
 * them, so the chart axis never widens beyond 24h.
 *
 * @param {number} [maxSamples] Per-consumer ring cap (defaults to MAX_SAMPLES).
 * @param {number} [ttlMs]      Consumer liveness TTL (defaults to CONSUMER_TTL_MS).
 */
export class TopicProbeViewNode extends Node {
	// View-model/infra node: never a user-added node (see useGraphReset).
	static isSystemNode = true;
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
		// (Overview tab backgrounded) — NOT consumers dying. SHIFT every lease forward
		// by the outage so the burst doesn't wipe consumers that resume in it, WITHOUT
		// granting a fresh full TTL: a consumer already silent before the outage keeps
		// its real remaining lease and still evicts on schedule. The resumed ones get a
		// fresh `now` lease as their frames land in _accumulate.
		if ( this._lastFill && now - this._lastFill > this.ttlMs ) {
			const outage = now - this._lastFill;
			for ( const c of Object.values( this.consumers ) ) {
				c._lastSeen += outage;
			}
		}
		this._lastFill = now;

		this._accumulate( reader, value, Number( message[ TIMESTAMP ] ) || 0 );
		this._evictStale();
		this._maybePublish();
	}

	_accumulate( reader, value, ts ) {
		// Drop a record already older than the live window — the replay tail
		// reaches past 24h, and a stale sample is not plottable on a 24h axis.
		if ( ts < Date.now() / 1000 - RETENTION_S ) {
			return;
		}
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
		const cacheSize = Number( value[ CACHE_SIZE ] ) || 0;
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

		c.series.push( { ts, msgRate, byteRate, backlog, cacheSize } );
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
		const now = Date.now();
		this._lastPublish = now;
		this._pruneExpired( now );
		this.setState( 'view', { consumers: this.snapshot() } );
	}

	// Drop samples that have aged out of the 24h window. The chart is live, so a
	// sample crosses the horizon by wall-clock TIME — not only when a newer record
	// for its consumer arrives — so this runs at every publish (the single choke
	// point for what React renders), across ALL consumers, not just the last one
	// touched. O(expired) amortized: each sample is shifted at most once.
	_pruneExpired( now ) {
		const cutoff = now / 1000 - RETENTION_S;
		for ( const c of Object.values( this.consumers ) ) {
			while ( c.series.length > 0 && c.series[ 0 ].ts < cutoff ) {
				c.series.shift();
			}
		}
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
			if ( 0 === c.series.length ) {
				continue; // fully aged out of the window — nothing to plot.
			}
			const latest = c.series[ c.series.length - 1 ];
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
