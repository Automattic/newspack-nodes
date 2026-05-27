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

	it( 'computes a positive rate on the next tick with a later timestamp', () => {
		let now = 1000;
		jest.spyOn( Date, 'now' ).mockImplementation( () => now * 1000 );
		const { result, rerender } = renderHook(
			( { graph } ) => useGraphRates( graph, 'k1' ),
			{ initialProps: { graph: g( [ { id: 'a', count: 0 } ] ) } }
		);
		now = 1001;
		rerender( { graph: g( [ { id: 'a', count: 10 } ] ) } );
		const entry = result.current.rateRef.current.get( 'a' );
		expect( entry.rate ).toBe( 10 );
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
