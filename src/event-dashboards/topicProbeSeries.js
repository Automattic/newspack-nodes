/**
 * Roll a probe stream's per-identity samples up into per-GROUP time series for
 * the Topics panels: one series of points per group, plus the `max` the chart
 * ranks its series by. Modeled on Tachikoma's Grafana Topics dashboard,
 * which charts rate and backlog ranked by peak.
 *
 * The grouping belongs to the caller. The Overview rolls `topicprobe:view`
 * consumers up per `source` and worker; Jobs and Tables split their rate
 * panels per worker the same way, through `perWorker`, and chart a mean per
 * identity. Nothing here knows any stream: an entry needs a `series` and a
 * group key, and a metric is any numeric field a sample carries.
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

/** MAX metric: a bucket keeps its largest sample, and a gap reads 0. */
const MAX_MODE = { fill: 'zero', agg: 'max' };

/**
 * Fill/aggregate mode per metric. RATE is the fallback, so only non-RATE metrics
 * need an entry. LEVEL gauges (`backlog`, `cacheSize`, `fileBytes`) hold across
 * gaps; MAX metrics (`maxMs`) zero-fill gaps and keep the largest sample.
 */
const FILL_MODES = {
	msgRate: RATE_MODE,
	byteRate: RATE_MODE,
	backlog: LEVEL_MODE,
	cacheSize: LEVEL_MODE,
	fileBytes: LEVEL_MODE,
	maxMs: MAX_MODE,
	// An event metric, not a gauge: hold paints the last job across idle hours.
	queueLatencyMs: RATE_MODE,
};

/**
 * The sample field each metric is a per-unit quotient OF, so a bucket aggregate
 * can weight by it. Per-second rates divide by seconds; `queueLatencyMs` and
 * `meanMs` are per-unit means (per run and per operation, respectively), so
 * weighting them by seconds would treat a busy window and an idle one as equals.
 */
const WEIGHT_FIELDS = {
	queueLatencyMs: 'runsDelta',
	meanMs: 'opsDelta',
};

/** Weight for every metric the table omits: the sample's own window, in seconds. */
const DEFAULT_WEIGHT_FIELD = 'elapsed';

/**
 * Fill/aggregate mode for a Topics metric: LEVEL gauges hold across gaps and
 * keep the last reading per bucket; RATE metrics zero-fill gaps and re-divide
 * the bucket's summed work by its summed weight; MAX metrics zero-fill gaps and
 * keep the largest sample. `backlog`, `cacheSize` and `fileBytes` are LEVEL
 * gauges; `maxMs` is a MAX metric; every other metric is a RATE.
 *
 * @param {string} metric A sample field name, such as `msgRate` or `backlog`.
 * @return {{fill:('hold'|'zero'),agg:('last'|'rate'|'max')}} The fill/aggregate mode.
 */
export function fillModeForMetric( metric ) {
	return FILL_MODES[ metric ] || RATE_MODE;
}

/**
 * Split each entry's samples into one entry per worker, keyed by
 * `<key> · <worker>`, so a chart plots each worker's stream on its own
 * and stacking sums them. A sample with no worker keeps the entry's key.
 * Entries sharing a key and a worker merge into one stream, and an entry
 * with no key is skipped.
 *
 * @param {?Object<string,{series?:Array<Object>}>} entries Probe-stream entries keyed by identity, each sample carrying `worker`.
 * @param {(entry:*)=>string}                       [keyOf] The key each entry plots under; the default is its own `key`.
 * @return {Object<string,{key:string,series:Array<Object>}>} Pseudo-entries for `topicChartSeries( out, metric, ( c ) => c.key )`.
 */
export function perWorker( entries, keyOf = ( c ) => c.key ) {
	/** @type {Object<string,{key:string,series:Array<Object>}>} */
	const out = {};
	for ( const c of Object.values( entries || {} ) ) {
		const base = keyOf( c ) || '';
		if ( '' === base ) {
			continue;
		}
		for ( const s of c.series || [] ) {
			const key = s.worker ? `${ base } · ${ s.worker }` : base;
			( out[ key ] ||= { key, series: [] } ).series.push( s );
		}
	}
	return out;
}

/**
 * Per-group time series for ONE metric, summed across the group's samples by
 * `ts`. An entry whose group key is empty is skipped rather than collected
 * under `''`, because a nameless series has nothing for the legend to show.
 *
 * The same-ts sum is exact only for samples one sweep stamped, which share a
 * worker. Two workers sweep on independent phases, so a rate chart hands this
 * `perWorker` entries: each worker's stream is its own series, and the chart
 * stacks them into the total.
 *
 * @param {Object<string,{source?:string,series?:Array<Object<string,number>>}>} consumers
 *                                                                                         Probe-stream entries keyed by identity — `topicprobe:view` consumers, `jobstats:view` handlers, or `perWorker` pseudo-entries.
 * @param {string}                                                               metric    The sample field to plot, such as `msgRate`, `backlog` or `queueLatencyMs`.
 * @param {(entry:*)=>string}                                                    [keyOf]   Group key per entry; the default groups by `source`, and Jobs and Tables pass the entry's own `key`.
 * @return {Object<string,{points:Array<{ts:number,value:number,weight:number}>,max:number}>}
 *   Per group key: the ts-sorted points, plus the series max the chart ranks by.
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

	/** @type {Object<string,{points:Array<{ts:number,value:number,weight:number}>,max:number}>} */
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
		const max = points.reduce( ( m, p ) => Math.max( m, p.value ), 0 );
		out[ key ] = { points, max };
	}
	return out;
}
