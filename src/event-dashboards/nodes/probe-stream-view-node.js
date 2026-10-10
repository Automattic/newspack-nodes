import { Node } from '../../runtime/node';
import { ReactBridge } from '../../runtime/react-bridge';
import { TIMESTAMP, FROM, VALUE } from '../../runtime/message';
import { workerOfFrom } from '@newspack-nodes/shared/utils/workerId';

/**
 * Fixed 24h live window, in seconds; an older record is dropped or pruned.
 *
 * @testonly Exported so the view's tests state the window edge they prune at.
 */
export const RETENTION_S = 86400;
// Throttle publish (a full-replay burst thrashes React): leading + trailing.
const PUBLISH_THROTTLE_MS = 500;
// Evict a key unseen this long; measured by arrival, not record ts.
const ENTRY_TTL_MS = 300000; // 5 min

/** Bucket width in seconds: a day is 480 buckets, under TopicsChart's 500. */
export const BUCKET_S = 180;

/**
 * One field's samples in one bucket: Σvalue, the largest, and the newest with
 * its instant.
 *
 * @typedef {{sum:number,max:number,last:number,lastTs:number}} Tally
 */

/**
 * One row's samples of one key over one `BUCKET_S` window; the row is the
 * worker that swept them, or `''` for a FROM naming no worker.
 *
 * @typedef {{start:number,worker:string,f:Object<string,Tally>}} Bucket
 */

/**
 * The buckets a snapshot has handed out. A fold copies one of these before
 * changing it, so a published snapshot never changes under React, while a
 * bucket no snapshot has seen folds in place.
 *
 * @type {WeakSet<Bucket>}
 */
const PUBLISHED = new WeakSet();

/**
 * Fold one sample into its row's bucket for its `ts`, on the one
 * epoch-aligned grid every worker's 15-second phase shares. Every numeric
 * field but `ts` tallies; a null field, a measure that does not apply, adds
 * nothing. A late sample lands in the bucket it belongs to, and its reading
 * becomes `last` only when it is the newest that bucket has seen.
 *
 * @testonly Exported so `bucketsFrom()` builds a reader's fixture buckets as
 * the view folds them; the view's `fill()` is the caller.
 *
 * @param {Map<string,Map<number,Bucket>>} rows   Row key to its buckets by start.
 * @param {string}                         row    The row the sample files under.
 * @param {Object}                         sample A `_fold` sample: `ts` plus numeric fields.
 * @return {void}
 */
export function foldInto( rows, row, sample ) {
	const start = Math.floor( sample.ts / BUCKET_S ) * BUCKET_S;
	let buckets = rows.get( row );
	if ( ! buckets ) {
		buckets = new Map();
		rows.set( row, buckets );
	}
	let b = buckets.get( start );
	if ( ! b || PUBLISHED.has( b ) ) {
		b = { start, worker: row, f: copyTallies( b?.f ) };
		buckets.set( start, b );
	}
	for ( const [ field, v ] of Object.entries( sample ) ) {
		if ( 'ts' === field || 'number' !== typeof v ) {
			continue;
		}
		const t = b.f[ field ];
		if ( ! t ) {
			b.f[ field ] = {
				sum: v,
				max: v,
				last: v,
				lastTs: sample.ts,
			};
			continue;
		}
		t.sum += v;
		t.max = Math.max( t.max, v );
		if ( sample.ts >= t.lastTs ) {
			t.last = v;
			t.lastTs = sample.ts;
		}
	}
}

/**
 * A copy of a published bucket's tallies, each its own object, so folding
 * into the copy leaves the published ones as they were.
 *
 * @param {Object<string,Tally>|undefined} f The tallies, or none.
 * @return {Object<string,Tally>} Their copy; empty for none.
 */
function copyTallies( f ) {
	return Object.fromEntries(
		Object.entries( f || {} ).map( ( [ field, t ] ) => [ field, { ...t } ] )
	);
}

/**
 * Σ and the largest max of each named field over some buckets: the windowed
 * totals the Jobs and Tables rows and the 24h cards read.
 *
 * @param {Array<Bucket>} buckets One key's buckets.
 * @param {Array<string>} fields  The fields to total.
 * @return {Object<string,{sum:number,max:number}>} Per field; 0 and 0 for a field no bucket carries.
 */
export function bucketTotals( buckets, fields ) {
	const out = Object.fromEntries(
		fields.map( ( field ) => [ field, { sum: 0, max: 0 } ] )
	);
	for ( const b of buckets ) {
		for ( const field of fields ) {
			const t = b.f[ field ];
			if ( t ) {
				out[ field ].sum += t.sum;
				out[ field ].max = Math.max( out[ field ].max, t.max );
			}
		}
	}
	return out;
}

