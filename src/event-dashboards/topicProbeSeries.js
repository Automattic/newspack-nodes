/**
 * Roll a probe stream's per-identity samples up into per-GROUP time series for
 * the Topics panels: one series of points per group, plus the `max` the chart
 * ranks its series by and the `mode` it aggregates a bucket under. Modeled on
 * Tachikoma's Grafana Topics dashboard, which charts rate and backlog ranked
 * by peak.
 *
 * The grouping belongs to the caller — the group key, and whether it splits
 * per worker — the metric's handling to `METRICS`. Nothing here knows any
 * stream: an entry needs a `series` and a group key, and a metric is any
 * numeric field a sample carries.
 *
 * One probe sweep stamps every identity in its worker with the same `ts`, so
 * those samples combine at that instant as the metric's `agg` says;
 * identities swept by workers on different phases stay separate points until
 * `buildAlignedSeries` floors them into a shared bucket. Each point also
 * carries the WEIGHT its metric is a quotient of, so that bucket can re-divide
 * the samples it holds (Σwork / Σweight) instead of letting one of them win.
 */

import { RATE_MODE } from './buildAlignedSeries';

/** A LEVEL gauge: a bucket keeps its last reading, and a gap carries it. */
const LEVEL = { fill: 'hold', agg: 'last' };

/**
 * How each metric charts, where it departs from the default: a RATE that
 * zero-fills gaps and re-divides a bucket, weighted by the sample's `elapsed`
 * seconds.
 *
 * `queueLatencyMs` and `meanMs` are per-unit MEANs, weighted by the runs and
 * operations they average over, so a busy window and an idle one never weigh
 * the same. `queueLatencyMs` is an event metric, so it zero-fills: holding it
 * would paint the last job across idle hours.
 */
const METRICS = Object.fromEntries(
	Object.entries( {
		backlog: LEVEL,
		cacheSize: LEVEL,
		fileBytes: LEVEL,
		fileDiskBytes: LEVEL,
		endBytes: LEVEL,
		diskBytes: LEVEL,
		maxMs: { fill: 'zero', agg: 'max' },
		queueLatencyMs: { agg: 'mean', weight: 'runsDelta' },
		meanMs: { agg: 'mean', weight: 'opsDelta' },
	} ).map( ( [ metric, spec ] ) => [ metric, metricSpec( spec ) ] )
);

/** Every metric `METRICS` does not name. */
const DEFAULT_METRIC = metricSpec( {} );

/**
 * A metric's full declaration over the defaults, its `mode` built once so
 * every series of that metric shares it.
 *
 * @param {Object} spec What the metric overrides.
 * @return {{mode:{fill:string,agg:string},weight:string}} The declaration.
 */
function metricSpec( spec ) {
	const { fill, agg, weight } = {
		...RATE_MODE,
		weight: 'elapsed',
		...spec,
	};
	return { mode: { fill, agg }, weight };
}

/**
 * One group's samples at one `ts`, tallied every way a metric may combine
 * them: Σvalue, the largest value, the widest weight and the count, beside
 * Σ(value × weight) and Σweight over the samples that carry a weight.
 *
 * @typedef {{sum:number,max:number,widest:number,count:number,work:number,weight:number}} InstantTally
 */

/**
 * How the samples one group holds at one `ts` combine into its point, by the
 * metric's `agg`. A rate adds, since the identities sampling one instant share
 * its window, and takes the widest weight; a level adds; a max keeps the
 * largest; a mean re-divides, ignoring a zero weight beside a positive one and
 * reading the plain mean when none carries any.
 *
 * @type {Object<string,( t: InstantTally ) => {value:number,weight:number}>}
 */
const COMBINE = {
	rate: ( t ) => ( { value: t.sum, weight: t.widest } ),
	last: ( t ) => ( { value: t.sum, weight: t.widest } ),
	max: ( t ) => ( { value: t.max, weight: t.widest } ),
	mean: ( t ) => ( {
		value: t.weight > 0 ? t.work / t.weight : t.sum / t.count,
		weight: t.weight,
	} ),
};

