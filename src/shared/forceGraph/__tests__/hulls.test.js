/**
 * Tests for the hull a branch draws around its leaves' label rects.
 */

import { polygonContains } from 'd3';
import { buildModel } from '../model';
import { hullPoints } from '../hulls';

const leavesAt = ( spots ) => {
	const model = buildModel( {
		nodes: spots.map( ( _, i ) => ( { id: `n${ i }`, label: `n${ i }` } ) ),
		links: [],
		groups: [],
	} );
	model.leaves.forEach( ( leaf, i ) => {
		[ leaf.x, leaf.y ] = spots[ i ];
	} );
	return model.leaves;
};

const corners = ( { x, y, halfW, halfH } ) => [
	[ x - halfW, y - halfH ],
	[ x + halfW, y - halfH ],
	[ x - halfW, y + halfH ],
	[ x + halfW, y + halfH ],
];

describe( 'hullPoints', () => {
	it.each( [
		[ 'one leaf', [ [ 310, 170 ] ] ],
		[
			'two leaves',
			[
				[ 310, 170 ],
				[ 520, 90 ],
			],
		],
		[
			'twelve leaves',
			Array.from( { length: 12 }, ( _, i ) => [
				100 + ( i % 4 ) * 170 + ( i % 3 ) * 13,
				60 + Math.floor( i / 4 ) * 90 + ( i % 2 ) * 17,
			] ),
		],
	] )( 'holds every label corner for %s', ( _, spots ) => {
		const leaves = leavesAt( spots );
		const hull = hullPoints( leaves );

		for ( const leaf of leaves ) {
			for ( const corner of corners( leaf ) ) {
				expect( polygonContains( hull, corner ) ).toBe( true );
			}
		}
	} );

	it( 'holds the whole rect of a sized node, circle and label', () => {
		const model = buildModel( {
			nodes: [
				{ id: 'big', label: 'a', size: 60 },
				{ id: 'small', label: 'b' },
			],
			links: [],
			groups: [],
		} );
		[ model.leaves[ 0 ].x, model.leaves[ 0 ].y ] = [ 300, 200 ];
		[ model.leaves[ 1 ].x, model.leaves[ 1 ].y ] = [ 520, 90 ];
		const hull = hullPoints( model.leaves );

		for ( const corner of [
			[ 240, 115 ],
			[ 360, 115 ],
			[ 240, 285 ],
			[ 360, 285 ],
			[ 490, 78 ],
			[ 550, 102 ],
		] ) {
			expect( polygonContains( hull, corner ) ).toBe( true );
		}
	} );

	it( 'grows by the padding it is given', () => {
		const [ leaf ] = leavesAt( [ [ 310, 170 ] ] );
		const small = hullPoints( [ leaf ], 10 );
		const large = hullPoints( [ leaf ], 70 );
		const width = ( pts ) =>
			Math.max( ...pts.map( ( p ) => p[ 0 ] ) ) -
			Math.min( ...pts.map( ( p ) => p[ 0 ] ) );

		expect( width( large ) ).toBeGreaterThan( width( small ) );
		expect( hullPoints( [ leaf ] ) ).toEqual( hullPoints( [ leaf ], 50 ) );
	} );
} );