/**
 * The layout mapping every concrete probe-stream view node supplies.
 *
 * The base owns the whole entry lifecycle — admit, create, touch, fold,
 * prune, evict, publish — so a subclass owns only which slot of a record
 * carries the per-key identity, which key the model publishes under, how one
 * record folds into an entry, and what the published per-key snapshot is.
 *
 * @typedef  {Object} ProbeStreamMapping
 * @property {number}                                                                                              identitySlot Record slot carrying the per-key identity.
 * @property {string}                                                                                              modelKey     Wrapper key the published model uses.
 * @property {( entry: Object, value: Array<string|number>, ts: number, worker: string, model: string ) => Object} _fold        Folds one record into its entry and returns the sample its bucket tallies.
 * @property {( entry: Object ) => Object}                                                                         _entryView   Builds the published snapshot for one key's entry.
 */

/**
 * Where one record files: the published model it belongs to and its key
 * there.
 *
 * @typedef {{model:string,key:string}} ProbeIdentity
 */

/**
 * A concrete probe-stream view node: this base plus a subclass's layout mapping.
 *
 * @typedef {ProbeStreamViewNode & ProbeStreamMapping} ProbeStreamSubclass
 */

/**
 * Shared base for the durable-probe stream view nodes — `TopicProbeViewNode`,
 * `JobstatsViewNode` and `TablestatsViewNode`, each in its own file beside
 * this one.
 *
 * Owns everything a probe stream needs that is not its record layout: the
 * per-key entries, their buckets, the throttle, the TTL, the eviction and the
 * prune. A subclass supplies `identitySlot`, `modelKey`,
 * `_fold(entry, value, ts, worker, model)` and `_entryView(entry)`. One whose
 * stream carries a second kind of record routes it into a model of its own by
 * overriding `_identify(value)` and `_models()`; the entries nest by model,
 * and `_fold` is told which it folds into.
 *
 * A record folds into one bucket — its row's `BUCKET_S` window for its `ts`
 * — and a sweep of the live keys, never a walk of a day of samples; every
 * walk — the prune, the snapshot's per-key copies — waits for a publish, and
 * the `view` publish is time-throttled so a 24h replay burst does not thrash
 * React. A bucket folds in place until a snapshot hands it out, and is copied
 * once before its next fold after that. Each worker a key hears from keeps
 * its own row of buckets, because one key may be swept by every partition: a
 * job identity with no id yields one record per worker per sweep. A row is
 * bounded by the live window over `BUCKET_S`, at most 481 buckets: a record
 * older than RETENTION_S is dropped on arrival, and a bucket is pruned once
 * it ends at or before the window's edge.
 *
 * @param {number} [ttlMs] Per-key liveness TTL (defaults to ENTRY_TTL_MS).
 */
export class ProbeStreamViewNode extends ReactBridge( Node ) {
	/** The model and its per-key 24h buckets: hundreds a key. */
	static dumpOmits = [ 'view', 'entries' ];

	/**
	 * What `nodeSchema()` reports to the console palette and to `help`. Every
	 * concrete subclass overrides it.
	 */
	static description =
		'Durable probe-stream render-model sink (the React view node).';

	/**
	 * Sets the liveness TTL and starts with no entries.
	 *
	 * A subclass declares `modelKey` and `identitySlot` as class fields, which
	 * initialize after this runs.
	 *
	 * @param {number} [ttlMs] Per-key liveness TTL in ms; ENTRY_TTL_MS when omitted.
	 */
	constructor( ttlMs ) {
		super();
		this.ttlMs = ttlMs || ENTRY_TTL_MS;
		// model → key → entry: key, rows (row → start → bucket), _lastSeen.
		this.entries = {};
		this._lastPublish = 0;
		this._flushTimer = null;
		this._lastFill = 0;
		/**
		 * The published model React reads: one key per `_models()` entry,
		 * `modelKey` first; null until the first publish.
		 *
		 * @type {?Object}
		 */
		this.view = null;
	}

