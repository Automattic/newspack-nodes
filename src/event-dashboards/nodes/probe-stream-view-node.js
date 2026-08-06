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
 * The field mapping every concrete probe-stream view node supplies.
 *
 * The base owns the ring, the throttle, the TTL and the prune; a subclass owns
 * only which slot of a record carries the per-key identity, how one record
 * folds into that key's entry, and what the published per-key snapshot is.
 *
 * @typedef  {Object} ProbeStreamMapping
 * @property {( value: Array<string|number> ) => string|number}                 _identityOf Reads the per-key identity out of a positional record.
 * @property {( key: string, value: Array<string|number>, ts: number ) => void} _accumulate Folds one record into that key's entry and pushes a derived sample.
 * @property {( entry: Object ) => Object}                                      _entryView  Builds the published snapshot for one key's entry.
 */

/**
 * A concrete probe-stream view node: this base plus a subclass's field mapping.
 *
 * @typedef {ProbeStreamViewNode & ProbeStreamMapping} ProbeStreamSubclass
 */

/**
 * Shared base for the durable-probe stream view nodes (Topic_Probe + Jobstats).
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

	/**
	 * Sizes the per-key ring and the liveness TTL, and starts with no entries.
	 *
	 * A subclass overrides `modelKey` after `super()` to name the wrapper key
	 * its published model uses.
	 *
	 * @param {number} [maxSamples] Per-key ring cap; MAX_SAMPLES when omitted.
	 * @param {number} [ttlMs]      Per-key liveness TTL in ms; ENTRY_TTL_MS when omitted.
	 */
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

	/**
	 * Fold one probe record into its key's entry, then evict stale keys and
	 * publish (throttled).
	 *
	 * Anything that is not a positional record, or whose identity slot is not a
	 * non-empty string, is ignored. A gap longer than the TTL means the stream
	 * was hidden rather than every producer dying, so each entry's lease shifts
	 * forward by the outage instead of the whole model evicting on this frame.
	 *
	 * @this {ProbeStreamSubclass}
	 * @param {Array} message The 7-field positional message; VALUE is the
	 *                        subclass's positional probe record.
	 * @return {void}
	 */
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

	/**
	 * Drop keys whose last frame is older than the TTL — a stopped or renamed
	 * producer, measured by arrival rather than by record timestamp so a replay
	 * burst never evicts.
	 *
	 * @return {void}
	 */
	_evictStale() {
		const cutoff = Date.now() - this.ttlMs;
		for ( const [ key, c ] of Object.entries( this.entries ) ) {
			if ( c._lastSeen < cutoff ) {
				delete this.entries[ key ];
			}
		}
	}

	/**
	 * Publish now if the throttle window has elapsed, otherwise arm a single
	 * trailing flush so a burst's newest sample still reaches React.
	 *
	 * @this {ProbeStreamSubclass}
	 * @return {void}
	 */
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

	/**
	 * Cancel any pending flush, prune the aged-out tail, and push the snapshot
	 * under `modelKey` as the `view` state. The one place that calls setState.
	 *
	 * @this {ProbeStreamSubclass}
	 * @return {void}
	 */
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

	/**
	 * Shift samples that have aged out of the 24h window off the front of every
	 * key's series. Runs on each publish, so windowed totals derived from the
	 * series shrink for free as wall-clock advances.
	 *
	 * @param {number} now Publish instant in epoch MILLIseconds; sample
	 *                     timestamps are seconds.
	 * @return {void}
	 */
	_pruneExpired( now ) {
		const cutoff = now / 1000 - RETENTION_S;
		for ( const c of Object.values( this.entries ) ) {
			while ( c.series.length > 0 && c.series[ 0 ].ts < cutoff ) {
				c.series.shift();
			}
		}
	}

	/**
	 * The published model: one subclass-shaped view per key. A key whose series
	 * has fully aged out is skipped rather than published empty.
	 *
	 * @this {ProbeStreamSubclass}
	 * @return {Object} Key to the subclass's per-key snapshot object.
	 */
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

	/**
	 * Whether a record predates the live 24h window. The durable replay tail is
	 * longer than the window, so a subclass drops these on arrival rather than
	 * folding them in and waiting for the prune.
	 *
	 * @param {number} ts Record instant in epoch SECONDS.
	 * @return {boolean} True when the record is older than the window.
	 */
	_isExpired( ts ) {
		return ts < Date.now() / 1000 - RETENTION_S;
	}

	/**
	 * One record slot as a non-negative number. A probe record carries the work
	 * done in its OWN window, so the only way to see a negative is a corrupt
	 * frame; the clamp keeps one from subtracting out of a windowed total.
	 *
	 * @param {string|number|undefined} raw The positional slot's value.
	 * @return {number} The clamped delta.
	 */
	_delta( raw ) {
		return Math.max( 0, Number( raw ) || 0 );
	}

	/**
	 * Enforce the ring cap in place, right after a subclass pushes a sample.
	 * The cap sits above the 24h window, so the prune is the real boundary and
	 * this only bounds memory when records arrive faster than expected.
	 *
	 * @param {Array<Object>} series One key's sample ring, mutated in place.
	 * @return {void}
	 */
	_capSeries( series ) {
		if ( series.length > this.maxSamples ) {
			series.shift();
		}
	}

	/**
	 * Cancel a pending trailing flush before teardown, so no setState fires
	 * into an unmounted tree, then hand off to the base.
	 *
	 * @return {void}
	 */
	removeNode() {
		if ( null !== this._flushTimer ) {
			clearTimeout( this._flushTimer );
			this._flushTimer = null;
		}
		super.removeNode();
	}
}
