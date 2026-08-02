/**
 * Turn IoTelemetry's compact rate ring into the `series` shape the reused
 * TopicsChart consumes — `{ [label]: { points:[{ts,value}], max, avg } }` — but
 * with two fixed series (In / Out) instead of one-per-topic. Two panels:
 * message rate and byte rate. Pure (ring in, series out) so it's trivially
 * testable and memoizable.
 *
 * Ring rows are `[ t, msgInRate, msgOutRate, byteInRate, byteOutRate ]`.
 */

const T = 0;
const MSG_IN = 1;
const MSG_OUT = 2;
const BYTE_IN = 3;
const BYTE_OUT = 4;

// One TopicsChart series ({ points, max, avg }) from a ring column.
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
 * @param {Array<Array<number>>} ring IoTelemetry rate ring.
 * @return {{ msgRate: Object, byteRate: Object }} Two In/Out TopicsChart series.
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
