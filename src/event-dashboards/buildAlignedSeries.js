/**
 * Snap every series of one Topics panel onto ONE shared, epoch-aligned
 * time-bucket grid, so a panel's topics all draw against the same X axis.
 *
 * Why a grid rather than the union of the raw sample instants: each worker
 * process runs its own Topic_Probe sweeping on an independent 15s phase, so
 * topics living in different processes emit their samples at OFFSET instants.
 * On the raw union every topic then carries a gap at every OTHER topic's
 * instant, and a `?? 0` gap-fill turns a LEVEL gauge (backlog, cacheSize) into
 * a [3MB,0,3MB,0…] sawtooth under curveMonotoneX. Flooring each sample to
 * `floor(ts/bucket)*bucket` lands two sweeps 15s out of phase in the SAME
 * bucket.
 *
 * How an empty bucket reads belongs to the metric, so the mode arrives from the
 * call site as `fillModeForMetric( metric )`; nothing here infers it from a
 * metric name.
 */

/** The Topic_Probe sweep cadence, and so the narrowest useful bucket. */
const BUCKET_BASE_S = 15;

/**
 * Build one Topics panel's draw-ready model: rank the topics by peak, then fill
 * every bucket of the shared grid for each of them.
 *
 * The ranking is load-bearing. `TopicsChart` indexes the palette and the legend
 * by position, so the busiest topic takes the first color and heads the legend.
 *
 * Fill mode:
 *
 * - LEVEL (`fill:'hold'`, `agg:'last'`): a bucket keeps its latest-ts value,
 *   and an empty bucket carries the topic's last known value forward — 0
 *   before its first sample, and its final reading on to the right edge of the
 *   grid. A smooth decline stays smooth.
 * - RATE (`fill:'zero'`, `agg:'rate'`): a bucket re-divides its samples,
 *   Σ(value × weight) / Σweight, which is Σwork / Σelapsed because each
 *   sample's value is its own work over its own weight. An empty bucket is 0.
 *
 * Bucket width is the probe cadence, widened only enough to hold the axis at or
 * under `maxPoints`: a panel is ~1800px wide, so a denser axis is sub-pixel,
 * and the cap is what keeps the d3 redraw cheap.
 *
 * @param {?Object} series      One panel's topics from `topicChartSeries`:
 *                              `{ [topic]: { points:[{ts,value,weight}], max, avg } }`, ts in seconds.
 * @param {number}  maxPoints   Cap on the rendered axis length; 0 or less holds the base bucket however long the axis grows.
 * @param {Object}  [mode]      Fill/aggregate mode, from `fillModeForMetric`.
 * @param {string}  [mode.fill] `'hold'` (carry forward) or `'zero'` (default).
 * @param {string}  [mode.agg]  `'last'` (latest-ts in bucket) or `'rate'` (default).
 * @return {{series:Array<{label:string,values:Array<{date:Date,value:number}>}>,dates:Array<Date>}}
 *   The topics busiest-first, plus the bucket instants they are aligned onto.
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
		// The -2 is headroom: flooring can add a bucket at each end.
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
 * @param {(ts:number)=>number}             bucketOf Floors a ts onto its bucket instant.
 * @return {Map<number,number>} Each bucket instant to that bucket's value.
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
 * RATE aggregate: a bucket re-divides its samples' work by their weight,
 * Σ(value×weight) / Σweight. A sample with no weight counts as 1, degrading to
 * a plain mean — every sample still counted, unlike a bucket MAX, which throws
 * away the work of all but one whenever two samples from one source land
 * together, as wide downsampled buckets make routine.
 *
 * @param {Array<{ts:number,value:number,weight:number}>} points   One topic's points.
 * @param {(ts:number)=>number}                           bucketOf Floors a ts onto its bucket instant.
 * @return {Map<number,number>} Each bucket instant to that bucket's rate.
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
