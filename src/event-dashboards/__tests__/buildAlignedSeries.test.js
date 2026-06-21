/**
 * buildAlignedSeries — aligns the per-topic probe series onto one shared date
 * axis (gaps → 0), ranked by peak, and DOWNSAMPLES a dense union (24h of
 * ~30k samples) to at most `maxPoints` max-per-bucket points so the d3 area
 * charts don't redraw a million path commands. No DOM.
 */

import { buildAlignedSeries } from '../buildAlignedSeries';

describe( 'buildAlignedSeries', () => {
	it( 'returns empty when no series have points', () => {
		expect( buildAlignedSeries( {}, 100 ) ).toEqual( {
			series: [],
			dates: [],
		} );
		expect(
			buildAlignedSeries( { a: { points: [], max: 0 } }, 100 )
		).toEqual( { series: [], dates: [] } );
	} );

	it( 'aligns topics onto the union axis, filling gaps with 0, ranked by max', () => {
		const out = buildAlignedSeries(
			{
				low: { points: [ { ts: 2, value: 1 } ], max: 1 },
				high: {
					points: [
						{ ts: 1, value: 9 },
						{ ts: 3, value: 5 },
					],
					max: 9,
				},
			},
			100
		);
		// union axis = [1,2,3]; ranked high (max 9) before low (max 1).
		expect( out.dates.map( ( d ) => d.getTime() / 1000 ) ).toEqual( [
			1, 2, 3,
		] );
		expect( out.series.map( ( s ) => s.label ) ).toEqual( [
			'high',
			'low',
		] );
		expect( out.series[ 0 ].values.map( ( v ) => v.value ) ).toEqual( [
			9, 0, 5,
		] );
		expect( out.series[ 1 ].values.map( ( v ) => v.value ) ).toEqual( [
			0, 1, 0,
		] );
	} );

	it( 'leaves the axis untouched when the union is within maxPoints', () => {
		const out = buildAlignedSeries(
			{ a: { points: [ { ts: 1, value: 3 } ], max: 3 } },
			100
		);
		expect( out.dates ).toHaveLength( 1 );
		expect( out.series[ 0 ].values ).toHaveLength( 1 );
	} );

	it( 'downsamples a dense union to at most maxPoints, preserving spikes (max-per-bucket)', () => {
		// 8 timestamps, one series; cap to 2 points → two buckets of 4.
		const spikes = { 3: 100, 7: 50 };
		const points = [ 1, 2, 3, 4, 5, 6, 7, 8 ].map( ( ts ) => ( {
			ts,
			value: spikes[ ts ] ?? 1,
		} ) );
		const out = buildAlignedSeries( { a: { points, max: 100 } }, 2 );
		expect( out.dates ).toHaveLength( 2 );
		expect( out.series[ 0 ].values ).toHaveLength( 2 );
		// bucket [1..4] peak 100, bucket [5..8] peak 50 — spikes survive.
		expect( out.series[ 0 ].values.map( ( v ) => v.value ) ).toEqual( [
			100, 50,
		] );
	} );

	it( 'never emits more than maxPoints buckets for a huge union', () => {
		const points = Array.from( { length: 30000 }, ( _, i ) => ( {
			ts: i + 1,
			value: i,
		} ) );
		const out = buildAlignedSeries( { a: { points, max: 29999 } }, 1000 );
		expect( out.dates.length ).toBeLessThanOrEqual( 1000 );
		expect( out.series[ 0 ].values.length ).toBe( out.dates.length );
	} );
} );