/**
 * Each entry plots under its own key.
 *
 * @param {{key:string}} c A job identity, a Table, or an operation.
 * @return {string} Its key.
 */
export const byKey = ( c ) => c.key;

/**
 * Each consumer plots under the partition it reads.
 *
 * @param {{source:string}} c A `topicprobe:view` consumer.
 * @return {string} Its source partition.
 */
export const bySource = ( c ) => c.source;

/**
 * The largest value among some points, the max a chart ranks its series by.
 *
 * @param {Array<{value:number}>} points One series' points.
 * @return {number} The largest value; 0 for none.
 */
export const maxOf = ( points ) =>
	points.reduce( ( m, p ) => Math.max( m, p.value ), 0 );

/**
 * Per-group time series for ONE metric, its samples at each `ts` combined as
 * the metric's `agg` says. An entry whose group key is empty is skipped rather
 * than collected under `''`, because a nameless series has nothing for the
 * legend to show. A sample whose metric is null, a figure that does not apply
 * to it, charts no point, and a group with no point charts no series.
 *
 * Whether a group splits per worker is the caller's to say, because it
 * depends on the key, not the metric: a job identity or an Overview source
 * names no worker, so two workers' samples of it sweep on independent phases
 * and chart apart as `<key> · <worker>`, while a Table identity names its
 * worker already. A sample naming no worker keeps the bare key.
 *
 * @param {?Object<string,{series?:Array<Object>}>} entries          Probe-stream entries keyed by identity — `topicprobe:view` consumers, `jobstats:view` handlers, `tablestats:view` Tables.
 * @param {string}                                  metric           The sample field to plot, such as `msgRate`, `backlog` or `queueLatencyMs`.
 * @param {(entry:*)=>string}                       keyOf            Group key per entry: `bySource`, `byKey`, or the caller's own.
 * @param {Object}                                  options          How the caller groups.
 * @param {boolean}                                 options.byWorker Chart each worker of a key apart.
 * @return {Object<string,{points:Array<{ts:number,value:number,weight:number}>,max:number,mode:{fill:string,agg:string}}>}
 *   Per group key: the ts-sorted points, the series max the chart ranks by,
 *   and the metric's mode.
 * @throws {TypeError} When the caller does not say whether to split by worker.
 */
export function topicChartSeries( entries, metric, keyOf, { byWorker } ) {
	if ( 'boolean' !== typeof byWorker ) {
		throw new TypeError(
			`topicChartSeries( ${ metric } ): byWorker must be a boolean`
		);
	}
	const { mode, weight } = METRICS[ metric ] || DEFAULT_METRIC;
	/** @type {Object<string,Map<number,InstantTally>>} */
	const groups = {};
	for ( const c of Object.values( entries || {} ) ) {
		const base = keyOf( c ) || '';
		if ( '' === base ) {
			continue;
		}
		for ( const s of c.series || [] ) {
			if ( null === s[ metric ] ) {
				continue;
			}
			const key =
				byWorker && s.worker ? `${ base } · ${ s.worker }` : base;
			const byTs = ( groups[ key ] ||= new Map() );
			let t = byTs.get( s.ts );
			if ( ! t ) {
				t = { sum: 0, max: 0, widest: 0, count: 0, work: 0, weight: 0 };
				byTs.set( s.ts, t );
			}
			const v = s[ metric ] || 0;
			const w = s[ weight ] || 0;
			t.max = 0 === t.count ? v : Math.max( t.max, v );
			t.sum += v;
			t.widest = Math.max( t.widest, w );
			t.count += 1;
			if ( w > 0 ) {
				t.work += v * w;
				t.weight += w;
			}
		}
	}

	const combine = COMBINE[ mode.agg ];
	/** @type {Object<string,{points:Array<{ts:number,value:number,weight:number}>,max:number,mode:{fill:string,agg:string}}>} */
	const out = {};
	for ( const [ key, byTs ] of Object.entries( groups ) ) {
		const points = [ ...byTs.keys() ]
			.sort( ( a, b ) => a - b )
			.map( ( ts ) => ( { ts, ...combine( byTs.get( ts ) ) } ) );
		out[ key ] = { points, max: maxOf( points ), mode };
	}
	return out;
}
