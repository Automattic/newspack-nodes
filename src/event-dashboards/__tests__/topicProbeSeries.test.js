import { topicChartSeries, byKey, bySource, maxOf } from '../topicProbeSeries';
import { bucketsFrom } from './bucketTestUtils';

// The two groupings a caller declares.
const WHOLE = { byWorker: false };
const SPLIT = { byWorker: true };

// Build a topicprobe:view consumers entry: keyed by reader, source + buckets.
function consumer( source, samples ) {
	return { source, buckets: bucketsFrom( samples ) };
}

// Every raw field a chart metric reads, so any metric charts a point.
const RAW = {
	elapsed: 15,
	msgs: 41,
	bytes: 41,
	runsDelta: 41,
	errorsDelta: 41,
	itemsOkDelta: 41,
	opsDelta: 41,
	misses: 41,
	queueDelta: 41,
	ms: 41,
};

describe( 'the mode topicChartSeries stamps on each series', () => {
	const modeOf = ( metric ) =>
		topicChartSeries(
			{
				a: consumer( 'kea.p3', [ { ts: 9, ...RAW, [ metric ]: 41 } ] ),
			},
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

describe( 'the raw fields each chart metric reads', () => {
	const t0 = 1755000000;
	const valueOf = ( metric, sample ) =>
		topicChartSeries(
			{
				a: {
					key: 'kea',
					buckets: bucketsFrom( [ { ts: t0, ...sample } ] ),
				},
			},
			metric,
			byKey,
			WHOLE
		).kea.points[ 0 ].value;

	it( 'divides a rate’s summed delta by its summed elapsed', () => {
		const rates = {
			msgRate: 'msgs',
			byteRate: 'bytes',
			runsRate: 'runsDelta',
			errorsRate: 'errorsDelta',
			opsRate: 'opsDelta',
			missRate: 'misses',
			'op:SMOVE': 'op:SMOVE',
		};
		for ( const [ metric, num ] of Object.entries( rates ) ) {
			expect( valueOf( metric, { elapsed: 12, [ num ]: 87 } ) ).toBe(
				87 / 12
			);
		}
	} );

	it( 'divides a mean by the units it averages over', () => {
		expect(
			valueOf( 'queueLatencyMs', { queueDelta: 930, runsDelta: 6 } )
		).toBe( 155 );
		expect( valueOf( 'meanMs', { ms: 148, opsDelta: 37 } ) ).toBe( 4 );
	} );

	it( 'counts a zero-elapsed record’s delta in its bucket’s rate', () => {
		const out = topicChartSeries(
			{
				r1: consumer( 'kea.p3', [
					{ ts: t0 + 15, elapsed: 15, msgs: 100 },
					{ ts: t0 + 16, elapsed: 0, msgs: 91 },
				] ),
			},
			'msgRate',
			bySource,
			WHOLE
		)[ 'kea.p3' ];
		expect( out.points[ 0 ].value ).toBe( 191 / 15 );
	} );

	it( 'reads a rate as 0 over a window with no elapsed', () => {
		expect( valueOf( 'msgRate', { elapsed: 0, msgs: 91 } ) ).toBe( 0 );
	} );
} );

describe( 'topicChartSeries over buckets', () => {
	const t0 = 1755000000;

	it( 're-divides one entry’s rate by its bucket’s elapsed, and adds two readers of one source', () => {
		const out = topicChartSeries(
			{
				r1: consumer( 'kea.p3', [
					{ ts: t0 + 15, elapsed: 10, msgs: 60 },
					{ ts: t0 + 30, elapsed: 30, msgs: 60 },
				] ),
				r2: consumer( 'kea.p3', [
					{ ts: t0 + 20, elapsed: 15, msgs: 60 },
				] ),
			},
			'msgRate',
			bySource,
			WHOLE
		)[ 'kea.p3' ];
		expect( out.points ).toEqual( [
			{ ts: t0 + 30, value: ( 60 + 60 ) / 40 + 60 / 15, weight: 40 },
		] );
		expect( out.step ).toBe( 180 );
	} );

	it( 'pools a mean across entries, weighed by the units it averages over', () => {
		const out = topicChartSeries(
			{
				a: {
					key: 'mail',
					buckets: bucketsFrom( [
						{ ts: t0 + 15, runsDelta: 3, queueDelta: 300 },
					] ),
				},
				b: {
					key: 'mail',
					buckets: bucketsFrom( [
						{ ts: t0 + 15, runsDelta: 1, queueDelta: 900 },
					] ),
				},
			},
			'queueLatencyMs',
			byKey,
			WHOLE
		).mail;
		expect( out.points[ 0 ].value ).toBe( ( 300 + 900 ) / 4 );
		expect( out.points[ 0 ].weight ).toBe( 4 );
	} );

	it( 'weighs meanMs by the window ops, not its seconds', () => {
		const out = topicChartSeries(
			{
				a: {
					key: 'lab-7:kea.p3',
					buckets: bucketsFrom( [
						{ ts: t0 + 9, ms: 148, opsDelta: 37, elapsed: 15 },
					] ),
				},
			},
			'meanMs',
			byKey,
			WHOLE
		);
		expect( out[ 'lab-7:kea.p3' ].points[ 0 ] ).toEqual( {
			ts: t0 + 9,
			value: 4,
			weight: 37,
		} );
	} );

	it( 'reads a mean whose window ran nothing as 0', () => {
		const out = topicChartSeries(
			{
				a: {
					key: 'mail',
					buckets: bucketsFrom( [
						{ ts: t0 + 15, runsDelta: 0, queueDelta: 0 },
						{ ts: t0 + 30, runsDelta: 0, queueDelta: 0 },
					] ),
				},
			},
			'queueLatencyMs',
			byKey,
			WHOLE
		).mail;
		expect( out.points ).toEqual( [
			{ ts: t0 + 30, value: 0, weight: 0 },
		] );
	} );

	it( 'adds the newest levels of a group and keeps the largest of a max', () => {
		const levels = topicChartSeries(
			{
				r1: consumer( 'kea.p3', [
					{ ts: t0 + 15, backlog: 900 },
					{ ts: t0 + 45, backlog: 300 },
				] ),
				r2: consumer( 'kea.p3', [ { ts: t0 + 20, backlog: 70 } ] ),
			},
			'backlog',
			bySource,
			WHOLE
		)[ 'kea.p3' ];
		expect( levels.points ).toEqual( [
			{ ts: t0 + 45, value: 370, weight: 0 },
		] );

		const peaks = topicChartSeries(
			{
				a: {
					key: 'flame',
					buckets: bucketsFrom( [
						{ ts: t0 + 15, maxMs: 12 },
						{ ts: t0 + 30, maxMs: 81 },
					] ),
				},
			},
			'maxMs',
			byKey,
			WHOLE
		).flame;
		expect( peaks.points ).toEqual( [
			{ ts: t0 + 30, value: 81, weight: 0 },
		] );
	} );

	it( 'adds each entry’s newest level across its rows, then adds the entries', () => {
		const out = topicChartSeries(
			{
				'ledger.p4': {
					source: 'ledger.p4',
					buckets: bucketsFrom( [
						{ ts: t0 + 15, worker: 'kea-2.p2', endBytes: 5003 },
						{ ts: t0 + 20, worker: 'emu-6.p0', endBytes: 5780 },
						{ ts: t0 + 17, worker: 'kea-2.p2', endBytes: 5100 },
					] ),
				},
				'jobs.p4': {
					source: 'jobs.p4',
					buckets: bucketsFrom( [
						{ ts: t0 + 16, worker: 'kea-2.p2', endBytes: 70 },
					] ),
				},
			},
			'endBytes',
			() => 'all',
			WHOLE
		).all;
		expect( out.points ).toEqual( [
			{ ts: t0 + 20, value: 5780 + 70, weight: 0 },
		] );
	} );

	it( 'charts a Table two worker types hold at its newer size, not the sum or the larger', () => {
		// The file shrank after a vacuum, so the newer reading is the smaller.
		const out = topicChartSeries(
			{
				'flame-stats.p3': {
					key: 'flame-stats.p3',
					buckets: bucketsFrom( [
						{
							ts: t0 + 40,
							worker: 'flame-builder.p3',
							fileBytes: 57344,
						},
						{
							ts: t0 + 25,
							worker: 'job-worker.p3',
							fileBytes: 61440,
						},
					] ),
				},
			},
			'fileBytes',
			byKey,
			WHOLE
		)[ 'flame-stats.p3' ];
		expect( out.points ).toEqual( [
			{ ts: t0 + 40, value: 57344, weight: 0 },
		] );
	} );

	it( 'orders points by bucket across entries and workers', () => {
		const out = topicChartSeries(
			{
				r1: consumer( 'kea.p3', [
					{ ts: t0 + 400, elapsed: 15, msgs: 15 },
				] ),
				r2: consumer( 'kea.p3', [
					{ ts: t0 + 15, elapsed: 15, msgs: 30 },
				] ),
			},
			'msgRate',
			bySource,
			WHOLE
		)[ 'kea.p3' ];
		expect( out.points.map( ( p ) => p.ts ) ).toEqual( [
			t0 + 15,
			t0 + 400,
		] );
	} );

	it( 'sums a worker’s Tables in one bucket into one point', () => {
		const table = ( ts, opsDelta ) => ( {
			key: 'flame-stats',
			buckets: bucketsFrom( [
				{ ts, opsDelta, elapsed: 15, worker: 'job-worker-4417.p3' },
			] ),
		} );
		const out = topicChartSeries(
			{
				a: table( t0 + 123.25, 105 ),
				b: table( t0 + 123.2637, 165 ),
				c: table( t0 + 123.2774, 195 ),
			},
			'opsRate',
			byKey,
			SPLIT
		);
		expect(
			out[ 'flame-stats · job-worker-4417.p3' ].points.map( ( p ) => [
				p.ts,
				p.value,
			] )
		).toEqual( [ [ t0 + 123.2774, 31 ] ] );
	} );
} );

describe( 'topicChartSeries', () => {
	it( 'groups by a caller key (source→topology) when given keyOf', () => {
		const consumers = {
			'firehose.p0': consumer( 'firehose.p0', [
				{ ts: 100, backlog: 1000 },
			] ),
			'requests.p0': consumer( 'requests.p0', [
				{ ts: 100, backlog: 200 },
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

	it( 'refuses a call that does not say whether to split by worker', () => {
		expect( () => topicChartSeries( {}, 'msgRate', bySource ) ).toThrow(
			TypeError
		);
	} );
} );

describe( 'topicChartSeries per worker', () => {
	const run = ( ts, runsDelta, worker ) => ( {
		ts,
		runsDelta,
		elapsed: 15,
		worker,
	} );
	const entries = {
		'cron:films': {
			key: 'cron:films',
			handler: 'cron',
			buckets: bucketsFrom( [
				run( 100, 45, 'job-worker-4417.p2' ),
				run( 100, 75, 'job-worker-4417.p6' ),
				run( 300, 105, 'job-worker-4417.p2' ),
				run( 300, 165, '' ),
			] ),
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
				'job-worker.jobs.p0': consumer( 'jobs.p0', [
					{ ts: 9, backlog: 4096, worker: 'kea-7713.p3' },
				] ),
			},
			'backlog',
			bySource,
			SPLIT
		);
		expect( Object.keys( out ) ).toEqual( [ 'jobs.p0 · kea-7713.p3' ] );
	} );

	it( 'keeps a mean or a max whole per key the caller keeps whole', () => {
		const raw = {
			queueLatencyMs: ( v ) => ( { queueDelta: v, runsDelta: 1 } ),
			meanMs: ( v ) => ( { ms: v, opsDelta: 1 } ),
			maxMs: ( v ) => ( { maxMs: v } ),
		};
		for ( const [ metric, fields ] of Object.entries( raw ) ) {
			const out = topicChartSeries(
				{
					a: {
						key: 'cron:films',
						buckets: bucketsFrom( [
							{ ts: 100, ...fields( 40 ), worker: 'w.p2' },
							{ ts: 300, ...fields( 80 ), worker: 'w.p6' },
						] ),
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

	it( 'keeps the larger max of two workers folded into one bucket of a whole key', () => {
		const out = topicChartSeries(
			{
				a: {
					key: 'cron:films',
					buckets: bucketsFrom( [
						{ ts: 100, maxMs: 41, worker: 'w.p2' },
						{ ts: 107, maxMs: 83, worker: 'w.p6' },
					] ),
				},
			},
			'maxMs',
			byKey,
			WHOLE
		);
		expect( out[ 'cron:films' ].points ).toEqual( [
			{ ts: 107, value: 83, weight: 0 },
		] );
	} );

	it( 'keeps a Table identity whole when the caller does not split by worker', () => {
		const raw = {
			opsRate: 'opsDelta',
			missRate: 'misses',
			fileBytes: 'fileBytes',
		};
		for ( const [ metric, field ] of Object.entries( raw ) ) {
			const out = topicChartSeries(
				{
					a: {
						key: 'lab-7:kea.p3',
						buckets: bucketsFrom( [
							{
								ts: 9,
								elapsed: 15,
								[ field ]: 41,
								worker: 'w.p3',
							},
						] ),
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
					buckets: bucketsFrom( [
						{ ts: 9, value: 30, elapsed: 15, worker: 'w.p1' },
					] ),
				},
				b: {
					op: 'GET',
					buckets: bucketsFrom( [
						{ ts: 9, value: 60, elapsed: 15, worker: 'w.p1' },
					] ),
				},
			},
			'value',
			( c ) => c.op,
			SPLIT
		);
		expect( Object.keys( out ) ).toEqual( [ 'GET · w.p1' ] );
		expect( out[ 'GET · w.p1' ].points ).toEqual( [
			{ ts: 9, value: 6, weight: 15 },
		] );
	} );
} );

describe( 'topicChartSeries and a figure that does not apply', () => {
	it( 'charts no point for a null sample, and no series of none', () => {
		const out = topicChartSeries(
			{
				'lab-7:kea.p3': {
					key: 'lab-7:kea.p3',
					buckets: bucketsFrom( [
						{ ts: 9, fileBytes: 8192 },
						{ ts: 24, fileBytes: null },
					] ),
				},
				'lab-7:emu.p3': {
					key: 'lab-7:emu.p3',
					buckets: bucketsFrom( [ { ts: 9, fileBytes: null } ] ),
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
