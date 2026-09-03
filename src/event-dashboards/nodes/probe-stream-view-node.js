import { Node } from '../../runtime/node';
import { TIMESTAMP, VALUE } from '../../runtime/message';

// Fixed 24h live window, in seconds; an older record is dropped or pruned.
const RETENTION_S = 86400;
// Per-key ring cap above the 24h window at the 15s cadence; prune is the bound.
const MAX_SAMPLES = RETENTION_S / 15 + 1; // 5761
// Throttle publish (a full-replay burst thrashes React): leading + trailing.
const PUBLISH_THROTTLE_MS = 500;
// Evict a key unseen this long; measured by arrival, not record ts.
const ENTRY_TTL_MS = 300000; // 5 min

/**
 * The layout mapping every concrete probe-stream view node supplies.
 *
 * The base owns the whole entry lifecycle — admit, create, touch, push, cap,
 * prune, evict, publish — so a subclass owns only which slot of a record
 * carries the per-key identity, which key the model publishes under, how one
 * record folds into an entry, and what the published per-key snapshot is.
 *
 * @typedef  {Object} ProbeStreamMapping
 * @property {number}                                                               identitySlot Record slot carrying the per-key identity.
 * @property {string}                                                               modelKey     Wrapper key the published model uses.
 * @property {( entry: Object, value: Array<string|number>, ts: number ) => Object} _fold        Folds one record into its entry and returns the sample to push.
 * @property {( entry: Object ) => Object}                                          _entryView   Builds the published snapshot for one key's entry.
 */

/**
 * A concrete probe-stream view node: this base plus a subclass's layout mapping.
 *
 * @typedef {ProbeStreamViewNode & ProbeStreamMapping} ProbeStreamSubclass
 */

/**
 * Shared base for the durable-probe stream view nodes — `TopicProbeViewNode`
 * and `JobstatsViewNode`, each in its own file beside this one.
 *
 * Owns everything a probe stream needs that is not its record layout: the
 * per-key entries, the ring, the throttle, the TTL, the eviction and the prune.
 * A subclass supplies `identitySlot`, `modelKey`, `_fold(entry, value, ts)` and
 * `_entryView(entry)`. Folding a record costs one push and a sweep of the live
 * keys, never a walk of a series; every walk — the prune, the snapshot's
 * per-key copies — waits for a publish, and `setState('view', …)` is
 * time-throttled so a 24h replay burst does not thrash React. The series is
 * bounded two ways: a hard ring cap at `maxSamples`, and the live 24h window (a
 * record older than RETENTION_S is dropped on arrival, and a sample is pruned
 * as wall-clock advances past it).
 *
 * @param {number} [maxSamples] Per-key ring cap (defaults to MAX_SAMPLES).
 * @param {number} [ttlMs]      Per-key liveness TTL (defaults to ENTRY_TTL_MS).
 */
export class ProbeStreamViewNode extends Node {
	/**
	 * What `nodeSchema()` reports to the console palette and to `help`. Every
	 * concrete subclass overrides it.
	 */
	static description =
		'Durable probe-stream render-model sink (the React view node).';

	/**
	 * Sizes the per-key ring and the liveness TTL, and starts with no entries.
	 *
	 * A subclass declares `modelKey` and `identitySlot` as class fields, which
	 * initialize after this runs.
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
		this._lastPublish = 0;
		this._flushTimer = null;
		this._lastFill = 0;
	}

	/**
	 * Fold one probe record into its key's entry, then evict stale keys and
	 * publish (throttled).
	 *
	 * Anything that is not a positional record, or whose identity slot is not a
	 * non-empty string, is ignored rather than refused: `fill()` runs in the
	 * drain with no per-message try/catch, so a throw here aborts the whole
	 * message turn.
	 *
	 * A gap longer than the TTL means the stream was hidden rather than every
	 * producer dying, so each entry's lease shifts forward by the outage instead
	 * of the whole model evicting on this frame. A record predating the live
	 * window is not folded at all: the durable replay tail is longer than the
	 * window, so dropping it on arrival beats carrying it until the next prune.
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
		const key = value[ this.identitySlot ];
		if ( 'string' !== typeof key || '' === key ) {
			return;
		}

		const now = Date.now();
		// A long gap means the stream was hidden: shift leases, don't evict.
		if ( this._lastFill && now - this._lastFill > this.ttlMs ) {
			const outage = now - this._lastFill;
			for ( const c of Object.values( this.entries ) ) {
				c._lastSeen += outage;
			}
		}
		this._lastFill = now;

		const ts = Number( message[ TIMESTAMP ] ) || 0;
		if ( ts >= now / 1000 - RETENTION_S ) {
			let c = this.entries[ key ];
			if ( ! c ) {
				c = { key, series: [], _lastSeen: 0 };
				this.entries[ key ] = c;
			}
			c._lastSeen = now;
			c.series.push( this._fold( c, value, ts ) );
			// Cap sits above the window, so this only bounds a fast stream.
			if ( c.series.length > this.maxSamples ) {
				c.series.shift();
			}
		}
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

	/**
	 * Hidden from the node palette — a dashboard wires these sinks itself — and
	 * terminal: no arguments and no target. `description` is the one part a
	 * subclass varies, as a static field.
	 *
	 * @return {Object} The `node_schema()` descriptor the console and `help` read.
	 */
	static nodeSchema() {
		return {
			category: 'Hidden',
			description: this.description,
			has_target: false,
			arguments: [],
			commands: [],
		};
	}
}
