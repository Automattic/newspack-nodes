/* eslint-env jest */
/**
 * A sparkline's geometry: each value a point, oldest left, scaled so the
 * tallest reaches the top of the box and a value at or below zero rests on
 * its floor; a window of more slots than values right-aligns them, and the
 * points join as one SVG path, none under two.
 */

import { linePath, sparklinePoints } from '../sparkline';

describe( 'sparklinePoints', () => {
	it( 'spreads the values across the box, the tallest at its top', () => {
		expect(
			sparklinePoints( [ 3, 6, 0 ], { width: 50, height: 20 } )
		).toEqual( [
			[ 0, 10 ],
			[ 25, 0 ],
			[ 50, 20 ],
		] );
	} );

	it( 'offsets the box and right-aligns a short history in its slots', () => {
		expect(
			sparklinePoints( [ 5, -2 ], {
				width: 30,
				height: 10,
				left: 7,
				top: 4,
				slots: 4,
			} )
		).toEqual( [
			[ 27, 4 ],
			[ 37, 14 ],
		] );
	} );

	it( 'lays values that are all zero along the floor', () => {
		expect( sparklinePoints( [ 0, 0 ], { width: 12, height: 9 } ) ).toEqual(
			[
				[ 0, 9 ],
				[ 12, 9 ],
			]
		);
	} );

	it( 'puts one value at the left of the box', () => {
		expect( sparklinePoints( [ 4 ], { width: 12, height: 9 } ) ).toEqual( [
			[ 0, 0 ],
		] );
	} );

	it( 'answers no point for no value', () => {
		expect( sparklinePoints( [], { width: 12, height: 9 } ) ).toEqual( [] );
	} );
} );

describe( 'linePath', () => {
	it( 'joins the points as one path, to two places', () => {
		expect(
			linePath( [
				[ 0, 10 ],
				[ 25.125, 0 ],
				[ 50, 19.996 ],
			] )
		).toBe( 'M 0.00,10.00 L 25.13,0.00 L 50.00,20.00' );
	} );

	it( 'answers null under two points', () => {
		expect( linePath( [ [ 1, 2 ] ] ) ).toBeNull();
		expect( linePath( [] ) ).toBeNull();
	} );
} );