	/**
	 * Fold one probe record into its key's entry, then evict stale keys and
	 * publish (throttled).
	 *
	 * Anything that is not a positional record, or that `_identify()` files
	 * nowhere (null), is ignored rather than refused: `fill()` runs in the
	 * drain with no per-message try/catch, so a throw here aborts the whole
	 * message turn. `_identify()` is the subclass hook that decides; by default
	 * a record files under `modelKey` when its `identitySlot` is a non-empty
	 * string, and `TopicProbeViewNode` also routes a blank-READER record into
	 * its `partitions` model.
	 *
	 * A gap longer than the TTL means the stream was hidden rather than every
	 * producer dying, so each entry's lease shifts forward by the outage instead
	 * of the whole model evicting on this frame. A record predating the live
	 * window is not folded at all: the durable replay tail is longer than the
	 * window, so dropping it on arrival beats carrying it until the next prune.
	 *
	 * The probe stamps FROM `<worker-id>/<probe>` and the SSE reader prepends
	 * its own stamp, so a frame arrives as `jobstats.p0/job-worker.p2/jobstats`.
	 * `workerOfFrom()` reads the worker, `''` for a malformed or foreign FROM;
	 * `_fold` receives it, and the sample `_fold` returns folds into that
	 * worker's bucket, so a chart can plot each worker's stream apart.
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
		const identity = this._identify( value );
		if ( null === identity ) {
			return;
		}
		const { model, key } = identity;

		const now = Date.now();
		// A long gap means the stream was hidden: shift leases, don't evict.
		if ( this._lastFill && now - this._lastFill > this.ttlMs ) {
			const outage = now - this._lastFill;
			for ( const c of this._allEntries() ) {
				c._lastSeen += outage;
			}
		}
		this._lastFill = now;

		const ts = Number( message[ TIMESTAMP ] ) || 0;
		if ( ts >= now / 1000 - RETENTION_S ) {
			const keyed = ( this.entries[ model ] ||= {} );
			const c = ( keyed[ key ] ||= {
				key,
				rows: new Map(),
				_lastSeen: 0,
			} );
			c._lastSeen = now;
			const worker = workerOfFrom( message[ FROM ] );
			foldInto(
				c.rows,
				worker,
				this._fold( c, value, ts, worker, model )
			);
		}
		this._evictStale();
		this._maybePublish();
	}

	/**
	 * Where a record files: under `modelKey`, keyed by its `identitySlot`,
	 * when that slot is a non-empty string, else nowhere.
	 *
	 * @this {ProbeStreamSubclass}
	 * @param {Array<string|number>} value The positional record.
	 * @return {?ProbeIdentity} Its model and key, or null to ignore it.
	 */
	_identify( value ) {
		const key = value[ this.identitySlot ];
		return 'string' === typeof key && '' !== key
			? { model: this.modelKey, key }
			: null;
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
		for ( const keyed of Object.values( this.entries ) ) {
			for ( const [ key, c ] of Object.entries( keyed ) ) {
				if ( c._lastSeen < cutoff ) {
					delete keyed[ key ];
				}
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
	 * Cancel any pending flush, prune the aged-out tail, and push one snapshot
	 * per published model into the `view` field. The one place that publishes.
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
		this.setField(
			'view',
			Object.fromEntries(
				this._models().map( ( model ) => [
					model,
					this.snapshot( model ),
				] )
			)
		);
	}

	/**
	 * Every model the view publishes, `modelKey` first.
	 *
	 * @this {ProbeStreamSubclass}
	 * @return {Array<string>} The published model keys.
	 */
	_models() {
		return [ this.modelKey ];
	}

	/**
	 * Delete every bucket that ends at or before the 24h window's edge, and
	 * drop a row left empty. Runs on each publish, so windowed totals derived
	 * from the buckets shrink for free as wall-clock advances.
	 *
	 * @param {number} now Publish instant in epoch MILLIseconds; bucket
	 *                     starts are seconds.
	 * @return {void}
	 */
	_pruneExpired( now ) {
		const cutoff = now / 1000 - RETENTION_S;
		for ( const c of this._allEntries() ) {
			for ( const [ row, buckets ] of c.rows ) {
				for ( const start of buckets.keys() ) {
					if ( start + BUCKET_S <= cutoff ) {
						buckets.delete( start );
					}
				}
				if ( 0 === buckets.size ) {
					c.rows.delete( row );
				}
			}
		}
	}

	/**
	 * Every entry of every model.
	 *
	 * @return {Array<Object>} The entries.
	 */
	_allEntries() {
		return Object.values( this.entries ).flatMap( Object.values );
	}

	/**
	 * One published model: one subclass-shaped view per key. A key whose
	 * buckets have all aged out is skipped rather than published empty.
	 *
	 * @this {ProbeStreamSubclass}
	 * @param {string} model The model to read.
	 * @return {Object} Key to the subclass's per-key snapshot object.
	 */
	snapshot( model ) {
		const out = {};
		for ( const [ key, c ] of Object.entries(
			this.entries[ model ] || {}
		) ) {
			if ( c.rows.size > 0 ) {
				out[ key ] = this._entryView( c );
			}
		}
		return out;
	}

	/**
	 * An entry's buckets, each row's in turn and in no order within it: a
	 * fresh array of buckets no later fold changes, each marked published.
	 *
	 * @param {Object} c The entry.
	 * @return {Array<Bucket>} Its buckets.
	 */
	_buckets( c ) {
		const out = [];
		for ( const buckets of c.rows.values() ) {
			for ( const b of buckets.values() ) {
				PUBLISHED.add( b );
				out.push( b );
			}
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
	 * Cancel a pending trailing flush before teardown, so no publish fires
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
			registrations: [ 'view' ],
			has_target: false,
			arguments: [],
			commands: [],
		};
	}
}
