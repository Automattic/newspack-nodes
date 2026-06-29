import { renderHook } from '@testing-library/react';
import { useAggregateRateSeries } from '../useAggregateRateSeries';

const src = ( count, bytesRead = 0, bytesWritten = 0 ) => ( {
	id: 'src',
	count,
	bytesRead,
	bytesWritten,
	has_target: true,
	accepts_fill: false,
} );
const snk = ( count ) => ( {
	id: 'snk',
	count,
	has_target: false,
	accepts_fill: true,
} );

describe( 'useAggregateRateSeries', () => {
	it( 'seeds the baseline on the first poll (no rate emitted)', () => {
		const { result } = renderHook(
			( { nodes } ) => useAggregateRateSeries( nodes ),
			{ initialProps: { nodes: [ src( 5 ), snk( 3 ) ] } }
		);
		expect( result.current ).toEqual( {
			in: [],
			out: [],
			read: [],
			write: [],
		} );
	} );

	it( 'emits byte read/write rate series alongside the msg rates', () => {
		const { result, rerender } = renderHook(
			( { nodes } ) => useAggregateRateSeries( nodes ),
			// Seed from a reading WITH data (the baseline must not be a zero one).
			{ initialProps: { nodes: [ src( 0, 1000, 200 ), snk( 0 ) ] } }
		);
		// Synchronous rerenders → dt floors to 1s, so rate == byte delta.
		rerender( { nodes: [ src( 0, 3048, 712 ), snk( 0 ) ] } );
		expect( result.current.read ).toEqual( [ 2048 ] );
		expect( result.current.write ).toEqual( [ 512 ] );
		// A counter reset (worker respawn) clamps the byte rate to 0, not negative.
		rerender( { nodes: [ src( 0, 100, 50 ), snk( 0 ) ] } );
		expect( result.current.read ).toEqual( [ 2048, 0 ] );
		expect( result.current.write ).toEqual( [ 512, 0 ] );
	} );

	it( 'does not spike when nodes are present but counters are still zero, then backfill', () => {
		const { result, rerender } = renderHook(
			( { nodes } ) => useAggregateRateSeries( nodes ),
			// Nodes loaded but their cumulative counters not populated yet.
			{ initialProps: { nodes: [ src( 0 ), snk( 0 ) ] } }
		);
		// The dump_metadata backfills the full cumulative in the next reading.
		rerender( { nodes: [ src( 16431 ), snk( 478 ) ] } );
		// 0→total is NOT a rate — it only seeds the baseline (sparkline empty).
		expect( result.current.in ).toEqual( [] );
		expect( result.current.out ).toEqual( [] );
		// The next reading is a true per-interval delta off that baseline.
		rerender( { nodes: [ src( 16440 ), snk( 480 ) ] } );
		expect( result.current.in ).toEqual( [ 9 ] );
		expect( result.current.out ).toEqual( [ 2 ] );
	} );

	it( 'does not spike when the first snapshot is empty then real data arrives', () => {
		const { result, rerender } = renderHook(
			( { nodes } ) => useAggregateRateSeries( nodes ),
			{ initialProps: { nodes: [] } } // not-yet-loaded poll
		);
		// First REAL poll on an already-running worker: large cumulative counters.
		rerender( { nodes: [ src( 500000 ), snk( 3000 ) ] } );
		// That snapshot only seeds the baseline — no rate (no cumulative-as-spike).
		expect( result.current.in ).toEqual( [] );
		expect( result.current.out ).toEqual( [] );
		// The next real poll yields the true delta, not the cumulative.
		rerender( { nodes: [ src( 500010 ), snk( 3004 ) ] } );
		expect( result.current.in ).toEqual( [ 10 ] );
		expect( result.current.out ).toEqual( [ 4 ] );
	} );

	it( 'drops the baseline + history when the scope (resetKey) changes (switch workers)', () => {
		const { result, rerender } = renderHook(
			( { nodes, resetKey } ) =>
				useAggregateRateSeries( nodes, resetKey ),
			{
				initialProps: {
					nodes: [ src( 5 ), snk( 2 ) ],
					resetKey: 'workerA',
				},
			}
		);
		rerender( { nodes: [ src( 15 ), snk( 6 ) ], resetKey: 'workerA' } );
		expect( result.current.in ).toEqual( [ 10 ] );
		// Switch to a different worker carrying its own large cumulative counters:
		// it must NOT delta against workerA's baseline (totals-as-rates spike).
		rerender( {
			nodes: [ src( 900000 ), snk( 500000 ) ],
			resetKey: 'workerB',
		} );
		expect( result.current.in ).toEqual( [] );
		expect( result.current.out ).toEqual( [] );
		// The next poll on workerB yields a true delta off its own baseline.
		rerender( {
			nodes: [ src( 900012 ), snk( 500003 ) ],
			resetKey: 'workerB',
		} );
		expect( result.current.in ).toEqual( [ 12 ] );
		expect( result.current.out ).toEqual( [ 3 ] );
	} );

	it( 'emits the in/out delta per poll, clamping a counter reset to 0', () => {
		const { result, rerender } = renderHook(
			( { nodes } ) => useAggregateRateSeries( nodes ),
			// Seed from a reading WITH data; rates accrue from the next poll on.
			{ initialProps: { nodes: [ src( 100 ), snk( 50 ) ] } }
		);
		// Synchronous rerenders → dt floors to 1s, so rate == delta. The source
		// counter feeds `in`, the sink counter feeds `out` (see processStats).
		rerender( { nodes: [ src( 110 ), snk( 54 ) ] } );
		expect( result.current.in ).toEqual( [ 10 ] );
		expect( result.current.out ).toEqual( [ 4 ] );
		// Counters went backward (worker respawn) → clamp to 0, not negative.
		rerender( { nodes: [ src( 2 ), snk( 1 ) ] } );
		expect( result.current.in ).toEqual( [ 10, 0 ] );
		expect( result.current.out ).toEqual( [ 4, 0 ] );
	} );
} );
