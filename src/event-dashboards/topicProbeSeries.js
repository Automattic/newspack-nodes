/**
 * Roll a probe stream's per-identity BUCKETS up into per-GROUP time series for
 * the Topics panels: one series of points per group, plus the `max` the chart
 * ranks its series by, the `mode` it aggregates a slot under, and the `step`
 * the points sit on. Modeled on Tachikoma's Grafana Topics dashboard, which
 * charts rate and backlog ranked by peak.
 *
 * The grouping belongs to the caller — the group key, and whether it splits
 * per worker — and each metric's handling to `METRICS` here, the one reader
 * of it. Nothing here knows any stream: an entry needs its `buckets` and a
 * group key, and a metric reads the raw fields its buckets tally.
 *
 * Every bucket sits on the one `BUCKET_S` grid, so a group's entries combine
 * bucket by bucket as the metric's `agg` says, and each point is one bucket.
 * A point's `ts` is the newest sample it combines, so a held level lasts its
 * live window past the reading it shows. A rate's or a mean's point also
 * carries the `weight` its value is a quotient of, so a widened slot can
 * re-divide the points it holds (Σ(value × weight) / Σweight), and each series
 * carries `step`, so `buildAlignedSeries` widens the grid only by whole
 * buckets.
 */

import { BUCKET_S } from './nodes/probe-stream-view-node';
import { RATE_MODE } from './buildAlignedSeries';

/** A LEVEL gauge: a bucket keeps its last reading, and a gap carries it. */
const LEVEL = { fill: 'hold', agg: 'last' };

/** A per-unit MEAN, such as a latency, zero-filled as an event metric. */
const MEAN = { fill: 'zero', agg: 'mean' };

/**
 * One chart metric: its `mode`, the summed field it reads (`num`), and the
 * summed field a rate or a mean divides by (`den`).
 *
 * @typedef {{mode:{fill:string,agg:string},num:string,den:string}} Metric
 */

/**
 * How each metric charts, where it departs from the default: a RATE of the
 * field named like the metric over the bucket's `elapsed` seconds. A
 * metric's `mode` is shared by every series of it.
 *
 * `queueLatencyMs` and `meanMs` are MEANs over the runs and the operations
 * they average, so a busy window and an idle one never weigh the same.
 *
 * @type {Object<string,Metric>}
 */
const METRICS = Object.fromEntries(
	Object.entries( {
		msgRate: { num: 'msgs' },
		byteRate: { num: 'bytes' },
		runsRate: { num: 'runsDelta' },
		errorsRate: { num: 'errorsDelta' },
		opsRate: { num: 'opsDelta' },
		missRate: { num: 'misses' },
		queueLatencyMs: { mode: MEAN, num: 'queueDelta', den: 'runsDelta' },
		meanMs: { mode: MEAN, num: 'ms', den: 'opsDelta' },
		maxMs: { mode: { fill: 'zero', agg: 'max' } },
		backlog: { mode: LEVEL },
		cacheSize: { mode: LEVEL },
		fileBytes: { mode: LEVEL },
		fileDiskBytes: { mode: LEVEL },
		endBytes: { mode: LEVEL },
		diskBytes: { mode: LEVEL },
	} ).map( ( [ metric, spec ] ) => [ metric, metricSpec( metric, spec ) ] )
);

/**
 * A metric's full declaration over the defaults.
 *
 * @param {string} metric The metric's name.
 * @param {Object} spec   What it overrides.
 * @return {Metric} The declaration.
 */
function metricSpec( metric, spec ) {
	return { mode: RATE_MODE, num: metric, den: 'elapsed', ...spec };
}

/**
 * A metric's declaration: its `METRICS` entry, else a RATE of the field it
 * names, as an `op:<OP>` field is.
 *
 * @param {string} metric The metric, such as `msgRate` or `op:GET`.
 * @return {Metric} Its declaration.
 */
const metricOf = ( metric ) => METRICS[ metric ] || metricSpec( metric, {} );

/**
 * Σ of a field in one bucket, 0 where the bucket does not tally it.
 *
 * @param {Object<string,import('./nodes/probe-stream-view-node').Tally>} f     A bucket's tallies.
 * @param {string}                                                        field The field.
 * @return {number} Its sum.
 */
const sumOf = ( f, field ) => f[ field ]?.sum ?? 0;

/**
 * How each `agg` accumulates a group's buckets into one point. `init` makes
 * an accumulator holding only what its `read` needs, plus `ts`; `add` joins
 * one entry's bucket; `read` yields the point's value and weight.
 *
 * - A rate reads each entry's Σnum / Σden, 0 over no den, and adds the
 *   entries, which sweep one window; its weight is the widest den.
 * - A mean pools Σnum and Σden across entries and divides once, 0 over no
 *   den; its weight is the pooled den.
 * - A level takes each entry's newest reading across its rows, since an
 *   entry's workers measure one thing, such as a partition's directory or a
 *   Table's file, and then adds the entries. A max keeps the largest. Neither
 *   has a weight. A max starts from 0, a true floor, because every max metric
 *   is a duration `_delta` clamps non-negative.
 *
 * A level's accumulator holds the entries' committed sum and the current
 * entry's newest reading. `topicChartSeries` walks entry by entry, so each
 * accumulator sees all of one entry's rows before the next entry's.
 *
 * @type {Object<string,{init:()=>Object,add:(acc:Object,f:Object,spec:Metric,c:Object)=>void,read:(acc:Object)=>{value:number,weight:number}}>}
 */
