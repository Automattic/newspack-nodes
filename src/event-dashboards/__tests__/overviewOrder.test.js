/**
 * overviewOrder — pure ordering helpers for the Overview active-topology list.
 * `orderTopologies` resolves the persisted order against the live set;
 * `reorderNames` computes a drag-reorder move. No DOM, no storage.
 */

import {
	orderTopologies,
	reorderNames,
	mergeStoredOrder,
} from '../overviewOrder';

describe( 'orderTopologies', () => {
	it( 'puts stored names first in stored order, then the rest alphabetically', () => {
		expect(
			orderTopologies(
				[ 'alpha', 'beta', 'gamma', 'delta' ],
				[ 'gamma', 'alpha' ]
			)
		).toEqual( [ 'gamma', 'alpha', 'beta', 'delta' ] );
	} );

	it( 'appends a brand-new (unstored) name at the end, alphabetically among the unstored', () => {
		expect(
			orderTopologies( [ 'beta', 'alpha', 'zeta' ], [ 'beta' ] )
		).toEqual( [ 'beta', 'alpha', 'zeta' ] );
	} );

	it( 'drops a stored name no longer present in the active set', () => {
		expect(
			orderTopologies( [ 'alpha', 'beta' ], [ 'gone', 'beta', 'alpha' ] )
		).toEqual( [ 'beta', 'alpha' ] );
	} );

	it( 'falls back to pure alphabetical when nothing is stored', () => {
		expect( orderTopologies( [ 'gamma', 'alpha', 'beta' ], [] ) ).toEqual( [
			'alpha',
			'beta',
			'gamma',
		] );
	} );

	it( 'returns an empty array for no active topologies', () => {
		expect( orderTopologies( [], [ 'alpha' ] ) ).toEqual( [] );
	} );
} );

describe( 'reorderNames', () => {
	const order = [ 'a', 'b', 'c', 'd' ];

	it( 'moves a name up, inserting it immediately before the target', () => {
		expect( reorderNames( order, 'd', 'b' ) ).toEqual( [
			'a',
			'd',
			'b',
			'c',
		] );
	} );

	it( 'moves a name down, inserting it immediately before the target', () => {
		expect( reorderNames( order, 'a', 'd' ) ).toEqual( [
			'b',
			'c',
			'a',
			'd',
		] );
	} );

	it( 'moves a name to the top when the target is the first element', () => {
		expect( reorderNames( order, 'c', 'a' ) ).toEqual( [
			'c',
			'a',
			'b',
			'd',
		] );
	} );

	it( 'returns the order unchanged when dragged === target', () => {
		expect( reorderNames( order, 'b', 'b' ) ).toEqual( order );
	} );

	it( 'returns the order unchanged when the dragged name is missing', () => {
		expect( reorderNames( order, 'x', 'b' ) ).toEqual( order );
	} );

	it( 'returns the order unchanged when the target name is missing', () => {
		expect( reorderNames( order, 'b', 'x' ) ).toEqual( order );
	} );
} );

describe( 'mergeStoredOrder', () => {
	it( 'keeps inactive stored names so a drag while one is down does not lose its slot', () => {
		// prior persisted [a,b,c,d]; c is inactive so the new active order is
		// [b,a,d]. c must survive (carried, in prior relative order) — not dropped.
		expect(
			mergeStoredOrder( [ 'a', 'b', 'c', 'd' ], [ 'b', 'a', 'd' ] )
		).toEqual( [ 'b', 'a', 'd', 'c' ] );
	} );

	it( 'is just the active order when nothing inactive is carried', () => {
		expect( mergeStoredOrder( [ 'x', 'y' ], [ 'y', 'x' ] ) ).toEqual( [
			'y',
			'x',
		] );
	} );

	it( 'handles an empty prior order', () => {
		expect( mergeStoredOrder( [], [ 'a', 'b' ] ) ).toEqual( [ 'a', 'b' ] );
	} );

	it( 'preserves multiple inactive names in their prior relative order', () => {
		expect(
			mergeStoredOrder( [ 'a', 'x', 'b', 'y' ], [ 'b', 'a' ] )
		).toEqual( [ 'b', 'a', 'x', 'y' ] );
	} );
} );
