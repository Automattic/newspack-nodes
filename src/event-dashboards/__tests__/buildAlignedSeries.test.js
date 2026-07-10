/**
 * buildAlignedSeries — snap the per-topic probe series onto ONE shared,
 * epoch-aligned time-bucket grid (bucket = probe interval, widened only to keep
 * the axis under `maxPoints`), then fill each bucket per the metric's mode:
 * LEVEL gauges (backlog/cacheSize) HOLD the last value across empty buckets
 * (0 before the first sample); RATE metrics zero-fill and MAX-aggregate. This
 * kills the phase-offset sawtooth the old raw-union + `?? 0` path drew. No DOM.
 */

import { buildAlignedSeries } from '../buildAlignedSeries';

const HOLD = { fill: 'hold', agg: 'last' };
const ZERO = { fill: 'zero', agg: 'max' };

describe( 'buildAlignedSeries', () => {
	it( 'returns empty when no series have points', () => {
		expect( buildAlignedSeries( {}, 100, HOLD ) ).toEqual( {
			series: [],
			dates: [],
		} );
		expect(
			buildAlignedSeries( { a: { points: [], max: 0 } }, 100, HOLD )
		).toEqual( { series: [], dates: [] } );
	} );

	it( 'aligns two LEVEL topics sampled 15s out of phase onto the SAME buckets — no interleaved zeros, smooth decline stays monotonic', () => {
		const out = buildAlignedSeries(
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
			100,
			HOLD
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
			{
				a: {
					points: [
						{ ts: 0, value: 500 },
						{ ts: 30, value: 300 },
					],
					max: 500,
				},
			},
			100,
			HOLD
		);
		// Grid 0,15,30 — bucket 15 has no sample, so it holds 500 (not 0).
		expect( out.series[ 0 ].values.map( ( v ) => v.value ) ).toEqual( [
			500, 500, 300,
		] );
	} );

	it( 'a LEVEL topic reads 0 for buckets before its first sample', () => {
		const out = buildAlignedSeries(
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
			100,
			HOLD
		);
		// Ranked by max: `late` (400) first.
		expect( out.series[ 0 ].label ).toBe( 'late' );
		expect( out.series[ 0 ].values.map( ( v ) => v.value ) ).toEqual( [
			0, 0, 400,
		] );
	} );

	it( 'a RATE metric zero-fills an empty bucket and MAX-aggregates within a bucket', () => {
		const out = buildAlignedSeries(
			{
				a: {
					points: [
						{ ts: 0, value: 10 },
						{ ts: 5, value: 40 },
						{ ts: 30, value: 20 },
					],
					max: 40,
				},
			},
			100,
			ZERO
		);
		// bucket 0 = max(10,40)=40; bucket 15 empty → 0; bucket 30 = 20.
		expect( out.series[ 0 ].values.map( ( v ) => v.value ) ).toEqual( [
			40, 0, 20,
		] );
	} );

	it( 'defaults to RATE behavior (zero-fill + max) when no mode is given', () => {
		const out = buildAlignedSeries(
			{
				a: {
					points: [
						{ ts: 0, value: 10 },
						{ ts: 30, value: 20 },
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
			{
				low: { points: [ { ts: 0, value: 1 } ], max: 1 },
				high: { points: [ { ts: 0, value: 9 } ], max: 9 },
			},
			100,
			ZERO
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
			{ a: { points, max: 5000 } },
			100,
			ZERO
		);
		expect( out.dates.length ).toBeLessThanOrEqual( 100 );
		expect( out.series[ 0 ].values.length ).toBe( out.dates.length );
	} );
} );