const AGG = {
	rate: {
		init: () => ( { ts: -Infinity, value: 0, weight: 0 } ),
		add: ( acc, f, { num, den } ) => {
			const d = sumOf( f, den );
			acc.value += d > 0 ? sumOf( f, num ) / d : 0;
			acc.weight = Math.max( acc.weight, d );
		},
		read: ( acc ) => ( { value: acc.value, weight: acc.weight } ),
	},
	mean: {
		init: () => ( { ts: -Infinity, num: 0, den: 0 } ),
		add: ( acc, f, { num, den } ) => {
			acc.num += sumOf( f, num );
			acc.den += sumOf( f, den );
		},
		read: ( acc ) => ( {
			value: acc.den > 0 ? acc.num / acc.den : 0,
			weight: acc.den,
		} ),
	},
	last: {
		init: () => ( {
			ts: -Infinity,
			sum: 0,
			entry: null,
			cur: 0,
			curTs: -Infinity,
		} ),
		add: ( acc, f, { num }, c ) => {
			const t = f[ num ];
			if ( acc.entry !== c ) {
				acc.sum += acc.cur;
				acc.entry = c;
				acc.cur = t.last;
				acc.curTs = t.lastTs;
			} else if ( t.lastTs >= acc.curTs ) {
				acc.cur = t.last;
				acc.curTs = t.lastTs;
			}
		},
		read: ( acc ) => ( { value: acc.sum + acc.cur, weight: 0 } ),
	},
	max: {
		init: () => ( { ts: -Infinity, value: 0 } ),
		add: ( acc, f, { num } ) => {
			acc.value = Math.max( acc.value, f[ num ].max );
		},
		read: ( acc ) => ( { value: acc.value, weight: 0 } ),
	},
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
 * Per-group time series for ONE metric, one point per bucket, its entries'
 * buckets combined as the metric's `agg` says. An entry whose group key is
 * empty is skipped rather than collected under `''`, because a nameless
 * series has nothing for the legend to show. A bucket that does not tally
 * the metric's `num`, a figure that does not apply to it, charts no point,
 * and a group with no point charts no series.
 *
 * Whether a group splits per worker is the caller's to say, because it
 * depends on the key, not the metric: a job identity or an Overview source
 * names no worker, so two workers' buckets of it chart apart as
 * `<key> · <worker>`, while a Table charts whole, because its level counts
 * once, as its newest reading across rows, and its rates add. A bucket
 * naming no worker keeps the bare key. An entry lists each row's
 * buckets in turn, so the group key is worked out once per row.
 *
 * @param {?Object<string,{buckets?:Array<import('./nodes/probe-stream-view-node').Bucket>}>} entries          Probe-stream entries keyed by identity — `topicprobe:view` consumers, `jobstats:view` handlers, `tablestats:view` Tables.
 * @param {string}                                                                            metric           The chart metric, such as `msgRate`, `backlog` or `queueLatencyMs`.
 * @param {(entry:*)=>string}                                                                 keyOf            Group key per entry: `bySource`, `byKey`, or the caller's own.
 * @param {Object}                                                                            options          How the caller groups.
 * @param {boolean}                                                                           options.byWorker Chart each worker of a key apart.
 * @return {Object<string,{points:Array<{ts:number,value:number,weight:number}>,max:number,mode:{fill:string,agg:string},step:number}>}
 *   Per group key: the bucket-ordered points, the series max the chart ranks
 *   by, the metric's mode, and the bucket width.
 * @throws {TypeError} When the caller does not say whether to split by worker.
 */
export function topicChartSeries( entries, metric, keyOf, { byWorker } ) {
	if ( 'boolean' !== typeof byWorker ) {
		throw new TypeError(
			`topicChartSeries( ${ metric } ): byWorker must be a boolean`
		);
	}
	const spec = metricOf( metric );
	const { init, add, read } = AGG[ spec.mode.agg ];
	/** @type {Object<string,Map<number,Object>>} */
	const groups = {};
	for ( const c of Object.values( entries || {} ) ) {
		const base = keyOf( c ) || '';
		if ( '' === base ) {
			continue;
		}
		let worker = null;
		let byStart = null;
		for ( const b of c.buckets || [] ) {
			const t = b.f[ spec.num ];
			if ( ! t ) {
				continue;
			}
			if ( b.worker !== worker ) {
				worker = b.worker;
				const key =
					byWorker && worker ? `${ base } · ${ worker }` : base;
				byStart = groups[ key ] ||= new Map();
			}
			let acc = byStart.get( b.start );
			if ( ! acc ) {
				acc = init();
				byStart.set( b.start, acc );
			}
			add( acc, b.f, spec, c );
			acc.ts = Math.max( acc.ts, t.lastTs );
		}
	}

	/** @type {Object<string,{points:Array<{ts:number,value:number,weight:number}>,max:number,mode:{fill:string,agg:string},step:number}>} */
	const out = {};
	for ( const [ key, byStart ] of Object.entries( groups ) ) {
		const points = [ ...byStart ]
			.sort( ( a, b ) => a[ 0 ] - b[ 0 ] )
			.map( ( [ , acc ] ) => ( { ts: acc.ts, ...read( acc ) } ) );
		out[ key ] = {
			points,
			max: maxOf( points ),
			mode: spec.mode,
			step: BUCKET_S,
		};
	}
	return out;
}
