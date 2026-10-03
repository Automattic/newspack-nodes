import { topicChartSeries, byKey, bySource, maxOf } from '../topicProbeSeries';

// The two groupings a caller declares.
const WHOLE = { byWorker: false };
const SPLIT = { byWorker: true };

// Build a topicprobe:view consumers entry: keyed by reader, source + series.
function consumer( source, series ) {
	return { source, series };
}

describe( 'the mode topicChartSeries stamps on each series', () => {
	const modeOf = ( metric ) =>
		topicChartSeries(
			{ a: { source: 'kea.p3', series: [ { ts: 9, [ metric ]: 41 } ] } },
			metric,
			bySource,
			WHOLE
		)[ 'kea.p3' ].mode;

	it( 'holds a LEVEL gauge and keeps its last reading', () => {
		for ( const metric of [
			'backlog',
			'cacheSize',
			'fileBytes',
			'fileDiskBytes',
			'endBytes',
			'diskBytes',
		] ) {
			expect( modeOf( metric ) ).toEqual( { fill: 'hold', agg: 'last' } );
		}
	} );

	it( 'zero-fills a RATE and re-divides its bucket, the default', () => {
		for ( const metric of [ 'msgRate', 'byteRate', 'whatever' ] ) {
			expect( modeOf( metric ) ).toEqual( { fill: 'zero', agg: 'rate' } );
		}
	} );

	it( 'zero-fills a weighted MEAN and re-divides its bucket by its weight', () => {
		for ( const metric of [ 'queueLatencyMs', 'meanMs' ] ) {
			expect( modeOf( metric ) ).toEqual( { fill: 'zero', agg: 'mean' } );
		}
	} );

	it( 'keeps the largest sample of a MAX metric', () => {
		expect( modeOf( 'maxMs' ) ).toEqual( { fill: 'zero', agg: 'max' } );
	} );
} );

describe( 'topicChartSeries', () => {
	it( 'sums the chosen metric across a source’s readers per ts, with max', () => {
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
		const byteRate = topicChartSeries(
			consumers,
			'byteRate',
			bySource,
			WHOLE
		);
		expect(
			byteRate[ 'firehose.p0' ].points.map( ( p ) => [ p.ts, p.value ] )
		).toEqual( [
			[ 100, 1500 ], // 1000 + 500
			[ 115, 2500 ], // 2000 + 500
		] );
		expect( byteRate[ 'firehose.p0' ].max ).toBe( 2500 );
		expect( byteRate[ 'firehose.p0' ] ).not.toHaveProperty( 'avg' );
		expect(
			byteRate[ 'jobs.p0' ].points.map( ( p ) => [ p.ts, p.value ] )
		).toEqual( [ [ 100, 50 ] ] );

		// Same consumers, different metric → backlog series.
		const backlog = topicChartSeries(
			consumers,
			'backlog',
			bySource,
			WHOLE
		);
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
			topicChartSeries( consumers, 'backlog', bySource, WHOLE )[
				'a.p0'
			].points.map( ( p ) => p.value )
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
			( c ) => map[ c.source ],
			WHOLE
		);
		expect( out.combined.points.map( ( p ) => [ p.ts, p.value ] ) ).toEqual(
			[ [ 100, 1200 ] ]
		);
	} );

	it( "carries each point's elapsed weight so a bucket can re-divide it", () => {
		// A bucket aggregate is Σwork / Σelapsed, so a point has to say how long
		// its own sample covered. Readers sweep in lockstep, so the group takes
		// the widest window at that instant.
		const consumers = {
			'firehose.p0': consumer( 'firehose.p0', [
				{ ts: 100, msgRate: 10, elapsed: 15 },
			] ),
			'firehose.job-router.p0': consumer( 'firehose.p0', [
				{ ts: 100, msgRate: 4, elapsed: 12 },
			] ),
		};
		expect(
			topicChartSeries( consumers, 'msgRate', bySource, WHOLE )[
				'firehose.p0'
			].points
		).toEqual( [ { ts: 100, value: 14, weight: 15 } ] );
	} );

	it( 'weights queue latency by RUNS, not by elapsed — its denominator is runs', () => {
		// queueLatencyMs is a per-run mean, so re-dividing a bucket has to be
		// Σqueue / Σruns. Weighting by seconds would average two windows of very
		// different job counts as if they were equal.
		const consumers = {
			'a.p0': consumer( 'a.p0', [
				{ ts: 100, queueLatencyMs: 800, runsDelta: 4, elapsed: 15 },
			] ),
		};
		expect(
			topicChartSeries( consumers, 'queueLatencyMs', bySource, WHOLE )[
				'a.p0'
			].points[ 0 ]
		).toEqual( { ts: 100, value: 800, weight: 4 } );
	} );

	it( 'skips consumers with no group key and tolerates an empty map', () => {
		expect( topicChartSeries( {}, 'backlog', bySource, WHOLE ) ).toEqual(
			{}
		);
		expect(
			topicChartSeries(
				{ 'a.p0': consumer( '', [ { ts: 1, backlog: 1 } ] ) },
				'backlog',
				bySource,
				WHOLE
			)
		).toEqual( {} );
	} );

	it( 'weights meanMs by the window ops, not its seconds', () => {
		const out = topicChartSeries(
			{
				a: {
					source: 'lab-7:kea.p3',
					series: [ { ts: 9, meanMs: 4, opsDelta: 37, elapsed: 15 } ],
				},
			},
			'meanMs',
			bySource,
			WHOLE
		);
		expect( out[ 'lab-7:kea.p3' ].points[ 0 ].weight ).toBe( 37 );
	} );

	it( 'refuses a call that does not say whether to split by worker', () => {
		expect( () => topicChartSeries( {}, 'msgRate', bySource ) ).toThrow(
			TypeError
		);
	} );
} );

