import { renderHook } from '@testing-library/react';
import { useAggregateRateSeries } from '../useAggregateRateSeries';

const src = ( count ) => ( {
	id: 'src',
	count,
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
		expect( result.current ).toEqual( { in: [], out: [] } );
	} );

	it( 'emits the in/out delta per poll, clamping a counter reset to 0', () => {
		const { result, rerender } = renderHook(
			( { nodes } ) => useAggregateRateSeries( nodes ),
			{ initialProps: { nodes: [ src( 0 ), snk( 0 ) ] } }
		);
		// Synchronous rerenders → dt floors to 1s, so rate == delta.
		rerender( { nodes: [ src( 10 ), snk( 4 ) ] } );
		expect( result.current.in ).toEqual( [ 10 ] );
		expect( result.current.out ).toEqual( [ 4 ] );
		// Counters went backward (worker respawn) → clamp to 0, not negative.
		rerender( { nodes: [ src( 2 ), snk( 1 ) ] } );
		expect( result.current.in ).toEqual( [ 10, 0 ] );
		expect( result.current.out ).toEqual( [ 4, 0 ] );
	} );
} );
