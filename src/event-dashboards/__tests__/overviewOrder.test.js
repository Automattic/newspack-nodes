/**
 * overviewOrder — pure ordering helpers for the Overview active-topology list.
 * `orderTopologies` resolves the persisted order against the live set;
 * `reorderNames` computes a drag-reorder move. No DOM, no storage.
 */

import {
	orderTopologies,
	dragReorder,
	dragGapTransforms,
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

describe( 'dragReorder', () => {
	const names = [ 'a', 'b', 'c', 'd' ];
	// Rows 100px tall stacked from y=0: a[0-100] b[100-200] c[200-300] d[300-400].
	const rects = [
		{ top: 0, bottom: 100 },
		{ top: 100, bottom: 200 },
		{ top: 200, bottom: 300 },
		{ top: 300, bottom: 400 },
	];

	it( 'moves a row DOWN to where the cursor is (not sticky)', () => {
		// Drag 'a' down past c's midpoint (y=260) → a lands between c and d.
		expect( dragReorder( names, 'a', rects, 260 ) ).toEqual( [
			'b',
			'c',
			'a',
			'd',
		] );
	} );

	it( 'moves a row UP to where the cursor is', () => {
		// Drag 'd' up past b's midpoint (y=160, b's lower half) → d below b.
		expect( dragReorder( names, 'd', rects, 160 ) ).toEqual( [
			'a',
			'b',
			'd',
			'c',
		] );
	} );

	it( 'moves to the top when the cursor is above the first midpoint', () => {
		expect( dragReorder( names, 'c', rects, 10 ) ).toEqual( [
			'c',
			'a',
			'b',
			'd',
		] );
	} );

	it( 'keeps the row in place when the cursor is over its own band', () => {
		// 'b' band is 100-200, midpoint 150; cursor 120 (above b's mid, below a's)
		// → slot 1 == b's index → no move.
		expect( dragReorder( names, 'b', rects, 120 ) ).toEqual( names );
	} );

	it( 'is a no-op when the dragged name is missing', () => {
		expect( dragReorder( names, 'x', rects, 250 ) ).toEqual( names );
	} );
} );

describe( 'dragGapTransforms', () => {
	// 4 rows, 100px pitch: a[0-100] b[100-200] c[200-300] d[300-400].
	const rects = [
		{ top: 0, bottom: 100 },
		{ top: 100, bottom: 200 },
		{ top: 200, bottom: 300 },
		{ top: 300, bottom: 400 },
	];

	it( 'drags the row by dy and shifts the rows it passes UP to open a gap below', () => {
		// Drag row 0 down to slot 2 (cursor y=260, past c midpoint).
		const { transforms, toIndex } = dragGapTransforms( rects, 0, 55, 260 );
		expect( toIndex ).toBe( 2 );
		// row0 = dy; rows 1,2 shift up one pitch to fill the vacated space; row3 stays.
		expect( transforms ).toEqual( [ 55, -100, -100, 0 ] );
	} );

	it( 'shifts rows DOWN when dragging upward', () => {
		// Drag row 3 up to slot 1 (cursor y=120, between a & b midpoints).
		const { transforms, toIndex } = dragGapTransforms(
			rects,
			3,
			-140,
			120
		);
		expect( toIndex ).toBe( 1 );
		// row3 = dy; rows 1,2 shift down one pitch; row0 stays.
		expect( transforms ).toEqual( [ 0, 100, 100, -140 ] );
	} );

	it( 'opens no gap when the row is held over its own slot', () => {
		const { transforms, toIndex } = dragGapTransforms( rects, 1, 20, 120 );
		expect( toIndex ).toBe( 1 );
		expect( transforms ).toEqual( [ 0, 20, 0, 0 ] );
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
