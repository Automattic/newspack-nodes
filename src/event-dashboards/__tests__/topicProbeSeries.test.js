import { topologySeries, downsample } from '../topicProbeSeries';

// Build a topicprobe:view `consumers` map entry (the real snapshot() shape:
// keyed by reader, carrying `source` + `series`, NO worker_type).
function consumer( source, series ) {
	return {
		source,
		latest: series[ series.length - 1 ] || { ts: 0, rate: 0, backlog: 0 },
		series,
	};
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

describe( 'topologySeries', () => {
	it( 'groups consumers by source and sums backlog + rate across its readers per ts', () => {
		const consumers = {
			// Two distinct readers of the SAME source sum together.
			'firehose.p0': consumer( 'firehose.p0', [
				{ ts: 100, rate: 10, backlog: 1000 },
				{ ts: 115, rate: 20, backlog: 500 },
			] ),
			'firehose.job-router.p0': consumer( 'firehose.p0', [
				{ ts: 100, rate: 5, backlog: 200 },
				{ ts: 115, rate: 5, backlog: 0 },
			] ),
			'jobs.p0': consumer( 'jobs.p0', [
				{ ts: 100, rate: 1, backlog: 50 },
			] ),
		};
		const out = topologySeries( consumers, 48 );

		// firehose.p0 = the two readers summed per ts.
		expect( out[ 'firehose.p0' ].backlog ).toEqual( [ 1200, 500 ] ); // 1000+200, 500+0
		expect( out[ 'firehose.p0' ].rate ).toEqual( [ 15, 25 ] ); // 10+5, 20+5
		expect( out[ 'firehose.p0' ].latestBacklog ).toBe( 500 );
		expect( out[ 'firehose.p0' ].latestRate ).toBe( 25 );
		// jobs.p0 stands alone.
		expect( out[ 'jobs.p0' ].backlog ).toEqual( [ 50 ] );
	} );

	it( 'orders the aggregated series by ts ascending regardless of consumer order', () => {
		const consumers = {
			'a.p0': consumer( 'a.p0', [
				{ ts: 300, rate: 0, backlog: 3 },
				{ ts: 100, rate: 0, backlog: 1 },
				{ ts: 200, rate: 0, backlog: 2 },
			] ),
		};
		expect( topologySeries( consumers )[ 'a.p0' ].backlog ).toEqual( [
			1, 2, 3,
		] );
	} );

	it( 'skips consumers with no source and tolerates an empty map', () => {
		expect( topologySeries( {} ) ).toEqual( {} );
		expect(
			topologySeries( {
				'a.p0': consumer( '', [ { ts: 1, rate: 1, backlog: 1 } ] ),
			} )
		).toEqual( {} );
	} );
} );
