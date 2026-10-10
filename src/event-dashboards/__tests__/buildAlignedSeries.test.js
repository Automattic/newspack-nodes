/**
 * buildAlignedSeries — snap the per-topic probe series onto ONE shared,
 * epoch-aligned time-bucket grid (bucket = probe interval, widened only to keep
 * the axis under `maxPoints`), then fill each bucket per the metric's mode:
 * LEVEL gauges (backlog/cacheSize) HOLD the last value across empty buckets
 * (0 before the first sample); RATE metrics zero-fill and re-divide the bucket's
 * summed work by its summed weight. This kills the phase-offset sawtooth the old
 * raw-union + `?? 0` path drew. No DOM.
 */

import { buildAlignedSeries } from '../buildAlignedSeries';

const HOLD = { fill: 'hold', agg: 'last' };
const ZERO = { fill: 'zero', agg: 'rate' };

// Stamp one mode on every series of a panel, as topicChartSeries does.
const withMode = ( series, mode ) =>
	Object.fromEntries(
		Object.entries( series ).map( ( [ k, v ] ) => [ k, { ...v, mode } ] )
	);

describe( 'buildAlignedSeries', () => {
	it( 'returns empty when no series have points', () => {
		expect( buildAlignedSeries( withMode( {}, HOLD ), 100 ) ).toEqual( {
			series: [],
			dates: [],
		} );
		expect(
			buildAlignedSeries(
				withMode( { a: { points: [], max: 0 } }, HOLD ),
				100
			)
		).toEqual( { series: [], dates: [] } );
	} );

	it( 'aligns two LEVEL topics sampled 15s out of phase onto the SAME buckets — no interleaved zeros, smooth decline stays monotonic', () => {
		const out = buildAlignedSeries(
			withMode(
				{
					a: {
						points: [
							{ ts: 0, value: 300 },
							{ ts: 15, value: 200 },
							{ ts: 30, value: 100 },
						],
						max: 300,
					},
					b: {
						points: [
							{ ts: 7, value: 300 },
							{ ts: 22, value: 200 },
							{ ts: 37, value: 100 },
						],
						max: 300,
					},
				},
				HOLD
			),
			100
		);
		// Both phases floor into the same 15s buckets: 0, 15, 30.
		expect( out.dates.map( ( d ) => d.getTime() / 1000 ) ).toEqual( [
			0, 15, 30,
		] );
		// Each topic has ONE value per bucket, no 0 dips, monotone decline.
		out.series.forEach( ( s ) => {
			expect( s.values.map( ( v ) => v.value ) ).toEqual( [
				300, 200, 100,
			] );
		} );
	} );

	it( 'HOLDS a LEVEL topic’s previous value across a genuinely-skipped bucket', () => {
		const out = buildAlignedSeries(
			withMode(
				{
					a: {
						points: [
							{ ts: 0, value: 500 },
							{ ts: 30, value: 300 },
						],
						max: 500,
					},
				},
				HOLD
			),
			100
		);
		// Grid 0,15,30 — bucket 15 has no sample, so it holds 500 (not 0).
		expect( out.series[ 0 ].values.map( ( v ) => v.value ) ).toEqual( [
			500, 500, 300,
		] );
	} );

	it( 'stops holding a LEVEL topic once it falls out of the live window', () => {
		const out = buildAlignedSeries(
			withMode(
				{
					// Its newest sample sits 120 s behind the live series.
					'departed.p0': {
						points: [ { ts: 1365, value: 4100, weight: 15 } ],
						max: 4100,
					},
					'live.p0': {
						points: [
							{ ts: 1365, value: 2700, weight: 15 },
							{ ts: 1485, value: 2900, weight: 15 },
						],
						max: 2900,
					},
					// Its newest sample sits 45 s behind, inside the window.
					'recent.p0': {
						points: [ { ts: 1440, value: 3300, weight: 15 } ],
						max: 3300,
					},
				},
				HOLD
			),
			100
		);
		const at = ( label ) =>
			out.series.find( ( s ) => s.label === label ).values.at( -1 ).value;
		expect( at( 'departed.p0' ) ).toBe( 0 );
		expect( at( 'live.p0' ) ).toBe( 2900 );
		expect( at( 'recent.p0' ) ).toBe( 3300 );
		// Held while still inside the window: bucket 1425 reads 4100.
		const departed = out.series.find( ( s ) => s.label === 'departed.p0' );
		expect(
			departed.values.find( ( v ) => 1425000 === v.date.getTime() ).value
		).toBe( 4100 );
	} );

	it( 'stops holding across a gap in the middle of a LEVEL series, then resumes', () => {
		// A 3 h fleet hold between two runs of samples.
		const resume = 1500 + 3 * 3600;
		const out = buildAlignedSeries(
			withMode(
				{
					'held.p2': {
						points: [
							{ ts: 1485, value: 6100, weight: 15 },
							{ ts: 1500, value: 6300, weight: 15 },
							{ ts: resume, value: 7700, weight: 15 },
						],
						max: 7700,
					},
				},
				HOLD
			),
			0
		);
		const at = ( ts ) =>
			out.series[ 0 ].values.find(
				( v ) => ts * 1000 === v.date.getTime()
			).value;
		expect( at( 1545 ) ).toBe( 6300 );
		expect( at( 1575 ) ).toBe( 0 );
		expect( at( 1500 + 3600 ) ).toBe( 0 );
		expect( at( resume ) ).toBe( 7700 );
	} );

	it( 'a LEVEL topic reads 0 for buckets before its first sample', () => {
		const out = buildAlignedSeries(
			withMode(
				{
					// `wide` spans grid 0..30; `late` appears at bucket 30.
					wide: {
						points: [
							{ ts: 0, value: 100 },
							{ ts: 15, value: 100 },
							{ ts: 30, value: 100 },
						],
						max: 100,
					},
					late: { points: [ { ts: 30, value: 400 } ], max: 400 },
				},
				HOLD
			),
			100
		);
		// Ranked by max: `late` (400) first.
		expect( out.series[ 0 ].label ).toBe( 'late' );
		expect( out.series[ 0 ].values.map( ( v ) => v.value ) ).toEqual( [
			0, 0, 400,
		] );
	} );

	it( 'a RATE bucket SUMS the work of every sample in it, rather than letting one win', () => {
		// Two samples from ONE source land in the same bucket: 10/s over 15s
		// (150 units) and 0/s over 15s (0 units) is 150 units over 30s = 5/s.
		// Taking the max would report 10/s and silently discard the idle window.
		const out = buildAlignedSeries(
			withMode(
				{
					a: {
						points: [
							{ ts: 0, value: 10, weight: 15 },
							{ ts: 5, value: 0, weight: 15 },
							{ ts: 30, value: 20, weight: 15 },
						],
						max: 20,
					},
				},
				ZERO
			),
			100
		);
		expect( out.series[ 0 ].values.map( ( v ) => v.value ) ).toEqual( [
			5, 0, 20,
		] );
	} );

	it( 'weights a RATE bucket by each sample’s own interval', () => {
		// 60/s across 1s (60 units) + 0/s across 14s = 60 units over 15s = 4/s.
		const out = buildAlignedSeries(
			withMode(
				{
					a: {
						points: [
							{ ts: 0, value: 60, weight: 1 },
							{ ts: 1, value: 0, weight: 14 },
						],
						max: 60,
					},
				},
				ZERO
			),
			100
		);
		expect( out.series[ 0 ].values[ 0 ].value ).toBe( 4 );
	} );

	it( 'falls back to a plain mean when a RATE bucket carries no weights', () => {
		const out = buildAlignedSeries(
			withMode(
				{
					a: {
						points: [
							{ ts: 0, value: 10 },
							{ ts: 5, value: 40 },
						],
						max: 40,
					},
				},
				ZERO
			),
			100
		);
		expect( out.series[ 0 ].values[ 0 ].value ).toBe( 25 );
	} );

	it( 'ignores idle zero-weight samples beside a weighted one in a RATE bucket', () => {
		// A 10 ms mean over 4 ops plus three idle windows: the mean is 10 ms.
		const out = buildAlignedSeries(
			withMode(
				{
					a: {
						points: [
							{ ts: 0, value: 10, weight: 4 },
							{ ts: 1, value: 0, weight: 0 },
							{ ts: 2, value: 0, weight: 0 },
							{ ts: 3, value: 0, weight: 0 },
						],
						max: 10,
					},
				},
				ZERO
			),
			100
		);
		expect( out.series[ 0 ].values[ 0 ].value ).toBe( 10 );
	} );

	it( 'defaults to RATE behavior (zero-fill + re-divide) when no mode is given', () => {
		const out = buildAlignedSeries(
			{
				a: {
					points: [
						{ ts: 0, value: 10, weight: 15 },
						{ ts: 30, value: 20, weight: 15 },
					],
					max: 20,
				},
			},
			100
		);
		expect( out.series[ 0 ].values.map( ( v ) => v.value ) ).toEqual( [
			10, 0, 20,
		] );
	} );

	it( 'ranks topics by peak', () => {
		const out = buildAlignedSeries(
			withMode(
				{
					low: { points: [ { ts: 0, value: 1 } ], max: 1 },
					high: { points: [ { ts: 0, value: 9 } ], max: 9 },
				},
				ZERO
			),
			100
		);
		expect( out.series.map( ( s ) => s.label ) ).toEqual( [
			'high',
			'low',
		] );
	} );

	it( 'never emits more than maxPoints buckets for a window that would exceed it', () => {
		// 5001 samples ~15s apart → ~5000 slots, far past the maxPoints cap.
		const points = Array.from( { length: 5001 }, ( _, i ) => ( {
			ts: i * 15,
			value: i,
		} ) );
		const out = buildAlignedSeries(
			withMode( { a: { points, max: 5000 } }, ZERO ),
			100
		);
		expect( out.dates.length ).toBeLessThanOrEqual( 100 );
		expect( out.series[ 0 ].values.length ).toBe( out.dates.length );
	} );

	it( 'a MAX bucket keeps its largest sample and an empty one reads 0', () => {
		const out = buildAlignedSeries(
			withMode(
				{
					'lab-7:kea.p3 max': {
						points: [
							{ ts: 1500, value: 4.25, weight: 15 },
							{ ts: 1505, value: 9.75, weight: 15 },
							{ ts: 1530, value: 2.5, weight: 15 },
						],
						max: 9.75,
					},
				},
				{ fill: 'zero', agg: 'max' }
			),
			0
		);
		expect( out.series[ 0 ].values.map( ( v ) => v.value ) ).toEqual( [
			9.75, 0, 2.5,
		] );
	} );

	it( 'aggregates each series of one panel under its own mode', () => {
		const out = buildAlignedSeries(
			{
				mean: {
					points: [
						{ ts: 1500, value: 2, weight: 1 },
						{ ts: 1505, value: 8, weight: 3 },
					],
					max: 8,
					mode: { fill: 'zero', agg: 'rate' },
				},
				peak: {
					points: [
						{ ts: 1500, value: 3, weight: 1 },
						{ ts: 1505, value: 11, weight: 1 },
					],
					max: 11,
					mode: { fill: 'zero', agg: 'max' },
				},
			},
			0
		);
		const byLabel = Object.fromEntries(
			out.series.map( ( s ) => [ s.label, s.values[ 0 ].value ] )
		);
		expect( byLabel.mean ).toBe( 6.5 );
		expect( byLabel.peak ).toBe( 11 );
	} );

	it( 'a MEAN bucket re-divides its samples by their weight', () => {
		const out = buildAlignedSeries(
			{
				'lab-7:kea.p3': {
					points: [
						{ ts: 1500, value: 40, weight: 3 },
						{ ts: 1505, value: 80, weight: 1 },
						{ ts: 1510, value: 900, weight: 0 },
					],
					max: 900,
					mode: { fill: 'zero', agg: 'mean' },
				},
			},
			0
		);
		expect( out.series[ 0 ].values[ 0 ].value ).toBe( 50 );
	} );

	it( 'maps a day of 180-second buckets one to one onto a 500-point axis', () => {
		const start = 1755000000;
		const points = Array.from( { length: 480 }, ( _, i ) => ( {
			ts: start + i * 180 + 165,
			value: i + 1,
			weight: 15,
		} ) );
		const { series, dates } = buildAlignedSeries(
			{ 'kea.p3': { points, max: 480, step: 180 } },
			500
		);
		expect( dates ).toHaveLength( 480 );
		expect( dates[ 1 ] - dates[ 0 ] ).toBe( 180000 );
		expect( series[ 0 ].values.map( ( v ) => v.value ) ).toEqual(
			points.map( ( p ) => p.value )
		);
	} );

	it( 'widens a stepped series by whole steps, never off its grid', () => {
		const start = 1755000000;
		const points = Array.from( { length: 40 }, ( _, i ) => ( {
			ts: start + i * 180 + 10,
			value: 6,
			weight: 15,
		} ) );
		const { dates } = buildAlignedSeries(
			{ 'kea.p3': { points, max: 6, step: 180 } },
			12
		);
		const widths = new Set(
			dates.slice( 1 ).map( ( d, i ) => ( d - dates[ i ] ) / 1000 )
		);
		expect( [ ...widths ] ).toEqual( [ 720 ] );
		expect( ( dates[ 0 ].getTime() / 1000 ) % 720 ).toBe( 0 );
	} );

	it( 'holds a stepped series at its step when maxPoints is 0, however long the window', () => {
		const start = 1755000000;
		const points = Array.from( { length: 300 }, ( _, i ) => ( {
			ts: start + i * 180 + 25,
			value: 9,
			weight: 15,
		} ) );
		const { dates } = buildAlignedSeries(
			{ 'kea.p3': { points, max: 9, step: 180 } },
			0
		);
		// 54,000 s would be 3,600 points on the 15-second grid.
		expect( dates ).toHaveLength( 300 );
		const widths = new Set(
			dates.slice( 1 ).map( ( d, i ) => ( d - dates[ i ] ) / 1000 )
		);
		expect( [ ...widths ] ).toEqual( [ 180 ] );
	} );

	it( 'keeps the 15-second base for a series that declares no step', () => {
		const points = [ 0, 5, 10, 15, 20 ].map( ( d ) => ( {
			ts: 1755000000 + d,
			value: 4,
		} ) );
		const { dates } = buildAlignedSeries( { In: { points, max: 4 } }, 500 );
		expect( dates[ 1 ] - dates[ 0 ] ).toBe( 15000 );
	} );
} );