describe( 'topicChartSeries combining samples at one instant', () => {
	const at = ( metric, samples ) =>
		topicChartSeries(
			{ a: { key: 'lab-7:kea.p3', series: samples } },
			metric,
			byKey,
			WHOLE
		)[ 'lab-7:kea.p3' ].points;

	it( 'combines a mean into a weighted mean, ignoring zero weights', () => {
		expect(
			at( 'meanMs', [
				{ ts: 9, meanMs: 40, opsDelta: 3 },
				{ ts: 9, meanMs: 80, opsDelta: 1 },
				{ ts: 9, meanMs: 900, opsDelta: 0 },
			] )
		).toEqual( [ { ts: 9, value: 50, weight: 4 } ] );
	} );

	it( 'reads the plain mean of a mean whose samples all weigh nothing', () => {
		expect(
			at( 'queueLatencyMs', [
				{ ts: 9, queueLatencyMs: 30, runsDelta: 0 },
				{ ts: 9, queueLatencyMs: 70, runsDelta: 0 },
			] )
		).toEqual( [ { ts: 9, value: 50, weight: 0 } ] );
	} );

	it( 'keeps the largest of a max', () => {
		expect(
			at( 'maxMs', [
				{ ts: 9, maxMs: 41, elapsed: 15 },
				{ ts: 9, maxMs: 7, elapsed: 12 },
			] )
		).toEqual( [ { ts: 9, value: 41, weight: 15 } ] );
	} );

	it( 'sums a level', () => {
		expect(
			at( 'fileBytes', [
				{ ts: 9, fileBytes: 4096, elapsed: 15 },
				{ ts: 9, fileBytes: 8192, elapsed: 15 },
			] )
		).toEqual( [ { ts: 9, value: 12288, weight: 15 } ] );
	} );
} );

