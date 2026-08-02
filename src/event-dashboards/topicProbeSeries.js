/**
 * Roll the TopicProbe view's per-`reader` samples up to per-group (default
 * per-`source`, the topic a consumer tails) TIME SERIES for the Overview's
 * Topics panels: message rate, byte rate, and backlog — modeled on Tachikoma's
 * Grafana Topics dashboard (rate + backlog, ranked by max).
 *
 * Readers of one source sweep on the same 15s tick (one shared `ts`), so summing
 * by `ts` aligns cleanly. Each series also carries its `max`/`avg` for the ranked
 * legend.
 */

// LEVEL gauges hold across gaps, RATE metrics zero-fill; mode derived by name.
const LEVEL_MODE = { fill: 'hold', agg: 'last' };
const RATE_MODE = { fill: 'zero', agg: 'max' };
const FILL_MODES = {
	msgRate: RATE_MODE,
	byteRate: RATE_MODE,
	backlog: LEVEL_MODE,
	cacheSize: LEVEL_MODE,
	// Event metric, not a gauge: hold painted the last job across idle hours.
	queueLatencyMs: RATE_MODE,
};

/**
 * Fill/aggregate mode for a Topics metric: LEVEL gauges hold across gaps and
 * keep the last reading per bucket; RATE metrics zero-fill gaps and keep the
 * bucket peak. Unknown metrics fall back to RATE.
 *
 * @param {string} metric One of `msgRate` | `byteRate` | `backlog` | `cacheSize`.
 * @return {{fill:('hold'|'zero'),agg:('last'|'max')}} The fill/aggregate mode.
 */
export function fillModeForMetric( metric ) {
	return FILL_MODES[ metric ] || RATE_MODE;
}

/**
 * Per-group time series for ONE metric, summed across the group's readers by ts.
 *
 * @param {Object<string,{source:string,series:Array<{ts:number,msgRate:number,byteRate:number,backlog:number}>}>} consumers
 *                                                                                                                           The `topicprobe:view` consumers map.
 * @param {string}                                                                                                 metric    One of `msgRate` | `byteRate` | `backlog`.
 * @param {Function}                                                                                               [keyOf]   Group key per consumer (default its `source`).
 * @return {Object<string,{points:Array<{ts:number,value:number}>,max:number,avg:number}>}
 *   Per group key: the ts-sorted points + the series max + avg (for the ranked legend).
 */
export function topicChartSeries(
	consumers,
	metric,
	keyOf = ( c ) => c.source
) {
	const byKey = {};
	for ( const c of Object.values( consumers || {} ) ) {
		const key = keyOf( c ) || '';
		if ( '' === key ) {
			continue;
		}
		( byKey[ key ] ||= [] ).push( c );
	}

	const out = {};
	for ( const [ key, list ] of Object.entries( byKey ) ) {
		const byTs = new Map();
		for ( const c of list ) {
			for ( const s of c.series || [] ) {
				byTs.set(
					s.ts,
					( byTs.get( s.ts ) || 0 ) + ( s[ metric ] || 0 )
				);
			}
		}
		const tss = [ ...byTs.keys() ].sort( ( a, b ) => a - b );
		const points = tss.map( ( ts ) => ( { ts, value: byTs.get( ts ) } ) );
		const values = points.map( ( p ) => p.value );
		const max = values.length ? Math.max( ...values ) : 0;
		const avg = values.length
			? values.reduce( ( a, b ) => a + b, 0 ) / values.length
			: 0;
		out[ key ] = { points, max, avg };
	}
	return out;
}
