/**
 * Roll a probe stream's per-identity samples up into per-GROUP time series for
 * the Topics panels: one series of points per group, plus the `max` and `avg`
 * the ranked legend reads. Modeled on Tachikoma's Grafana Topics dashboard,
 * which charts rate and backlog ranked by peak.
 *
 * The grouping belongs to the caller. The Overview rolls `topicprobe:view`
 * consumers up per `source`, the topic a consumer tails; Jobs rolls
 * `jobstats:view` entries up per handler for the rate panels and per job
 * identity for queue latency. Nothing here knows either stream: an entry needs
 * a `series` and a group key, and a metric is any numeric field a sample
 * carries.
 *
 * One probe sweep stamps every identity in its worker with the same `ts`, so
 * those samples sum cleanly; identities swept by workers on different phases
 * stay separate points until `buildAlignedSeries` floors them into a shared
 * bucket. Each point also carries the WEIGHT its metric is a quotient of, so
 * that bucket can re-divide the samples it holds (Σwork / Σweight) instead of
 * letting one of them win.
 */

/** LEVEL gauge: a bucket keeps its last reading, and a gap carries it forward. */
const LEVEL_MODE = { fill: 'hold', agg: 'last' };

/** RATE metric: a bucket re-divides Σwork by Σweight, and a gap reads 0. */
const RATE_MODE = { fill: 'zero', agg: 'rate' };

/**
 * Fill/aggregate mode per metric. RATE is the fallback, so only a LEVEL gauge
 * needs an entry: Jobs' `runsRate` and `errorsRate` are absent and still chart
 * correctly. `queueLatencyMs` is listed to record the judgement, not to change
 * the outcome.
 */
const FILL_MODES = {
	msgRate: RATE_MODE,
	byteRate: RATE_MODE,
	backlog: LEVEL_MODE,
	cacheSize: LEVEL_MODE,
	// An event metric, not a gauge: hold paints the last job across idle hours.
	queueLatencyMs: RATE_MODE,
};

/**
 * The sample field each metric is a per-unit quotient OF, so a bucket aggregate
 * can weight by it. Per-second rates divide by seconds; queue latency is a
 * per-RUN mean, so weighting it by seconds would treat a busy window and an idle
 * one as equals. A per-run mean only sums within ONE identity, which is why Jobs
 * groups its latency panel by job key rather than by handler.
 */
const WEIGHT_FIELDS = { queueLatencyMs: 'runsDelta' };

/** Weight for every metric the table omits: the sample's own window, in seconds. */
const DEFAULT_WEIGHT_FIELD = 'elapsed';

/**
 * Fill/aggregate mode for a Topics metric: LEVEL gauges hold across gaps and
 * keep the last reading per bucket; RATE metrics zero-fill gaps and re-divide
 * the bucket's summed work by its summed weight. `backlog` and `cacheSize` are
 * the LEVEL gauges; every other metric, named in the table or not, is a RATE.
 *
 * @param {string} metric A sample field name, such as `msgRate` or `backlog`.
 * @return {{fill:('hold'|'zero'),agg:('last'|'rate')}} The fill/aggregate mode.
 */
export function fillModeForMetric( metric ) {
	return FILL_MODES[ metric ] || RATE_MODE;
}

/**
 * Per-group time series for ONE metric, summed across the group's identities by
 * `ts`. An entry whose group key is empty is skipped rather than collected under
 * `''`, because a nameless series has nothing for the legend to show.
 *
 * @param {Object<string,{source?:string,series?:Array<Object<string,number>>}>} consumers
 *                                                                                         Probe-stream entries keyed by identity — `topicprobe:view` consumers, or `jobstats:view` handlers.
 * @param {string}                                                               metric    The sample field to plot, such as `msgRate`, `backlog` or `queueLatencyMs`.
 * @param {(entry:*)=>string}                                                    [keyOf]   Group key per entry; the default groups by `source`, and Jobs passes `handler` or the job `key`.
 * @return {Object<string,{points:Array<{ts:number,value:number,weight:number}>,max:number,avg:number}>}
 *   Per group key: the ts-sorted points, plus the series max and avg the ranked legend reads.
 */
export function topicChartSeries(
	consumers,
	metric,
	keyOf = ( c ) => c.source
) {
	const weightField = WEIGHT_FIELDS[ metric ] || DEFAULT_WEIGHT_FIELD;
	const byKey = {};
	for ( const c of Object.values( consumers || {} ) ) {
		const key = keyOf( c ) || '';
		if ( '' === key ) {
			continue;
		}
		( byKey[ key ] ||= [] ).push( c );
	}

	/** @type {Object<string,{points:Array<{ts:number,value:number,weight:number}>,max:number,avg:number}>} */
	const out = {};
	for ( const [ key, list ] of Object.entries( byKey ) ) {
		const byTs = new Map();
		for ( const c of list ) {
			for ( const s of c.series || [] ) {
				const prev = byTs.get( s.ts ) || { value: 0, weight: 0 };
				byTs.set( s.ts, {
					// Rates ADD across the identities sampling one instant...
					value: prev.value + ( s[ metric ] || 0 ),
					// ...but share that window, so take the widest.
					weight: Math.max( prev.weight, s[ weightField ] || 0 ),
				} );
			}
		}
		const tss = [ ...byTs.keys() ].sort( ( a, b ) => a - b );
		const points = tss.map( ( ts ) => ( { ts, ...byTs.get( ts ) } ) );
		const values = points.map( ( p ) => p.value );
		const max = values.length ? Math.max( ...values ) : 0;
		const avg = values.length
			? values.reduce( ( a, b ) => a + b, 0 ) / values.length
			: 0;
		out[ key ] = { points, max, avg };
	}
	return out;
}
