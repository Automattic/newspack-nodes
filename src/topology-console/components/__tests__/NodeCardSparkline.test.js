/* eslint-env jest */
/**
 * A card's rate sparkline is right-aligned across the whole rate window, so
 * a short history walks in from the right edge: four samples sit in the last
 * four of sixty slots, scaled to the tallest, a negative one clamped to the
 * floor, inside the card's band.
 */

import { sparklinePath } from '../NodeCard';

describe( 'sparklinePath', () => {
	it( 'right-aligns a short history in the card band', () => {
		expect( sparklinePath( [ 2, 0, 4, -1 ] ) ).toBe(
			'M 176.15,56.00 L 179.10,64.00 L 182.05,48.00 L 185.00,64.00'
		);
	} );

	it( 'draws nothing under two samples', () => {
		expect( sparklinePath( [ 7 ] ) ).toBeNull();
		expect( sparklinePath( null ) ).toBeNull();
	} );
} );
