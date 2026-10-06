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
 * How an empty bucket reads belongs to the metric, so each series carries its
 * own `mode`, which `topicChartSeries` stamps from its metric table; nothing
 * here infers it from a metric name. A series with none reads as a RATE.
 */

import { LIVE_WINDOW_S } from './liveSample';

/** The Topic_Probe sweep cadence, and so the narrowest useful bucket. */
const BUCKET_BASE_S = 15;

/** RATE: a bucket re-divides Σwork by Σweight, and a gap reads 0. */
export const RATE_MODE = { fill: 'zero', agg: 'rate' };

/**
 * Each aggregate's per-bucket reducer, by `mode.agg`. A weighted MEAN
 * re-divides its bucket exactly as a rate does; the two part only where
 * `topicChartSeries` combines the samples of one instant.
 */
const AGGREGATES = {
	last: lastPerBucket,
	rate: ratePerBucket,
	mean: ratePerBucket,
	max: maxPerBucket,
};

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
 *   before its first sample, and each reading only until LIVE_WINDOW_S past
 *   it, then 0, the freshness rule the live cards apply. That bound holds
 *   after any point, so a gap mid-series (a fleet hold, an on-demand worker
 *   idling out) reads 0 until the series resumes. A smooth decline stays
 *   smooth, and a reader that stopped leaves a stacked total.
 * - RATE (`fill:'zero'`, `agg:'rate'`): a bucket re-divides its samples,
 *   Σ(value × weight) / Σweight, which is Σwork / Σelapsed because each
 *   sample's value is its own work over its own weight. A zero-weight sample
 *   counts only in a bucket that holds no weight at all. An empty bucket is 0.
 * - MEAN (`fill:'zero'`, `agg:'mean'`): a per-unit mean such as a latency,
 *   weighted by the units it averages over, re-divided as a RATE is.
 * - MAX (`fill:'zero'`, `agg:'max'`): a bucket keeps its largest sample.
 *   An empty bucket is 0.
 *
 * Bucket width is the probe cadence, widened only enough to hold the axis at or
 * under `maxPoints`, which the caller sizes to its panel's width: an axis
 * denser than the pixels drawing it is sub-pixel, and the cap is what keeps the
 * d3 redraw cheap.
 *
 * @param {?Object} series    One panel's topics from `topicChartSeries`:
 *                            `{ [topic]: { points:[{ts,value,weight}], max, mode? } }`,
 *                            ts in seconds and sorted; `mode.fill` is `'hold'` or
 *                            `'zero'`, `mode.agg` is `'last'`, `'rate'`, `'mean'` or `'max'`.
 * @param {number}  maxPoints Cap on the rendered axis length; 0 or less holds the base bucket however long the axis grows.
 * @return {{series:Array<{label:string,values:Array<{date:Date,value:number}>}>,dates:Array<Date>}}
 *   The topics busiest-first, plus the bucket instants they are aligned onto.
 */
export function buildAlignedSeries( series, maxPoints ) {
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

	const aligned = ranked.map( ( s ) => {
		const { fill, agg } = s.mode || RATE_MODE;
		const acc = AGGREGATES[ agg ]( s.points, bucketOf );
		// Each bucket's newest ts; points are ts-sorted, so the last one wins.
		const newest = new Map(
			s.points.map( ( p ) => [ bucketOf( p.ts ), p.ts ] )
		);
		const hold = 'hold' === fill ? LIVE_WINDOW_S : -Infinity;
		let carried = 0;
		let holdUntil = -Infinity;
		return {
			label: s.key,
			values: buckets.map( ( b, i ) => {
				if ( acc.has( b ) ) {
					carried = acc.get( b );
					holdUntil = newest.get( b ) + hold;
					return { date: dates[ i ], value: carried };
				}
				// Empty bucket: HOLD carries last value forward; ZERO reads 0.
				return {
					date: dates[ i ],
					value: b <= holdUntil ? carried : 0,
				};
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
 * Σ(value×weight) / Σweight — every sample counted, unlike a bucket MAX, which
 * throws away the work of all but one whenever two samples from one source
 * land together, as wide downsampled buckets make routine.
 *
 * A sample with no weight is an idle window: it is ignored when the bucket
 * holds positive weight, and the bucket reads the plain mean of its samples
 * only when none of them carries any.
 *
 * @param {Array<{ts:number,value:number,weight:number}>} points   One topic's points.
 * @param {(ts:number)=>number}                           bucketOf Floors a ts onto its bucket instant.
 * @return {Map<number,number>} Each bucket instant to that bucket's rate.
 */
function ratePerBucket( points, bucketOf ) {
	const sums = new Map();
	for ( const p of points ) {
		const b = bucketOf( p.ts );
		const cur = sums.get( b ) || { work: 0, weight: 0, total: 0, count: 0 };
		if ( p.weight > 0 ) {
			cur.work += p.value * p.weight;
			cur.weight += p.weight;
		}
		cur.total += p.value;
		cur.count += 1;
		sums.set( b, cur );
	}
	const out = new Map();
	for ( const [ b, { work, weight, total, count } ] of sums ) {
		out.set( b, weight > 0 ? work / weight : total / count );
	}
	return out;
}

/**
 * PEAK aggregate: a bucket keeps its largest sample, so one slow call in a
 * widened bucket still shows.
 *
 * @param {Array<{ts:number,value:number}>} points   One topic's points.
 * @param {(ts:number)=>number}             bucketOf Floors a ts onto its bucket instant.
 * @return {Map<number,number>} Each bucket instant to its largest value.
 */
function maxPerBucket( points, bucketOf ) {
	const out = new Map();
	for ( const p of points ) {
		const b = bucketOf( p.ts );
		out.set( b, Math.max( out.get( b ) ?? -Infinity, p.value ) );
	}
	return out;
}