describe( 'topicChartSeries per worker', () => {
	const entries = {
		'cron:films': {
			key: 'cron:films',
			handler: 'cron',
			series: [
				{ ts: 100, runsRate: 3, worker: 'job-worker-4417.p2' },
				{ ts: 100, runsRate: 5, worker: 'job-worker-4417.p6' },
				{ ts: 115, runsRate: 7, worker: 'job-worker-4417.p2' },
				{ ts: 115, runsRate: 11, worker: '' },
			],
		},
	};
	const values = ( out, key ) => out[ key ].points.map( ( p ) => p.value );

	it( 'charts each worker apart when the caller splits by worker', () => {
		const out = topicChartSeries( entries, 'runsRate', byKey, SPLIT );
		expect( Object.keys( out ).sort() ).toEqual( [
			'cron:films',
			'cron:films · job-worker-4417.p2',
			'cron:films · job-worker-4417.p6',
		] );
		expect( values( out, 'cron:films · job-worker-4417.p2' ) ).toEqual( [
			3, 7,
		] );
		expect( values( out, 'cron:films · job-worker-4417.p6' ) ).toEqual( [
			5,
		] );
		expect( values( out, 'cron:films' ) ).toEqual( [ 11 ] );
	} );

	it( 'keeps every key whole when the caller does not split by worker', () => {
		const out = topicChartSeries( entries, 'runsRate', byKey, WHOLE );
		expect( Object.keys( out ) ).toEqual( [ 'cron:films' ] );
		expect( values( out, 'cron:films' ) ).toEqual( [ 8, 18 ] );
	} );

	it( 'splits a LEVEL gauge per worker too, each worker its own debt', () => {
		const out = topicChartSeries(
			{
				'job-worker.jobs.p0': {
					source: 'jobs.p0',
					series: [ { ts: 9, backlog: 4096, worker: 'kea-7713.p3' } ],
				},
			},
			'backlog',
			bySource,
			SPLIT
		);
		expect( Object.keys( out ) ).toEqual( [ 'jobs.p0 · kea-7713.p3' ] );
	} );

	it( 'keeps a mean or a max whole per key the caller keeps whole', () => {
		for ( const metric of [ 'queueLatencyMs', 'meanMs', 'maxMs' ] ) {
			const out = topicChartSeries(
				{
					a: {
						key: 'cron:films',
						series: [
							{ ts: 100, [ metric ]: 40, worker: 'w.p2' },
							{ ts: 107, [ metric ]: 80, worker: 'w.p6' },
						],
					},
				},
				metric,
				byKey,
				WHOLE
			);
			expect( Object.keys( out ) ).toEqual( [ 'cron:films' ] );
			expect( values( out, 'cron:films' ) ).toEqual( [ 40, 80 ] );
		}
	} );

	it( 'keeps a Table identity whole, its key already naming one worker', () => {
		for ( const metric of [ 'opsRate', 'missRate', 'fileBytes' ] ) {
			const out = topicChartSeries(
				{
					a: {
						key: 'lab-7:kea.p3',
						series: [ { ts: 9, [ metric ]: 41, worker: 'w.p3' } ],
					},
				},
				metric,
				byKey,
				WHOLE
			);
			expect( Object.keys( out ) ).toEqual( [ 'lab-7:kea.p3' ] );
		}
	} );

	it( 'merges entries that share a key and a worker into one stream', () => {
		const out = topicChartSeries(
			{
				a: {
					op: 'GET',
					series: [ { ts: 9, value: 2, worker: 'w.p1' } ],
				},
				b: {
					op: 'GET',
					series: [ { ts: 9, value: 4, worker: 'w.p1' } ],
				},
			},
			'value',
			( c ) => c.op,
			SPLIT
		);
		expect( Object.keys( out ) ).toEqual( [ 'GET · w.p1' ] );
		expect( out[ 'GET · w.p1' ].points ).toEqual( [
			{ ts: 9, value: 6, weight: 0 },
		] );
	} );
} );

describe( 'topicChartSeries and a figure that does not apply', () => {
	it( 'charts no point for a null sample, and no series of none', () => {
		const out = topicChartSeries(
			{
				'lab-7:kea.p3': {
					key: 'lab-7:kea.p3',
					series: [
						{ ts: 9, fileBytes: 8192 },
						{ ts: 24, fileBytes: null },
					],
				},
				'lab-7:emu.p3': {
					key: 'lab-7:emu.p3',
					series: [ { ts: 9, fileBytes: null } ],
				},
			},
			'fileBytes',
			byKey,
			WHOLE
		);
		expect( Object.keys( out ) ).toEqual( [ 'lab-7:kea.p3' ] );
		expect( out[ 'lab-7:kea.p3' ].points ).toEqual( [
			{ ts: 9, value: 8192, weight: 0 },
		] );
	} );
} );

describe( 'byKey, bySource and maxOf', () => {
	it( 'byKey reads an entry’s own key, bySource its source', () => {
		const entry = { key: 'cron:films', source: 'jobs.p0' };
		expect( byKey( entry ) ).toBe( 'cron:films' );
		expect( bySource( entry ) ).toBe( 'jobs.p0' );
	} );

	it( 'maxOf is the largest value, 0 for none', () => {
		expect( maxOf( [ { value: 3 }, { value: 4471 }, { value: 9 } ] ) ).toBe(
			4471
		);
		expect( maxOf( [] ) ).toBe( 0 );
	} );
} );

describe( 'a worker’s Tables swept at one instant', () => {
	it( 'sum into one point, where staggered stamps chart apart', () => {
		const table = ( ts, opsRate ) => ( {
			key: 'flame-stats',
			series: [
				{ ts, opsRate, elapsed: 15000, worker: 'job-worker-4417.p3' },
			],
		} );
		const shared = topicChartSeries(
			{
				a: table( 1790000123.25, 7 ),
				b: table( 1790000123.25, 11 ),
				c: table( 1790000123.25, 13 ),
			},
			'opsRate',
			byKey,
			SPLIT
		);
		expect(
			shared[ 'flame-stats · job-worker-4417.p3' ].points.map( ( p ) => [
				p.ts,
				p.value,
			] )
		).toEqual( [ [ 1790000123.25, 31 ] ] );

		const staggered = topicChartSeries(
			{
				a: table( 1790000123.25, 7 ),
				b: table( 1790000123.2637, 11 ),
				c: table( 1790000123.2774, 13 ),
			},
			'opsRate',
			byKey,
			SPLIT
		);
		expect(
			staggered[ 'flame-stats · job-worker-4417.p3' ].points
		).toHaveLength( 3 );
	} );
} );
