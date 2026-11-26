/**
 * Tests for the fitted view: what a band covered at the canvas's foot leaves
 * the graph, and where that band stops counting.
 */

const { TEXT_ZOOM, fitOf } = require( '../fit' );

/**
 * A leaf at a point with the given half extents.
 *
 * @param {number} x     Its x.
 * @param {number} y     Its y.
 * @param {number} halfW Half its width.
 * @param {number} halfH Half its height.
 * @return {Object} The leaf.
 */
const leaf = ( x, y, halfW = 0, halfH = 0 ) => ( { x, y, halfW, halfH } );

/** One 100-wide box at the origin: 200 a side with the fit's padding. */
const BOX = [ leaf( 0, 0, 50, 50 ) ];

const SIZE = { width: 1000, height: 1000 };

describe( 'fitOf', () => {
	it( 'fits the whole canvas without a covered band', () => {
		const { x, y, k } = fitOf( BOX, SIZE, 0 );
		expect( [ x, y ] ).toEqual( [ 500, 500 ] );
		expect( k ).toBeCloseTo( 4.5, 6 );
	} );

	it( 'fits the band above a covered foot, centred in it', () => {
		const { x, y, k } = fitOf( BOX, SIZE, 400 );
		expect( [ x, y ] ).toEqual( [ 500, 300 ] );
		expect( k ).toBeCloseTo( 2.7, 6 );
	} );

	it( 'fits the whole canvas when the band covers nine tenths of it', () => {
		const { y, k } = fitOf( BOX, SIZE, 900 );
		expect( y ).toBe( 500 );
		expect( k ).toBeCloseTo( 4.5, 6 );
	} );

	it( 'gives up band until the fit reads its names, with room to spare', () => {
		const tall = [ leaf( 0, 0 ), leaf( 0, 2161 ) ];
		const { k } = fitOf( tall, SIZE, 400 );
		expect( k ).toBeGreaterThan( TEXT_ZOOM );
		expect( k ).toBeCloseTo( TEXT_ZOOM * 1.2, 6 );
	} );

	it( 'fits the whole canvas when no band would read its names', () => {
		const huge = [ leaf( 0, 0 ), leaf( 0, 9000 ) ];
		expect( fitOf( huge, SIZE, 400 ) ).toEqual( fitOf( huge, SIZE, 0 ) );
	} );
} );
