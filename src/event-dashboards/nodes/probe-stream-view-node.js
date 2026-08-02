import { Node } from '../../runtime/node';
import { TIMESTAMP, VALUE } from '../../runtime/message';

// Fixed 24h live window; older records dropped/pruned. Seconds (epoch).
const RETENTION_S = 86400;
// Per-key ring cap ABOVE the 24h window (N+1=5761); prune is the real boundary.
const MAX_SAMPLES = RETENTION_S / 15 + 1; // 5761
// Throttle publish (replay bursts thrash): leading-edge + trailing flush.
const PUBLISH_THROTTLE_MS = 500;
// Evict a key unseen this long; measured by arrival, not record ts.
const ENTRY_TTL_MS = 300000; // 5 min

/**
 * Shared base for the durable-probe stream view nodes (TopicProbe + Jobstats).
 *
 * Owns the ring/throttle/TTL/eviction/prune machinery a probe stream needs so the
 * subclasses supply ONLY their field mapping: `_identityOf(value)` (which slot is
 * the per-key id), `_accumulate(key, value, ts)` (fold one record into an entry +
 * push a derived sample), `_entryView(entry)` (the per-key snapshot object), and
 * `modelKey` (the published model's wrapper key). Everything is O(1) per record and
 * does NOT publish; setState('view', …) is time-throttled so a 24h replay burst
 * doesn't thrash React. The series is bounded two ways: a hard ring cap at
 * `maxSamples`, and the live 24h window (records older than RETENTION_S are dropped
 * on arrival and pruned as wall-clock advances past them).
 *
 * @param {number} [maxSamples] Per-key ring cap (defaults to MAX_SAMPLES).
 * @param {number} [ttlMs]      Per-key liveness TTL (defaults to ENTRY_TTL_MS).
 */
export class ProbeStreamViewNode extends Node {
	// View-model/infra node: never a user-added node (see useGraphReset).
	static isSystemNode = true;
	constructor( maxSamples, ttlMs ) {
		super();
		this.maxSamples = maxSamples || MAX_SAMPLES;
		this.ttlMs = ttlMs || ENTRY_TTL_MS;
		// key → subclass-shaped entry (always carries series + _lastSeen).
		this.entries = {};
		this.modelKey = 'entries';
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
		const key = this._identityOf( value );
		if ( 'string' !== typeof key || '' === key ) {
			return;
		}

		const now = Date.now();
		// Big gap = stream hidden, not dying: shift leases by the outage.
		if ( this._lastFill && now - this._lastFill > this.ttlMs ) {
			const outage = now - this._lastFill;
			for ( const c of Object.values( this.entries ) ) {
				c._lastSeen += outage;
			}
		}
		this._lastFill = now;

		this._accumulate( key, value, Number( message[ TIMESTAMP ] ) || 0 );
		this._evictStale();
		this._maybePublish();
	}

	// Drop keys whose last frame is older than the TTL (stopped/renamed).
	_evictStale() {
		const cutoff = Date.now() - this.ttlMs;
		for ( const [ key, c ] of Object.entries( this.entries ) ) {
			if ( c._lastSeen < cutoff ) {
				delete this.entries[ key ];
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
		this.setState( 'view', { [ this.modelKey ]: this.snapshot() } );
	}

	// Drop samples aged out of the 24h window; every publish, all keys.
	_pruneExpired( now ) {
		const cutoff = now / 1000 - RETENTION_S;
		for ( const c of Object.values( this.entries ) ) {
			while ( c.series.length > 0 && c.series[ 0 ].ts < cutoff ) {
				c.series.shift();
			}
		}
	}

	// Per-key view via the subclass; fully-aged-out keys are skipped.
	snapshot() {
		const out = {};
		for ( const [ key, c ] of Object.entries( this.entries ) ) {
			if ( 0 === c.series.length ) {
				continue;
			}
			out[ key ] = this._entryView( c );
		}
		return out;
	}

	// A record older than the live window (the replay tail is longer than 24h).
	_isExpired( ts ) {
		return ts < Date.now() / 1000 - RETENTION_S;
	}

	// Ring-cap a per-key series in place after a push.
	_capSeries( series ) {
		if ( series.length > this.maxSamples ) {
			series.shift();
		}
	}

	// Cancel a pending trailing flush so no setState fires after teardown.
	removeNode() {
		if ( null !== this._flushTimer ) {
			clearTimeout( this._flushTimer );
			this._flushTimer = null;
		}
		super.removeNode();
	}
}
