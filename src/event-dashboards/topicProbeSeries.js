/**
 * Roll a probe stream's per-identity samples up into per-GROUP time series for
 * the Topics panels: one series of points per group, plus the `max` the chart
 * ranks its series by and the `mode` it aggregates a bucket under. Modeled on
 * Tachikoma's Grafana Topics dashboard, which charts rate and backlog ranked
 * by peak.
 *
 * The grouping belongs to the caller, the metric's handling to `METRICS`.
 * Nothing here knows any stream: an entry needs a `series` and a group key,
 * and a metric is any numeric field a sample carries.
 *
 * One probe sweep stamps every identity in its worker with the same `ts`, so
 * those samples sum cleanly; identities swept by workers on different phases
 * stay separate points until `buildAlignedSeries` floors them into a shared
 * bucket. Each point also carries the WEIGHT its metric is a quotient of, so
 * that bucket can re-divide the samples it holds (Σwork / Σweight) instead of
 * letting one of them win.
 */

import { RATE_MODE } from './buildAlignedSeries';

/** A LEVEL gauge: a bucket keeps its last reading, and a gap carries it. */
const LEVEL = { fill: 'hold', agg: 'last' };

/**
 * How each metric charts, where it departs from the default: a RATE that
 * zero-fills gaps and re-divides a bucket, weighted by the sample's `elapsed`
 * seconds, and ADDITIVE. An additive metric's samples of one key from two
 * workers add up, so each worker charts apart as `<key> · <worker>`: two
 * workers sweep on independent phases, and summing them per `ts` is exact
 * only inside one. A mean or a max never adds, and a Table's key names one
 * worker's Table already, so neither splits.
 *
 * `queueLatencyMs` and `meanMs` are per-unit means, weighted by the runs and
 * operations they average over, so a busy window and an idle one never weigh
 * the same. `queueLatencyMs` is an event metric, so it zero-fills: holding it
 * would paint the last job across idle hours.
 */
const METRICS = Object.fromEntries(
	Object.entries( {
		backlog: LEVEL,
		cacheSize: LEVEL,
		fileBytes: { ...LEVEL, additive: false },
		maxMs: { fill: 'zero', agg: 'max', additive: false },
		queueLatencyMs: { weight: 'runsDelta', additive: false },
		meanMs: { weight: 'opsDelta', additive: false },
		opsRate: { additive: false },
		missRate: { additive: false },
	} ).map( ( [ metric, spec ] ) => [ metric, metricSpec( spec ) ] )
);

/** Every metric `METRICS` does not name. */
const DEFAULT_METRIC = metricSpec( {} );

/**
 * A metric's full declaration over the defaults, its `mode` built once so
 * every series of that metric shares it.
 *
 * @param {Object} spec What the metric overrides.
 * @return {{mode:{fill:string,agg:string},weight:string,additive:boolean}} The declaration.
 */
function metricSpec( spec ) {
	const { fill, agg, weight, additive } = {
		...RATE_MODE,
		weight: 'elapsed',
		additive: true,
		...spec,
	};
	return { mode: { fill, agg }, weight, additive };
}

/**
 * Each entry plots under its own key.
 *
 * @param {{key:string}} c A job identity, a Table, or an operation.
 * @return {string} Its key.
 */
export const byKey = ( c ) => c.key;

/**
 * The largest value among some points, the max a chart ranks its series by.
 *
 * @param {Array<{value:number}>} points One series' points.
 * @return {number} The largest value; 0 for none.
 */
export const maxOf = ( points ) =>
	points.reduce( ( m, p ) => Math.max( m, p.value ), 0 );

/**
 * Per-group time series for ONE metric, summed across the group's samples by
 * `ts`. An entry whose group key is empty is skipped rather than collected
 * under `''`, because a nameless series has nothing for the legend to show.
 * A sample whose metric is null, a figure that does not apply to it, charts
 * no point, and a group with no point charts no series. An additive metric
 * groups by the key and the sample's `worker`; a sample naming no worker
 * keeps the bare key.
 *
 * @param {?Object<string,{series?:Array<Object>}>} entries Probe-stream entries keyed by identity — `topicprobe:view` consumers, `jobstats:view` handlers, `tablestats:view` Tables.
 * @param {string}                                  metric  The sample field to plot, such as `msgRate`, `backlog` or `queueLatencyMs`.
 * @param {(entry:*)=>string}                       [keyOf] Group key per entry; the default groups by `source`, and Jobs and Tables pass `byKey`.
 * @return {Object<string,{points:Array<{ts:number,value:number,weight:number}>,max:number,mode:{fill:string,agg:string}}>}
 *   Per group key: the ts-sorted points, the series max the chart ranks by,
 *   and the metric's mode.
 */
export function topicChartSeries( entries, metric, keyOf = ( c ) => c.source ) {
	const { mode, weight, additive } = METRICS[ metric ] || DEFAULT_METRIC;
	/** @type {Object<string,Map<number,{value:number,weight:number}>>} */
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
				additive && s.worker ? `${ base } · ${ s.worker }` : base;
			const byTs = ( groups[ key ] ||= new Map() );
			const prev = byTs.get( s.ts ) || { value: 0, weight: 0 };
			byTs.set( s.ts, {
				// Rates ADD across the identities sampling one instant...
				value: prev.value + ( s[ metric ] || 0 ),
				// ...but share that window, so take the widest.
				weight: Math.max( prev.weight, s[ weight ] || 0 ),
			} );
		}
	}

	/** @type {Object<string,{points:Array<{ts:number,value:number,weight:number}>,max:number,mode:{fill:string,agg:string}}>} */
	const out = {};
	for ( const [ key, byTs ] of Object.entries( groups ) ) {
		const points = [ ...byTs.keys() ]
			.sort( ( a, b ) => a - b )
			.map( ( ts ) => ( { ts, ...byTs.get( ts ) } ) );
		out[ key ] = { points, max: maxOf( points ), mode };
	}
	return out;
}
