// The Topic_Probe sweep interval, and so the narrowest useful bucket.
const BUCKET_BASE_S = 15;

/**
 * buildAlignedSeries — turn `topicChartSeries` output into the draw-ready model
 * for the d3 Topics charts: rank topics by peak, then snap every topic onto ONE
 * shared, epoch-aligned time-bucket grid and fill each bucket per the metric's
 * mode.
 *
 * Why a bucket GRID, not the raw union of sample instants: each worker process
 * runs its own Topic_Probe sweeping on an independent 15s phase, so topics in
 * different processes emit their samples at OFFSET instants. Merging on the raw
 * union then leaves every topic with a gap at every OTHER topic's instant — and
 * a `?? 0` gap-fill turns a LEVEL gauge (backlog/cacheSize) into a [3MB,0,3MB,0…]
 * sawtooth under curveMonotoneX. Flooring each sample to `floor(ts/bucket)*bucket`
 * lands two 15s-out-of-phase sweeps in the SAME bucket, so the topics share one
 * axis with no interleaved-instant gaps.
 *
 * Fill mode (from the call site, never inferred here by metric name):
 *   - LEVEL (`fill:'hold'`, `agg:'last'`): a bucket keeps its latest-ts value;
 *     an empty bucket carries the topic's last known value forward (0 before the
 *     topic's first sample). A smooth decline stays smooth.
 *   - RATE (`fill:'zero'`, `agg:'rate'`): a bucket re-divides its samples,
 *     Σ(value × weight) / Σweight — which is Σwork / Σelapsed, since each
 *     sample's value is its own work over its own weight. An empty bucket is 0.
 *     Taking the bucket MAX instead discarded work whenever two samples from one
 *     source landed together, which wide downsampled buckets do routinely.
 *
 * Bucket width is the probe interval (15s) by default, widened only enough to
 * keep the axis at or under `maxPoints` — a panel is ~1800px wide, so a denser
 * axis is sub-pixel anyway, and the cap is what keeps the d3 redraw cheap.
 *
 * @param {?Object} series      `{ [topic]: { points:[{ts,value,weight}], max, avg } }` (ts in seconds).
 * @param {number}  maxPoints   Hard cap on the rendered axis length (<=0 disables the cap).
 * @param {Object}  [mode]      Fill/aggregate mode (see `fillModeForMetric`).
 * @param {string}  [mode.fill] `'hold'` (carry forward) or `'zero'` (default).
 * @param {string}  [mode.agg]  `'last'` (latest-ts in bucket) or `'rate'` (default).
 * @return {{ series: Array<{label:string, values:Array<{date:Date,value:number}>}>, dates: Date[] }}
 *   Ranked, grid-aligned topics plus the shared date axis (each date is the bucket instant).
 */
export function buildAlignedSeries(
	series,
	maxPoints,
	{ fill = 'zero', agg = 'rate' } = {}
) {
	const ranked = Object.keys( series || {} )
		.map( ( key ) => ( { key, ...series[ key ] } ) )
		.filter( ( s ) => ( s.points || [] ).length > 0 )
		.sort( ( a, b ) => b.max - a.max );

	if ( 0 === ranked.length ) {
		return { series: [], dates: [] };
	}

	let minTs = Infinity;
	let maxTs = -Infinity;
	ranked.forEach( ( s ) =>
		s.points.forEach( ( p ) => {
			if ( p.ts < minTs ) {
				minTs = p.ts;
			}
			if ( p.ts > maxTs ) {
				maxTs = p.ts;
			}
		} )
	);

	// Widen the bucket past 15s only if the 15s grid would overflow maxPoints.
	const windowSec = maxTs - minTs;
	let bucketSec = BUCKET_BASE_S;
	if ( maxPoints > 0 ) {
		const denom = Math.max( 1, maxPoints - 2 );
		bucketSec = Math.max( BUCKET_BASE_S, Math.ceil( windowSec / denom ) );
	}

	const bucketOf = ( ts ) => Math.floor( ts / bucketSec ) * bucketSec;
	const minBucket = bucketOf( minTs );
	const maxBucket = bucketOf( maxTs );
	const buckets = [];
	const dates = [];
	for ( let b = minBucket; b <= maxBucket; b += bucketSec ) {
		buckets.push( b );
		dates.push( new Date( b * 1000 ) );
	}

	const hold = 'hold' === fill;
	const last = 'last' === agg;
	const aligned = ranked.map( ( s ) => {
		const acc = last
			? lastPerBucket( s.points, bucketOf )
			: ratePerBucket( s.points, bucketOf );
		let carried = 0;
		return {
			label: s.key,
			values: buckets.map( ( b, i ) => {
				if ( acc.has( b ) ) {
					carried = acc.get( b );
					return { date: dates[ i ], value: carried };
				}
				// Empty bucket: HOLD carries last value forward; ZERO reads 0.
				return { date: dates[ i ], value: hold ? carried : 0 };
			} ),
		};
	} );

	return { series: aligned, dates };
}

/**
 * LEVEL aggregate: a gauge's bucket reads its latest-ts sample.
 *
 * @param {Array<{ts:number,value:number}>} points   One topic's points.
 * @param {Function}                        bucketOf ts → bucket instant.
 * @return {Map<number,number>} Bucket instant → value.
 */
function lastPerBucket( points, bucketOf ) {
	const newest = new Map();
	const out = new Map();
	for ( const p of points ) {
		const b = bucketOf( p.ts );
		if ( ! newest.has( b ) || p.ts >= newest.get( b ) ) {
			newest.set( b, p.ts );
			out.set( b, p.value );
		}
	}
	return out;
}

/**
 * RATE aggregate: a bucket re-divides the work its samples did, Σ(value×weight)
 * / Σweight. A sample with no weight falls back to 1, degrading to a plain mean
 * — still every sample counted, unlike a max.
 *
 * @param {Array<{ts:number,value:number,weight:number}>} points   One topic's points.
 * @param {Function}                                      bucketOf ts → bucket instant.
 * @return {Map<number,number>} Bucket instant → rate.
 */
function ratePerBucket( points, bucketOf ) {
	const sums = new Map();
	for ( const p of points ) {
		const b = bucketOf( p.ts );
		const weight = p.weight > 0 ? p.weight : 1;
		const cur = sums.get( b ) || { work: 0, weight: 0 };
		cur.work += p.value * weight;
		cur.weight += weight;
		sums.set( b, cur );
	}
	const out = new Map();
	for ( const [ b, { work, weight } ] of sums ) {
		out.set( b, weight > 0 ? work / weight : 0 );
	}
	return out;
}
