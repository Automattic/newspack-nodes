/**
 * Reshape IoTelemetry's rate ring into the series model TopicsChart draws, so
 * the debug overlay's Overview tab reuses the event dashboards' chart instead
 * of growing a second one. The shape matches `topicChartSeries` —
 * `{ [label]: { points:[{ts,value}], max, avg } }` — over two fixed labels, In
 * and Out, where the dashboards carry one label per topic, and over two panels,
 * message rate and byte rate.
 *
 * A ring row is `[ t, msgInRate, msgOutRate, byteInRate, byteOutRate ]`: one
 * row per 5-second sample, each rate already divided by IoTelemetry. The points
 * carry no `weight`, so a chart bucket spanning several samples takes their
 * plain mean, which is what one fixed cadence wants.
 *
 * Reading nothing but the ring is what lets `useOverviewStats` memoize on
 * `IoTelemetry.revision`: the sampler appends in place, so a memo keyed on the
 * array itself would never see a new sample.
 */

/** Ring column: the sample instant, in whole seconds. */
const T = 0;

/** Ring column: messages per second in, over SSE and command responses. */
const MSG_IN = 1;

/** Ring column: messages per second out, in command requests. */
const MSG_OUT = 2;

/** Ring column: bytes per second in. */
const BYTE_IN = 3;

/** Ring column: bytes per second out. */
const BYTE_OUT = 4;

/**
 * Build one TopicsChart series from a single ring column.
 *
 * `buildAlignedSeries` ranks a panel's series by `max`, so the busier direction
 * draws first; `avg` completes the shape. An empty ring yields empty points
 * with both at zero, which TopicsChart renders as a blank panel.
 *
 * @param {Array<Array<number>>} ring The rate ring, oldest row first.
 * @param {number}               col  Column index to read from each row.
 * @return {{points:Array<{ts:number,value:number}>,max:number,avg:number}} One chart series.
 */
function seriesFromColumn( ring, col ) {
	const points = ring.map( ( row ) => ( {
		ts: row[ T ],
		value: row[ col ],
	} ) );
	const values = points.map( ( p ) => p.value );
	const max = values.length ? Math.max( ...values ) : 0;
	const avg = values.length
		? values.reduce( ( a, b ) => a + b, 0 ) / values.length
		: 0;
	return { points, max, avg };
}

/**
 * Split the rate ring into the two In/Out panels the Overview tab renders.
 *
 * @param {Array<Array<number>>} ring IoTelemetry's rate ring, from `getSeries()`.
 * @return {{msgRate:Object<string,{points:Array<{ts:number,value:number}>,max:number,avg:number}>,byteRate:Object<string,{points:Array<{ts:number,value:number}>,max:number,avg:number}>}}
 *   The message-rate and byte-rate panels, each keyed `In` and `Out`.
 */
export function overviewChartSeries( ring ) {
	return {
		msgRate: {
			In: seriesFromColumn( ring, MSG_IN ),
			Out: seriesFromColumn( ring, MSG_OUT ),
		},
		byteRate: {
			In: seriesFromColumn( ring, BYTE_IN ),
			Out: seriesFromColumn( ring, BYTE_OUT ),
		},
	};
}
