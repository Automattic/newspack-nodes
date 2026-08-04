// The TopicProbe sweep interval, and so the narrowest useful bucket.
const BUCKET_BASE_S = 15;

/**
 * buildAlignedSeries — turn `topicChartSeries` output into the draw-ready model
 * for the d3 Topics charts: rank topics by peak, then snap every topic onto ONE
 * shared, epoch-aligned time-bucket grid and fill each bucket per the metric's
 * mode.
 *
 * Why a bucket GRID, not the raw union of sample instants: each worker process
 * runs its own TopicProbe sweeping on an independent 15s phase, so topics in
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
 *   - RATE (`fill:'zero'`, `agg:'max'`): a bucket keeps its peak; an empty bucket
 *     is 0. Spikes survive, gaps read as no-flow.
 *
 * Bucket width is the probe interval (15s) by default, widened only enough to
 * keep the axis at or under `maxPoints` — a panel is ~1800px wide, so a denser
 * axis is sub-pixel anyway, and the cap is what keeps the d3 redraw cheap.
 *
 * @param {?Object} series      `{ [topic]: { points:[{ts,value}], max, avg } }` (ts in seconds).
 * @param {number}  maxPoints   Hard cap on the rendered axis length (<=0 disables the cap).
 * @param {Object}  [mode]      Fill/aggregate mode (see `fillModeForMetric`).
 * @param {string}  [mode.fill] `'hold'` (carry forward) or `'zero'` (default).
 * @param {string}  [mode.agg]  `'last'` (latest-ts in bucket) or `'max'` (default).
 * @return {{ series: Array<{label:string, values:Array<{date:Date,value:number}>}>, dates: Date[] }}
 *   Ranked, grid-aligned topics plus the shared date axis (each date is the bucket instant).
 */
export function buildAlignedSeries(
	series,
	maxPoints,
	{ fill = 'zero', agg = 'max' } = {}
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
		// Per bucket, keep the latest-ts sample (LEVEL) or the peak (RATE).
		const acc = new Map();
		for ( const p of s.points ) {
			const b = bucketOf( p.ts );
			const cur = acc.get( b );
			const wins = last
				? ! cur || p.ts >= cur.ts
				: ! cur || p.value > cur.value;
			if ( wins ) {
				acc.set( b, { value: p.value, ts: p.ts } );
			}
		}

		let carried = 0;
		return {
			label: s.key,
			values: buckets.map( ( b, i ) => {
				if ( acc.has( b ) ) {
					carried = acc.get( b ).value;
					return { date: dates[ i ], value: carried };
				}
				// Empty bucket: HOLD carries last value forward; ZERO reads 0.
				return { date: dates[ i ], value: hold ? carried : 0 };
			} ),
		};
	} );

	return { series: aligned, dates };
}
