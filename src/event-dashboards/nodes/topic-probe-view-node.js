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

// Fixed 24h live window; older records dropped/pruned. Seconds (epoch).
const RETENTION_S = 86400;
// Per-consumer ring cap ABOVE the 24h window (N+1=5761); prune is boundary.
const MAX_SAMPLES = RETENTION_S / 15 + 1; // 5761
// Throttle publish (replay bursts thrash): leading-edge + trailing flush.
const PUBLISH_THROTTLE_MS = 500;
// Evict a consumer unseen this long; measured by arrival, not record ts.
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
		// reader → { source, series, _lastMsgs, _lastTs, _lastSeen }.
		this.consumers = {};
		this._lastPublish = 0;
		this._flushTimer = null;
		this._lastFill = 0;
	}

	fill( message ) {
		// Terminal node (no sink): count here for the overlay's throughput.
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
		// Big gap = stream hidden, not dying: shift leases by the outage.
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
		// Drop a record older than the live window (replay tail is longer).
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
		if ( c.series.length > this.maxSamples ) {
			c.series.shift();
		}
	}

	// Drop consumers whose last frame is older than the TTL (stopped/renamed).
	_evictStale() {
		const cutoff = Date.now() - this.ttlMs;
		for ( const [ reader, c ] of Object.entries( this.consumers ) ) {
			if ( c._lastSeen < cutoff ) {
				delete this.consumers[ reader ];
			}
		}
	}

	// Leading-edge throttle + trailing flush so a burst's newest sample lands.
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

	// Drop samples aged out of the 24h window; every publish, all consumers.
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
				// Copies, not live refs (else memo freezes + tears mid-burst).
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
