import { renderHook } from '@testing-library/react';
import { useGraphRates } from '../useGraphRates';

const g = ( nodes ) => ( { nodes, edges: [] } );

describe( 'useGraphRates', () => {
	it( 'seeds a rate entry at 0 for a newly-seen node', () => {
		const { result } = renderHook( () =>
			useGraphRates( g( [ { id: 'a', count: 5 } ] ), 'k1' )
		);
		const entry = result.current.rateRef.current.get( 'a' );
		expect( entry.count ).toBe( 5 );
		expect( entry.rate ).toBe( 0 );
	} );

	it( 'treats the first real reading as a baseline, then computes a rate on the next tick', () => {
		let now = 1000;
		jest.spyOn( Date, 'now' ).mockImplementation( () => now * 1000 );
		const { result, rerender } = renderHook(
			( { graph } ) => useGraphRates( graph, 'k1' ),
			{ initialProps: { graph: g( [ { id: 'a', count: 0 } ] ) } }
		);
		// First non-zero reading only seeds baseline — cumulative ≠ interval.
		now = 1001;
		rerender( { graph: g( [ { id: 'a', count: 10 } ] ) } );
		expect( result.current.rateRef.current.get( 'a' ).rate ).toBe( 0 );
		// The NEXT delta is a true per-interval rate.
		now = 1002;
		rerender( { graph: g( [ { id: 'a', count: 20 } ] ) } );
		expect( result.current.rateRef.current.get( 'a' ).rate ).toBe( 10 );
		Date.now.mockRestore();
	} );

	it( 'does not turn the first dump_metadata cumulative backfill into a rate spike', () => {
		let now = 1000;
		jest.spyOn( Date, 'now' ).mockImplementation( () => now * 1000 );
		// Node enters at 0 (placeholder); dump_metadata backfills cumulative.
		const { result, rerender } = renderHook(
			( { graph } ) => useGraphRates( graph, 'k1' ),
			{ initialProps: { graph: g( [ { id: 'a', count: 0 } ] ) } }
		);
		now = 1001;
		rerender( { graph: g( [ { id: 'a', count: 12075 } ] ) } );
		const entry = result.current.rateRef.current.get( 'a' );
		expect( entry.rate ).toBe( 0 );
		// The peak the sparkline reads must not be poisoned by the backfill.
		expect( Math.max( 0, ...entry.history ) ).toBe( 0 );
		// A genuine +5 over the next interval still reads correctly.
		now = 1002;
		rerender( { graph: g( [ { id: 'a', count: 12080 } ] ) } );
		expect( result.current.rateRef.current.get( 'a' ).rate ).toBe( 5 );
		Date.now.mockRestore();
	} );

	it( 'baselines byte counters on the first reading too (no byte-rate spike)', () => {
		let now = 1000;
		jest.spyOn( Date, 'now' ).mockImplementation( () => now * 1000 );
		const { result, rerender } = renderHook(
			( { graph } ) => useGraphRates( graph, 'k1' ),
			{
				initialProps: {
					graph: g( [ { id: 'a', count: 0, bytesRead: 0 } ] ),
				},
			}
		);
		now = 1001;
		rerender( {
			graph: g( [ { id: 'a', count: 12075, bytesRead: 2300000 } ] ),
		} );
		const entry = result.current.rateRef.current.get( 'a' );
		expect( entry.readRate ).toBe( 0 );
		expect( Math.max( 0, ...entry.readHistory ) ).toBe( 0 );
		Date.now.mockRestore();
	} );

	it( 'seeds a node first seen WITH data as warm so the next tick is a real delta', () => {
		let now = 1000;
		jest.spyOn( Date, 'now' ).mockImplementation( () => now * 1000 );
		// Node seen WITH cumulative → seeds warm; next reading is a delta.
		const { result, rerender } = renderHook(
			( { graph } ) => useGraphRates( graph, 'k1' ),
			{ initialProps: { graph: g( [ { id: 'a', count: 5000 } ] ) } }
		);
		now = 1001;
		rerender( { graph: g( [ { id: 'a', count: 5007 } ] ) } );
		expect( result.current.rateRef.current.get( 'a' ).rate ).toBe( 7 );
		Date.now.mockRestore();
	} );

	it( 'does not re-spike after a counter reset (worker respawn)', () => {
		let now = 1000;
		jest.spyOn( Date, 'now' ).mockImplementation( () => now * 1000 );
		const { result, rerender } = renderHook(
			( { graph } ) => useGraphRates( graph, 'k1' ),
			{ initialProps: { graph: g( [ { id: 'a', count: 0 } ] ) } }
		);
		// Warm up: baseline 8000, then a real +10 delta.
		now = 1001;
		rerender( { graph: g( [ { id: 'a', count: 8000 } ] ) } );
		now = 1002;
		rerender( { graph: g( [ { id: 'a', count: 8010 } ] ) } );
		expect( result.current.rateRef.current.get( 'a' ).rate ).toBe( 10 );
		// Respawn resets counter — the negative delta clamps to 0, no spike.
		now = 1003;
		rerender( { graph: g( [ { id: 'a', count: 0 } ] ) } );
		expect( result.current.rateRef.current.get( 'a' ).rate ).toBe( 0 );
		// Post-respawn climb reads as a clean positive delta.
		now = 1004;
		rerender( { graph: g( [ { id: 'a', count: 4 } ] ) } );
		expect( result.current.rateRef.current.get( 'a' ).rate ).toBe( 4 );
		Date.now.mockRestore();
	} );

	it( 'clamps a negative delta (counter reset) to rate 0', () => {
		let now = 1000;
		jest.spyOn( Date, 'now' ).mockImplementation( () => now * 1000 );
		const { result, rerender } = renderHook(
			( { graph } ) => useGraphRates( graph, 'k1' ),
			{ initialProps: { graph: g( [ { id: 'a', count: 100 } ] ) } }
		);
		now = 1001;
		rerender( { graph: g( [ { id: 'a', count: 3 } ] ) } );
		expect( result.current.rateRef.current.get( 'a' ).rate ).toBe( 0 );
		Date.now.mockRestore();
	} );

	it( 'yields a finite rate of 0 for a node with no count field', () => {
		let now = 1000;
		jest.spyOn( Date, 'now' ).mockImplementation( () => now * 1000 );
		const { result, rerender } = renderHook(
			( { graph } ) => useGraphRates( graph, 'k1' ),
			{ initialProps: { graph: g( [ { id: 'a' } ] ) } }
		);
		now = 1001;
		rerender( { graph: g( [ { id: 'a' } ] ) } );
		const entry = result.current.rateRef.current.get( 'a' );
		expect( Number.isNaN( entry.rate ) ).toBe( false );
		expect( entry.rate ).toBe( 0 );
		expect( entry.history.every( Number.isFinite ) ).toBe( true );
		Date.now.mockRestore();
	} );

	it( 'prunes entries for ids absent from the current graph', () => {
		const { result, rerender } = renderHook(
			( { graph } ) => useGraphRates( graph, 'k1' ),
			{ initialProps: { graph: g( [ { id: 'a', count: 5 } ] ) } }
		);
		expect( result.current.rateRef.current.has( 'a' ) ).toBe( true );
		rerender( { graph: g( [ { id: 'b', count: 1 } ] ) } );
		expect( result.current.rateRef.current.has( 'a' ) ).toBe( false );
		expect( result.current.rateRef.current.has( 'b' ) ).toBe( true );
	} );

	it( 'clears the accumulated map when resetKey changes', () => {
		const { result, rerender } = renderHook(
			( { graph, key } ) => useGraphRates( graph, key ),
			{
				initialProps: {
					graph: g( [ { id: 'a', count: 5 } ] ),
					key: 'k1',
				},
			}
		);
		expect( result.current.rateRef.current.has( 'a' ) ).toBe( true );
		rerender( { graph: g( [ { id: 'b', count: 1 } ] ), key: 'k2' } );
		expect( result.current.rateRef.current.has( 'a' ) ).toBe( false );
		expect( result.current.rateRef.current.has( 'b' ) ).toBe( true );
	} );
} );
