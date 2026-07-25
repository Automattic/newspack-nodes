import {
	topicChartSeries,
	downsample,
	fillModeForMetric,
} from '../topicProbeSeries';

// Build a topicprobe:view consumers entry: keyed by reader, source + series.
function consumer( source, series ) {
	return { source, series };
}

describe( 'downsample', () => {
	it( 'returns the values unchanged when already within the width', () => {
		expect( downsample( [ 1, 2, 3 ], 8 ) ).toEqual( [ 1, 2, 3 ] );
	} );

	it( 'buckets to the target width, taking the max per bucket (spikes survive)', () => {
		// 8 values → width 4: buckets [1,9],[2,3],[4,4],[5,8] → maxes 9,3,4,8.
		expect( downsample( [ 1, 9, 2, 3, 4, 4, 5, 8 ], 4 ) ).toEqual( [
			9, 3, 4, 8,
		] );
	} );

	it( 'returns [] for empty input', () => {
		expect( downsample( [], 4 ) ).toEqual( [] );
	} );
} );

describe( 'fillModeForMetric', () => {
	it( 'maps LEVEL gauges to hold/last', () => {
		expect( fillModeForMetric( 'backlog' ) ).toEqual( {
			fill: 'hold',
			agg: 'last',
		} );
		expect( fillModeForMetric( 'cacheSize' ) ).toEqual( {
			fill: 'hold',
			agg: 'last',
		} );
	} );

	it( 'maps RATE metrics to zero/max', () => {
		expect( fillModeForMetric( 'msgRate' ) ).toEqual( {
			fill: 'zero',
			agg: 'max',
		} );
		expect( fillModeForMetric( 'byteRate' ) ).toEqual( {
			fill: 'zero',
			agg: 'max',
		} );
	} );

	it( 'maps queue latency to RATE (an event metric — holding it painted the last job across idle hours)', () => {
		expect( fillModeForMetric( 'queueLatencyMs' ) ).toEqual( {
			fill: 'zero',
			agg: 'max',
		} );
	} );

	it( 'defaults an unknown metric to RATE (zero/max)', () => {
		expect( fillModeForMetric( 'whatever' ) ).toEqual( {
			fill: 'zero',
			agg: 'max',
		} );
	} );
} );

describe( 'topicChartSeries', () => {
	it( 'sums the chosen metric across a source’s readers per ts, with max/avg', () => {
		const consumers = {
			// Two readers of the SAME source sum per ts.
			'firehose.p0': consumer( 'firehose.p0', [
				{ ts: 100, msgRate: 10, byteRate: 1000, backlog: 4000 },
				{ ts: 115, msgRate: 20, byteRate: 2000, backlog: 0 },
			] ),
			'firehose.job-router.p0': consumer( 'firehose.p0', [
				{ ts: 100, msgRate: 5, byteRate: 500, backlog: 200 },
				{ ts: 115, msgRate: 5, byteRate: 500, backlog: 0 },
			] ),
			'jobs.p0': consumer( 'jobs.p0', [
				{ ts: 100, msgRate: 1, byteRate: 50, backlog: 50 },
			] ),
		};
		const byteRate = topicChartSeries( consumers, 'byteRate' );
		expect( byteRate[ 'firehose.p0' ].points ).toEqual( [
			{ ts: 100, value: 1500 }, // 1000 + 500
			{ ts: 115, value: 2500 }, // 2000 + 500
		] );
		expect( byteRate[ 'firehose.p0' ].max ).toBe( 2500 );
		expect( byteRate[ 'firehose.p0' ].avg ).toBe( 2000 );
		expect( byteRate[ 'jobs.p0' ].points ).toEqual( [
			{ ts: 100, value: 50 },
		] );

		// Same consumers, different metric → backlog series.
		const backlog = topicChartSeries( consumers, 'backlog' );
		expect(
			backlog[ 'firehose.p0' ].points.map( ( p ) => p.value )
		).toEqual( [ 4200, 0 ] );
		expect( backlog[ 'firehose.p0' ].max ).toBe( 4200 );
	} );

	it( 'orders points by ts ascending regardless of consumer order', () => {
		const consumers = {
			'a.p0': consumer( 'a.p0', [
				{ ts: 300, msgRate: 0, byteRate: 0, backlog: 3 },
				{ ts: 100, msgRate: 0, byteRate: 0, backlog: 1 },
				{ ts: 200, msgRate: 0, byteRate: 0, backlog: 2 },
			] ),
		};
		expect(
			topicChartSeries( consumers, 'backlog' )[ 'a.p0' ].points.map(
				( p ) => p.value
			)
		).toEqual( [ 1, 2, 3 ] );
	} );

	it( 'groups by a caller key (source→topology) when given keyOf', () => {
		const consumers = {
			'firehose.p0': consumer( 'firehose.p0', [
				{ ts: 100, msgRate: 0, byteRate: 0, backlog: 1000 },
			] ),
			'requests.p0': consumer( 'requests.p0', [
				{ ts: 100, msgRate: 0, byteRate: 0, backlog: 200 },
			] ),
		};
		const map = { 'firehose.p0': 'combined', 'requests.p0': 'combined' };
		const out = topicChartSeries(
			consumers,
			'backlog',
			( c ) => map[ c.source ]
		);
		expect( out.combined.points ).toEqual( [ { ts: 100, value: 1200 } ] );
	} );

	it( 'skips consumers with no group key and tolerates an empty map', () => {
		expect( topicChartSeries( {}, 'backlog' ) ).toEqual( {} );
		expect(
			topicChartSeries(
				{ 'a.p0': consumer( '', [ { ts: 1, backlog: 1 } ] ) },
				'backlog'
			)
		).toEqual( {} );
	} );
} );
